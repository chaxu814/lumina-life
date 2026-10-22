// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// sttService.ts — 语音识别服务 (v2.11 增强)
//
// 三层降级策略:
//   Layer 1: Electron 原生语音识别 (通过 IPC → 主进程 whisper/vosk)
//   Layer 2: Web Speech API (Chrome/Edge 内置，需联网)
//   Layer 3: 优雅降级 - 引导用户安装 Whisper
//
// v2.11 改进:
//   - 自动重试机制 (最多 3 次)
//   - 暂停/恢复支持
//   - 引擎自动检测与降级
//   - 更好的状态反馈
//   - 超时自动停止 (防止资源泄露)
// ============================================================

export type STTEngine = 'web-speech' | 'whisper' | 'vosk' | 'native' | 'auto'

export interface STTStatus {
  listening: boolean
  engine: STTEngine
  engineLabel: string
  error?: string
  retryCount: number
}

type STTCallback = (text: string) => void
type StatusCallback = (status: STTStatus) => void

const MAX_RETRIES = 3
const AUTO_STOP_TIMEOUT_MS = 30_000 // 30秒无结果自动停止
const RESTART_DELAY_MS = 300

export class STTService {
  private recognition: any = null
  private listening = false
  private paused = false
  private engine: STTEngine = 'auto'
  private onResult: STTCallback | null = null
  private onStatus: StatusCallback | null = null
  private retryCount = 0
  private autoStopTimer: ReturnType<typeof setTimeout> | null = null
  private lastResultTime = 0

  // ═══ 公共 API ═══

  static isWebSpeechSupported(): boolean {
    return !!(
      (window as any).SpeechRecognition ||
      (window as any).webkitSpeechRecognition
    )
  }

  setCallbacks(onResult: STTCallback, onStatus?: StatusCallback): void {
    this.onResult = onResult
    this.onStatus = onStatus ?? null
  }

  setEngine(engine: STTEngine): void {
    this.engine = engine
    this.retryCount = 0
  }

  async start(): Promise<void> {
    if (this.listening && !this.paused) {return}

    // 重置状态
    this.retryCount = 0

    // Layer 1: Electron 原生 (whisper/vosk)
    if (this.engine === 'auto' || this.engine === 'whisper' || this.engine === 'vosk' || this.engine === 'native') {
      try {
        const available = await window.luminaAPI?.sttCheck()
        if (available?.available) {
          this.engine = available.engine as STTEngine
          this.startNative()
          return
        }
      } catch { /* 静默降级 */ }
    }

    // Layer 2: Web Speech API
    if (this.engine === 'auto' || this.engine === 'web-speech') {
      if (STTService.isWebSpeechSupported()) {
        this.startWebSpeech()
        return
      }
    }

    // Layer 3: 不可用
    this.notifyError(
      '语音识别不可用。\n' +
      '• Chrome/Edge 用户：浏览器内置语音识别已就绪\n' +
      '• 其他用户：请在设置中安装 Whisper（本地离线识别）'
    )
  }

  stop(): void {
    this.listening = false
    this.paused = false
    this.clearAutoStop()
    if (this.recognition) {
      try { this.recognition.stop() } catch { /* ignore */ }
      this.recognition = null
    }
    // 通知主进程停止
    window.luminaAPI?.sttStop().catch(() => {})
    this.emitStatus()
  }

  pause(): void {
    if (!this.listening) {return}
    this.paused = true
    this.clearAutoStop()
    if (this.recognition) {
      try { this.recognition.stop() } catch { /* ignore */ }
    }
    this.emitStatus()
  }

  resume(): void {
    if (!this.paused) {return}
    this.paused = false
    this.start()
  }

  toggle(): 'started' | 'stopped' {
    if (this.listening && !this.paused) {
      this.stop()
      return 'stopped'
    } else if (this.paused) {
      this.resume()
      return 'started'
    } else {
      this.start()
      return 'started'
    }
  }

  isListening(): boolean { return this.listening && !this.paused }
  isPaused(): boolean { return this.paused }
  getEngine(): STTEngine { return this.engine }

  // ═══ Web Speech 实现 ═══

