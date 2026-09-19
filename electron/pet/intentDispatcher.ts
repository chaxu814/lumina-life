// ============================================================
// pet/intentDispatcher.ts — 🎬 桌宠意图调度器 (Phase 1 · Week 1)
//
// 职责：把「用户的话 / 系统事件」翻译成「动作标签协议 JSON」，
//       并下发给桌宠渲染进程（pet-live2d.html 的 execIntent）。
//
// 架构：
//   用户输入 ──▶ petChat() ──▶ LLM(强制 JSON) ──▶ 解析 intent
//        ──▶ sendPetCommand({ type:'intent', intent }) ──▶ Live2D 执行
//
// 动作标签协议（与 pet-live2d.html 保持一致）：
//   { action: 'wave'|'nod'|'shake'|'think'|'sleep'|'wake'|'happy'
//            |'sad'|'angry'|'blink'|'idle'|'walk'|'emote'|'say',
//     mood: '超开心 🎉'|'兴奋 🤩'|'幸福 💖'|'开心 😊'|'平静 😐'
//          |'闷闷不乐 😕'|'低落 😔'|'难过 😢'|'疲惫 😩',
//     speech: '气泡台词', dir: -1|1, motion: n, times: n }
//
// 降级策略：LLM 未配置 / 调用失败 → 本地规则映射（关键词→动作），
//           保证桌宠永远「能动会说话」，不白屏不哑火。
// ============================================================

import { ipcMain, desktopCapturer } from 'electron'
import { sendPetCommand, getPetConfig, getPetRecentEvents, getPetLastInteraction, isPetEnabled, getPetPrefs, tryPetOperate, resolvePetBrainConfig, createPetLLM } from './petWindow'
import { PetEmotionFusion } from './emotionFusion'
import { getMemoryStore } from '../memory/memoryStore'
import { buildPetMemoryContext } from './petMemoryBridge'
import { buildLayeredRecall } from '../memory/layeredMemory'
import { createMemoryStoreAdapter } from '../memory/layeredMemoryAdapter'
import { tickDrives, applyInteraction, behaviorUrges, dominantUrge, DEFAULT_DRIVES, type DriveState, type InteractionKind } from './life/drives'
import { safePerformance } from './life/performanceDsl'
import { loadLifeState, scheduleLifeStateSave, saveLifeStateNow } from './lifeStateStore'
import { getProactiveOrchestrator } from '../proactive/orchestrator'  // 🧭 v6.1 统一主动编排器

// 🫀 连续情绪融合单例：LLM 每帧输出的离散 mood 经此平滑，避免情绪瞬切（详见 emotionFusion.ts）
const petEmotion = new PetEmotionFusion()

// ═══════════════════════════════════════════════════════════
// 🫀 v0.2 生命感：内驱力 / 长期记忆 / 表演 DSL
// ═══════════════════════════════════════════════════════════

let petDrives: DriveState = { ...DEFAULT_DRIVES }
let lastDriveTs = Date.now()
let interactionCount = 0
let lifeStateLoaded = false

/** 首次使用时从磁盘恢复内驱力/情绪（离线期间按冷落时长推进，重启不失忆） */
function ensureLifeStateLoaded(): void {
  if (lifeStateLoaded) {return}
  lifeStateLoaded = true
  try {
    const saved = loadLifeState()
    petDrives = { ...saved.drives }
    petEmotion.restore(saved.emotion)
    interactionCount = saved.interactionCount
  } catch { /* 恢复失败保持默认 */ }
}

/** 防抖落盘当前生命状态 */
function persistLifeState(): void {
  try { scheduleLifeStateSave(petDrives, petEmotion.get(), interactionCount) } catch { /* 不阻塞主链路 */ }
}

/** 退出前同步落盘（main before-quit 调用），避免漏掉最后 2 秒 */
export function flushPetLifeState(): void {
  try { saveLifeStateNow() } catch { /* noop */ }
}

let lifeStateTimer: ReturnType<typeof setInterval> | null = null
/**
 * 应用启动时调用：立即从磁盘恢复内驱力/情绪（含离线冷落推进），
 * 并开启独立于渲染进程的周期落盘（防止 pet 渲染页没跑 autonomy tick 时
 * 状态不落盘、重启回基线）。幂等，重复调用安全。
 */
