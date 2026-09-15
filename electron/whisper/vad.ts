// ============================================================
// whisper/vad.ts — 🎙️ 语音活动检测状态机 (v0.2)
//
// 在实时麦克风电平上判断「什么时候开始说话 / 什么时候说完」，用于：
//   - 流式 STT 的自动断句（替代手动按键）
//   - 全双工打断（与 bargeIn 协同）
//   - 唤醒后只在有人声时才送识别，省算力
// 特性：自适应门限（接 NoiseGate）、起音确认（防一声咳嗽误触发）、
//      尾点判定（停顿 N ms 判说完）、前置缓冲（start 时回溯保留字首）、最短有效语音。
// 纯 TS、时间注入，可单测。
// ============================================================

import { analyzeFrame, NoiseGate, type LevelFrame } from './audioLevel'

export type VadState = 'silent' | 'speaking'

export interface VadConfig {
  /** 连续有声多久确认开始说 */
  startMs?: number
  /** 停顿多久判定说完 */
  endMs?: number
  /** 短于该时长的语音视为噪声（end 事件标 tooShort） */
  minUtteranceMs?: number
  /** 前置缓冲时长，保留字首不丢 */
  preRollMs?: number
  gate?: NoiseGate
}

export type VadEvent =
  | { type: 'start'; atMs: number; preRoll: Array<{ atMs: number; frame: LevelFrame }> }
  | { type: 'end'; startMs: number; endMs: number; durationMs: number; tooShort: boolean }

interface Buffered { atMs: number; frame: LevelFrame }

export class VoiceActivityDetector {
  state: VadState = 'silent'
  private startMs: number
  private endMs: number
  private minUtteranceMs: number
  private preRollMs: number
  private gate: NoiseGate
  private candidateStart: number | null = null
  private speechStart: number | null = null
  private lastUnvoicedAt: number | null = null
  private lastAt = 0
  private preRoll: Buffered[] = []

  constructor(cfg: VadConfig = {}) {
    this.startMs = cfg.startMs ?? 120
    this.endMs = cfg.endMs ?? 700
    this.minUtteranceMs = cfg.minUtteranceMs ?? 250
    this.preRollMs = cfg.preRollMs ?? 300
    this.gate = cfg.gate ?? new NoiseGate()
  }

  /** 喂入一帧 PCM（便捷封装：内部算电平） */
  feedPcm(samples: ArrayLike<number>, atMs: number): VadEvent | null {
    return this.feed(analyzeFrame(samples), atMs)
  }

  /** 喂入一帧已算好的电平 */
  feed(frame: LevelFrame, atMs: number): VadEvent | null {
    const voiced = this.gate.isVoiced(frame)
    this.gate.update(frame, voiced)

    // 维护前置环形缓冲
    this.preRoll.push({ atMs, frame })
    while (this.preRoll.length && atMs - this.preRoll[0].atMs > this.preRollMs) this.preRoll.shift()

    if (this.state === 'silent') {
      if (voiced) {
        if (this.candidateStart === null) this.candidateStart = atMs
        if (atMs - this.candidateStart >= this.startMs) {
          this.state = 'speaking'
          this.speechStart = this.candidateStart
          this.candidateStart = null
          this.lastUnvoicedAt = null
          return { type: 'start', atMs, preRoll: this.preRoll.slice() }
        }
      } else {
        this.candidateStart = null
      }
    } else {
      if (voiced) {
        this.lastUnvoicedAt = null
      } else {
        if (this.lastUnvoicedAt === null) this.lastUnvoicedAt = atMs
        if (atMs - this.lastUnvoicedAt >= this.endMs) {
          const start = this.speechStart ?? atMs
          const duration = this.lastUnvoicedAt - start
          const event: VadEvent = {
            type: 'end', startMs: start, endMs: this.lastUnvoicedAt,
            durationMs: Math.max(0, duration), tooShort: duration < this.minUtteranceMs,
          }
          this.state = 'silent'
          this.speechStart = null
          this.lastUnvoicedAt = null
          return event
        }
      }
    }
    this.lastAt = atMs
    return null
  }

  reset(): void {
    this.state = 'silent'
    this.candidateStart = null
    this.speechStart = null
    this.lastUnvoicedAt = null
    this.preRoll = []
  }
}
