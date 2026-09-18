// ============================================================
// pet/emotionFusion.ts — 🫀 连续情绪融合层 (v0.1)
//
// 问题：桌宠情绪此前由 LLM 每帧独立输出一个离散 mood 标签，
//       于是会出现「上一句超开心、被怼后下一句瞬间难过」的硬切，
//       情绪没有余韵、不像活着。
//
// 本模块做的事：
//   1) 把 9 个离散 mood 标签映射到连续情绪空间 (valence, arousal)；
//   2) 用 EMA 惯性 + 单步变化率限制，把「目标情绪」平滑地拉向当前情绪；
//   3) 用迟滞（hysteresis）反查输出标签，避免在两个标签边界来回抖动；
//   4) 没有新情绪输入时，可向基线（平静）缓慢回归。
//
// 设计为纯 TS、不依赖 Electron，便于单元测试。
// ============================================================

/** 连续情绪状态：valence 效价(-1 负 ~ +1 正)，arousal 唤醒度(0 低 ~ 1 高) */
export interface EmotionState {
  v: number
  a: number
  /** 当前对外输出的标准 mood 标签（与 intentDispatcher 的 9 个标签一致） */
  label: string
}

export interface FusionOptions {
  /** EMA 惯性系数 0~1：越小越「慢热/有余韵」，默认 0.35 */
  alpha?: number
  /** 单步效价最大变化量，默认 0.18 */
  maxStepV?: number
  /** 单步唤醒度最大变化量，默认 0.18 */
  maxStepA?: number
  /** 标签迟滞余量：新标签要比当前标签近这么多才切换，默认 0.06（防抖） */
  hysteresis?: number
  /** 无输入时每步向基线回归的比例，默认 0.05 */
  baselineDrift?: number
}

interface MoodPoint {
  label: string
  v: number
  a: number
  /** 关键字（容忍 LLM 漏 emoji / 措辞差异） */
  keywords: string[]
}

// 顺序很重要：更具体的「超开心」要在「开心」之前参与关键字匹配
const MOOD_POINTS: MoodPoint[] = [
  { label: '超开心 🎉', v: 0.95, a: 0.92, keywords: ['超开心', '超级开心'] },
  { label: '兴奋 🤩', v: 0.82, a: 0.95, keywords: ['兴奋', '激动'] },
  { label: '幸福 💖', v: 0.8, a: 0.42, keywords: ['幸福', '满足', '安心'] },
  { label: '开心 😊', v: 0.6, a: 0.62, keywords: ['开心', '高兴', '快乐'] },
  { label: '平静 😐', v: 0.05, a: 0.4, keywords: ['平静', '一般', '正常'] },
  { label: '闷闷不乐 😕', v: -0.42, a: 0.38, keywords: ['闷闷不乐', '郁闷', '不开心'] },
  { label: '低落 😔', v: -0.62, a: 0.26, keywords: ['低落', '失落', '沮丧'] },
  { label: '难过 😢', v: -0.82, a: 0.32, keywords: ['难过', '伤心', '哭'] },
  { label: '疲惫 😩', v: -0.3, a: 0.12, keywords: ['疲惫', '累', '困', '倦'] },
]

/** 基线情绪（平静） */
export const BASELINE: EmotionState = { v: 0.05, a: 0.4, label: '平静 😐' }

const DEFAULTS: Required<FusionOptions> = {
  alpha: 0.35,
  maxStepV: 0.18,
  maxStepA: 0.18,
  hysteresis: 0.06,
  baselineDrift: 0.05,
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x))
}

/** 把 LLM 原始 mood 文本归一到标准标签；无法识别返回 null */
export function normalizeMoodLabel(raw: string | undefined | null): string | null {
  if (!raw) return null
  const text = String(raw).trim()
  if (!text) return null
  // 1) 精确等于标准标签
  const exact = MOOD_POINTS.find(p => text === p.label)
  if (exact) return exact.label
  // 2) 关键字包含（按声明顺序，避免「开心」抢先匹配「超开心」）
  for (const p of MOOD_POINTS) {
    if (p.keywords.some(k => text.includes(k))) return p.label
  }
  return null
}

function pointOf(label: string): MoodPoint | undefined {
  return MOOD_POINTS.find(p => p.label === label)
}

