// ============================================================
// ttsEngine.ts — TTS 引擎 (v2.5.3 直连 Python 服务)
//
// 渲染进程直接 fetch Python edge-tts 服务获取 MP3 二进制，
// 不再通过 IPC 传输 base64，彻底消除编码/解码问题。
// ============================================================

export type TTSEngine = 'edge-tts' | 'gpt-sovits' | 'indextts'

export interface TTSConfig {
  engine: TTSEngine
  voice?: string
  speed?: number
  volume?: number
  enabled?: boolean
  sovits?: {
    apiUrl: string
    refAudioPath?: string
    refText?: string
    refLanguage?: 'zh' | 'en' | 'ja'
    targetLanguage?: 'zh' | 'en' | 'ja'
  }
  indextts?: {
    apiUrl?: string
    port?: number
    refAudioPath?: string
    lang?: 'ZH' | 'EN' | 'JA' | 'ES' | 'AR'
    emotion?: string
    durationFactor?: number
  }
}

export interface TTSSpeakOptions {
  text: string
  engine?: TTSEngine
  voice?: string
  speed?: number
  volume?: number
}

export interface TTSSpeakResult {
  audio?: string
  error?: string
  engine: string
  duration?: number
}

// ═══════════════════════════════════════════════════════════
// TTS 引擎服务
// ═══════════════════════════════════════════════════════════

export class TTSEngineService {
  private config: TTSConfig = { engine: 'edge-tts' }
  private currentAudio: HTMLAudioElement | null = null
  private currentBlobUrl: string | null = null
  private _onStateChange?: (speaking: boolean) => void
  private _onError?: (error: string) => void
  private _lastPort = 18089

  /** 在用户交互时调用，提升 Media Engagement Index */
  unlock(): void {
    try {
      const ctx = new AudioContext()
      if (ctx.state === 'suspended') ctx.resume()
      setTimeout(() => ctx.close(), 500)
    } catch {}
  }

  onStateChange(fn: (speaking: boolean) => void) {
    this._onStateChange = fn
  }

  onError(fn: (error: string) => void) {
    this._onError = fn
  }

  get isSpeaking(): boolean {
    return this.currentAudio !== null && !this.currentAudio.paused
  }

  /** 健康检查：Python TTS 服务是否可用 */
  async healthCheck(): Promise<{ ok: boolean; detail: string }> {
    const api = (window as any).luminaAPI
    const port = (api?.edgeTtsPort ? await api.edgeTtsPort() : this._lastPort) || this._lastPort
    this._lastPort = port
    try {
      const res = await fetch(`http://localhost:${port}/health`, {
        signal: AbortSignal.timeout(2000),
      })
      if (res.ok) return { ok: true, detail: `服务运行中 (port ${port})` }
      return { ok: false, detail: `服务返回异常: ${res.status}` }
    } catch (err: any) {
      return { ok: false, detail: `服务未运行: ${err.message}` }
    }
  }

  configure(config: Partial<TTSConfig>): void {
    this.config = { ...this.config, ...config }
  }

  getConfig(): TTSConfig {
    return { ...this.config }
  }

  // ═══════════════════════════════════════════════════════
  // speak — 统一入口
  // ═══════════════════════════════════════════════════════

  async speak(options: TTSSpeakOptions): Promise<TTSSpeakResult> {
    // TTS 总开关
    if (this.config.enabled === false) {
      return { engine: 'none', error: undefined }
    }

    const engine = options.engine || this.config.engine

    if (engine === 'edge-tts') {
      return this.speakEdgeTTS(options)
    }

    if (engine === 'indextts') {
      return this.speakIndexTTS(options)
    }

    if (engine === 'gpt-sovits' && this.config.sovits) {
      try {
        return await this.speakSoVITS(options)
      } catch (err: any) {
        return { error: `SoVITS 失败: ${err.message}`, engine: 'gpt-sovits' }
      }
    }

    return { error: `未知 TTS 引擎: ${engine}`, engine }
  }

  // ═══════════════════════════════════════════════════════
  // Edge-TTS — 渲染进程直连 Python 服务
  // ═══════════════════════════════════════════════════════

