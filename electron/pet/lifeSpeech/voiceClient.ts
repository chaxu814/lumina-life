// ============================================================
// pet/lifeSpeech/voiceClient.ts — 🎙 桌宠全双工语音客户端（渲染侧 bundle）
//
// 经 esbuild 打成 pet-voice.js（全局 LuminaVoice），由 pet-live2d.html 加载。
// 负责「最后一公里」：
//   STT：Web Speech 流式(zh-CN，partial) 为主；不可用/网络失败时降级到
//        本地麦克风能量 VAD 切句 → 主进程 Whisper(whisper-base) 离线识别。
//   编排：FullDuplexController（纯逻辑）+ 主进程 LiveSpeechDirector（IPC）。
//   TTS：edge-tts / indextts 逐句播放，可被 barge-in 立即打断，带五元音口型。
//
// 所有 DOM/硬件调用都做了防御，失败时安全降级并通过 onStatus 回报。
// ============================================================

import { FullDuplexController } from './fullDuplexController'

// nodeIntegration=true，pet 页可直接 require
const electron = (typeof require === 'function' ? require('electron') : (window as any).electron) || {}
const ipc = electron.ipcRenderer || null

export interface VoiceStartOptions {
  ttsEngine?: 'edge-tts' | 'indextts'
  volume?: number
  spatial?: boolean
  micDevice?: string
  /** Web Speech 语种 */
  lang?: string
  /** 本地 Whisper 模型名（兜底） */
  whisperModel?: string
}

export interface VoiceHooks {
  onState?: (s: 'idle' | 'listening' | 'thinking' | 'speaking') => void
  onPartial?: (text: string) => void
  onStatus?: (msg: string, kind?: 'info' | 'warn' | 'error') => void
  onError?: (msg: string) => void
}

// ── 16k 单声道 WAV 编码（本地 Whisper 兜底用）─────────────────
function downsampleTo16k(input: Float32Array, inRate: number): Float32Array {
  if (inRate === 16000) return input
  const ratio = inRate / 16000
  const newLen = Math.round(input.length / ratio)
  const out = new Float32Array(newLen)
  let oPos = 0
  for (let i = 0; i < newLen; i++) {
    const pos = i * ratio
    const i0 = Math.floor(pos)
    const i1 = Math.min(input.length - 1, i0 + 1)
    const frac = pos - i0
    out[oPos++] = input[i0] * (1 - frac) + input[i1] * frac
  }
  return out
}

function encodeWav16k(pcm: Float32Array, sampleRate = 16000): string {
  const buf = new ArrayBuffer(44 + pcm.length * 2)
  const view = new DataView(buf)
  const writeStr = (off: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)) }
  writeStr(0, 'RIFF')
  view.setUint32(4, 36 + pcm.length * 2, true)
  writeStr(8, 'WAVE'); writeStr(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)            // PCM
  view.setUint16(22, 1, true)            // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeStr(36, 'data')
  view.setUint32(40, pcm.length * 2, true)
  let off = 44
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]))
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true)
    off += 2
  }
  let binary = ''
  const bytes = new Uint8Array(buf)
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)) as any)
  }
  return (typeof btoa === 'function' ? btoa(binary) : Buffer.from(bytes).toString('base64'))
}

class VoiceClient {
  private opts: VoiceStartOptions = { ttsEngine: 'edge-tts', volume: 100, spatial: true, lang: 'zh-CN', whisperModel: 'Xenova/whisper-base' }
  private hooks: VoiceHooks = {}
  private controller: FullDuplexController | null = null
  private running = false
  private sttMode: 'web' | 'local' | 'off' = 'off'

  // ── TTS ──
  private audioCtx: AudioContext | null = null
  private currentSrc: AudioBufferSourceNode | null = null
  private ttsToken = 0
  private synthAbort: AbortController | null = null

  // ── Web Speech ──
  private recognition: any = null
  private restarting = false

