// ============================================================
// __tests__/doctor.test.ts — 诊断工具单元测试
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

describe('handleDoctor', () => {
  beforeEach(() => {
    vi.resetModules()
    delete process.env.LUMINA_ALLOW_INSECURE_SSL
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
  })

  it('返回诊断报告（基本结构）', async () => {
    const { handleDoctor } = await import('../cli/doctor')
    const result = await handleDoctor([])
    expect(result.ok).toBe(true)
    expect(result.data).toBeDefined()
  })

  it('诊断报告包含 SSL 检查项', async () => {
    const { handleDoctor } = await import('../cli/doctor')
    const result = await handleDoctor([])
    const report = result.data as string
    expect(report).toContain('SSL')
    expect(report).toContain('已启用')
  })

  it('SSL 关闭时报告警告', async () => {
    process.env.LUMINA_ALLOW_INSECURE_SSL = '1'
    const { handleDoctor } = await import('../cli/doctor')
    const result = await handleDoctor([])
    const report = result.data as string
    expect(report).toContain('SSL')
    expect(report).toContain('关闭')
    expect(report).toContain('⚠️')
  })

  it('诊断报告包含 Node 版本', async () => {
    const { handleDoctor } = await import('../cli/doctor')
    const result = await handleDoctor([])
    const report = result.data as string
    expect(report).toContain(process.versions.node)
  })

  it('诊断报告包含 LLM 配置', async () => {
    const { handleDoctor } = await import('../cli/doctor')
    const result = await handleDoctor([])
    const report = result.data as string
    expect(report).toContain('LLM')
  })

  it('诊断报告工具完整性检查', async () => {
    const { handleDoctor } = await import('../cli/doctor')
    const result = await handleDoctor([])
    const report = result.data as string
    expect(report).toContain('工具')
  })

  it('不传参数不抛异常', async () => {
    const { handleDoctor } = await import('../cli/doctor')
    await expect(handleDoctor([])).resolves.not.toThrow()
  })
})
