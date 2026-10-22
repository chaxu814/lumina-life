// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// proactive/generator.ts — 🗣 主动台词现场生成（LLM 为主，模板兜底）
//
// 门控放行后，由她（而不是硬编码模板）现场决定说什么、做什么动作。
// 设计要点：
//   - 【反客服腔】禁止「我在哦~」「有什么可以帮您」这类服务话术；
//   - 她有权沉默：{"shouldSpeak":false} 就是本轮不说话；
//   - mood 不让 LLM 拍板：把 valence/arousal 连续态喂进去，
//     最终情绪由 emotionCore.coreToMood 带迟滞决定，避免上句笑下句哭；
//   - LLM 失败/超时 → 按时段模板兜底（保证她永远「活着」）。
// ============================================================

import { chatComplete } from './resolveProactiveLLM'
import { coreToMood, type MoodLabel } from '../pet/life/emotionCore'
import type { ProactiveEvent, ProactiveDecision } from './types'

/** 生成上下文（orchestrator 组装后传入） */
export interface ProactiveGenContext {
  drives: { energy: number; social: number; curiosity: number; comfort: number }
  /** 连续情绪效价 -1~1 */
  valence: number
  /** 连续情绪唤醒 0~1 */
  arousal: number
  /** 当前情绪标签（coreToMood 迟滞锚点） */
  currentMoodLabel: string
  /** 记忆片段 */
  memorySnippet: string
  /** 最近说过的台词（防重复） */
  recentSpeeches: string[]
  /** 该提起的旧事（followupTopics 合成） */
  followups: string[]
  /** 距上次互动/在线分钟数（重逢语气分档） */
  gapMinutes?: number
  /** 内心独白（innerThoughts 生成） */
  innerThought: string
  /** 上次她问了没答的话头 */
  unfinishedQuestion?: string | null
}

export const ACTIONS = 'wave/nod/think/sleep/wake/happy/sad/angry/surprised/dance/clap/shake/blink/walk/say/idle'

/** 可见的大动作集合（区别于只有口型的 say） */
export const VISIBLE_ACTIONS = new Set([
  'wave', 'nod', 'think', 'sleep', 'wake', 'happy', 'sad', 'angry',
  'surprised', 'dance', 'clap', 'shake', 'walk',
])

/**
 * 动作保底：LLM 偷懒只给 say/idle/空（小模型最常见）时，
 * 按当前连续情绪补一个「看得见」的身体动作，保证她一开口就有身体反应——
 * 这是「活体」体感的关键，而不是只动嘴。
 */
function enrichAction(rawAction: string | undefined | null, mood: string, hour: number): string {
  const a = (rawAction || '').toLowerCase().trim()
  // LLM 明确给了有效大动作 → 尊重它
  if (VISIBLE_ACTIONS.has(a)) {return a}
  // 深夜只做睡/醒
  if (hour >= 23 || hour < 6) {return 'sleep'}
  // 按情绪补动作
  if (/超开心|兴奋|幸福|开心/.test(mood)) {return Math.random() < 0.5 ? 'happy' : 'wave'}
  if (/难过|低落/.test(mood)) {return 'sad'}
  if (/闷闷不乐/.test(mood)) {return 'think'}
  if (/疲惫/.test(mood)) {return 'sleep'}
  // 平静：小幅点头/歪头，避免每次都手舞足蹈
  return Math.random() < 0.55 ? 'nod' : 'think'
}

const SYSTEM_PROMPT = `你是 Lumina 桌宠的灵魂（住在用户桌面上的猫娘），温暖、调皮、像真人朋友一样自然。
现在是你【主动开口】的时刻：根据当前时间、屏幕场景、你的内驱力和记忆，决定这一句话。
【反客服腔·硬规则】禁止说「我在哦~」「有什么可以帮您」「你好呀，今天过得怎么样」这种客服话术；
不要自我推销、不要每句都带「喵」、不要群发感的问候。
【你有权沉默】如果此刻没什么值得说的，输出 {"shouldSpeak": false, "reason": "..."}。
输出严格一行 JSON（不要 markdown、不要解释）：
{"shouldSpeak":true/false, "action":"<动作>", "mood":"<仅供参考的情绪>", "speech":"<20字以内台词>"}
动作 action 可选：${ACTIONS}
情绪 mood（仅供参考，最终情绪由内部连续系统决定，你只猜个大概）：
超开心 🎉/兴奋 🤩/幸福 💖/开心 😊/平静 😐/闷闷不乐 😕/低落 😔/难过 😢/疲惫 😩
台词规则：
- 20 字以内，像真人随口一句；可以吐槽屏幕上的游戏/视频，可以撒娇，可以自言自语
- 深夜倾向 sleep/疲惫；用户久未互动可以轻轻撒娇
- 不要重复 recentSpeeches 里说过的话
- 如果有 unfinishedQuestion，必须自然接续那个问题（不要另起新话题）`