  // ── 本地 mic VAD ──
  private micStream: MediaStream | null = null
  private micCtx: AudioContext | null = null
  private micNode: any = null

  setOptions(o: VoiceStartOptions): void { this.opts = { ...this.opts, ...o } }

  isRunning(): boolean { return this.running }

  // ─────────────────────────────────────────────
  start(opts: VoiceStartOptions = {}, hooks: VoiceHooks = {}): void {
    this.opts = { ...this.opts, ...opts }
    this.hooks = hooks
    if (this.running) return
    this.running = true

    this.controller = new FullDuplexController({
      sendEvent: async (p) => {
        if (!ipc) return { actions: [], generation: 0, queueSize: 0 }
        return ipc.invoke('pet:live-speech:event', p)
      },
      callLlm: async (text) => {
        const r = await ipc.invoke('pet:voice-chat', { text })
        if (!r || !r.ok) throw new Error(r?.error || '语音对话失败')
        return r.text || ''
      },
      speakSentence: (text) => this.speak(text),
      cancelSpeech: () => this.cancelSpeech(),
      onState: (s) => this.hooks.onState?.(s),
      onPartial: (t) => this.hooks.onPartial?.(t),
      onError: (m) => this.hooks.onError?.(m),
    })
    this.controller.setEnabled(true)

    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    if (SR) {
      this.startWebSpeech(SR)
    } else {
      this.hooks.onStatus?.('浏览器不支持在线语音识别，切换本地语音…', 'warn')
      this.startLocalMic()
    }
  }

  stop(): void {
    if (!this.running) return
    this.running = false
    try { this.controller?.setEnabled(false) } catch {}
    try { this.recognition?.stop() } catch {}
    try { this.recognition?.abort?.() } catch {}
    this.stopMic()
    this.cancelSpeech()
    this.hooks.onState?.('idle')
  }

