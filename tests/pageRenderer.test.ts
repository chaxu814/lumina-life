// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// tests/pageRenderer.test.ts
//
// 离屏真浏览器渲染是「反爬 / JS 渲染站点」的兜底能力。
// 它的**安全边界**必须钉死：非 Electron 环境、非 http(s) 协议都不能真的去开窗口。
// ============================================================

import { describe, it, expect } from 'vitest'
import { renderPageWithBrowser, isRendererAvailable } from '../electron/tools/utils/pageRenderer'

describe('pageRenderer — 边界与降级', () => {
  it('isRendererAvailable 返回布尔值（不在 Electron 里必须为 false，不能抛异常）', () => {
    expect(typeof isRendererAvailable()).toBe('boolean')
  })

  it('拒绝非 http(s) 协议 —— 绝不把 file:// / javascript: 交给浏览器', async () => {
    expect(await renderPageWithBrowser('file:///C:/Windows/System32/drivers/etc/hosts')).toBeNull()
    expect(await renderPageWithBrowser('javascript:alert(1)')).toBeNull()
    expect(await renderPageWithBrowser('data:text/html,<h1>x</h1>')).toBeNull()
    expect(await renderPageWithBrowser('')).toBeNull()
  })

  it('不具备渲染能力时返回 null 而不是抛异常（纯 Node / 单测环境）', async () => {
    if (isRendererAvailable()) {
      // 有 Electron 运行时的环境不在单测范围（真渲染要联网、要开窗口）
      return
    }
    expect(await renderPageWithBrowser('https://example.com')).toBeNull()
  })
})