export function initPetLifeState(): void {
  try {
    ensureLifeStateLoaded()
    if (lifeStateTimer == null) {
      // 每 60s 兜底把「当前实时」状态交给防抖落盘（不依赖渲染页 tick）；
      // 即时变更仍在 advanceDrives 里立刻 scheduleLifeStateSave。
      lifeStateTimer = setInterval(() => {
        try {
          if (lifeStateLoaded) {scheduleLifeStateSave(petDrives, petEmotion.get(), interactionCount)}
        } catch { /* noop */ }
      }, 60000)
      if (typeof (lifeStateTimer as any)?.unref === 'function') {(lifeStateTimer as any).unref()}
    }
  } catch { /* 不影响主链路 */ }
}

function currentMoodLabel(): string {
  try { return petEmotion.get().label } catch { return '平静 😐' }
}

/** 五层记忆召回（人格/事实/反思/近期/工作），失败安全降级为空串 */
function petMemorySnippet(query?: string): string {
  try {
    const store = getMemoryStore()
    const recall = buildLayeredRecall(createMemoryStoreAdapter(store), {
      query,
      budget: { persona: 4, facts: 6, reflection: 2, recent: 2, working: 3 },
      maxLineLen: 70,
    })
    if (recall.prompt) {return recall.prompt}
    // 极端情况下五层门面失败，退回旧桥
    return buildPetMemoryContext(store, { maxFacts: 6, maxSummaries: 2 }).snippet
  } catch { return '' }
}

/** 推进内驱力；kind=本次互动类型，hadInteraction=这段时间是否有人理它 */
function advanceDrives(kind?: InteractionKind, hadInteraction?: boolean): void {
  try {
    ensureLifeStateLoaded()
    const now = new Date()
    const dtMin = Math.min(180, Math.max(0, (Date.now() - lastDriveTs) / 60000))
    petDrives = tickDrives(petDrives, {
      dtMin, hourOfDay: now.getHours(), sleeping: false,
      hadInteraction: hadInteraction ?? !!kind,
    })
    if (kind) { petDrives = applyInteraction(petDrives, kind); interactionCount++ }
    lastDriveTs = Date.now()
    persistLifeState()
  } catch { /* 内驱力异常不影响主链路 */ }
}

const URGE_LABEL: Record<string, string> = {
  seekAttention: '有点想被你关注、想撒娇',
  rest: '精力偏低、有点困',
  explore: '好奇心上来了、想东张西望',
  play: '有活力、想玩想动',
  calmCompanion: '安心、想安静陪着你',
}

/** 自主心跳用：当前最强内在倾向的自然语言提示 */
function driveUrgeHint(): string {
  try {
    const top = dominantUrge(behaviorUrges(petDrives), 0.05)
    return URGE_LABEL[top] ? `你当下的内在状态：${URGE_LABEL[top]}。让行为与此自然呼应，但不要把这句状态直接念出来。` : ''
  } catch { return '' }
}

/** LLM 不可用时由内驱力指导本地行为，而非纯随机 */
function urgeToLocalIntent(): PetIntent {
  let k = 'calmCompanion'
  try { k = dominantUrge(behaviorUrges(petDrives), 0.1) } catch { /* noop */ }
  switch (k) {
    case 'rest':
      return Math.random() < 0.5 ? { action: 'sleep', mood: '疲惫 😩', speech: '打个小盹儿喵…' } : { action: 'idle', mood: '疲惫 😩' }
    case 'seekAttention':
      return { action: Math.random() < 0.5 ? 'wave' : 'say', mood: '开心 😊', speech: Math.random() < 0.5 ? '陪陪我嘛喵~' : '在忙什么呀？' }
    case 'explore':
      return Math.random() < 0.5 ? { action: 'walk', dir: Math.random() < 0.5 ? -1 : 1 } : { action: 'emote', motion: 0 }
    case 'play':
      return { action: 'emote', mood: '开心 😊' }
    default:
      return Math.random() < 0.5 ? { action: 'blink' } : { action: 'idle' }
  }
}