  // ── Web Speech 流式识别 ──────────────────────────
  private startWebSpeech(SR: any): void {
    if (!this.running) return
    this.sttMode = 'web'
    const rec = new SR()
    this.recognition = rec
    rec.lang = this.opts.lang || 'zh-CN'
    rec.interimResults = true
    rec.continuous = false
    rec.maxAlternatives = 1

    let firedStart = false
    rec.onstart = () => { this.hooks.onStatus?.('全双工已开启（在线流式识别）', 'info') }
    rec.onaudiostart = () => { /* 已开始采集 */ }
    rec.onresult = (e: any) => {
      let interim = ''
      let finalText = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i]
        if (r.isFinal) finalText += r[0].transcript
        else interim += r[0].transcript
      }
      const heard = (finalText || interim).trim()
      if (heard && !firedStart) { firedStart = true; this.controller?.userStarted().catch(() => {}) }
      if (interim) this.controller?.partial(interim)
      if (finalText.trim()) {
        this.controller?.userUtterance(finalText.trim()).catch(() => {})
        firedStart = false
      }
    }
    rec.onerror = (e: any) => {
      const err = e?.error || ''
      if (err === 'no-speech' || err === 'aborted') return
      if (err === 'network' || err === 'service-not-allowed' || err === 'not-allowed' || err === 'audio-capture' || err === 'language-not-supported') {
        // Electron 常缺 Google 语音服务 / 国内网络不通 → 降级本地
        if (this.sttMode === 'web') {
          this.hooks.onStatus?.('在线语音识别不可用（' + err + '），切换本地识别…', 'warn')
          try { rec.abort?.() } catch {}
          this.startLocalMic()
        }
      }
    }
    rec.onend = () => {
      // 连续聆听：非主动关闭则自动重启
      if (this.running && this.sttMode === 'web') {
        this.restarting = true
        setTimeout(() => {
          if (this.running && this.sttMode === 'web') {
            try { rec.start() } catch { /* 仍占用则稍后再试 */ }
          }
          this.restarting = false
        }, 180)
      }
    }
    try { rec.start() } catch (e: any) {
      this.hooks.onStatus?.('在线识别启动失败，切换本地识别…', 'warn')
      this.startLocalMic()
    }
  }

  // ── 本地麦克风：能量 VAD 切句 → Whisper 离线识别 ─────
  private startLocalMic(): void {
    if (!this.running) return
    this.sttMode = 'local'
    const constraints: MediaStreamConstraints = {
      audio: this.opts.micDevice ? { deviceId: { exact: this.opts.micDevice } } : true,
    }
    navigator.mediaDevices.getUserMedia(constraints).then((stream) => {
      if (!this.running || this.sttMode !== 'local') { stream.getTracks().forEach(t => t.stop()); return }
      this.micStream = stream
      const ctx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 })
      this.micCtx = ctx
      const src = ctx.createMediaStreamSource(stream)
      const inRate = ctx.sampleRate || 16000
      const node = ctx.createScriptProcessor(4096, 1, 1)
      this.micNode = node
      const collect: Float32Array[] = []
      let speaking = false
      let silenceMs = 0
      let speechMs = 0
      let noiseFloor = 0.01
      let lastT = Date.now()
      const FRAME_MS = 4096 / inRate * 1000

      const finish = () => {
        if (!speaking) { collect.length = 0; return }
        const total = collect.reduce((n, c) => n + c.length, 0)
        const merged = new Float32Array(total)
        let p = 0; for (const c of collect) { merged.set(c, p); p += c.length }
        collect.length = 0
        speaking = false; speechMs = 0; silenceMs = 0
        if (total < inRate * 0.3) return // 太短（<0.3s）丢弃（userStarted 在说话起始已发）
        const pcm = downsampleTo16k(merged, inRate)
        const b64 = encodeWav16k(pcm)
        this.hooks.onStatus?.('本地识别中…', 'info')
        ipc.invoke('pet:transcribe-utterance', { audioBase64: b64, model: this.opts.whisperModel })
          .then((r: any) => {
            if (r && r.ok && r.text) {
              this.hooks.onPartial?.(r.text)
              this.controller?.userUtterance(r.text).catch(() => {})
            } else if (r && r.missingDependency) {
              this.hooks.onError?.('本地语音模型未安装（@xenova/transformers / whisper-base），请在设置中安装或改用在线识别。')
            } else {
              this.hooks.onStatus?.('没听清，可以再说一次～', 'info')
            }
          }).catch(() => {})
      }

      node.onaudioprocess = (ev: any) => {
        if (!this.running || this.sttMode !== 'local') return
        const chunk = ev.inputBuffer.getChannelData(0)
        const now = Date.now()
        // 能量
        let sum = 0; for (let i = 0; i < chunk.length; i += 4) { const v = chunk[i]; sum += v * v }
        const rms = Math.sqrt(sum / (chunk.length / 4))
        if (!speaking) noiseFloor = noiseFloor * 0.98 + Math.min(noiseFloor, rms) * 0.02
        const threshold = Math.max(0.012, noiseFloor * 3.5)
        if (rms > threshold) {
          if (!speaking) { speaking = true; speechMs = 0; this.controller?.userStarted().catch(() => {}) }
          silenceMs = 0; speechMs += FRAME_MS
          collect.push(chunk.slice(0))
        } else if (speaking) {
          silenceMs += FRAME_MS; speechMs += FRAME_MS
          collect.push(chunk.slice(0))
          if (silenceMs >= 700) finish()
          else if (speechMs >= 12000) finish()
        }
        lastT = now
      }
      // 经 0 增益静音节点接到 destination：ScriptProcessor 必须有到输出的图才会回调，
      // 但绝不能把麦克风直接送进扬声器（会产生自激啸叫）。
      const mute = ctx.createGain()
      mute.gain.value = 0
      src.connect(node)
      node.connect(mute)
      mute.connect(ctx.destination)
      this.hooks.onStatus?.('全双工已开启（本地识别）', 'info')
    }).catch((err: any) => {
      this.sttMode = 'off'
      this.hooks.onError?.('麦克风不可用：' + (err?.message || err))
    })
  }

  private stopMic(): void {
    this.sttMode = 'off'
    try { this.micNode?.disconnect?.() } catch {}
    try { this.micCtx?.close?.() } catch {}
    this.micStream?.getTracks().forEach(t => { try { t.stop() } catch {} })
    this.micStream = null; this.micNode = null; this.micCtx = null
  }

  // ── 句级 TTS：可 await、可被立即打断 ───────────────
  private async synth(text: string, token: number): Promise<string> {
    const engine = this.opts.ttsEngine || 'edge-tts'
    if (engine === 'indextts') {
      try {
        this.synthAbort = new AbortController()
        const res = await fetch('http://127.0.0.1:18927/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, lang: 'ZH' }),
          signal: this.synthAbort.signal,
        })
        if (res.ok) {
          const data = await res.json()
          if (data.audio) {
            const hex = data.audio
            const bytes = new Uint8Array(hex.length / 2)
            for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16)
            const blob = new Blob([bytes], { type: 'audio/wav' })
            return URL.createObjectURL(blob)
          }
        }
      } catch (e) {
        if (token !== this.ttsToken) throw new Error('cancelled')
        // 降级 edge
      }
    }
    const r = await ipc.invoke('edge-tts:speak', { text })
    if (token !== this.ttsToken) throw new Error('cancelled')
    return r?.audio || ''
  }

  private async speak(text: string): Promise<void> {
    if (!text) return
    const token = ++this.ttsToken
    this.cancelPlaybackOnly()
    try {
      const url = await this.synth(text, token)
      if (token !== this.ttsToken || !url) return
      const ctx = this.ensureAudioCtx()
      const buf = await (await fetch(url)).arrayBuffer()
      const audio = await ctx.decodeAudioData(buf)
      if (token !== this.ttsToken) return
      await new Promise<void>((resolve) => {
        const src = ctx.createBufferSource()
        src.buffer = audio
        const gain = ctx.createGain()
        gain.gain.value = (Number(this.opts.volume) || 100) / 100
        src.connect(gain)
        let out: AudioNode = gain
        if (this.opts.spatial !== false && ctx.createStereoPanner && (window as any).__petModelX !== undefined && window.innerWidth) {
          const pan = ctx.createStereoPanner()
          pan.pan.value = Math.max(-0.8, Math.min(0.8, ((window as any).__petModelX / window.innerWidth) * 2 - 1))
          gain.connect(pan); out = pan
        }
        out.connect(ctx.destination)
        this.currentSrc = src
        const engine = (window as any).__petLifeEngine
        try { engine?.speak?.(text, performance.now()) } catch {}
        src.onended = () => {
          try { engine?.stopSpeak?.(performance.now()) } catch {}
          if (this.currentSrc === src) this.currentSrc = null
          resolve()
        }
        src.start()
      })
    } catch {
      /* 被打断或合成失败，交给控制器继续推进 */
    }
  }

  private ensureAudioCtx(): AudioContext {
    if (!this.audioCtx) this.audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)()
    if (this.audioCtx.state === 'suspended') this.audioCtx.resume().catch(() => {})
    return this.audioCtx
  }

  private cancelPlaybackOnly(): void {
    try { this.synthAbort?.abort?.() } catch {}
    if (this.currentSrc) {
      try { this.currentSrc.onended = null; this.currentSrc.stop() } catch {}
      this.currentSrc = null
    }
    try { (window as any).__petLifeEngine?.stopSpeak?.(performance.now()) } catch {}
  }

  cancelSpeech(): void {
    this.ttsToken++
    this.cancelPlaybackOnly()
  }
}

// IIFE 全局
const client = new VoiceClient()
;(window as any).LuminaVoice = {
  start: (o?: VoiceStartOptions, h?: VoiceHooks) => client.start(o, h),
  stop: () => client.stop(),
  setOptions: (o: VoiceStartOptions) => client.setOptions(o),
  isRunning: () => client.isRunning(),
}
