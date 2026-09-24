// ============================================================
// tests/gaming/focusRobustness.test.ts — 焦点鲁棒性
//
// 全部 mock getAdapter / exec / sleep，不真实操作系统窗口。
// 覆盖：
//   - 适配器聚焦成功且标题匹配 → 直接成功，不走 AppActivate 兜底
//   - 标题不匹配 → 重试一次 focusWindow
//   - 适配器聚焦始终不命中 → 回退 PowerShell AppActivate
//   - 空标题 → 返回 false
//   - 聚焦后会发 ESC 关闭干扰弹窗
// ============================================================

import { describe, it, expect, vi } from 'vitest'
import { focusWindowRobust, type FocusAdapterLike } from '../../electron/gaming/focus'

/** 立即 resolve 的 sleep（测试不真等） */
const noSleep = async () => {}

function makeAdapter(opts: {
  focusWindow?: (t: string) => Promise<boolean>
  activeTitle?: string
}): FocusAdapterLike {
  return {
    focusWindow: opts.focusWindow || vi.fn(async () => true),
    getActiveWindow: vi.fn(async () => ({ title: opts.activeTitle || '', processName: '' })),
  }
}

describe('focusWindowRobust', () => {
  it('空标题直接返回 false', async () => {
    const exec = vi.fn(async () => 'OK')
    const r = await focusWindowRobust('   ', { exec, sleep: noSleep })
    expect(r).toBe(false)
    expect(exec).not.toHaveBeenCalled()
  })

  it('适配器聚焦后标题已匹配 → 成功，不调用 AppActivate', async () => {
    const adapter = makeAdapter({ activeTitle: 'Minecraft 1.20.4' })
    const focusWindow = adapter.focusWindow as ReturnType<typeof vi.fn>
    const exec = vi.fn(async () => 'OK')
    // 初始前台标题就已经是游戏窗口 → currentTitleMatch 第一轮即 true
    const r = await focusWindowRobust('Minecraft', {
      getAdapter: async () => adapter,
      exec,
      sleep: noSleep,
    })
    expect(r).toBe(true)
    // 已经匹配，不需要再调 focusWindow
    expect(focusWindow).not.toHaveBeenCalled()
    // 不应走 AppActivate 兜底（exec 只用于关弹窗 ESC）
    const appActivateCalls = exec.mock.calls.filter(c => String(c[1]).includes('AppActivate'))
    expect(appActivateCalls.length).toBe(0)
  })

  it('标题不匹配 → 重试一次 focusWindow，仍不匹配则回退 AppActivate', async () => {
    let callCount = 0
    const adapter = makeAdapter({
      activeTitle: 'Chrome', // 前台始终是 Chrome，从不匹配 Minecraft
    })
    const focusWindow = vi.fn(async () => { callCount++; return false })
    adapter.focusWindow = focusWindow
    const exec = vi.fn(async () => 'OK')

    const r = await focusWindowRobust('Minecraft', {
      getAdapter: async () => adapter,
      exec,
      sleep: noSleep,
    })
    // focusWindow 调了 2 次（重试一次）
    expect(focusWindow).toHaveBeenCalledTimes(2)
    // 走了 AppActivate 兜底
    const appActivateCalls = exec.mock.calls.filter(c => String(c[1]).includes('AppActivate'))
    expect(appActivateCalls.length).toBe(1)
    // AppActivate 返回 OK（非 ERR:）→ activateOk=true
    expect(r).toBe(true)
  })

  it('适配器无 focusWindow → 直接用 PowerShell AppActivate 兜底', async () => {
    const adapter: FocusAdapterLike = {
      getActiveWindow: vi.fn(async () => ({ title: 'Chrome', processName: '' })),
      // 没有 focusWindow
    }
    const exec = vi.fn(async () => 'OK')
    const r = await focusWindowRobust('Stardew Valley', {
      getAdapter: async () => adapter,
      exec,
      sleep: noSleep,
    })
    const appActivateCalls = exec.mock.calls.filter(c => String(c[1]).includes('AppActivate'))
    expect(appActivateCalls.length).toBe(1)
    expect(r).toBe(true)
  })

  it('聚焦后会发 ESC 关闭干扰弹窗', async () => {
    const adapter = makeAdapter({ activeTitle: 'Minecraft' })
    const exec = vi.fn(async () => 'OK')
    await focusWindowRobust('Minecraft', {
      getAdapter: async () => adapter,
      exec,
      sleep: noSleep,
    })
    const escCalls = exec.mock.calls.filter(c => String(c[1]).includes('{ESC}'))
    expect(escCalls.length).toBe(1)
  })

  it('AppActivate 失败（ERR:）且标题仍不匹配 → 返回 false', async () => {
    const adapter: FocusAdapterLike = {
      getActiveWindow: vi.fn(async () => ({ title: 'Chrome', processName: '' })),
      focusWindow: vi.fn(async () => false),
    }
    const exec = vi.fn(async () => 'ERR:something failed')
    const r = await focusWindowRobust('CS2', {
      getAdapter: async () => adapter,
      exec,
      sleep: noSleep,
    })
    expect(r).toBe(false)
  })
})