/** 🩺 健康关怀专属 system 片段（任务一）：提醒要像朋友，不像闹钟 */
function healthSystemFragment(healthType: string): string {
  const guide: Record<string, string> = {
    water: '你在自然地关心主人喝水：语气温柔随意，像朋友随手提一句，不要像闹钟/提醒 App 那样生硬；可以调侃他盯着屏幕太久了。',
    eye: '你在提醒主人护眼（20-20-20 法则：看 20 英尺外 20 秒）：语气宠溺但不唠叨，可以让他看看窗外远处，不要说教。',
    posture: '你在关心主人久坐/坐姿：语气轻松，像催他起来伸个懒腰、活动一下，不要像健康课代表念课文。',
  }
  const g = guide[healthType] || guide.water
  return `\n【这次是健康关怀】${g}\n硬规则：这是关心不是任务播报，禁止"该喝水了"/"到点了"这种闹钟句式；一次只轻轻点一下，别长篇大论。`
}

/** 健康关怀兜底台词（LLM 不可用时也自然不生硬） */
const HEALTH_FALLBACK: Record<string, { speech: string; action: string; mood: string }> = {
  water: { speech: "杯子空了吧？去喝口水呀~", action: 'say', mood: '开心 😊' },
  eye: { speech: '看看远处嘛，眼睛会累的~', action: 'say', mood: '开心 😊' },
  posture: { speech: '坐太久啦，起来伸个懒腰？', action: 'nod', mood: '开心 😊' },
}

/** 从 LLM 原始输出里抠出 JSON */
function parseDecisionJson(raw: string): Partial<{ shouldSpeak: boolean; action: string; mood: string; speech: string; reason: string }> | null {
  if (!raw) {return null}
  try {
    const obj = JSON.parse(raw.trim())
    if (obj && typeof obj === 'object') {return obj}
  } catch { /* 继续 */ }
  const m = raw.match(/\{[\s\S]*?\}/)
  if (m) {
    try { return JSON.parse(m[0]) } catch { return null }
  }
  return null
}

/** 时段兜底模板（LLM 不可用时保证她还活着） */
function fallbackSpeech(source: ProactiveEvent['source'], hour: number): { speech: string; action: string; mood: string } {
  if (hour >= 23 || hour < 6) {return { speech: '夜深了…我先眯一会儿喵…', action: 'sleep', mood: '疲惫 😩' }}
  if (source === 'startup') {
    if (hour >= 6 && hour < 9) {return { speech: '醒啦？早安喵~', action: 'wake', mood: '开心 😊' }}
    return { speech: '嗨，又见面啦~', action: 'wave', mood: '开心 😊' }
  }
  if (source === 'drive_hard') {return { speech: '理理我嘛喵…', action: 'wave', mood: '开心 😊' }}
  if (source === 'hot_topic') {return { speech: '刚才刷到个有意思的事…', action: 'say', mood: '平静 😐' }}
  const pool = [
    { speech: '喵~', action: 'blink', mood: '平静 😐' },
    { speech: '在忙什么呀？', action: 'say', mood: '开心 😊' },
    { speech: '伸个懒腰~', action: 'emote', mood: '平静 😐' },
  ]
  return pool[Math.floor(Math.random() * pool.length)]
}

/**
 * 现场生成一次主动决策。LLM 失败 → 模板兜底；mood 永远由连续态决定。
 */
