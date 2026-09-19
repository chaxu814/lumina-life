// ============================================================
// pet/vision/presence.ts — 📷 摄像头「在场 / 注视 / 表情」隐私状态机 (v0.2)
//
// 让桌宠能感知「你在不在、有没有看它、大概什么表情」，但隐私默认最保守：
//   - 默认关闭、未授权；必须显式 authorize 才进入可用，且不会自动开始采样；
//   - 仅允许本地处理（localOnly），拒绝任何把画面外发的配置；
//   - 采样期间指示灯必须亮（indicatorOn）；撤销授权立即停止并熄灯；
//   - 真实人脸检测（检测在场/视线/表情）在接线层注入结果，本模块不绑定具体模型。
// 纯 TS、时间注入，可单测。
// ============================================================

export type PresenceState = 'disabled' | 'off' | 'on'

export interface DetectionResult {
  present: boolean
  lookingAtScreen?: boolean
  expression?: string
  confidence?: number
}

export interface PresenceConfig {
  authorized?: boolean
  /** 是否仅本地处理；必须为 true 才允许开启（默认 true） */
  localOnly?: boolean
  sampleIntervalMs?: number
}

export class PresenceMonitor {
  state: PresenceState = 'disabled'
  localOnly: boolean
  sampleIntervalMs: number
  private authorized = false
  private lastSampleAt: number | null = null
  private lastPresentAt: number | null = null
  private lastLookingAt: number | null = null
  private lastExpression: string | null = null
  private presentCount = 0
  private sampleCount = 0
  blockedReason: string | null = null

  constructor(cfg: PresenceConfig = {}) {
    this.localOnly = cfg.localOnly ?? true
    this.sampleIntervalMs = cfg.sampleIntervalMs ?? 1500
    if (cfg.authorized && this.localOnly) {
      this.authorized = true
      this.state = 'off'
    }
  }

  get isAuthorized(): boolean { return this.authorized }
  /** 采样指示灯：仅在 on 时亮 */
  get indicatorOn(): boolean { return this.state === 'on' }

  /** 显式授权（不自动开始采样） */
  authorize(): void {
    this.authorized = true
    if (this.state === 'disabled') {this.state = 'off'}
    this.blockedReason = null
  }

  /** 撤销授权：立即停止、熄灯、清空时间戳 */
  revoke(): void {
    this.authorized = false
    this.state = 'disabled'
    this.lastSampleAt = null
  }

  /** 开始采样；未授权或非本地处理则拒绝 */
  enable(now: number): boolean {
    this.blockedReason = null
    if (!this.authorized) { this.blockedReason = '未授权摄像头'; return false }
    if (!this.localOnly) { this.blockedReason = '拒绝：摄像头数据必须仅本地处理'; return false }
    this.state = 'on'
    this.lastSampleAt = null // 允许立即采一帧
    void now
    return true
  }

  /** 暂停采样（保持授权） */
  disable(): void {
    if (this.authorized) {this.state = 'off'}
    else {this.state = 'disabled'}
  }

  /** 是否到了采样时刻（未授权/未开启恒为 false） */
  shouldSample(now: number): boolean {
    if (this.state !== 'on') {return false}
    if (this.lastSampleAt === null) {return true}
    return now - this.lastSampleAt >= this.sampleIntervalMs
  }

  /** 接线层完成一次采样后回调，推进节流时钟 */
  markSampled(now: number): void { this.lastSampleAt = now; this.sampleCount++ }

  /** 喂入人脸检测结果（仅 on 状态接受） */
  feedDetection(r: DetectionResult, now: number): boolean {
    if (this.state !== 'on') {return false}
    if (r.present) {
      this.lastPresentAt = now
      this.presentCount++
      if (r.lookingAtScreen) {this.lastLookingAt = now}
      if (r.expression) {this.lastExpression = r.expression}
    }
    return true
  }

  /** 最近 withinMs 内用户是否在场（默认 10 秒） */
  isUserPresent(now: number, withinMs = 10_000): boolean {
    return this.lastPresentAt !== null && now - this.lastPresentAt <= withinMs
  }

  /** 最近 withinMs 内是否在看屏幕/桌宠 */
  isLookingAt(now: number, withinMs = 8_000): boolean {
    return this.lastLookingAt !== null && now - this.lastLookingAt <= withinMs
  }

  get expression(): string | null { return this.lastExpression }
  get stats() {
    return {
      state: this.state, presentCount: this.presentCount, sampleCount: this.sampleCount,
      indicatorOn: this.indicatorOn, localOnly: this.localOnly,
    }
  }
}
