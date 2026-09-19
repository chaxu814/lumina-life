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

const ACTIONS = 'wave/nod/think/sleep/wake/happy/sad/dance/blink/walk/say/idle'

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

/** 从 LLM 原始输出里抠出 JSON */
function parseDecisionJson(raw: string): Partial<{ shouldSpeak: boolean; action: string; mood: string; speech: string; reason: string }> | null {
  if (!raw) return null
  try {
    const obj = JSON.parse(raw.trim())
    if (obj && typeof obj === 'object') return obj
  } catch { /* 继续 */ }
  const m = raw.match(/\{[\s\S]*?\}/)
  if (m) {
    try { return JSON.parse(m[0]) } catch { return null }
  }
  return null
}

/** 时段兜底模板（LLM 不可用时保证她还活着） */
function fallbackSpeech(source: ProactiveEvent['source'], hour: number): { speech: string; action: string; mood: string } {
  if (hour >= 23 || hour < 6) return { speech: '夜深了…我先眯一会儿喵…', action: 'sleep', mood: '疲惫 😩' }
  if (source === 'startup') {
    if (hour >= 6 && hour < 9) return { speech: '醒啦？早安喵~', action: 'wake', mood: '开心 😊' }
    return { speech: '嗨，又见面啦~', action: 'wave', mood: '开心 😊' }
  }
  if (source === 'drive_hard') return { speech: '理理我嘛喵…', action: 'wave', mood: '开心 😊' }
  if (source === 'hot_topic') return { speech: '刚才刷到个有意思的事…', action: 'say', mood: '平静 😐' }
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
  if (event.screenSummary) parts.push(`屏幕上在：${event.screenSummary}`)
  if (event.externalTopics?.length) parts.push(`外部话题：${event.externalTopics.slice(0, 3).join('、')}`)
  if (ctx.gapMinutes !== undefined) parts.push(`距上次互动/离线 ${ctx.gapMinutes} 分钟。`)
  if (ctx.innerThought) parts.push(`你刚才在心里想：${ctx.innerThought}（据此选语气，但不要直接念出来）`)
  if (ctx.unfinishedQuestion) parts.push(`【必须接续】你上次问了：「${ctx.unfinishedQuestion}」`)
  if (ctx.followups.length) parts.push(`可以自然提起的旧事：${ctx.followups.slice(0, 3).join('；')}`)
  if (ctx.memorySnippet) parts.push(`记忆：${ctx.memorySnippet.slice(0, 300)}`)
  if (ctx.recentSpeeches.length) parts.push(`最近说过（别重复）：${ctx.recentSpeeches.slice(-6).join(' / ')}`)
  parts.push(`你的内驱力：精力${ctx.drives.energy.toFixed(2)} 社交${ctx.drives.social.toFixed(2)}。`)
  parts.push('请决定这一句话（或沉默）。')

  // ── 调 LLM ─────────────────────────────────────
  let raw = ''
  try {
    raw = await chatComplete({
      system: SYSTEM_PROMPT,
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
      action: typeof parsed.action === 'string' && parsed.action ? parsed.action : 'say',
      speech: parsed.speech.trim().slice(0, 40),
      mood: finalMood, // 连续态覆盖 LLM 建议
      reason: `llm:${event.source}`,
    }
  }

  // ── 兜底：模板 ─────────────────────────────────
  const fb = fallbackSpeech(event.source, hour)
  return {
    shouldSpeak: true,
    action: fb.action,
    speech: fb.speech,
    mood: fb.mood,
    reason: `fallback:${event.source}`,
  }
}
