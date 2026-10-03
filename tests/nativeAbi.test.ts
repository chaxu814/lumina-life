// ============================================================
// tests/nativeAbi.test.ts — 原生模块 ABI 冒烟测试
// ============================================================
//
// 【要防的真实事故】
// 2026-10-03 发布前审计发现：`better-sqlite3` 的预编译产物是为 Node 20 打的
// （NODE_MODULE_VERSION 143），而 Electron 40 需要 ABI 148。于是**打包后启动时**
// 报 ERR_DLOPEN_FAILED，记忆系统的 ReMe / Scroll 分支静默降级 ——
// 而 `vitest run` 全绿，因为测试跑在 Node 下，不在 Electron 下，
// 两者用的是不同 ABI。这正是「测试全绿但真机炸掉」的典型盲区。
//
// 【这个测试做什么】
// 它不试图在 Node 里加载 Electron ABI 的模块（那必然失败，也没意义），
// 而是**断言「打包/运行时用的 ABI 与原生模块的编译 ABI 一致」**：
//   1. 读出 Electron 的 ABI（modules.versions.electron → 对应 modules 编号）
//   2. 读出 better-sqlite3 二进制的编译 ABI（预编译包有 ABI 标记）
//   3. 不一致时给出**明确的修复命令**而不是一堆 dlopen 栈
//
// 【为什么不能只靠 typecheck / vitest】
// 类型检查看不见 ABI；单测跑的是 Node。这条只能靠显式断言守住。
// ============================================================

import { describe, it, expect } from 'vitest'
import { execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'

const ROOT = path.resolve(__dirname, '..')

/** 读取 electron 包版本 */
function electronVersion(): string | null {
  try {
    const pkgPath = path.join(ROOT, 'node_modules', 'electron', 'package.json')
    if (!fs.existsSync(pkgPath)) return null
    return JSON.parse(fs.readFileSync(pkgPath, 'utf-8')).version
  } catch {
    return null
  }
}

/**
 * 【为什么必须在 Electron 里验】
 * 2026-10-03 发布审计的真实事故：`better-sqlite3` 预编译包是 Node 20 的 ABI，
 * Electron 40 需要另一个 ABI。`vitest` 全绿（跑在 Node 下），但**打包后启动时**
 * 抛 ERR_DLOPEN_FAILED，记忆系统 ReMe/Scroll 静默降级。
 *
 * 曾经试图从二进制里 grep `NODE_MODULE_VERSION` 字符串来比对 —— **不可行**：
 * 现代 node-gyp 产物里那个标记并不是以可搜索的明文出现，扫描永远返回 null，
 * 于是这个守卫会静默退化成“跳过”，等于没有。
 *
 * 唯一可靠的真相是：**让 Electron 自己 require 一次**。
 * 能 require 成功 == ABI 对；失败 == 打包后一定炸。
 */
function probeUnderElectron(): { ok: boolean; output: string } {
  const electronBin = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
  const isWin = process.platform === 'win32'
  const bin = isWin
    ? electronBin
    : path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron')

  if (!fs.existsSync(bin)) return { ok: false, output: `electron binary not found: ${bin}` }

  // 在 Electron 的 Node 模式下执行一段脚本，真实加载原生模块并跑一条 SQL
  const script = [
    "const D = require('better-sqlite3');",
    "const d = new D(':memory:');",
    "d.exec('CREATE TABLE t(x INTEGER)');",
    "d.prepare('INSERT INTO t VALUES (?)').run(42);",
    "const r = d.prepare('SELECT x FROM t').get();",
    "d.close();",
    "if (r.x !== 42) { throw new Error('unexpected value ' + r.x); }",
    "console.log('LUMINA_ABI_OK');",
  ].join('')

  try {
    // ⚠️ 必须设 ELECTRON_RUN_AS_NODE=1，否则 Electron 会把它当 GUI 参数，
    //    直接报 "bad option: --no-sandbox"（踩过一次）。
    const out = execFileSync(bin, ['-e', script], {
      cwd: ROOT,
      encoding: 'utf-8',
      timeout: 60_000,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    })
    return { ok: out.includes('LUMINA_ABI_OK'), output: out }
  } catch (err: any) {
    return { ok: false, output: String(err?.stderr || err?.message || err) }
  }
}

describe('原生模块 ABI 一致性', () => {
  it('better-sqlite3 能在 Electron ABI 下真实加载并执行 SQL', () => {
    const ver = electronVersion()
    if (!ver) {
      console.warn('[ABI] 未安装 electron，跳过')
      return
    }

    const { ok, output } = probeUnderElectron()
    if (ok) return

    throw new Error(
      `\n原生模块在 Electron ${ver} 下加载失败 —— 打包后记忆系统（SQLite）会静默降级。\n` +
      `实际输出：\n${output.slice(0, 1500)}\n\n` +
      `修复：npm run rebuild:electron\n` +
      `这是 2026-10-03 发布审计发现的真实事故：vitest 全绿（跑在 Node 下），` +
      `但 Electron 下 SQLite 初始化失败，ReMe/Scroll 分支悄悄降级。\n`,
    )
  })

  it('原生二进制构建产物存在（rebuild 没有把产物删掉）', () => {
    const dir = path.join(ROOT, 'node_modules', 'better-sqlite3', 'build', 'Release')
    if (!fs.existsSync(dir)) {
      console.warn('[ABI] better-sqlite3 尚未构建，跳过（npm install 后会自动编译）')
      return
    }
    expect(fs.existsSync(path.join(dir, 'better_sqlite3.node'))).toBe(true)
  })
})

describe('rebuild 脚本可用性', () => {
  it('package.json 提供了 rebuild:electron 脚本（ABI 修复的入口）', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'))
    expect(pkg.scripts?.['rebuild:electron']).toBeTruthy()
    expect(pkg.scripts?.['rebuild:electron']).toContain('better-sqlite3')
  })

  it('electron-rebuild 依赖已声明（否则修复命令跑不起来）', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'))
    expect(pkg.devDependencies?.['@electron/rebuild'] || pkg.dependencies?.['@electron/rebuild']).toBeTruthy()
  })
})
