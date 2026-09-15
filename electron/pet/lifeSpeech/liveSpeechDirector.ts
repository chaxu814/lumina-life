// ============================================================
// pet/lifeSpeech/liveSpeechDirector.ts — 🎬 全双工语音对话编排状态机 (v0.2)
//
// 串起「VAD 断句 → STT → LLM 流式分句 → TTS 边生成边播 → 随时打断」。
// 真实采集/识别/合成/网络在接线层完成；本类只做确定性的状态与动作决策
// （产出动作意图队列，接线层执行），因此可完整单测。
//
// 关键能力：
//   - 全双工打断：AI 正在说话时用户开口 → 立即 cancel_speech、清空待播、回到聆听；
//   - 代际作废：每次新发言递增 generation，上一轮迟到的 LLM token 自动丢弃，不会串台；
//   - 边生成边播：assistantChunk 经 SentenceSplitter 切句后立即 enqueue_speak。
// ============================================================

import { SentenceSplitter } from './sentenceSplitter'

export type DirectorState = 'idle' | 'listening' | 'thinking' | 'speaking'

export type DirectorAction =
  | { type: 'call_llm'; text: string; generation: number }
  | { type: 'enqueue_speak'; text: string; generation: number }
  | { type: 'cancel_speech' }
  | { type: 'start_listening' }
  | { type: 'stop_listening' }

export class LiveSpeechDirector {
  state: DirectorState = 'idle'
  private splitter = new SentenceSplitter()
  private generation = 0
  private currentGen = 0
  private pending = 0

  /** 待播放句子数 */
  get queueSize(): number { return this.pending }
  /** 当前代际（接线层随 call_llm 回传，用于丢弃过期响应） */
  get currentGeneration(): number { return this.currentGen }

  private backToListen(): DirectorAction[] {
    this.state = 'listening'
    return [{ type: 'start_listening' }]
  }

  /** 用户开始说话（VAD start）。AI 在说则打断 */
  userSpeechStart(): DirectorAction[] {
    const acts: DirectorAction[] = []
    if (this.state === 'speaking' || this.pending > 0) {
      acts.push({ type: 'cancel_speech' })
      this.pending = 0
    }
    this.generation++
    this.splitter = new SentenceSplitter()
    if (this.state !== 'listening') acts.push({ type: 'start_listening' })
    this.state = 'listening'
    return acts
  }

  /** 用户说完并得到识别文本 */
  userUtterance(text: string): DirectorAction[] {
    const t = text.trim()
    if (!t) return this.backToListen()
    this.generation++
    this.currentGen = this.generation
    this.splitter = new SentenceSplitter()
    this.state = 'thinking'
    return [{ type: 'stop_listening' }, { type: 'call_llm', text: t, generation: this.currentGen }]
  }

  /** LLM 增量 token（可携带 generation；过期代际直接忽略） */
  assistantChunk(text: string, generation?: number): DirectorAction[] {
    if (generation !== undefined && generation !== this.currentGen) return []
    const acts: DirectorAction[] = []
    for (const s of this.splitter.push(text)) {
      this.pending++
      acts.push({ type: 'enqueue_speak', text: s, generation: this.currentGen })
    }
    if (acts.length && this.state !== 'speaking') this.state = 'speaking'
    return acts
  }

  /** LLM 输出结束，吐出残余半句 */
  assistantEnd(generation?: number): DirectorAction[] {
    if (generation !== undefined && generation !== this.currentGen) return []
    const acts: DirectorAction[] = []
    const rest = this.splitter.flush()
    if (rest) {
      this.pending++
      acts.push({ type: 'enqueue_speak', text: rest, generation: this.currentGen })
      if (this.state !== 'speaking') this.state = 'speaking'
    }
    return acts
  }

  /** 一句 TTS 播放结束 */
  sentenceSpoken(): DirectorAction[] {
    this.pending = Math.max(0, this.pending - 1)
    if (this.pending === 0 && this.state === 'speaking') return this.backToListen()
    return []
  }

  reset(): void {
    this.state = 'idle'
    this.splitter = new SentenceSplitter()
    this.generation = 0
    this.currentGen = 0
    this.pending = 0
  }
}
