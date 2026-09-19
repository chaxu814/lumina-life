// ============================================================
// proactive/innerThoughts.ts — 🧠 内心独白（不说出口的潜台词）
//
// 真人朋友在开口前，心里其实已经转了一圈：「他怎么又在打游戏，
// 今天都没吃饭吧…」这种潜台词不需要说出来，但它决定了开口的语气。
// 这里让小模型花 5~15 字写下她此刻心里在想什么，
// 作为 generator 的「情绪基调」输入，失败就返回空串（不影响主流程）。
// ============================================================

import { chatComplete } from './resolveProactiveLLM'

export interface InnerThoughtContext {
  /** 现在时段（上午/下午/晚上/深夜） */
  timeOfDay: string
  /** 当前内驱力快照 */
  drives: { energy: number; social: number; curiosity: number; comfort: number }
  /** 当前情绪标签 */
  mood: string
  /** 最近发生的一件事（屏幕场景/外部话题一句话） */
  recentEvent: string
  /** 记忆片段（近期回忆/事实摘要） */
  memorySnippet: string
}

/** 生成一句 5~15 字的内心独白；失败返回空串 */
export async function generateInnerThoughts(ctx: InnerThoughtContext): Promise<string> {
  try {
    const system = `你是 Lumina 桌宠（猫娘）此刻的内心独白生成器。
根据她当前的状态，用 5~15 个汉字、第一人称、写她此刻心里在想什么（不要说出口的那种潜台词）。
要求：
- 只输出那句话本身，不要引号、不要解释、不要表情符号
- 像真人内心 OS：可以是「他又忘了吃饭…」「好想被摸摸」「今天有点累」
- 不要客服腔、不要「我在哦」这种废话`
    const user = `时段：${ctx.timeOfDay}
情绪：${ctx.mood}
内驱力：精力${ctx.drives.energy.toFixed(2)} 社交${ctx.drives.social.toFixed(2)} 好奇${ctx.drives.curiosity.toFixed(2)} 安心${ctx.drives.comfort.toFixed(2)}
最近的事：${ctx.recentEvent || '无'}
记忆片段：${ctx.memorySnippet || '无'}
请写她此刻的内心独白：`
    const raw = (await chatComplete({
      system,
      user,
      maxTokens: 40,
      temperature: 0.9,
    })).trim()
    if (!raw) {return ''}
    // 清洗：去引号/换行/多余标点，限长
    const cleaned = raw.replace(/[""'「」\n\r]/g, '').trim()
    return cleaned.slice(0, 30)
  } catch {
    return ''
  }
}
