// ============================================================
// whisper/wakeWord.ts — 🔔 唤醒词门控 (v0.2)
//
// 全双工常开麦克风时，用唤醒词区分「跟桌宠说话」与「和别人聊天的背景声」。
// 本实现走 STT partial 文本关键词匹配（无需额外模型、离线、零成本）：
//   - 可开关（默认关，不强制唤醒词）；
//   - 命中关键词进入「聆听会话窗口」，窗口内无需重复唤醒；
//   - 冷却防抖；拉丁词忽略大小写、容忍标点。
// 高精度的本地热词检测（如 openWakeWord / porcupine）作为未来适配点，
// 只需在接线层把检测结果映射到 wake()。
// 纯 TS、时间注入，可单测。
// ============================================================

export interface WakeWordConfig {
  enabled?: boolean
  keywords?: string[]
  /** 两次唤醒的最小间隔 */
  cooldownMs?: number
  /** 唤醒后保持免唤醒聆听的时长 */
  sessionMs?: number
}

export const DEFAULT_WAKE_KEYWORDS = ['lumina', '露娜', '小光', '小灯']

export class WakeWordGate {
  enabled: boolean
  private keywords: string[]
  private cooldownMs: number
  sessionMs: number
  private lastWakeAt: number | null = null
  private sessionUntil = 0
  wakeCount = 0

  constructor(cfg: WakeWordConfig = {}) {
    this.enabled = cfg.enabled ?? false
    this.keywords = (cfg.keywords && cfg.keywords.length ? cfg.keywords : DEFAULT_WAKE_KEYWORDS)
    this.cooldownMs = cfg.cooldownMs ?? 1500
    this.sessionMs = cfg.sessionMs ?? 12_000
  }

  private normalize(text: string): string {
    return text.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '')
  }

  /** 返回命中的关键词（原始关键词），否则 null */
  matchKeyword(text: string): string | null {
    const n = this.normalize(text)
    if (!n) {return null}
    for (const kw of this.keywords) {
      if (n.includes(this.normalize(kw))) {return kw}
    }
    return null
  }

  isSessionActive(now: number): boolean {
    return now < this.sessionUntil
  }

  /** 尝试唤醒；命中且过冷却返回 true 并开启会话窗口 */
  wake(text: string, now: number): { waked: boolean; keyword?: string } {
    const kw = this.matchKeyword(text)
    if (!kw) {return { waked: false }}
    if (this.lastWakeAt !== null && now - this.lastWakeAt < this.cooldownMs) {
      return { waked: false, keyword: kw }
    }
    this.lastWakeAt = now
    this.sessionUntil = now + this.sessionMs
    this.wakeCount++
    return { waked: true, keyword: kw }
  }

  /**
   * 该句是否应交给对话：
   * 关闭唤醒词→放行；会话窗口内→放行；句中含唤醒词→唤醒并放行；否则忽略。
   */
  shouldProcess(text: string, now: number): boolean {
    if (!this.enabled) {return true}
    if (this.isSessionActive(now)) {return true}
    const r = this.wake(text, now)
    return r.waked || (r.keyword !== undefined && this.isSessionActive(now))
  }

  /** 主动结束聆听会话 */
  endSession(): void { this.sessionUntil = 0 }

  setEnabled(on: boolean): void {
    this.enabled = on
    if (!on) {this.sessionUntil = 0}
  }
}