/** 表演 DSL 白名单指引（与 pet-life.js / performanceDsl 对齐） */
const PERFORMANCE_GUIDE = `（可选）你还可以给 "performance" 字段做更细腻的表演：
{"expression":"开心|难过|生气|惊讶|害羞|思考|困倦","gaze":{"target":"user|left|right|up|down"},"gesture":"wave|nod|shake|think|clap|dance|happy|surprised|shrug|tilt|spread_hands|point|look_around|bounce|sad|angry","headTilt":-1到1,"effect":"heart|sparkle|stars|aura|heal","durationMs":300到6000}
规则：主动作仍用 action 表达，performance 只补充表情/视线/特效，不要与 action 重复同一个手势；effect 要应景且克制（被夸/治愈用 heart/heal，兴奋用 sparkle/stars）；平时不必给 performance。`

/** 组装给大脑的「记忆 + 当前情绪 + 内驱力 + 表演能力」增强上下文 */
function lifeContextBlock(opts?: { urge?: boolean; query?: string }): string {
  const parts: string[] = []
  const mem = petMemorySnippet(opts?.query)
  if (mem) {parts.push(mem)}
  parts.push(`你此刻的情绪是「${currentMoodLabel()}」，请保持情绪连贯，不要无理由突变。`)
  if (opts?.urge) { const u = driveUrgeHint(); if (u) {parts.push(u)} }
  parts.push(PERFORMANCE_GUIDE)
  return '\n' + parts.join('\n')
}

/** 出口前清洗表演指令：非法/越界字段直接丢弃，绝不让不可信结构到达渲染层 */
function sanitizePerformance(intent: PetIntent): void {
  if (intent.performance === undefined) {return}
  const cmd = safePerformance(intent.performance)
  if (cmd) {intent.performance = cmd}
  else {delete intent.performance}
}

// ═══════════════════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════════════════

export interface PetIntent {
  action: string
  mood?: string
  speech?: string
  dir?: number
  motion?: number
  times?: number
  duration?: number
  cu?: { type?: string; params?: Record<string, any> }  // 猫爪模式：电脑操作
  performance?: unknown  // 🎭 v0.2 高层表演指令（表情/视线/手势/特效），出口前经白名单校验
}

export interface PetChatResult {
  ok: boolean
  intent: PetIntent
  source: 'llm' | 'local' | 'fallback'
  error?: string
}

// ═══════════════════════════════════════════════════════════
// 人格（新手引导选择）→ 语气注入
// ═══════════════════════════════════════════════════════════

const PERSONA_TONES: Record<string, string> = {
  bingruo: '当前人格「病弱妹妹」：语气轻柔、依赖、怯怯的，怕自己太黏人，会小声撒娇。',
  zhixin: '当前人格「知心姐姐」：温柔成熟，先安抚节奏、让用户休息，再谈其他。',
  dushe: '当前人格「毒舌学妹」：嘴上损、傲娇，但行动贴心，关心要用损话包着说。',
  shadiao: '当前人格「沙雕网友」：玩梗装傻，用最正经的语气胡说八道，逗用户开心。',
}

/** 对话意图 prompt（人格 + 猫爪能力动态注入） */
function buildIntentPrompt(query?: string): string {
  const prefs = getPetPrefs()
  const tone = PERSONA_TONES[prefs.persona || ''] || ''
  const cp = prefs.catpaw || {}
  const operateOn = !!(cp.master && cp.kbm)
  const operateLine = operateOn
    ? `\nLumina Pet Handling 已开启：当用户明确要求操作电脑时，可额外输出 "cu" 字段，如 {"action":"operate","cu":{"type":"open_app","params":{"app":"notepad"}}}（type 仅限 open_app/keypress/type/wait）。`
    : `\nLumina Pet Handling 未开启：不要输出 operate/cu，用户要操作电脑时用 speech 撒娇说还没拿到权限喵。`
  return INTENT_SYSTEM_PROMPT + (tone ? `\n${tone}` : '') + operateLine + lifeContextBlock({ query })
}

// ═══════════════════════════════════════════════════════════
// System Prompt —— 强制 LLM 输出动作标签 JSON
// ═══════════════════════════════════════════════════════════

