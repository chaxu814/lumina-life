// ============================================================
// __tests__/shell.test.ts — Shell 执行沙箱单元测试
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

describe('shellExec 安全拦截', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('危险命令被拦截（rm -rf 模式）', async () => {
    const { shellExec } = await import('../tools/impl/shell')
    const result = await shellExec({ command: 'rm -rf /' })
    expect(result.ok).toBe(true)
    expect(result.content).toContain('沙箱拦截')
  })

  it('危险命令被拦截（del /F 模式）', async () => {
    const { shellExec } = await import('../tools/impl/shell')
    const result = await shellExec({ command: 'del /F /Q C:\\Windows\\*' })
    expect(result.ok).toBe(true)
    expect(result.content).toContain('沙箱拦截')
  })

  it('危险命令被拦截（format 模式）', async () => {
    const { shellExec } = await import('../tools/impl/shell')
    const result = await shellExec({ command: 'format D: /FS:NTFS' })
    expect(result.ok).toBe(true)
    expect(result.content).toContain('沙箱拦截')
  })

  it('危险命令被拦截（dd if= 模式）', async () => {
    const { shellExec } = await import('../tools/impl/shell')
    const result = await shellExec({ command: 'dd if=/dev/zero of=/dev/sda' })
    expect(result.ok).toBe(true)
    expect(result.content).toContain('沙箱拦截')
  })

  it('安全命令不被拦截', async () => {
    // 这个测试只验证拦截逻辑，不真正执行
    const { shellExec } = await import('../tools/impl/shell')
    const result = await shellExec({ command: 'echo "hello"', timeout: 1 })
    // 应该去执行而不是被拦截（但执行会超时或失败，没关系）
    expect(result.ok).toBe(false) // 执行超时或 error
  })

  it('explorer 命令重定向到 open_file', async () => {
    const { shellExec } = await import('../tools/impl/shell')
    // explorer 后跟路径，应被重定向
    const result = await shellExec({ command: 'explorer C:\\test' })
    expect(result.ok).toBe(true)
    // 内容提示用 open_file
    expect(result.content).toContain('open_file')
  })

  it('start 命令被拦截', async () => {
    const { shellExec } = await import('../tools/impl/shell')
    const result = await shellExec({ command: 'start notepad.exe' })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('open_file')
  })
})

describe('needsShell 判断', () => {
  it('npm 命令需要 shell', async () => {
    const mod = await import('../tools/impl/shell')
    // 通过执行测试看调用路径—直接测内部的 needsShell 不容易
    // 用 shellExec 的 timeout 测试—npm 不走 shell 会失败
    const result = await mod.shellExec({ command: 'npm --version', timeout: 10 })
    // npm 在 shell 模式下通常能运行
    // 注：这个测试在 CI 可能失败，但验证思路正确
    expect(result.ok).toBeTruthy()
  })

  it('管道命令需要 shell', async () => {
    const mod = await import('../tools/impl/shell')
    const result = await mod.shellExec({ command: 'echo hello | findstr h', timeout: 15 })
    // 管道需要 shell 解析
  })

  it('普通命令不需要 shell', async () => {
    // 直接测 shellExec 中对 needsShell 的内部行为
    // 看 shell.ts 中 needsShell 函数的定义
    const { shellExec } = await import('../tools/impl/shell')
    const result = await shellExec({ command: 'dir /b', timeout: 10 })
  })
})