  private startWebSpeech(): void {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    if (!SR) {
      this.notifyError('浏览器不支持 SpeechRecognition')
      return
    }

    const recognition = new SR()
    recognition.lang = 'zh-CN'
    recognition.interimResults = true
    recognition.continuous = true
    recognition.maxAlternatives = 1

    recognition.onresult = (event: any) => {
      this.lastResultTime = Date.now()
      this.resetAutoStop()
      let final = ''
      for (let i = event.resultIndex; i < event.results.length; i++) {
        if (event.results[i].isFinal) {final += event.results[i][0].transcript}
      }
      if (final) {
        this.retryCount = 0 // 成功后重置重试计数
        this.onResult?.(final.trim())
      }
    }

    recognition.onerror = (event: any) => {
      if (event.error === 'no-speech') {
        // 无声 — 继续监听
        return
      }
      if (event.error === 'aborted') {
        // 正常中止（暂停/停止）
        return
      }
      if (event.error === 'not-allowed') {
        this.notifyError('麦克风权限被拒绝。请在浏览器设置中允许麦克风访问。')
        this.listening = false
        return
      }
      if (event.error === 'network') {
        // 网络错误 — 重试
        this.handleRetry()
        return
      }
      // 其他错误
      this.notifyError(`语音识别错误: ${event.error}`)
      this.listening = false
    }

    recognition.onend = () => {
      // 如果应该继续监听且未被暂停，自动重启
      if (this.listening && !this.paused && this.recognition === recognition) {
        setTimeout(() => {
          if (this.listening && !this.paused) {
            try { recognition.start() } catch { /* ignore */ }
          }
        }, RESTART_DELAY_MS)
      }
    }

    try {
      recognition.start()
      this.recognition = recognition
      this.listening = true
      this.paused = false
      this.engine = 'web-speech'
      this.resetAutoStop()
      this.emitStatus()
    } catch (err: any) {
      this.notifyError(`语音识别启动失败: ${err.message}`)
    }
  }

  // ═══ Electron 原生实现 ═══

  private async startNative(): Promise<void> {
    try {
      this.listening = true
      this.paused = false
      this.emitStatus()

      // 通过 IPC 监听主进程的 STT 结果
      const unsub = window.luminaAPI?.onSTTResult((text: string) => {
        if (text) {
          this.lastResultTime = Date.now()
          this.retryCount = 0
          this.onResult?.(text.trim())
        }
      })

      // 存储取消订阅函数
      ;(this as any)._nativeUnsub = unsub

      await window.luminaAPI?.sttStart()
    } catch (err: any) {
      this.notifyError(`原生语音识别失败: ${err.message}`)
      // 降级到 Web Speech
      if (STTService.isWebSpeechSupported()) {
        this.engine = 'web-speech'
        this.startWebSpeech()
      }
    }
  }

  // ═══ 辅助 ═══

  private handleRetry(): void {
    this.retryCount++
    if (this.retryCount <= MAX_RETRIES) {
      // 指数退避: 300ms, 900ms, 2700ms
      const delay = RESTART_DELAY_MS * Math.pow(3, this.retryCount - 1)
      console.warn(`[STT] 重试 ${this.retryCount}/${MAX_RETRIES}，${delay}ms 后重试`)
      setTimeout(() => {
        if (this.listening && !this.paused) {
          this.start()
        }
      }, delay)
    } else {
      this.notifyError(`语音识别失败（已重试 ${MAX_RETRIES} 次）。请检查网络连接。`)
      this.listening = false
      this.emitStatus()
    }
  }

  private resetAutoStop(): void {
    this.clearAutoStop()
    if (this.listening) {
      this.autoStopTimer = setTimeout(() => {
        if (Date.now() - this.lastResultTime >= AUTO_STOP_TIMEOUT_MS) {
          console.log('[STT] 30秒无语音输入，自动停止')
          this.stop()
        }
      }, AUTO_STOP_TIMEOUT_MS)
    }
  }

  private clearAutoStop(): void {
    if (this.autoStopTimer) {
      clearTimeout(this.autoStopTimer)
      this.autoStopTimer = null
    }
  }

  private emitStatus(): void {
    this.onStatus?.({
      listening: this.listening && !this.paused,
      engine: this.engine,
      engineLabel: this.getEngineLabel(),
      retryCount: this.retryCount,
    })
  }

  private getEngineLabel(): string {
    switch (this.engine) {
      case 'web-speech': return '浏览器内置'
      case 'whisper': return 'Whisper (本地)'
      case 'vosk': return 'Vosk (本地)'
      case 'native': return '原生引擎'
      default: return '自动检测'
    }
  }

  private notifyError(msg: string): void {
    console.error('[STT]', msg)
    this.onStatus?.({
      listening: false,
      engine: this.engine,
      engineLabel: this.getEngineLabel(),
      error: msg,
      retryCount: this.retryCount,
    })
  }
}

export const sttService = new STTService()
