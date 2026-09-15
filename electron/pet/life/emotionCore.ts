// ============================================================
// pet/life/emotionCore.ts — 🫀 统一情绪核心 (v0.2「生命感」升级)
//
// 项目里原本有三套互不相通的情绪表示：
//   - 团队五维 AgentState.emotion {joy,fatigue,focus,anxiety,curiosity}
//   - 前端三维 AgentEmotion {mood(-1~1), energy, affinity}
//   - 桌宠 9 个离散 mood 标签（+ emotionFusion 的 valence/arousal 连续态）
// 本模块是它们之间的「权威换算层」：内部统一为 valence/arousal + 五维 + affinity，
// 任意一套表示都能进来、任意一套表示都能出去，身体与大脑从此共享同一份情绪。
//
// 纯 TS、零依赖（不引用 Electron / DOM / pixi），主进程与渲染运行时同构可用。
// ============================================================

/** 桌宠 9 个标准情绪标签（与 intentDispatcher / 渲染层协议一致） */
export type MoodLabel =
  | '超开心 🎉' | '兴奋 🤩' | '幸福 💖' | '开心 😊' | '平静 😐'
  | '闷闷不乐 😕' | '低落 😔' | '难过 😢' | '疲惫 😩'

/** 统一情绪核心状态 */
export interface CoreEmotion {
  /** 效价 -1(极糟) ~ +1(极好) */
  valence: number
  /** 唤醒度 0(沉寂) ~ 1(亢奋) */
  arousal: number
  // ── 团队五维（0~1）──
  joy: number
  /** 疲劳度 0(精神) ~ 1(累趴) */
  fatigue: number
  focus: number
  anxiety: number
  curiosity: number
  /** 对用户的亲近度 0~1（来自关系/前端三维） */
  affinity: number
}

export interface TeamFive {
  joy: number
  fatigue: number
  focus: number
  anxiety: number
  curiosity: number
}

export interface FrontendThree {
  /** -1 ~ 1 */
  mood: number
  /** 0 ~ 1 */
  energy: number
  /** 0 ~ 1 */
  affinity: number
}

const clamp = (x: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, x))

/** 9 情绪在连续平面上的权威坐标（valence, arousal），单一事实源 */
export const MOOD_COORDS: Record<MoodLabel, { v: number; a: number }> = {
  '超开心 🎉': { v: 0.95, a: 0.92 },
  '兴奋 🤩': { v: 0.82, a: 0.95 },
  '幸福 💖': { v: 0.8, a: 0.42 },
  '开心 😊': { v: 0.6, a: 0.62 },
  '平静 😐': { v: 0.05, a: 0.4 },
  '闷闷不乐 😕': { v: -0.42, a: 0.38 },
  '低落 😔': { v: -0.62, a: 0.26 },
  '难过 😢': { v: -0.82, a: 0.32 },
  '疲惫 😩': { v: -0.3, a: 0.12 },
}

const MOOD_LIST = Object.keys(MOOD_COORDS) as MoodLabel[]

/** 容忍 LLM 漏 emoji / 措辞差异，归一到标准标签 */
export function normalizeMood(raw: unknown): MoodLabel | null {
  if (typeof raw !== 'string') return null
  const t = raw.trim()
  if (!t) return null
  if ((MOOD_LIST as string[]).includes(t)) return t as MoodLabel
  const table: Array<[MoodLabel, string[]]> = [
    ['超开心 🎉', ['超开心', '超级开心']],
    ['兴奋 🤩', ['兴奋', '激动']],
    ['幸福 💖', ['幸福', '满足', '安心', '温馨']],
    ['开心 😊', ['开心', '高兴', '快乐', '愉快']],
    ['平静 😐', ['平静', '一般', '正常', '中性']],
    ['闷闷不乐 😕', ['闷闷不乐', '郁闷', '不开心', '烦']],
    ['低落 😔', ['低落', '失落', '沮丧', '委屈']],
    ['难过 😢', ['难过', '伤心', '哭', '悲伤']],
    ['疲惫 😩', ['疲惫', '累', '困', '倦', '无力']],
  ]
  for (const [label, keys] of table) {
    if (keys.some(k => t.includes(k))) return label
  }
  return null
}