  private async speakEdgeTTS(options: TTSSpeakOptions): Promise<TTSSpeakResult> {
    const api = (window as any).luminaAPI
    const port = (api?.edgeTtsPort ? await api.edgeTtsPort() : this._lastPort) || this._lastPort
    this._lastPort = port
    const ttsUrl = `http://localhost:${port}/tts`

    const speakParams = {
      text: options.text,
      voice: options.voice || this.config.voice || 'zh-CN-XiaoxiaoNeural',
      speed: options.speed ?? this.config.speed ?? 1.0,
    }

    console.log(`[TTS] 准备朗读 ${speakParams.text.length} 字符 → ${speakParams.text.slice(0, 30)}...`)

    // 首次尝试（含超时保护）
    let mp3Bytes: ArrayBuffer | null = null
    try {
      const ctrl = new AbortController()
      const timeoutId = setTimeout(() => ctrl.abort(), 15000)
      const res = await fetch(ttsUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(speakParams),
        signal: ctrl.signal,
      })
      clearTimeout(timeoutId)
      if (res.ok) {
        mp3Bytes = await res.arrayBuffer()
      } else {
        console.warn(`[TTS] 服务返回 ${res.status}`)
      }
    } catch (err: any) {
      console.warn(`[TTS] 直连失败: ${err.message}`)
    }

