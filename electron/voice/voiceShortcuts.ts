// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// electron/voice/voiceShortcuts.ts — ⌨️ PTT 全局快捷键注册
//
// 用 Electron globalShortcut 注册「按住说话」快捷键。
// 注意：globalShortcut 只在「按下」时回调，不区分松开。
//   - 按下 → onPTTDown()（开始录音）
//   - 松开 → 通过可注入的 key-up 检测器轮询触发 onPTTUp()；
//     未接入原生 key-up hook（如 uiohook-napi）时，松开由
//     「再次按下 / VAD 静音 / 最大时长」兜底结束。
//
// 与现有快捷键冲突检测：main.ts 已注册的加速器一律保留。
// 纯逻辑 + 依赖注入，globalShortcut 通过构造函数传入，便于单测。
// ============================================================

export interface GlobalShortcutLike {
  register(accelerator: string, callback?: () => void): boolean
  unregister(accelerator: string): void
  isRegistered(accelerator: string): boolean
}

/** 应用已占用的全局快捷键（与 electron/main.ts registerHotkeys 对齐） */
export const RESERVED_ACCELERATORS: ReadonlySet<string> = new Set([
  'Ctrl+Shift+L',      // 显示/隐藏主窗口
  'Alt+Space',         // 全局呼出/隐藏
  'Alt+Shift+L',       // 截图分析
  'Ctrl+Alt+X',        // Computer Use 急停
  'F12',               // DevTools
  'CommandOrControl+Shift+R', // 桌宠重载
])

export const DEFAULT_PTT_ACCELERATOR = 'Ctrl+Space'

export interface PTTHandlers {
  onPTTDown: () => void
  onPTTUp: () => void
}

export class VoiceShortcuts {
  accelerator: string
  private registered = false
  private pollTimer: ReturnType<typeof setInterval> | null = null
  /** 返回当前物理按键是否仍被按住（接入 uiohook-napi 后实现；默认 null=不轮询） */
  private keyUpDetector: (() => boolean) | null = null

  constructor(
    private readonly gs: GlobalShortcutLike,
    accelerator: string = DEFAULT_PTT_ACCELERATOR,
  ) {
    this.accelerator = accelerator
  }

  /** 是否与现有快捷键冲突 */
  isConflicting(accel: string = this.accelerator): boolean {
    return RESERVED_ACCELERATORS.has(accel)
  }

  /**
   * 注册 PTT 快捷键。冲突或注册失败返回 false。
   * 按下 → onPTTDown；松开（检测器）→ onPTTUp。
   */
  register(handlers: PTTHandlers): boolean {
    if (this.registered) {this.unregister()}
    if (this.isConflicting()) {
      console.warn(`[VoiceShortcuts] ⚠️ PTT 快捷键 ${this.accelerator} 与现有快捷键冲突，未注册`)
      return false
    }

    // globalShortcut 只给「按下」。用 holding 状态区分首次按下与系统自动重复。
    let holding = false
    const ok = this.gs.register(this.accelerator, () => {
      if (!holding) {
        holding = true
        handlers.onPTTDown()
        this.startPolling(handlers, () => { holding = false })
      }
    })
    if (!ok) {
      console.warn(`[VoiceShortcuts] ⚠️ 全局注册 ${this.accelerator} 失败（被系统/其他应用占用？）`)
      return false
    }
    this.registered = true
    return true
  }

  private startPolling(handlers: PTTHandlers, onReleased: () => void): void {
    if (!this.keyUpDetector) {return} // 未接入 key-up 检测，靠再次按下/超时兜底
    this.stopPolling()
    this.pollTimer = setInterval(() => {
      try {
        if (!this.keyUpDetector || !this.keyUpDetector()) {
          this.stopPolling()
          onReleased()
          handlers.onPTTUp()
        }
      } catch { /* 检测器异常则继续轮询 */ }
    }, 80)
    if (this.pollTimer && typeof (this.pollTimer as any).unref === 'function') {
      (this.pollTimer as any).unref()
    }
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }

  /** 注入物理按键状态检测器（true=仍按住，false=已松开） */
  setKeyUpDetector(detector: (() => boolean) | null): void {
    this.keyUpDetector = detector
  }

  /** 修改快捷键并重新注册；返回是否成功 */
  setAccelerator(accel: string, handlers: PTTHandlers): boolean {
    this.unregister()
    this.accelerator = accel
    return this.register(handlers)
  }

  unregister(): void {
    this.stopPolling()
    if (this.registered) {
      try { this.gs.unregister(this.accelerator) } catch { /* noop */ }
      this.registered = false
    }
  }

  isRegistered(): boolean {
    return this.registered
  }
}
