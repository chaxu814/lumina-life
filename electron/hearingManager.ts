// ============================================================
// hearingManager.ts — 听觉系统管理器 (v2.5)
//
// 借鉴 Hiyori: VAD 语音活动检测 + 三模式听觉
//
// 三种模式:
//   dictation（语音输入）：转录文本合并后自动作为用户消息发送
//   passive  （陪伴监听）：转录缓存，AI 通过 get_transcript 工具按需读取
//   summary  （总结模式）：转录缓存，AI 可请求获取全文总结
//
// 依赖:
//   - Python STT 服务 (Whisper/Vosk)，通过 sttServerManager 管理
//   - 浏览器 Web Audio API (渲染进程) 捕获麦克风
// ============================================================

import { EventEmitter } from 'events'
import { ChildProcess, spawn } from 'child_process'
import { globalEventBus, BusEvents } from './eventBus'
import fs from 'fs'
import path from 'path'

// ═══════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════

export type AudioSource = 'mic' | 'system' | 'both'
export type HearingMode = 'dictation' | 'passive' | 'summary'

export interface HearingStatus {
  active: boolean
  source: AudioSource | null
  mode: HearingMode
  transcriptionCount: number
  sttServerRunning: boolean
}

export interface TranscriptionResult {
  text: string
  isFinal: boolean
  language: string
  confidence: number
  timestamp: number
  duration: number
}

export interface TranscriptEntry {
  text: string
  timestamp: number
  language: string
  confidence: number
}

// ═══════════════════════════════════════════════════════════
// 转录缓存
// ═══════════════════════════════════════════════════════════

class TranscriptBuffer {
  private entries: TranscriptEntry[] = []
  private static MAX = 500

  append(result: TranscriptionResult): void {
    this.entries.push({
      text: result.text,
      timestamp: result.timestamp,
      language: result.language,
      confidence: result.confidence,
    })
    // 超限淘汰最早的
    if (this.entries.length > TranscriptBuffer.MAX) {
      this.entries = this.entries.slice(-TranscriptBuffer.MAX)
    }
  }

  getFullText(): string {
    return this.entries.map(e => e.text).join(' ')
  }

  getRecentText(seconds: number): string {
    const cutoff = Date.now() - seconds * 1000
    return this.entries
      .filter(e => e.timestamp >= cutoff)
      .map(e => e.text)
      .join(' ')
  }

  /** 获取最近的完整句子 (以句号/问号/感叹号结束) */
  getRecentSentences(maxSentences: number): string {
    const full = this.getFullText()
    const sentences = full.split(/[。！？.!?\n]+/).filter(s => s.trim())
    return sentences.slice(-maxSentences).join('。')
  }

  get count(): number {
    return this.entries.length
  }

  clear(): void {
    this.entries = []
  }

  /** 判断是否有人说了话（有实质内容） */
  hasContent(minChars: number = 10): boolean {
    return this.getFullText().trim().length >= minChars
  }
}

// ═══════════════════════════════════════════════════════════
// 听觉系统
// ═══════════════════════════════════════════════════════════

export class HearingManager extends EventEmitter {
  private buffer = new TranscriptBuffer()
  private mode: HearingMode = 'passive'
  private source: AudioSource = 'mic'
  private active = false
  private sttProcess: ChildProcess | null = null
  private sttPort = 9882

  // ── 模式控制 ─────────────────────────────────────────

  async start(mode: HearingMode = 'passive', source: AudioSource = 'mic'): Promise<string> {
    if (this.active) this.stop()

    this.mode = mode
    this.source = source
    this.buffer.clear()

    try {
      // 尝试启动 STT 服务
      await this.startSTTServer()
      this.active = true
      const status = `听觉系统已启动 [${mode}/${source}]`

      this.emit('started', { mode, source })
      console.log(`[Hearing] ${status}`)
      return status
    } catch (err: any) {
      console.warn(`[Hearing] STT 服务启动失败: ${err.message}`)
      return `听觉系统启动失败: ${err.message}`
    }
  }

  stop(): void {
    if (!this.active) return

    // summary 模式: 停止前输出全文
    if (this.mode === 'summary' && this.buffer.hasContent()) {
      const text = this.buffer.getFullText()
      this.emit('summary-ready', text)
    }

    this.active = false
    this.stopSTTServer()
    this.emit('stopped')
    console.log('[Hearing] 已停止')
  }

  // ── 转录接收 ─────────────────────────────────────────

  /** 接收来自渲染进程的转录结果 */
  onTranscription(result: TranscriptionResult): void {
    this.buffer.append(result)

    this.emit('transcription', result)

    // dictation 模式: 遇到最终结果时，将近期文本发送给 AI
    if (this.mode === 'dictation' && result.isFinal) {
      const text = this.buffer.getRecentSentences(3)
      if (text.trim()) {
        this.emit('dictation-ready', text)
        this.buffer.clear()
      }
    }
  }

  // ── 转录查询 (供工具使用) ────────────────────────────

  getTranscript(options?: {
    mode?: 'full' | 'recent'
    seconds?: number
    maxSentences?: number
  }): string {
    const { mode = 'full', seconds = 60, maxSentences = 5 } = options || {}

    switch (mode) {
      case 'recent':
        return this.buffer.getRecentText(seconds)
      default:
        return maxSentences
          ? this.buffer.getRecentSentences(maxSentences)
          : this.buffer.getFullText()
    }
  }

  getStatus(): HearingStatus {
    return {
      active: this.active,
      source: this.active ? this.source : null,
      mode: this.mode,
      transcriptionCount: this.buffer.count,
      sttServerRunning: this.sttProcess !== null,
    }
  }

  switchMode(mode: HearingMode): void {
    this.mode = mode
    console.log(`[Hearing] 模式切换: ${mode}`)
  }

  // ── STT 服务管理 ─────────────────────────────────────

  private async startSTTServer(): Promise<void> {
    // 尝试查找 Python STT 服务
    const sttDir = path.join(process.cwd(), '..', 'stt-server')
    const mainPy = path.join(sttDir, 'main.py')

    if (!fs.existsSync(mainPy)) {
      throw new Error(`STT 服务未找到: ${mainPy}，请先安装 Whisper/Vosk`)
    }

    return new Promise((resolve, reject) => {
      try {
        this.sttProcess = spawn('python', [mainPy, '--port', String(this.sttPort)], {
          cwd: sttDir,
          stdio: ['pipe', 'pipe', 'pipe'],
        })

        let started = false
        const timeout = setTimeout(() => {
          if (!started) {
            reject(new Error('STT 服务启动超时'))
          }
        }, 15000)

        this.sttProcess.stdout?.on('data', (data) => {
          const output = data.toString()
          if (output.includes('listening') || output.includes('ready') || output.includes('Running')) {
            started = true
            clearTimeout(timeout)
            resolve()
          }
        })

        this.sttProcess.on('error', (err) => {
          clearTimeout(timeout)
          reject(err)
        })

        this.sttProcess.on('exit', (code) => {
          if (!started) {
            clearTimeout(timeout)
            reject(new Error(`STT 进程退出 (code ${code})`))
          }
        })
      } catch (err) {
        reject(err)
      }
    })
  }

  private stopSTTServer(): void {
    if (this.sttProcess) {
      this.sttProcess.kill('SIGTERM')
      this.sttProcess = null
    }
  }
}

// ═══════════════════════════════════════════════════════════
// 单例
// ═══════════════════════════════════════════════════════════

let _hearing: HearingManager | null = null

export function getHearingManager(): HearingManager {
  if (!_hearing) {
    _hearing = new HearingManager()
  }
  return _hearing
}