    // 服务启动 + 重试
    if (!mp3Bytes && api?.edgeTtsStart) {
      console.log('[TTS] 尝试通过 IPC 启动 Python 服务...')
      const startResult = await api.edgeTtsStart()
      if (startResult?.ok) {
        this._lastPort = startResult.port || port
        const retryUrl = `http://localhost:${this._lastPort}/tts`
        try {
          const ctrl = new AbortController()
          const timeoutId = setTimeout(() => ctrl.abort(), 15000)
          const res = await fetch(retryUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(speakParams),
            signal: ctrl.signal,
          })
          clearTimeout(timeoutId)
          if (res.ok) {
            mp3Bytes = await res.arrayBuffer()
          }
        } catch (err: any) {
          const errMsg = `TTS 服务请求失败: ${err.message}`
          this._onError?.(errMsg)
          return { error: errMsg, engine: 'edge-tts' }
        }
      } else {
        const errMsg = `TTS 服务启动失败: ${startResult?.detail || '未知原因'}`
        this._onError?.(errMsg)
        return { error: errMsg, engine: 'edge-tts' }
      }
    }

    if (!mp3Bytes || mp3Bytes.byteLength < 100) {
      const errMsg = mp3Bytes
        ? `TTS 返回数据过小 (${mp3Bytes.byteLength} bytes)`
        : 'TTS 未返回有效音频数据，请检查 Python 服务状态'
      this._onError?.(errMsg)
      return { error: errMsg, engine: 'edge-tts' }
    }

    console.log(`[TTS] 获取音频: ${(mp3Bytes.byteLength / 1024).toFixed(1)} KB`)

    // Blob URL 播放
    const blob = new Blob([mp3Bytes], { type: 'audio/mpeg' })
    const blobUrl = URL.createObjectURL(blob)
    this.playAudio(blobUrl, options.volume ?? this.config.volume ?? 1.0)

    return { engine: 'edge-tts' }
  }

  // ═══════════════════════════════════════════════════════
  // IndexTTS-2.5 — 本地 GPU 语音克隆
  // ═══════════════════════════════════════════════════════

  private getIndexTtsUrl(): string {
    const cfg = this.config.indextts
    const port = cfg?.port || 18927
    const base = cfg?.apiUrl || `http://127.0.0.1:${port}`
    return base.replace(/\/+$/, '')
  }

  async indexTtsHealth(): Promise<{ ok: boolean; detail: string }> {
    try {
      const res = await fetch(`${this.getIndexTtsUrl()}/health`, {
        signal: AbortSignal.timeout(2000),
      })
      if (res.ok) {
        const data = await res.json()
        if (data.ready) return { ok: true, detail: 'IndexTTS-2.5 就绪' }
        return { ok: false, detail: data.error || '模型加载中…' }
      }
      return { ok: false, detail: `服务返回: ${res.status}` }
    } catch (err: any) {
      return { ok: false, detail: `IndexTTS 服务未运行: ${err.message}` }
    }
  }

  private async speakIndexTTS(options: TTSSpeakOptions): Promise<TTSSpeakResult> {
    const cfg = this.config.indextts || {}
    const url = `${this.getIndexTtsUrl()}/tts`

    const body: any = {
      text: options.text,
      lang: cfg.lang || 'ZH',
      ref_audio: cfg.refAudioPath || '',
      duration_factor: cfg.durationFactor ?? (options.speed ?? this.config.speed ?? 1.0),
    }
    if (cfg.emotion) body.emotion = cfg.emotion

    try {
      const ctrl = new AbortController()
      const timeoutId = setTimeout(() => ctrl.abort(), 60000) // IndexTTS 首次推理可能较慢
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      })
      clearTimeout(timeoutId)

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}))
        return { error: `IndexTTS 返回 ${res.status}: ${errData.error || ''}`, engine: 'indextts' }
      }

      const data = await res.json()
      if (data.error) return { error: data.error, engine: 'indextts' }

      const hexStr = typeof data.audio === 'string' ? data.audio : ''
      if (!hexStr) return { error: 'IndexTTS 未返回音频数据', engine: 'indextts' }

      // hex → ArrayBuffer → Blob (WAV)
      const wavBytes = new Uint8Array(hexStr.length / 2)
      for (let i = 0; i < wavBytes.length; i++) {
        wavBytes[i] = parseInt(hexStr.substr(i * 2, 2), 16)
      }
      const blob = new Blob([wavBytes], { type: 'audio/wav' })
      const blobUrl = URL.createObjectURL(blob)
      this.playAudio(blobUrl, options.volume ?? this.config.volume ?? 1.0)

      return { engine: 'indextts' }
    } catch (err: any) {
      const errMsg = err.name === 'AbortError'
        ? 'IndexTTS 推理超时（首次加载模型可能需要 30 秒以上）'
        : `IndexTTS 连接失败: ${err.message}`
      this._onError?.(errMsg)
      return { error: errMsg, engine: 'indextts' }
    }
  }

  // ═══════════════════════════════════════════════════════
  // GPT-SoVITS
  // ═══════════════════════════════════════════════════════

  private async speakSoVITS(options: TTSSpeakOptions): Promise<TTSSpeakResult> {
    const sovits = this.config.sovits!
    const res = await fetch(`${sovits.apiUrl}/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: options.text,
        text_language: sovits.refLanguage || 'zh',
        ref_audio_path: sovits.refAudioPath || '',
        prompt_text: sovits.refText || '',
      }),
    })
    const data = await res.json()
    const audioPath = data.audio_path || data.audio
    if (audioPath) {
      const api = (window as any).luminaAPI
      if (api?.playAudio) await api.playAudio(audioPath)
    }
    return { engine: 'gpt-sovits', duration: data.duration }
  }

  // ═══════════════════════════════════════════════════════
  // Audio 播放
  // ═══════════════════════════════════════════════════════

  private playAudio(blobUrl: string, volume: number): void {
    try {
      this.stop()

      const audio = new Audio(blobUrl)
      audio.volume = Math.max(0, Math.min(1, volume))
      this.currentAudio = audio
      this.currentBlobUrl = blobUrl
      this._onStateChange?.(true)

      audio.onended = () => { this.cleanup(); this._onStateChange?.(false) }
      audio.onerror = () => {
        const err = (audio as any).error
        console.warn('[TTS] 音频错误:', err?.code, err?.message)
        this.cleanup(); this._onStateChange?.(false)
      }

      audio.play().then(() => {
        console.log('[TTS] ✅ 播放成功')
      }).catch((e: any) => {
        if (e.name === 'NotAllowedError') {
          console.warn('[TTS] autoplay 阻止，等待用户交互后重试...')
          this._onError?.('🔒 浏览器阻止了自动播放，请点击页面任意位置后再试')
          // 保存当前状态，等待下次点击自动重试
          this.currentBlobUrl = null
          this.currentAudio = null
          this._onStateChange?.(false)
          this.scheduleRetry(blobUrl, volume)
        } else {
          console.warn('[TTS] play() 失败:', e.name, e.message)
          this._onError?.(`TTS 播放失败: ${e.message}`)
          this.cleanup(); this._onStateChange?.(false)
        }
      })
    } catch (err: any) {
      console.warn('[TTS] 播放异常:', err.message)
      this.cleanup(); this._onStateChange?.(false)
    }
  }

  private scheduleRetry(blobUrl: string, volume: number): void {
    const retry = () => {
      document.removeEventListener('click', retry)
      document.removeEventListener('keydown', retry)
      this.playAudio(blobUrl, volume)
    }
    document.addEventListener('click', retry, { once: true })
    document.addEventListener('keydown', retry, { once: true })
  }

  private cleanup(): void {
    if (this.currentBlobUrl) {
      URL.revokeObjectURL(this.currentBlobUrl)
      this.currentBlobUrl = null
    }
    this.currentAudio = null
  }

  // ═══════════════════════════════════════════════════════
  // 停止
  // ═══════════════════════════════════════════════════════

  stop(): void {
    if (this.currentAudio) {
      this.currentAudio.pause()
    }
    this.cleanup()
    this._onStateChange?.(false)
  }
}

export const ttsEngine = new TTSEngineService()