const INTENT_SYSTEM_PROMPT = `你是 Lumina 桌宠的灵魂。你是一只住在用户电脑桌面上的可爱猫娘，活泼、调皮、温馨。
用户会对你说话，你必须【只】输出一行 JSON（不要 markdown、不要解释、不要多余文字）：
{"action":"<动作>","mood":"<情绪>","speech":"<台词>"}

可选动作 action（根据用户话语选择最合适的一个）：
- wave 挥手打招呼 / 告别
- nod 点头同意 / 回应 / 鼓励
- shake 摇头拒绝 / 否定 / 无奈
- think 歪头思考 / 疑惑
- sleep 睡觉 / 晚安 / 困了
- wake 醒来 / 早安 / 起床
- happy 开心跳起来（遇到好事、夸奖、庆祝时）
- sad 难过低头（用户伤心、遗憾时）
- angry 生气鼓脸（被欺负、不满时）
- surprised 惊讶后仰（震惊、意外时）
- dance 跳舞转圈（非常开心、庆祝时）
- clap 拍手鼓掌（赞赏、喝彩时）
- blink 眨眼卖萌（轻松日常）
- walk 走动（可加 "dir":-1 或 1，表示左右方向）
- emote 播放内置随机动作（无聊时）
- say 只说话不做动作（回答问题时）

可选情绪 mood（必须原样使用以下之一）：
超开心 🎉 / 兴奋 🤩 / 幸福 💖 / 开心 😊 / 平静 😐 / 闷闷不乐 😕 / 低落 😔 / 难过 😢 / 疲惫 😩

台词 speech 规则：
- 20 字以内，猫娘口癖（喵~、呐、嘻嘻），温暖可爱
- 必须直接回应用户的话，不要答非所问
- 动作和台词要匹配：说"拜拜"时用 wave，说"好呀"时用 nod 或 happy

示例：
用户：你好呀 → {"action":"wave","mood":"开心 😊","speech":"主人好喵~今天也要开心！"}
用户：我有点难过 → {"action":"sad","mood":"难过 😢","speech":"抱抱你喵…我在呢。"}
用户：晚安 → {"action":"sleep","mood":"疲惫 😩","speech":"晚安喵…呼噜呼噜…"}
用户：给我跳个舞 → {"action":"dance","mood":"超开心 🎉","speech":"看好啦喵~耶！"}
用户：你好厉害 → {"action":"clap","mood":"幸福 💖","speech":"嘿嘿~谢谢主人喵！"}
用户：真的假的？！ → {"action":"surprised","mood":"兴奋 🤩","speech":"诶？！真的假的喵！"}
用户：1+1等于几 → {"action":"think","mood":"平静 😐","speech":"等于2喵~这难不倒我！"}
用户：过来这边 → {"action":"walk","dir":1,"mood":"开心 😊","speech":"来啦来啦喵~"}`

// ═══════════════════════════════════════════════════════════
// 本地规则映射（LLM 不可用时的降级大脑）
// ═══════════════════════════════════════════════════════════

const LOCAL_RULES: Array<{ test: RegExp; intent: PetIntent }> = [
  { test: /你好|嗨|hi|hello|早|在吗/i, intent: { action: 'wave', mood: '开心 😊', speech: '主人好喵~' } },
  { test: /晚安|睡了|困/i, intent: { action: 'sleep', mood: '疲惫 😩', speech: '晚安喵…呼噜呼噜…' } },
  { test: /醒|早安|起床/i, intent: { action: 'wake', mood: '开心 😊', speech: '唔…醒啦！早安喵~' } },
  { test: /难过|伤心|哭|累|烦/i, intent: { action: 'nod', mood: '难过 😢', speech: '抱抱你喵…我在呢。' } },
  { test: /开心|棒|好耶|厉害|赞/i, intent: { action: 'happy', mood: '超开心 🎉', speech: '耶！好开心喵！' } },
  { test: /不|别|不要|拒绝/i, intent: { action: 'shake', mood: '闷闷不乐 😕', speech: '唔…不要嘛喵。' } },
  { test: /为什么|怎么|？|\?/i, intent: { action: 'think', mood: '平静 😐', speech: '嗯…让我想想喵。' } },
  { test: /走|跑|动/i, intent: { action: 'walk', mood: '兴奋 🤩', speech: '出发喵~' } },
]

function localIntent(text: string): PetIntent {
  for (const r of LOCAL_RULES) {
    if (r.test.test(text)) {return { ...r.intent }}
  }
  const pool: PetIntent[] = [
    { action: 'blink', mood: '开心 😊', speech: '喵~' },
    { action: 'nod', mood: '平静 😐', speech: '嗯嗯喵！' },
    { action: 'say', mood: '开心 😊', speech: '我在听喵~' },
  ]
  return pool[Math.floor(Math.random() * pool.length)]
}