function dist(v: number, a: number, p: MoodPoint): number {
  // 效价量纲 -1~1、唤醒 0~1，唤醒差乘 2 拉到同量纲
  return Math.abs(v - p.v) + 2 * Math.abs(a - p.a)
}

/** 带迟滞地反查最近标签 */
function nearestLabelWithHysteresis(v: number, a: number, currentLabel: string, hysteresis: number): string {
  let best = BASELINE.label
  let bestD = Infinity
  for (const p of MOOD_POINTS) {
    const d = dist(v, a, p)
    if (d < bestD) { bestD = d; best = p.label }
  }
  if (currentLabel && currentLabel !== best) {
    const cur = pointOf(currentLabel)
    if (cur) {
      const curD = dist(v, a, cur)
      // 当前标签没有明显更差（差距小于迟滞余量）就保持，防止抖动
      if (curD <= bestD + hysteresis) return currentLabel
    }
  }
  return best
}

/**
 * 单步融合（纯函数）：给定上一状态与本次 LLM 目标情绪，返回下一状态。
 * 目标标签无法识别时，状态保持不变（不做猜测）。
 */
export function fuseEmotionStep(
  prev: EmotionState,
  rawTargetLabel: string | undefined | null,
  options?: FusionOptions,
): EmotionState {
  const opt = { ...DEFAULTS, ...(options || {}) }
  const targetLabel = normalizeMoodLabel(rawTargetLabel)
  if (!targetLabel) return { ...prev }

  const target = pointOf(targetLabel)!
  // 1) EMA 惯性
  let nv = prev.v + opt.alpha * (target.v - prev.v)
  let na = prev.a + opt.alpha * (target.a - prev.a)
  // 2) 单步变化率限制（情绪不能瞬变）
  nv = prev.v + clamp(nv - prev.v, -opt.maxStepV, opt.maxStepV)
  na = prev.a + clamp(na - prev.a, -opt.maxStepA, opt.maxStepA)
  nv = clamp(nv, -1, 1)
  na = clamp(na, 0, 1)
  // 3) 迟滞反查标签
  const label = nearestLabelWithHysteresis(nv, na, prev.label, opt.hysteresis)
  return { v: nv, a: na, label }
}

/** 向基线（平静）缓慢回归一步；用于长时间没有新情绪输入时 */
export function driftToBaseline(prev: EmotionState, options?: FusionOptions): EmotionState {
  const opt = { ...DEFAULTS, ...(options || {}) }
  const nv = prev.v + (BASELINE.v - prev.v) * opt.baselineDrift
  const na = prev.a + (BASELINE.a - prev.a) * opt.baselineDrift
  const label = nearestLabelWithHysteresis(nv, na, prev.label, opt.hysteresis)
  return { v: nv, a: na, label }
}

/** 有状态的融合器：桌宠主进程持有一个单例即可 */
export class PetEmotionFusion {
  private state: EmotionState
  private readonly opt: Required<FusionOptions>

  constructor(initial?: Partial<EmotionState>, options?: FusionOptions) {
    this.opt = { ...DEFAULTS, ...(options || {}) }
    this.state = {
      v: initial?.v ?? BASELINE.v,
      a: initial?.a ?? BASELINE.a,
      label: initial?.label ?? BASELINE.label,
    }
  }

  /** 输入本次 LLM 情绪，返回平滑后的状态 */
  next(rawLabel: string | undefined | null): EmotionState {
    this.state = fuseEmotionStep(this.state, rawLabel, this.opt)
    return this.get()
  }

  /** 无输入时调一次，向基线轻微回归 */
  idle(): EmotionState {
    this.state = driftToBaseline(this.state, this.opt)
    return this.get()
  }

  get(): EmotionState {
    return { ...this.state }
  }

  /** 从持久化状态恢复（重启后延续情绪，而不是回到基线） */
  restore(saved: { v?: number; a?: number; label?: string } | undefined | null): void {
    if (!saved) return
    this.state = {
      v: Number.isFinite(saved.v) ? Math.max(-1, Math.min(1, saved.v as number)) : BASELINE.v,
      a: Number.isFinite(saved.a) ? Math.max(0, Math.min(1, saved.a as number)) : BASELINE.a,
      label: typeof saved.label === 'string' && saved.label ? saved.label : BASELINE.label,
    }
  }

  reset(): void {
    this.state = { ...BASELINE }
  }
}
