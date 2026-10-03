// ============================================================
// bundledRequires.test.ts — 打包产物的相对 require 守卫（v3.34 新增）
//
// 【这个文件为什么存在，且为什么必须有】
// 2026-10-03 第一次真机跑打包版时，`delegate_to` 返回「Yak 未配置 LLM」，
// 而启动日志刚打印过「✅ yak 独立 Runner 已创建」。
//
// 根因：`delegationManager.ts` 里的
//     require('./core/agentOrchestrator')
// 在 **dev 模式**能解析（源文件在磁盘上），在**打包后必然失败** —— 打包器把
// 源码扁平化进 out/main/index.js，运行时基准目录变成 out/main/，而
// out/main/core/agentOrchestrator 并不存在。抛错被 catch {} 吞掉后，
// getDelegationManager() 退回一个**全新的空实例**，runners 全部丢失。
//
// 结论：**三 Agent 团队在打包版里整个是坏的，而在 dev 与 187 个测试里全绿。**
//
// 这类 bug 只要「跑一次真实打包产物」才会暴露。CI 的 test job 跑的是 vitest
// （跑源码），build job 跑完也不检查产物 —— 所以必须把检查写成测试，
// 让它在 CI 里跑。
// ============================================================

import { describe, it, expect } from 'vitest'
import { execFileSync } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'

const root = join(__dirname, '..')
const outMain = join(root, 'out', 'main')
const hasBuild = existsSync(join(outMain, 'index.js'))

describe('打包产物 · 运行时相对 require 守卫', () => {
  it('check-bundle-requires.cjs 存在且可执行', () => {
    expect(existsSync(join(root, 'scripts', 'check-bundle-requires.cjs'))).toBe(true)
  })

  // 没有构建产物时跳过而不是失败：CI 的 test job 在 build 之前跑。
  // 真正的把关在 build job 里（构建后立即跑这个脚本）。
  it.skipIf(!hasBuild)('打包后不应存在解析不到的相对 require', () => {
    let out = ''
    let code = 0
    try {
      out = execFileSync(
        process.execPath,
        [join(root, 'scripts', 'check-bundle-requires.cjs')],
        { cwd: root, encoding: 'utf8' },
      )
    } catch (e: any) {
      code = e.status ?? 1
      out = e.stdout || ''
    }
    // 允许一定数量的已知欠债（目前 42 处），但不允许**增长**。
    // 数字写死是刻意的：它就是「已知欠债」的水位线，改它需要同时修代码。
    const KNOWN_BROKEN = 42
    // 脚本第一行输出 BROKEN_RELATIVE_REQUIRES=<n>（机器可读）
    const m = out.match(/BROKEN_RELATIVE_REQUIRES=(\d+)/)
    const broken = m ? Number(m[1]) : NaN

    expect(Number.isNaN(broken), `无法从检查脚本输出中解析数字：\n${out.slice(0, 400)}`).toBe(false)
    expect(
      broken,
      `打包后解析不到的相对 require 从 ${KNOWN_BROKEN} 变成了 ${broken}。\n` +
      `新增的这类 require 在 dev 下能跑、打包后必然抛错且被 try/catch 静默吞掉，\n` +
      `表现为「功能莫名失效但日志正常」。\n` +
      `修法：把运行时的 require('./xxx') 改成静态 import（注意别造成循环依赖），\n` +
      `或把对应的 try/catch 改成会出声的。\n\n${out.slice(0, 1500)}`,
    ).toBeLessThanOrEqual(KNOWN_BROKEN)

    if (code !== 0 && broken <= KNOWN_BROKEN) {
      // 已知欠债导致非 0 退出码是可接受的，不额外断言
    }
  })
})

describe('DelegationManager 单例一致性（防脑裂复发）', () => {
  it('orchestrator.init 会把自己的实例反向登记到模块单例', () => {
    const fs = require('fs')
    const src = fs.readFileSync(join(root, 'electron', 'core', 'agentOrchestrator.ts'), 'utf8')
    expect(
      src.includes('registerDelegationManagerInstance'),
      'agentOrchestrator.init() 必须调用 registerDelegationManagerInstance，' +
      '否则打包后 getDelegationManager() 的 require 失败会退回另一个空实例，' +
      'yak / recha 的 runner 全部丢失 → 委托报「未配置 LLM」。',
    ).toBe(true)
  })

  it('delegationManager 导出了反向登记函数', () => {
    const fs = require('fs')
    const src = fs.readFileSync(join(root, 'electron', 'delegationManager.ts'), 'utf8')
    expect(src).toMatch(/export function registerDelegationManagerInstance/)
  })

  it('registerRunner 失败时必须出声，不能静默吞掉', () => {
    const fs = require('fs')
    const src = fs.readFileSync(join(root, 'electron', 'core', 'agentOrchestrator.ts'), 'utf8')
    const i = src.indexOf('registerRunner(id: string')
    const rest = src.slice(i + 10)
    const nextMethod = rest.search(/\n {2}\w+\s*\(/)
    const raw = nextMethod > 0 ? rest.slice(0, nextMethod) : rest
    // 剥离行注释 —— v3.34 的说明性注释里会引用旧的代码形态，
    // 不剥离就会把「注释里提到了旧写法」误判成「旧写法还在」
    const body = raw.split(/\r?\n/).filter(l => !/^\s*\/\//.test(l)).join('\n')
    expect(body).toMatch(/console\.error/)
    // 旧的静默形态：`if (this.delegation?.registerRunner) { try {...} catch {} }`
    expect(body).not.toMatch(/this\.delegation\?\.registerRunner/)
    expect(body).not.toMatch(/catch\s*\{\s*\}/)
  })
})