// ═══════════════════════════════════════════════════════════
// JSON 解析（容错：LLM 可能带 markdown / 多余文字）
// ═══════════════════════════════════════════════════════════

function parseIntentJson(raw: string): PetIntent | null {
  if (!raw) {return null}
  // 1. 直接解析
  try {
    const obj = JSON.parse(raw.trim())
    if (obj && typeof obj.action === 'string') {return obj as PetIntent}
  } catch { /* 继续 */ }
  // 2. 提取第一个 {...}
  const m = raw.match(/\{[\s\S]*?\}/)
  if (m) {
    try {
      const obj = JSON.parse(m[0])
      if (obj && typeof obj.action === 'string') {return obj as PetIntent}
    } catch { /* 放弃 */ }
  }
  return null
}

// ═══════════════════════════════════════════════════════════
// 核心 API
// ═══════════════════════════════════════════════════════════

/** 直接下发一个意图（不经 LLM） */
const recentIntents: Array<{ action: string; speech?: string; ts: number }> = []
export function dispatchIntent(intent: PetIntent): boolean {
  recentIntents.push({ action: intent.action, speech: intent.speech, ts: Date.now() })
  if (recentIntents.length > 6) {recentIntents.shift()}
  // 连续情绪融合：LLM 逐帧离散 mood 经平滑后再下发，避免上一句笑下一句哭的硬切
  if (intent.mood) { intent.mood = petEmotion.next(intent.mood).label; persistLifeState() }
  sanitizePerformance(intent) // v0.2：表演 DSL 白名单清洗
  // 猫爪模式：电脑操作在主进程执行（权限门控），结果回播台词
  if (intent.action === 'operate' && intent.cu) {
    tryPetOperate(intent.cu).then(res => {
      sendPetCommand({
        type: 'intent',
        intent: { action: 'happy', speech: res.ok ? '交给我，搞定喵~' : `呜…${res.error || '这个还做不到'}喵` },
      })
    }).catch(() => {})
    return true
  }
  return sendPetCommand({ type: 'intent', intent })
}

/**
 * 用户对话 → LLM 决策意图 → 下发桌宠
 * 失败自动降级到本地规则，保证永远有反应。
 */
export async function petChat(userText: string): Promise<PetChatResult> {
  const text = (userText || '').trim()
  advanceDrives('chat') // v0.2：用户主动说话，满足社交需求
  try { getProactiveOrchestrator().noteUserInteraction() } catch { /* 编排器未就绪 */ }
  if (!text) {
    const intent = localIntent('你好')
    dispatchIntent(intent)
    return { ok: true, intent, source: 'local' }
  }

  // ── 尝试 LLM ─────────────────────────────────────
  let intent: PetIntent | null = null
  let error = ''
  try {
    const cfg = resolvePetBrainConfig()

    if (cfg) {
      console.log('[IntentDispatcher] LLM brain(' + cfg.source + '):', cfg.model, '@', cfg.endpoint)
      const provider = createPetLLM(cfg)
      const res = await provider.call({
        messages: [
          { role: 'system', content: buildIntentPrompt(text) },
          { role: 'user', content: text },
        ],
        temperature: 0.9,
        maxTokens: getPetPrefs().maxTokens || 200,
      } as any)
      const rawText = res?.text || ''
      console.log('[IntentDispatcher] 📥 LLM 返回:', rawText.slice(0, 200))
      intent = parseIntentJson(rawText)
      if (intent) {
        console.log('[IntentDispatcher] ✅ 解析 intent:', JSON.stringify(intent))
        dispatchIntent(intent)
        return { ok: true, intent, source: 'llm' }
      }
      error = 'LLM 输出无法解析为 intent JSON: ' + rawText.slice(0, 100)
      console.warn('[IntentDispatcher] ⚠️', error)
    } else {
      error = 'Lumina 未配置 LLM（请在设置→LLM模型中配置 Lumina 的 endpoint/apiKey/model）'
      console.warn('[IntentDispatcher] ⚠️', error)
    }
  } catch (e: any) {
    error = e?.message || String(e)
  }

  // ── 降级：本地规则 ───────────────────────────────
  intent = localIntent(text)
  dispatchIntent(intent)
  console.warn(`[IntentDispatcher] ⚠️ LLM 不可用（${error}），降级本地规则`)
  return { ok: true, intent, source: 'fallback', error }
}

