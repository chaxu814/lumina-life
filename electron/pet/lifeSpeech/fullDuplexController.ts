// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// pet/lifeSpeech/fullDuplexController.ts — 🎙 全双工对话编排器（渲染侧）
//
// 主进程的 LiveSpeechDirector 只做「状态机 + 动作决策」，通过 IPC
// （pet:live-speech:event）同步返回 actions；本控制器在渲染侧把这些动作
// 真正执行出来：
//   call_llm       → 调 LLM 拿回复（按代际作废）
//   enqueue_speak  → 逐句 TTS（边生成边播）
//   sentence_spoken→ 一句播完回灌导演，队列空了回到聆听
//   cancel_speech  → 立即打断（barge-in：AI 说话时用户开口）
//
// 不依赖 DOM / Electron，全部副作用走 FullDuplexBridge 注入，便于单测。
// ============================================================

export type DirectorAction =
  | { type: 'call_llm'; text: string; generation: number }
  | { type: 'enqueue_speak'; text: string; generation: number }
  | { type: 'cancel_speech' }
  | { type: 'start_listening' }
  | { type: 'stop_listening' }

export type DuplexState = 'idle' | 'listening' | 'thinking' | 'speaking'

export interface DirectorEventResult {
  actions: DirectorAction[]
  generation: number
  queueSize: number
}

export interface FullDuplexBridge {
  /** 向主进程 LiveSpeechDirector 注入事件，拿回本轮动作 */
  sendEvent(params: { type: string; text?: string; generation?: number }): Promise<DirectorEventResult>
  /** 跑一次自然口语对话，返回纯文本回复（不要 JSON intent） */
  callLlm(text: string, generation: number): Promise<string>
  /** 播放一句 TTS；被打断时必须 resolve（或 reject），不能永久挂住 */
  speakSentence(text: string, generation: number): Promise<void>
  /** 立即停掉当前 TTS 并清空待播 */
  cancelSpeech(): void
  /** 可选：状态变化（用于 UI 指示灯） */
  onState?(state: DuplexState): void
  /** 可选：收到识别中的 partial 文本（用于气泡"聆听中…"） */
  onPartial?(text: string): void
  /** 可选：致命错误（Web Speech 不可用 / 网络不通） */
  onError?(msg: string): void
}

/** 去除 markdown/引号/动作括号，避免把星号、舞台提示念出来 */
export function cleanSpokenReply(raw: string): string {
  if (!raw) {return ''}
  let t = String(raw)
  // 去掉 ``` 代码块
  t = t.replace(/```[\s\S]*?```/g, '，')
  // 去掉粗体/斜体 markdown 标记
  t = t.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\*([^*]+)\*/g, '$1')
  // 去掉 *动作* 、（动作）、【】这类舞台提示（中文括号/方括号）
  t = t.replace(/（[^）]*）/g, '').replace(/\([^)]*\)/g, ' ')
  t = t.replace(/【[^】]*】/g, '')
  // 去掉 markdown 标题/列表符号
  t = t.replace(/^\s{0,3}#{1,6}\s+/gm, '').replace(/^\s*[-*+]\s+/gm, '')
  // 折叠空白
  t = t.replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim()
  return t
}

export class FullDuplexController {
  private bridge: FullDuplexBridge
  private enabled = false
  /** 最近一次从导演拿到的代际（过期响应据此丢弃） */
  private latestGen = 0
  /** 打断序号：每次 cancel_speech 自增，让正在逐句播放的动作循环立即作废 */
  private speechSeq = 0
  /** 当前执行中的代际（用于打断后让进行中的 TTS/LLM 放弃） */
  private running: Promise<void> = Promise.resolve()

  constructor(bridge: FullDuplexBridge) {
    this.bridge = bridge
  }

  setEnabled(on: boolean): void {
    this.enabled = on
    if (on) {
      this.bridge.onState?.('listening')
    } else {
      this.speechSeq++
      this.bridge.cancelSpeech()
      this.bridge.onState?.('idle')
      this.sendEvent({ type: 'reset' }).catch(() => {})
    }
  }

  isEnabled(): boolean { return this.enabled }

