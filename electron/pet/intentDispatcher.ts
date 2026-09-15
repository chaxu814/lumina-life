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

// 🫀 连续情绪融合单例：LLM 每帧输出的离散 mood 经此平滑，避免情绪瞬切（详见 emotionFusion.ts）
const petEmotion = new PetEmotionFusion()

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
function buildIntentPrompt(): string {
  const prefs = getPetPrefs()
  const tone = PERSONA_TONES[prefs.persona || ''] || ''
  const cp = prefs.catpaw || {}
  const operateOn = !!(cp.master && cp.kbm)
  const operateLine = operateOn
    ? `\nLumina Pet Handling 已开启：当用户明确要求操作电脑时，可额外输出 "cu" 字段，如 {"action":"operate","cu":{"type":"open_app","params":{"app":"notepad"}}}（type 仅限 open_app/keypress/type/wait）。`
    : `\nLumina Pet Handling 未开启：不要输出 operate/cu，用户要操作电脑时用 speech 撒娇说还没拿到权限喵。`
  return INTENT_SYSTEM_PROMPT + (tone ? `\n${tone}` : '') + operateLine
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
    if (r.test.test(text)) return { ...r.intent }
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
  if (!raw) return null
  // 1. 直接解析
  try {
    const obj = JSON.parse(raw.trim())
    if (obj && typeof obj.action === 'string') return obj as PetIntent
  } catch { /* 继续 */ }
  // 2. 提取第一个 {...}
  const m = raw.match(/\{[\s\S]*?\}/)
  if (m) {
    try {
      const obj = JSON.parse(m[0])
      if (obj && typeof obj.action === 'string') return obj as PetIntent
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
  if (recentIntents.length > 6) recentIntents.shift()
  // 连续情绪融合：LLM 逐帧离散 mood 经平滑后再下发，避免上一句笑下一句哭的硬切
  if (intent.mood) intent.mood = petEmotion.next(intent.mood).label
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
          { role: 'system', content: buildIntentPrompt() },
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
  if (!isPetEnabled()) return { ok: false, intent: { action: 'idle' }, source: 'fallback', error: 'pet off' }

  // ── 组装上下文 ─────────────────────────────────
  const now = new Date()
  const week = ['日', '一', '二', '三', '四', '五', '六'][now.getDay()]
  const idleMin = Math.round((Date.now() - getPetLastInteraction()) / 60000)
  const evts = getPetRecentEvents()
  const recent = evts.length ? evts.map(e => e.type).slice(-8).join(',') : '无'
  const myRecent = recentIntents.length ? recentIntents.map(i => i.action).join(',') : '无'
  let userContent = `当前：周${week} ${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}；近期互动：${recent}；距上次互动 ${idleMin} 分钟；你最近做过：${myRecent}（别重复，保持自然连贯）。请决定你的下一个行为。`

  // 重度模式附加屏幕快照（多模态）
  let images: string[] | undefined
  if (opts?.screenshot) {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 640, height: 360 } })
      if (sources[0]) images = [sources[0].thumbnail.toDataURL()]
    } catch { /* 截屏失败不影响决策 */ }
  }

  // ── 尝试 LLM ──────────────────────────────────
  try {
    const cfg = resolvePetBrainConfig()
    if (cfg) {
      const provider = createPetLLM(cfg)
      const sysContent = AUTONOMY_SYSTEM_PROMPT + (PERSONA_TONES[getPetPrefs().persona || ''] || '')
      let res = await provider.call({
        messages: [
          { role: 'system', content: sysContent },
          { role: 'user', content: userContent, images },
        ],
        temperature: 1.0,
        maxTokens: 150,
      } as any)
      let intent = parseIntentJson(res?.text || '')
      // 带截图调用失败（纯文本模型）→ 去掉图片，仅凭时间/互动历史再决策一次
      if (!intent && images && images.length) {
        try {
          res = await provider.call({
            messages: [
              { role: 'system', content: sysContent },
              { role: 'user', content: userContent + '（你看不到屏幕，请只根据时间和互动历史决定行为）' },
            ],
            temperature: 1.0, maxTokens: 150,
          } as any)
          intent = parseIntentJson(res?.text || '')
        } catch { /* 继续降级 */ }
      }
      if (intent) {
        dispatchIntent(intent)
        return { ok: true, intent, source: 'llm' }
      }
    }
  } catch (e: any) {
    console.warn('[IntentDispatcher] 自主心跳 LLM 失败:', e?.message || e)
  }

  // ── 降级：本地随机行为（保证活着）──────────────
  const pool: PetIntent[] = [
    { action: 'walk', dir: Math.random() < 0.5 ? -1 : 1 },
    { action: 'blink' },
    { action: 'wave', speech: '喵~' },
    { action: 'say', speech: '尾巴摇啊摇~' },
    { action: 'think' },
    { action: 'idle' },
  ]
  const intent = pool[Math.floor(Math.random() * pool.length)]
  dispatchIntent(intent)
  return { ok: true, intent, source: 'fallback' }
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

  // 🫀 自主思考心跳：渲染页定时触发 → LLM 结合时间/屏幕/互动历史决策
  ipcMain.handle('pet:autonomy:tick', async () => {
    try {
      const level = getPetConfig().auto
      if (level === 'off') return { ok: true, skipped: true }
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
