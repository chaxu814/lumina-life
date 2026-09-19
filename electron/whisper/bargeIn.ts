// ============================================================
// whisper/bargeIn.ts — 🎙️ 可打断语音（barge-in）最小闭环控制器 (v0.1)
//
// 场景：Lumina 正在用 TTS 说话时，用户开口插话，应当：
//   立即停止当前播报 → 转入「听」状态，而不是自顾自说完。
//
// 为避免误触发（TTS 自己的声音、单次爆音），采用三重防抖：
//   1) 电平阈值 threshold；
//   2) 需连续 confirmFrames 帧超过阈值才认定为「用户在说话」；
//   3) 触发后进入 cooldownMs 冷却，期间不再打断（防尾音自激）。
//
// 本类只做确定性状态判定，不直接持有麦克风/音频设备：
//   电平采样 getLevel 与时钟 now 均可注入，便于单元测试。
//   渲染层/语音服务每帧（约 100ms）调用 observe() 即可。
// ============================================================

export type BargeInState = 'idle' | 'speaking' | 'interrupted'

export interface InterruptibleSpeech {
  /** 立即停止当前 TTS 播报 */
  stop: () => void
}

export interface BargeInOptions {
  /** 触发电平阈值 0~1，默认 0.12 */
  threshold?: number
  /** 连续超阈值帧数，默认 3 */
  confirmFrames?: number
  /** 打断后的冷却毫秒，默认 700 */
  cooldownMs?: number
  /** 注入：当前毫秒时间戳（测试用） */
  now?: () => number
}

export class BargeInController {
  private state: BargeInState = 'idle'
  private hitFrames = 0
  private lastInterruptAt = -Infinity
  private interruptCount = 0
  private speech: InterruptibleSpeech | null = null
  private readonly threshold: number
  private readonly confirmFrames: number
  private readonly cooldownMs: number
  private readonly now: () => number
  /** 打断回调（例如切换到「正在听」） */
  onInterrupt?: (meta: { at: number }) => void

  constructor(opts: BargeInOptions = {}, onInterrupt?: (meta: { at: number }) => void) {
    this.threshold = opts.threshold ?? 0.12
    this.confirmFrames = Math.max(1, opts.confirmFrames ?? 3)
    this.cooldownMs = opts.cooldownMs ?? 700
    this.now = opts.now ?? (() => Date.now())
    this.onInterrupt = onInterrupt
  }

  /** TTS 开始播报时调用 */
  beginSpeech(speech: InterruptibleSpeech): void {
    this.speech = speech
    this.state = 'speaking'
    this.hitFrames = 0
  }

  /**
   * 喂入一帧麦克风电平（0~1）。返回是否在本帧触发了打断。
   * 非 speaking 状态、冷却期内都不会触发。
   */
  observe(level: number): boolean {
    if (this.state !== 'speaking') {return false}
    const t = this.now()
    if (t - this.lastInterruptAt < this.cooldownMs) {return false}

    if (level >= this.threshold) {
      this.hitFrames += 1
    } else {
      // 一帧低于阈值即归零，要求「连续」达标，抗瞬时爆音
      this.hitFrames = 0
      return false
    }

    if (this.hitFrames < this.confirmFrames) {return false}

    // 触发打断
    this.state = 'interrupted'
    this.lastInterruptAt = t
    this.interruptCount += 1
    try { this.speech?.stop() } catch { /* 停止失败不影响状态流转 */ }
    this.onInterrupt?.({ at: t })
    return true
  }

  /** TTS 自然播报结束（未被打断）时调用 */
  endSpeech(): void {
    this.state = 'idle'
    this.hitFrames = 0
    this.speech = null
  }

  getState(): BargeInState { return this.state }
  getInterruptCount(): number { return this.interruptCount }
  isSpeaking(): boolean { return this.state === 'speaking' }
}
