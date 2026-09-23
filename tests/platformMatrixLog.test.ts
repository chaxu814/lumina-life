// ============================================================
// tests/platformMatrixLog.test.ts — CI 日志：打印当前 runner 的平台能力矩阵
//
// 三平台 CI 矩阵（windows/macos/ubuntu × Node 20/22）跑这个用例时，
// 会把 getPlatformFeatureMatrix() 打到日志里，便于人工核对各 runner 的
// Computer Use / UIA / 截屏 / 桌宠透明能力是否符合预期。
// 不做断言（CI 环境本就该允许 Linux 无 xdotool / Wayland 降级），只负责「打印」。
// ============================================================

import { describe, it, expect, vi } from 'vitest'

// 与 platformAdapter.test.ts 相同：避免在纯 Node 测试环境加载真实 Electron / 截图库
vi.mock('electron', () => ({
  clipboard: { writeText: vi.fn(), readText: vi.fn(() => '') },
}))
vi.mock('screenshot-desktop', () => ({
  default: vi.fn().mockResolvedValue(Buffer.from([])),
}))

import { getPlatformFeatureMatrix } from '../electron/core/platform'

describe('CI 平台能力矩阵（仅打印，供日志核对）', () => {
  it('prints feature matrix for this runner', () => {
    const m = getPlatformFeatureMatrix()
    // eslint-disable-next-line no-console
    console.log('[platform-matrix]', JSON.stringify(m, null, 2))
    // 基本健全性：核心功能恒可用
    expect(m.features.chat.available).toBe(true)
    expect(m.features.memory.available).toBe(true)
  })
})