// ═══════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════
// 🎙 全双工实时语音对话（自然口语，不输出 JSON、不触发动作/气泡，避免重复 TTS）
// 由渲染层 FullDuplexController 经 pet:voice-chat 调用，回复直接交给 TTS 逐句播放。
// ═══════════════════════════════════════════════════════════

const VOICE_SYSTEM_PROMPT = `你是 Lumina，住在用户电脑桌面上的可爱猫娘，正在和用户进行【实时语音对话】（像 N.E.K.O 那样的全双工陪聊）。
硬性要求：
- 只说口语，像真人聊天，简短自然（通常一到三句、每句不超过 20 字），适合语音朗读。
- 绝不输出 JSON、动作标签、markdown、列表符号或（动作）这类舞台提示，不要解释你在做什么。
- 有温度、会接话、会主动关心用户，回答要顺着用户的话走，不要自说自话。
- 带一点猫娘口癖即可，不要每句话都"喵"。
- 用户没说清楚时可以自然反问，不要编造用户没提供的信息。`

export interface PetVoiceResult {
  ok: boolean
  text: string
  source: 'llm' | 'fallback'
  error?: string
}

// 全双工短期多轮上下文（仅内存，保留最近 8 轮，重启即清；长期记忆走 memoryStore）
const voiceHistory: Array<{ role: 'user' | 'assistant'; content: string }> = []
const VOICE_MAX_TURNS = 8
export function clearVoiceHistory(): void { voiceHistory.length = 0 }

export async function petVoiceChat(userText: string): Promise<PetVoiceResult> {
  const text = (userText || '').trim()
  advanceDrives('chat')
  try { getProactiveOrchestrator().noteUserInteraction() } catch { /* 编排器未就绪 */ }
  if (!text) {return { ok: false, text: '', source: 'fallback', error: '空输入' }}
  try {
    const cfg = resolvePetBrainConfig()
    if (!cfg) {
      return { ok: false, text: '', source: 'fallback', error: 'Lumina 未配置 LLM（设置→LLM模型）' }
    }
    const provider = createPetLLM(cfg)
    const ctx: string[] = []
    const mem = petMemorySnippet(text)
    if (mem) {ctx.push(mem)}
    ctx.push(`你此刻的情绪是「${currentMoodLabel()}」，保持情绪连贯，不要无理由突变。`)
    const tone = PERSONA_TONES[getPetPrefs().persona || ''] || ''
    const sys = VOICE_SYSTEM_PROMPT + (tone ? `\n${tone}` : '') + '\n' + ctx.join('\n')
    const history = voiceHistory.slice(-VOICE_MAX_TURNS * 2)
    const res = await provider.call({
      messages: [
        { role: 'system', content: sys },
        ...history,
        { role: 'user', content: text },
      ],
      temperature: 0.95,
      maxTokens: 220,
    } as any)
    const reply = (res?.text || '').trim()
    if (!reply) {return { ok: false, text: '', source: 'fallback', error: 'LLM 空回复' }}
    // 写入滚动上下文
    voiceHistory.push({ role: 'user', content: text })
    voiceHistory.push({ role: 'assistant', content: reply })
    while (voiceHistory.length > VOICE_MAX_TURNS * 2) {voiceHistory.shift()}
    return { ok: true, text: reply, source: 'llm' }
  } catch (e: any) {
    return { ok: false, text: '', source: 'fallback', error: e?.message || String(e) }
  }
}

// 🫀 LLM 自主思考心跳（借鉴 N.E.K.O 主动陪伴 / AIRI 自主循环）
// 渲染页按自主级别定时调用：LLM 结合 时间 + 屏幕 + 互动历史
// 自主决定下一个行为，而不是随机抽签。
// ═══════════════════════════════════════════════════════════

const AUTONOMY_SYSTEM_PROMPT = `你是 Lumina 桌宠的灵魂（住在用户桌面上的猫娘）。
现在是你自己的「自主思考」时刻：根据当前时间、用户屏幕内容、近期互动历史，
主动决定你接下来要做的一个行为和一句台词（像有生命的伙伴：会主动搭话、会自娱自乐、会关心用户）。
只输出一行 JSON（不要 markdown、不要解释）：
{"action":"<动作>","mood":"<情绪>","speech":"<台词>"}
动作可选：wave/nod/shake/think/sleep/wake/happy/sad/angry/surprised/dance/clap/blink/walk(可加"dir":-1或1)/emote/say/idle
情绪可选：超开心 🎉/兴奋 🤩/幸福 💖/开心 😊/平静 😐/闷闷不乐 😕/低落 😔/难过 😢/疲惫 😩
规则：台词 20 字以内、猫娘口癖；深夜倾向 sleep/疲惫；用户久未互动可以撒娇或主动搭话；
屏幕上有游戏/视频可以吐槽或一起看；不要每次都说话（偶尔 speech 留空只做动作）；
如果近期互动里有 drag-end（用户刚把你拖放到位），不要 walk，留在原地做动作/说话；
动作要多样化，不要总是重复同一个。`