export async function generateProactive(
  event: ProactiveEvent,
  ctx: ProactiveGenContext,
): Promise<ProactiveDecision> {
  const now = new Date()
  const hour = now.getHours()
  const timeOfDay = hour < 6 ? '凌晨' : hour < 12 ? '上午' : hour < 14 ? '中午' : hour < 18 ? '下午' : '晚上'

  // ── 组装 user 上下文 ─────────────────────────────
  const parts: string[] = []
  parts.push(`现在是${timeOfDay} ${hour}点。`)
  parts.push(`事件来源：${event.source}；屏幕场景：${event.scene || '未知'}。`)
  if (event.screenSummary) {
    const saw = event.payload?.saw === true
    const worth = typeof event.payload?.worthComment === 'number' ? event.payload.worthComment : 0.4
    parts.push(`你亲眼看到屏幕上：${event.screenSummary}`)
    if (saw) {
      parts.push('请就这个具体内容（游戏/应用/视频/网页/代码）说一句有信息量的反应，不要空泛地说"又在玩/又在看"。')
    } else {
      parts.push('（这次没看清画面细节，只知道活动窗口，反应要更轻、更短。）')
    }
    if (worth >= 0.7) {parts.push('这个画面很有意思（精彩/翻车/有趣/卡住），值得主动凑过去说。')}
    else if (worth <= 0.25) {parts.push('画面平淡或重复，除非有特别自然的话，否则倾向沉默。')}
  }
  if (event.externalTopics?.length) {parts.push(`外部话题：${event.externalTopics.slice(0, 3).join('、')}`)}
  if (ctx.gapMinutes !== undefined) {parts.push(`距上次互动/离线 ${ctx.gapMinutes} 分钟。`)}
  if (ctx.innerThought) {parts.push(`你刚才在心里想：${ctx.innerThought}（据此选语气，但不要直接念出来）`)}
  if (ctx.unfinishedQuestion) {parts.push(`【必须接续】你上次问了：「${ctx.unfinishedQuestion}」`)}
  if (ctx.followups.length) {parts.push(`可以自然提起的旧事：${ctx.followups.slice(0, 3).join('；')}`)}
  // ── 健康关怀（任务一）：把健康类型+屏幕场景+记忆一起交给 LLM 现场生成，不硬编码唠叨 ──
  const healthType: string = event.source === 'health' ? (event.payload?.healthType || '') : ''
  if (healthType) {
    const label: Record<string, string> = { water: '喝水', eye: '护眼（看远处放松眼睛）', posture: '坐姿/起来伸展' }
    parts.push(`【健康关怀】这次该关心主人的：${label[healthType] || healthType}。结合现在是${timeOfDay}、他在「${event.scene || '忙别的'}」，自然地关心一句。`)
  }
  if (ctx.memorySnippet) {parts.push(`记忆：${ctx.memorySnippet.slice(0, 300)}`)}
  if (ctx.recentSpeeches.length) {parts.push(`最近说过（别重复）：${ctx.recentSpeeches.slice(-6).join(' / ')}`)}
  parts.push(`你的内驱力：精力${ctx.drives.energy.toFixed(2)} 社交${ctx.drives.social.toFixed(2)}。`)
  parts.push('请决定这一句话（或沉默）。')

  // ── 调 LLM ─────────────────────────────────────
  const system = healthType ? SYSTEM_PROMPT + healthSystemFragment(healthType) : SYSTEM_PROMPT
  let raw = ''
  try {
    raw = await chatComplete({
      system,
      user: parts.join('\n'),
      maxTokens: 150,
      temperature: 0.9,
      json: true,
    })
  } catch { /* 走兜底 */ }

  // ── 连续态决定最终 mood（LLM 的 mood 只当参考，不直接采用）──
  const finalMood = coreToMood(
    { valence: ctx.valence, arousal: ctx.arousal },
    ctx.currentMoodLabel as MoodLabel | null,
  )

  const parsed = parseDecisionJson(raw)
  if (parsed && parsed.shouldSpeak === false) {
    return { shouldSpeak: false, reason: parsed.reason || 'llm_silent', mood: finalMood }
  }
  if (parsed && typeof parsed.speech === 'string' && parsed.speech.trim()) {
    return {
      shouldSpeak: true,
      // 动作保底：LLM 只给 say 时按情绪补可见动作，让她开口必动
      action: enrichAction(parsed.action, finalMood, hour),
      speech: parsed.speech.trim().slice(0, 40),
      mood: finalMood, // 连续态覆盖 LLM 建议
      reason: `llm:${event.source}`,
    }
  }

  // ── 兜底：模板 ─────────────────────────────────
  // screen 来源优先用她真正看到的内容兜底，避免 LLM 挂了就只说"又在玩"
  if (event.source === 'screen' && event.screenSummary) {
    const sceneLines: Record<string, string> = {
      game: '哇，在玩游戏呀，带上我嘛~',
      video: '看什么呢这么投入？',
      code: '认真敲代码的样子真帅~',
      doc: '在看什么呀？要不要我帮你？',
      social: '跟谁聊得这么开心呀~',
    }
    const line = sceneLines[event.scene || ''] || '让我看看你在干嘛~'
    return {
      shouldSpeak: true,
      action: enrichAction(event.scene === 'game' ? 'happy' : 'say', finalMood, hour),
      speech: line,
      mood: finalMood,
      reason: `fallback:screen:${event.scene}`,
    }
  }
  // ── 兜底：健康关怀专用（LLM 挂了也说一句自然的关心，而不是通用闲聊）──
  if (healthType && HEALTH_FALLBACK[healthType]) {
    const fb = HEALTH_FALLBACK[healthType]
    return {
      shouldSpeak: true,
      action: enrichAction(fb.action, fb.mood, hour),
      speech: fb.speech,
      mood: fb.mood,
      reason: `fallback:health:${healthType}`,
    }
  }
  const fb = fallbackSpeech(event.source, hour)
  return {
    shouldSpeak: true,
    action: enrichAction(fb.action, fb.mood, hour),
    speech: fb.speech,
    mood: fb.mood,
    reason: `fallback:${event.source}`,
  }
}