/** 团队五维 → 统一核心（启发式加权，疲劳压低唤醒、焦虑拉低效价） */
export function teamFiveToCore(five: Partial<TeamFive>, affinity = 0.5): CoreEmotion {
  const joy = clamp(five.joy ?? 0.5)
  const fatigue = clamp(five.fatigue ?? 0.3)
  const focus = clamp(five.focus ?? 0.5)
  const anxiety = clamp(five.anxiety ?? 0.2)
  const curiosity = clamp(five.curiosity ?? 0.5)
  const valence = clamp(joy * 1.05 - anxiety * 0.9 - fatigue * 0.35, -1, 1)
  const arousal = clamp((joy * 0.5 + curiosity * 0.55 + focus * 0.25 + anxiety * 0.35) * (1 - fatigue * 0.6))
  return { valence, arousal, joy, fatigue, focus, anxiety, curiosity, affinity: clamp(affinity) }
}

/** 前端三维 → 统一核心 */
export function frontendThreeToCore(t: FrontendThree): CoreEmotion {
  const valence = clamp(t.mood, -1, 1)
  const arousal = clamp(t.energy)
  const joy = clamp((t.mood + 1) / 2)
  return {
    valence,
    arousal,
    joy,
    fatigue: clamp(1 - t.energy),
    focus: 0.5,
    anxiety: clamp(-t.mood * 0.5),
    curiosity: 0.5,
    affinity: clamp(t.affinity),
  }
}

/** 离散情绪标签 → 统一核心（坐标 + 启发式五维） */
export function moodToCore(label: MoodLabel, affinity = 0.5): CoreEmotion {
  const { v, a } = MOOD_COORDS[label]
  return {
    valence: v,
    arousal: a,
    joy: clamp((v + 1) / 2),
    fatigue: label === '疲惫 😩' ? 0.85 : clamp(1 - a * 1.1),
    focus: label === '平静 😐' ? 0.65 : clamp(a * 0.6 + 0.25),
    anxiety: v < -0.4 ? clamp(-v * (0.5 + a * 0.4)) : clamp(a > 0.85 ? 0.2 : 0.08),
    curiosity: a > 0.8 ? 0.85 : clamp(a * 0.7),
    affinity: clamp(affinity),
  }
}

function dist(v: number, a: number, p: { v: number; a: number }): number {
  return Math.abs(v - p.v) + 2 * Math.abs(a - p.a)
}

/** 统一核心 → 最近的离散情绪标签；带迟滞避免在边界抖动 */
export function coreToMood(core: Pick<CoreEmotion, 'valence' | 'arousal'>, current?: MoodLabel | null, hysteresis = 0.06): MoodLabel {
  let best: MoodLabel = '平静 😐'
  let bestD = Infinity
  for (const label of MOOD_LIST) {
    const d = dist(core.valence, core.arousal, MOOD_COORDS[label])
    if (d < bestD) { bestD = d; best = label }
  }
  if (current && current !== best) {
    const cur = MOOD_COORDS[current]
    if (cur && dist(core.valence, core.arousal, cur) <= bestD + hysteresis) return current
  }
  return best
}

/** 线性融合两个核心状态（t=0 完全 a，t=1 完全 b），供平滑/插值复用 */
export function blendCore(a: CoreEmotion, b: CoreEmotion, t: number): CoreEmotion {
  const k = clamp(t)
  const keys: (keyof CoreEmotion)[] = ['valence', 'arousal', 'joy', 'fatigue', 'focus', 'anxiety', 'curiosity', 'affinity']
  const out = { ...a }
  for (const key of keys) {
    const lo = key === 'valence' ? -1 : 0
    ;(out as any)[key] = clamp(a[key] + (b[key] - a[key]) * k, lo, 1)
  }
  return out
}