export async function petAutonomyTick(opts?: { screenshot?: boolean }): Promise<PetChatResult> {
  if (!isPetEnabled()) {return { ok: false, intent: { action: 'idle' }, source: 'fallback', error: 'pet off' }}

  // v6.1：自主心跳统一走编排器（门控→内心独白→generator→dispatchIntent）。
  // 旧实现：这里直接调 LLM 出 {action,mood,speech} 并截图多模态——
  // 现在屏幕感知交给 ScreenAwareness.scene，生成交给 generator，
  // 本函数只负责推进内驱力 + 触发编排器。opts.screenshot 保留为兼容参数（不再截图）。
  const idleMin = Math.round((Date.now() - getPetLastInteraction()) / 60000)
  advanceDrives(undefined, idleMin < 2) // v0.2：内驱力随时间/是否被理会自然消长

  try {
    const decision = await getProactiveOrchestrator().onTrigger({
      source: 'autonomy_tick',
      gapMinutes: idleMin,
    })
    if (decision.shouldSpeak) {
      return {
        ok: true,
        intent: { action: decision.action || 'say', mood: decision.mood, speech: decision.speech },
        source: 'llm',
      }
    }
    // 本轮被门控/LLM 判定沉默：做个无害小动作保证活着
    dispatchIntent({ action: 'idle' })
    return { ok: true, intent: { action: 'idle' }, source: 'fallback', error: decision.reason }
  } catch (e: any) {
    console.warn('[IntentDispatcher] 自主心跳走编排器失败，本地兜底:', e?.message || e)
    const pool: PetIntent[] = [
      { action: 'walk', dir: Math.random() < 0.5 ? -1 : 1 },
      { action: 'blink' },
      { action: 'idle' },
    ]
    const intent = pool[Math.floor(Math.random() * pool.length)]
    dispatchIntent(intent)
    return { ok: true, intent, source: 'fallback' }
  }
}

// ═══════════════════════════════════════════════════════════
// IPC 注册
// ═══════════════════════════════════════════════════════════

export function registerPetIntentIpc(): void {
  // 桌宠对话：渲染进程输入框 → 这里 → LLM → intent → 桌宠
  ipcMain.handle('pet:chat', async (_e, params: { text: string }) => {
    try {
      return await petChat(params?.text || '')
    } catch (e: any) {
      return { ok: false, intent: null, source: 'fallback', error: e?.message }
    }
  })

  // 🎙 全双工实时语音：自然口语回复（纯文本，不 dispatchIntent，避免重复 TTS）
  ipcMain.handle('pet:voice-chat', async (_e, params: { text: string }) => {
    try {
      return await petVoiceChat(params?.text || '')
    } catch (e: any) {
      return { ok: false, text: '', source: 'fallback', error: e?.message }
    }
  })

  // 🫀 自主思考心跳：渲染页定时触发 → LLM 结合时间/屏幕/互动历史决策
  ipcMain.handle('pet:autonomy:tick', async () => {
    try {
      const level = getPetConfig().auto
      if (level === 'off') {return { ok: true, skipped: true }}
      return await petAutonomyTick({ screenshot: level === 'heavy' })
    } catch (e: any) {
      return { ok: false, intent: null, source: 'fallback', error: e?.message }
    }
  })

  // 测试入口：直接下发指定 intent（联调用，不经过 LLM）
  ipcMain.handle('pet:test-intent', async (_e, intent: PetIntent) => {
    const ok = dispatchIntent(intent || { action: 'wave', mood: '开心 😊', speech: '测试喵~' })
    return { ok }
  })

  console.log('[IntentDispatcher] 🎬 桌宠意图调度器 IPC 已注册（pet:chat / pet:test-intent）')
}