  /** VAD/STT 检测到用户开始说话（AI 在说则打断） */
  async userStarted(): Promise<void> {
    if (!this.enabled) {return}
    const r = await this.sendEvent({ type: 'user_start' })
    await this.runActions(r.actions)
  }

  /** 识别到中间结果（仅做 UI 提示，不进状态机） */
  partial(text: string): void {
    if (!this.enabled) {return}
    this.bridge.onPartial?.(text)
  }

  /** 一句话识别完成 */
  async userUtterance(text: string): Promise<void> {
    if (!this.enabled) {return}
    const t = (text || '').trim()
    if (!t) {
      // 空识别：回到聆听
      const r = await this.sendEvent({ type: 'user_utterance', text: '' })
      await this.runActions(r.actions)
      return
    }
    const r = await this.sendEvent({ type: 'user_utterance', text: t })
    // 串行执行，避免多轮动作交叉（打断代际由导演保证）
    this.running = this.runActions(r.actions)
    await this.running
  }

  /** 手动重置 */
  async reset(): Promise<void> {
    this.speechSeq++
    this.bridge.cancelSpeech()
    const r = await this.sendEvent({ type: 'reset' })
    this.latestGen = r.generation
    if (this.enabled) {this.bridge.onState?.('listening')}
  }

  private async sendEvent(params: { type: string; text?: string; generation?: number }): Promise<DirectorEventResult> {
    const r = await this.bridge.sendEvent(params)
    if (typeof r.generation === 'number') {this.latestGen = r.generation}
    return r
  }

  /** 该代际是否已被新发言作废 */
  private stale(gen: number): boolean {
    return gen !== this.latestGen
  }

  private async runActions(actions: DirectorAction[]): Promise<void> {
    const seq = this.speechSeq
    for (const a of actions) {
      if (a.type === 'cancel_speech') {
        // 打断：作废当前逐句播放循环（seq 自增），并停掉真实音频
        this.speechSeq++
        this.bridge.cancelSpeech()
        continue
      }
      if (a.type === 'start_listening') { this.bridge.onState?.('listening'); continue }
      if (a.type === 'stop_listening') { this.bridge.onState?.('thinking'); continue }
      if (a.type === 'call_llm') {
        await this.runLlm(a.text, a.generation, seq)
        if (this.speechSeq !== seq) {return} // 等待期间被打断
        continue
      }
      if (a.type === 'enqueue_speak') {
        await this.runSpeak(a.text, a.generation, seq)
        if (this.speechSeq !== seq) {return} // 等待期间被打断，后续句子全部丢弃
        continue
      }
    }
  }

  private async runLlm(text: string, gen: number, seq: number): Promise<void> {
    this.bridge.onState?.('thinking')
    let reply = ''
    try {
      reply = await this.bridge.callLlm(text, gen)
    } catch (e: any) {
      this.bridge.onError?.(e?.message || '对话失败')
      return
    }
    if (this.stale(gen) || this.speechSeq !== seq) {return} // 已被新发言/打断作废
    reply = cleanSpokenReply(reply)
    if (!reply) {
      this.bridge.onState?.('listening')
      return
    }
    // 整段回复喂给导演，由 SentenceSplitter 切成可播句子
    const r1 = await this.sendEvent({ type: 'assistant_chunk', text: reply, generation: gen })
    if (this.stale(gen) || this.speechSeq !== seq) {return}
    const r2 = await this.sendEvent({ type: 'assistant_end', generation: gen })
    if (this.stale(gen) || this.speechSeq !== seq) {return}
    await this.runActions([...r1.actions, ...r2.actions])
  }

  private async runSpeak(text: string, gen: number, seq: number): Promise<void> {
    if (this.stale(gen) || this.speechSeq !== seq) {return}
    this.bridge.onState?.('speaking')
    try {
      await this.bridge.speakSentence(text, gen)
    } catch {
      /* 被打断或播放失败：继续推进，避免卡死队列 */
    }
    if (this.stale(gen) || this.speechSeq !== seq) {return}
    const r = await this.sendEvent({ type: 'sentence_spoken' })
    await this.runActions(r.actions)
  }
}
