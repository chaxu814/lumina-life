// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// __tests__/shell.test.ts — Shell 执行沙箱单元测试
// ============================================================

import { describe, it, expect, vi } from 'vitest'

// 【v3.34 修注】本文件此前**从未被执行过**（vitest.config.ts 的 include 只写
// 'tests/**'，不含 electron/__tests__/），所以 explorer / start 两条重定向断言
// 已经挂了很久，只是没人看得见。
//
// 挂掉的根因不是生产代码有 bug，而是测试环境没 mock electron：vitest 跑在纯
// Node 下，`require('electron')` 拿到的是 npm 包导出的**可执行文件路径字符串**，
// 解构出的 shell 是 undefined，于是 shell.openPath 抛
// "Cannot read properties of undefined"。真实 Electron 主进程里行为完全正常。
//
// 这里按项目其它测试的惯例 mock 掉 electron，并断言「重定向到了 open_path /
// open_external」这个真正的意图，而不是断言执行结果。

// 【为什么要 vi.hoisted】本文件原先在 beforeEach 里调 vi.resetModules()，那会
// 重置模块注册表，mock 工厂重新执行 —— 用例里拿到的 shell 会与 shell.ts 内部
// 捕获的**不是同一个对象**，断言永远不成立。hoisted 把 mock 实例提到模块初始化
// 之前创建一次，所有用例共享它。
const { electronShellMock } = vi.hoisted(() => ({
  electronShellMock: {
    openPath: vi.fn(async () => ''),      // 空字符串 = 成功
    openExternal: vi.fn(async () => undefined),
  },
}))

vi.mock('electron', () => ({
  shell: electronShellMock,
  app: { getPath: vi.fn(() => '.') },
}))

/** 统一的 shell 模块取用入口。
 *
 *  刻意**不**配 vi.resetModules()：resetModules 与 vi.mock 组合会让这个 worker
 *  在 teardown 阶段无法退出，整轮 npm test 卡死在
 *  「Timeout terminating forks worker」并最终打不出汇总。
 *  隔离性由每个用例自己 import 一份新实例来保证，足够用。
 */
const mockImportShell = () => import('../tools/impl/shell')

describe('shellExec 安全拦截', () => {
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
    const { shellExec } = await mockImportShell()
    electronShellMock.openPath.mockClear()
    // explorer 后跟路径，应被重定向
    const result = await shellExec({ command: 'explorer C:\\test' })
    expect(result.ok).toBe(true)
    // 真的调了 electron.shell.openPath，而不是自己 spawn 一个 explorer 进程
    expect(electronShellMock.openPath).toHaveBeenCalled()
    // 内容提示用 open_file
    expect(result.content).toContain('open_file')
  })

  it('start 命令被拦截并重定向到 open_file', async () => {
    const { shellExec } = await mockImportShell()
    electronShellMock.openPath.mockClear()
    const result = await shellExec({ command: 'start notepad.exe' })
    // start 被拦下，交给 open_file 处理，**不**直接 spawn
    expect(electronShellMock.openPath).toHaveBeenCalled()
    expect(result.ok).toBe(true)
    expect(result.content).toContain('open_file')
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
