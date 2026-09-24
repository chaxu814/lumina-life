// ============================================================
// electron/voice/voiceLoopWiring.ts — 🔌 语音闭环真实接线
//
// 把 VoiceLoop 状态机接到项目已有模块：
//   录音：sox/ffmpeg 子进程（PTT 按住开始、松开 kill）
//   STT ：electron/whisper/transcriber.ts（WhisperTranscriber，复用）
//   意图：electron/pet/intentDispatcher.ts 的 petVoiceChat（复用）
//   TTS ：POST Python edge-tts 节点 → 把音频 dataURL 发给渲染层播放
//
// 真实麦克风/STT/TTS 在 headless 环境无法实机验证，
// VoiceLoop 本身用 mock 单测；本文件只做「最后一公里」接线。
// ============================================================

import { spawn, type ChildProcess } from 'child_process'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'
import { existsSync, unlinkSync } from 'fs'
import type { VoiceLoopDeps } from './voiceLoop'

export interface WiringHooks {
  /** 把 TTS 音频 dataURL 交给渲染层播放 */
  sendAudioToRenderer?: (dataUrl: string) => void
  /** TTS 播放结束通知渲染层停止（打断用） */
  stopRendererAudio?: () => void
}

/** PTT 录音：按住开始 sox/ffmpeg 录音，松开 kill 进程落盘 */
class PTTRecorder {
  private proc: ChildProcess | null = null
  private filePath = ''
  private startedAt = 0

  start(): void {
    this.filePath = join(tmpdir(), `lumina_ptt_${randomUUID()}.wav`)
    this.startedAt = Date.now()
    // 优先 sox rec；不可用时退 ffmpeg（与 whisper/recorder.ts 一致）
    const args = ['-b', '16', '-c', '1', '-r', '16000', this.filePath]
    this.proc = spawn('rec', args, { stdio: 'ignore' })
    this.proc.on('error', () => {
      // sox 不可用 → ffmpeg dshow
      const ffmpeg = spawn('ffmpeg', [
        '-f', 'dshow', '-i', 'audio=Microphone',
        '-ar', '16000', '-ac', '1', '-sample_fmt', 's16',
        '-t', '120', '-y', this.filePath,
      ], { stdio: 'ignore' })
      this.proc = ffmpeg
    })
  }

  async stop(): Promise<{ audioPath: string; duration: number }> {
    const duration = (Date.now() - this.startedAt) / 1000
    if (this.proc) {
      this.proc.kill('SIGTERM')
      this.proc = null
    }
    // 等文件落盘
    await new Promise((r) => setTimeout(r, 120))
    if (!this.filePath || !existsSync(this.filePath)) {
      throw new Error('未录到音频（请检查麦克风与 sox/ffmpeg）')
    }
    return { audioPath: this.filePath, duration }
  }

  cleanup(): void {
    try { this.proc?.kill('SIGTERM') } catch { /* noop */ }
    this.proc = null
    if (this.filePath && existsSync(this.filePath)) {
      try { unlinkSync(this.filePath) } catch { /* noop */ }
    }
  }
}

/**
 * 组装 VoiceLoop 真实依赖。
 * @param hooks 渲染层音频回调（由主进程把 TTS 结果发回窗口）
 */
export async function createVoiceLoopDeps(hooks: WiringHooks = {}): Promise<VoiceLoopDeps> {
  const recorder = new PTTRecorder()
  const { WhisperTranscriber } = await import('../whisper/transcriber')
  const { petVoiceChat } = await import('../pet/intentDispatcher')
  const ttsUrl = process.env.LUMINA_TTS_URL || 'http://127.0.0.1:18927/tts'

  return {
    startRecording: () => recorder.start(),
    stopRecording: () => recorder.stop(),
    transcribe: async (audioPath) => {
      const tr = WhisperTranscriber.getInstance()
      const res = await tr.transcribe(audioPath, { language: 'zh' })
      try { unlinkSync(audioPath) } catch { /* noop */ }
      return res.text
    },
    dispatch: async (text) => {
      const r = await petVoiceChat(text)
      return r.ok ? r.text : (r.error ? `抱歉，${r.error}` : '')
    },
    speak: async (text) => {
      const res = await fetch(ttsUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voice: 'zh-CN-XiaoxiaoNeural', speed: 1.0 }),
        signal: AbortSignal.timeout(30000),
      })
      if (!res.ok) {throw new Error(`TTS 服务返回 ${res.status}`)}
      const data: any = await res.json()
      const hex: string = typeof data.audio === 'string' ? data.audio : ''
      const buf = Buffer.from(hex, 'hex')
      if (buf.length < 100) {throw new Error('TTS 音频过短')}
      const dataUrl = `data:audio/mpeg;base64,${buf.toString('base64')}`
      hooks.sendAudioToRenderer?.(dataUrl)
      // 等待渲染层播完（通过 stopRendererAudio 在打断/播完时释放）
      await new Promise<void>((resolve) => {
        ;(speakWaiters as any).push(resolve)
      })
    },
    cancelSpeak: () => {
      hooks.stopRendererAudio?.()
      const waiters = speakWaiters as unknown as Array<() => void>
      while (waiters.length) {waiters.shift()!()}
    },
  }
}

// speak() 等待「渲染层播完」的 resolve 队列
const speakWaiters: Array<() => void> = []

/** 渲染层通知某段 TTS 播完（打断/自然结束都调用） */
export function notifyRendererSpeakDone(): void {
  const waiters = speakWaiters as unknown as Array<() => void>
  while (waiters.length) {
    const resolve = waiters.shift()
    if (resolve) {resolve()}
  }
}
