// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// electron/voice/voiceLoop.ts — 🎙 无障碍语音交互闭环（创新提案 7）
//
// 状态机：idle → recording → recognizing → speaking → idle（+ error）
//   按住 PTT → recording（开始录音）
//   松开 PTT → recognizing（STT 转文字）→ dispatch 意图 → speaking（TTS 播报）→ idle
//   speaking 中再次按下 PTT → cancelSpeak 打断 → 直接进入 recording
//
// 设计原则：纯逻辑、依赖注入，不直接 import electron / 真实硬件，
// 以便在 node 单测里用 mock 驱动状态转换。真实接线见 initVoiceLoop()。
// ============================================================

export type VoiceLoopState =
  | 'idle'
  | 'recording'
  | 'recognizing'
  | 'speaking'
  | 'error'

export interface RecordingOut {
  /** 录好的音频文件路径（交给 transcribe） */
  audioPath: string
  /** 时长（秒），可选 */
  duration?: number
}

export interface VoiceLoopDeps {
  /** 开始按住录音 */
  startRecording(): void | Promise<void>
  /** 松开：停止录音，返回音频 */
  stopRecording(): Promise<RecordingOut>
  /** STT：音频 → 文字 */
  transcribe(audioPath: string): Promise<string>
  /** 意图分发：用户文字 → 回复语音文本（复用 petVoiceChat） */
  dispatch(text: string): Promise<string>
  /** TTS：播报文本 */
  speak(text: string): Promise<void>
  /** 立即停止当前播报（打断） */
  cancelSpeak(): void
  /** 取消进行中的 STT / dispatch（可选） */
  cancelPending?: () => void
}

export interface VoiceLoopEvents {
  onStateChange?: (state: VoiceLoopState, meta?: { text?: string; error?: string }) => void
}

export interface VoiceLoopOptions {
  /** 错误态自动回到 idle 的延时（ms），默认 1500 */
  errorRecoverMs?: number
  /** 可注入定时器（测试用），默认 setTimeout，返回可清理句柄 */
  setTimer?: (fn: () => void, ms: number) => unknown
}

export class VoiceLoop {
  state: VoiceLoopState = 'idle'
  /** 最近一次识别出的用户文字（UI 展示用） */
  lastTranscript = ''
  /** 最近一次播报的回复 */
  lastReply = ''

  private gen = 0
  private errorTimer: unknown = null
  private readonly errorRecoverMs: number
  private readonly setTimer: (fn: () => void, ms: number) => unknown

  constructor(
    private readonly deps: VoiceLoopDeps,
    private readonly events: VoiceLoopEvents = {},
    options: VoiceLoopOptions = {},
  ) {
    this.errorRecoverMs = options.errorRecoverMs ?? 1500
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  }

  private setState(s: VoiceLoopState, meta: { text?: string; error?: string } = {}): void {
    this.state = s
    this.events.onStateChange?.(s, meta)
  }

  /** 当前是否忙（录音/识别/播报中） */
  busy(): boolean {
    return this.state !== 'idle'
  }

  /**
   * PTT 按下：
   *  - 若正在播报 → 打断播报，立即开始新录音
   *  - 若正在识别 → 取消进行中的识别，立即开始新录音
   *  - idle / error → 开始录音
   *  - 已在录音 → 忽略（防止重复触发）
   */
  handlePTTDown(): void {
    // 让任何进行中的异步链路（识别/播报）失效
    this.gen++
    this.clearErrorTimer()
    // 打断播报
    try { this.deps.cancelSpeak() } catch { /* noop */ }
    // 打断进行中的 STT/dispatch
    try { this.deps.cancelPending?.() } catch { /* noop */ }

    if (this.state === 'recording') {return} // 已在录，忽略

    this.setState('recording')
    try {
      const r = this.deps.startRecording()
      if (r && typeof (r as Promise<void>).then === 'function') {
        (r as Promise<void>).catch((e) => this.fail(e))
      }
    } catch (e) { this.fail(e) }
  }

  /** PTT 松开：结束录音 → STT → dispatch → TTS */
  handlePTTUp(): void {
    if (this.state !== 'recording') {return}
    void this.runPipeline()
  }

  private async runPipeline(): Promise<void> {
    const myGen = this.gen
    this.setState('recognizing')
    try {
      const rec = await this.deps.stopRecording()
      if (myGen !== this.gen) {return} // 被打断
      const text = (await this.deps.transcribe(rec.audioPath) || '').trim()
      if (myGen !== this.gen) {return}
      if (!text) {
        this.setState('idle')
        return
      }
      this.lastTranscript = text
      const reply = (await this.deps.dispatch(text) || '').trim()
      if (myGen !== this.gen) {return}
      if (!reply) {
        this.setState('idle')
        return
      }
      this.lastReply = reply
      this.setState('speaking', { text: reply })
      await this.deps.speak(reply)
      if (myGen !== this.gen) {return}
      this.setState('idle')
    } catch (e: any) {
      if (myGen !== this.gen) {return} // 被主动打断，不算错误
      this.fail(e)
    }
  }

  private fail(e: any): void {
    const msg = e?.message || String(e) || '语音处理失败'
    this.setState('error', { error: msg })
    this.clearErrorTimer()
    this.errorTimer = this.setTimer(() => {
      if (this.state === 'error') {this.setState('idle')}
    }, this.errorRecoverMs)
  }

  private clearErrorTimer(): void {
    if (this.errorTimer) {
      try { clearTimeout(this.errorTimer as ReturnType<typeof setTimeout>) } catch { /* noop */ }
      this.errorTimer = null
    }
  }

  /** 主动停止并复位（设置关闭语音时调用） */
  reset(): void {
    this.gen++
    this.clearErrorTimer()
    try { this.deps.cancelSpeak() } catch { /* noop */ }
    try { this.deps.cancelPending?.() } catch { /* noop */ }
    this.setState('idle')
  }
}
