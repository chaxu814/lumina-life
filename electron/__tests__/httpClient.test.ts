// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// __tests__/httpClient.test.ts — 统一 HTTP 客户端单元测试
// ============================================================

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'

// 在全局设置前清理环境变量
const OLD_ENV = { ...process.env }

describe('allowInsecureSSL', () => {
  beforeEach(() => {
    vi.resetModules()
    delete process.env.LUMINA_ALLOW_INSECURE_SSL
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
  })

  afterEach(() => {
    process.env = { ...OLD_ENV }
  })

  it('默认返回 false（安全模式）', async () => {
    const { allowInsecureSSL } = await import('../tools/utils/httpClient')
    expect(allowInsecureSSL()).toBe(false)
  })

  it('LUMINA_ALLOW_INSECURE_SSL=1 返回 true', async () => {
    process.env.LUMINA_ALLOW_INSECURE_SSL = '1'
    const { allowInsecureSSL } = await import('../tools/utils/httpClient')
    expect(allowInsecureSSL()).toBe(true)
  })

  it('LUMINA_ALLOW_INSECURE_SSL=true 返回 true', async () => {
    process.env.LUMINA_ALLOW_INSECURE_SSL = 'true'
    const { allowInsecureSSL } = await import('../tools/utils/httpClient')
    expect(allowInsecureSSL()).toBe(true)
  })

  it('LUMINA_ALLOW_INSECURE_SSL=0 返回 false', async () => {
    process.env.LUMINA_ALLOW_INSECURE_SSL = '0'
    const { allowInsecureSSL } = await import('../tools/utils/httpClient')
    expect(allowInsecureSSL()).toBe(false)
  })

  it('warn 只打印一次（第二次调用不重复）', async () => {
    process.env.LUMINA_ALLOW_INSECURE_SSL = '1'
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { allowInsecureSSL } = await import('../tools/utils/httpClient')
    allowInsecureSSL()
    allowInsecureSSL()
    allowInsecureSSL()
    expect(warnSpy).toHaveBeenCalledTimes(1)
    warnSpy.mockRestore()
  })
})

describe('stripHtml', () => {
  it('移除简单 HTML 标签', async () => {
    const { stripHtml } = await import('../tools/utils/httpClient')
    expect(stripHtml('<p>Hello</p>')).toBe('Hello')
  })

  it('移除 script 和 style 块', async () => {
    const { stripHtml } = await import('../tools/utils/httpClient')
    const input = '<div>text</div><script>alert(1)</script><style>body{}</style>'
    expect(stripHtml(input)).toBe('text')
  })

  it('解码 HTML 实体', async () => {
    const { stripHtml } = await import('../tools/utils/httpClient')
    expect(stripHtml('&amp; &lt; &gt; &quot;')).toBe('& < > "')
  })

  it('合并多余空白', async () => {
    const { stripHtml } = await import('../tools/utils/httpClient')
    expect(stripHtml('  a   b   c  ')).toBe('a b c')
  })

  it('空字符串返回空字符串', async () => {
    const { stripHtml } = await import('../tools/utils/httpClient')
    expect(stripHtml('')).toBe('')
  })
})

describe('httpsRequestOptions', () => {
  beforeEach(() => {
    delete process.env.LUMINA_ALLOW_INSECURE_SSL
  })

  it('默认 rejectUnauthorized = true', async () => {
    const { httpsRequestOptions } = await import('../tools/utils/httpClient')
    const opts = httpsRequestOptions('https://example.com')
    expect(opts.rejectUnauthorized).toBe(true)
  })

  it('关闭时 rejectUnauthorized = false', async () => {
    process.env.LUMINA_ALLOW_INSECURE_SSL = '1'
    // 重新导入以拾取新 env
    const mod = await import('../tools/utils/httpClient')
    const opts = mod.httpsRequestOptions('https://example.com')
    expect(opts.rejectUnauthorized).toBe(false)
  })

  it('正确解析 URL 组件', async () => {
    const { httpsRequestOptions } = await import('../tools/utils/httpClient')
    const opts = httpsRequestOptions('https://host.example/path?a=1')
    expect(opts.hostname).toBe('host.example')
    expect(opts.path).toBe('/path?a=1')
  })

  it('合并自定义 headers', async () => {
    const { httpsRequestOptions } = await import('../tools/utils/httpClient')
    const opts = httpsRequestOptions('https://example.com', { 'X-Custom': 'val' })
    expect((opts.headers as Record<string, string>)['X-Custom']).toBe('val')
    expect((opts.headers as Record<string, string>)['User-Agent']).toContain('Chrome')
  })

  it('不修改默认 header 内容', async () => {
    const { httpsRequestOptions } = await import('../tools/utils/httpClient')
    const opts1 = httpsRequestOptions('https://a.com')
    const opts2 = httpsRequestOptions('https://b.com', { 'Accept': 'text/plain' })
    // 第二个调用的 Accept 应该覆盖默认
    expect((opts1.headers as Record<string, string>)['Accept']).not.toBe((opts2.headers as Record<string, string>)['Accept'])
  })
})
