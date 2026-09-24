import { describe, it, expect, vi } from 'vitest'
import {
  VoiceShortcuts,
  DEFAULT_PTT_ACCELERATOR,
  RESERVED_ACCELERATORS,
  type GlobalShortcutLike,
} from '../electron/voice/voiceShortcuts'

/** 内存版 globalShortcut mock */
function makeGS(): GlobalShortcutLike & { handlers: Map<string, () => void> } {
  const registered = new Map<string, () => void>()
  return {
    handlers: registered,
    register: vi.fn((accel: string, cb?: () => void) => {
      if (registered.has(accel)) {return false}
      registered.set(accel, cb ?? (() => {}))
      return true
    }),
    unregister: vi.fn((accel: string) => {registered.delete(accel)}),
    isRegistered: vi.fn((accel: string) => registered.has(accel)),
  }
}

describe('VoiceShortcuts PTT 快捷键', () => {
  it('默认加速器为 Ctrl+Space', () => {
    expect(DEFAULT_PTT_ACCELERATOR).toBe('Ctrl+Space')
  })

  it('注册成功后 isRegistered 为 true，并绑定按下回调', () => {
    const gs = makeGS()
    const sc = new VoiceShortcuts(gs)
    const onDown = vi.fn(); const onUp = vi.fn()
    const ok = sc.register({ onPTTDown: onDown, onPTTUp: onUp })
    expect(ok).toBe(true)
    expect(sc.isRegistered()).toBe(true)
    expect(gs.register).toHaveBeenCalledWith('Ctrl+Space', expect.any(Function))

    // 触发按下 → onPTTDown
    gs.handlers.get('Ctrl+Space')!()
    expect(onDown).toHaveBeenCalledTimes(1)
  })

  it('与现有快捷键冲突时拒绝注册', () => {
    const gs = makeGS()
    const sc = new VoiceShortcuts(gs, 'Alt+Space')
    expect(sc.isConflicting()).toBe(true)
    const ok = sc.register({ onPTTDown: vi.fn(), onPTTUp: vi.fn() })
    expect(ok).toBe(false)
    expect(sc.isRegistered()).toBe(false)
  })

  it('RESERVED 覆盖 main.ts 已注册的全部快捷键', () => {
    for (const accel of ['Ctrl+Shift+L', 'Alt+Space', 'Alt+Shift+L', 'Ctrl+Alt+X', 'F12', 'CommandOrControl+Shift+R']) {
      expect(RESERVED_ACCELERATORS.has(accel)).toBe(true)
    }
  })

  it('全局注册失败（被占用）返回 false', () => {
    const gs = makeGS()
    gs.register = vi.fn(() => false)
    const sc = new VoiceShortcuts(gs)
    const ok = sc.register({ onPTTDown: vi.fn(), onPTTUp: vi.fn() })
    expect(ok).toBe(false)
  })

  it('unregister 后 globalShortcut 被注销', () => {
    const gs = makeGS()
    const sc = new VoiceShortcuts(gs)
    sc.register({ onPTTDown: vi.fn(), onPTTUp: vi.fn() })
    sc.unregister()
    expect(sc.isRegistered()).toBe(false)
    expect(gs.unregister).toHaveBeenCalledWith('Ctrl+Space')
  })

  it('setAccelerator 重新注册，冲突时失败', () => {
    const gs = makeGS()
    const sc = new VoiceShortcuts(gs, 'Ctrl+Space')
    sc.register({ onPTTDown: vi.fn(), onPTTUp: vi.fn() })
    // 改成冲突键
    const ok = sc.setAccelerator('F12', { onPTTDown: vi.fn(), onPTTUp: vi.fn() })
    expect(ok).toBe(false)
    expect(sc.isRegistered()).toBe(false)
    expect(sc.accelerator).toBe('F12')
  })

  it('接入 key-up 检测器后，松开触发 onPTTUp', async () => {
    vi.useFakeTimers()
    try {
      const gs = makeGS()
      const sc = new VoiceShortcuts(gs)
      let held = true
      sc.setKeyUpDetector(() => held)
      const onDown = vi.fn(); const onUp = vi.fn()
      sc.register({ onPTTDown: onDown, onPTTUp: onUp })

      gs.handlers.get('Ctrl+Space')!() // 按下
      expect(onDown).toHaveBeenCalledTimes(1)

      // 仍按住：onUp 不触发
      await vi.advanceTimersByTimeAsync(200)
      expect(onUp).not.toHaveBeenCalled()

      // 松开
      held = false
      await vi.advanceTimersByTimeAsync(200)
      expect(onUp).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('按住期间系统自动重复触发不重复 onPTTDown', async () => {
    const gs = makeGS()
    const sc = new VoiceShortcuts(gs)
    const onDown = vi.fn(); const onUp = vi.fn()
    sc.register({ onPTTDown: onDown, onPTTUp: onUp })
    const cb = gs.handlers.get('Ctrl+Space')!
    cb(); cb(); cb() // OS 自动重复
    expect(onDown).toHaveBeenCalledTimes(1)
  })
})
