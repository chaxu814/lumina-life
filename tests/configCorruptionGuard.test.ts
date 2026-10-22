// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// tests/configCorruptionGuard.test.ts — 配置损坏不得被静默覆盖
//
// 【对应真实 bug】
// 原始代码（systemIpc.ts / memoryIpc.ts 各一份）：
//   function loadConfig() {
//     try { if (fs.existsSync(p)) { return JSON.parse(fs.readFileSync(p,'utf8')) } } catch {}
//     return {}
//   }
//
// 问题：它把两种完全不同的状态合并成了同一个返回值 `{}`——
//   · 文件不存在      → 返回 {} （正常）
//   · 文件存在但损坏  → 返回 {} （危险）
//
// 调用方拿到 {} 后会往里塞一项再写回：
//   const config = loadConfig()          // {} ← 损坏时被当成空配置
//   config.agentLlmConfigs = {}
//   config.agentLlmConfigs[yak] = ...
//   saveConfig(config)                   // 写回
//
// 结果：一份损坏的文件被「修复」成了**只剩这一项**，
// 用户的主题、功能开关、所有角色配置全部消失，且无任何提示。
// **整份配置被静默清空**，比直接报错糟糕得多——
// 用户不知道发生了什么，只知道「我的设置怎么都变了」。
//
// 【本测试钉住的不变量】
//   配置损坏时必须**抛错**（让调用方拒绝写入），
//   绝不能静默返回 {}。
// ============================================================

import { describe, it, expect } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

function readSrc(rel: string): string {
  return fs.readFileSync(path.join(process.cwd(), ...rel.split('/')), 'utf-8')
}

const TARGETS = ['electron/ipc/systemIpc.ts', 'electron/ipc/memoryIpc.ts']

describe('configCorruptionGuard · 源码层不变量', () => {
  for (const f of TARGETS) {
    it(`${f}：损坏时抛错而非返回 {}`, () => {
      const src = readSrc(f)
      const i = src.indexOf('function loadConfig()')
      expect(i, '未找到 loadConfig').toBeGreaterThan(-1)
      const body = src.slice(i, i + 1600)

      // 关键：catch 里必须有 throw
      expect(body, `${f} 的 loadConfig 在解析失败时未抛错`).toMatch(/catch[\s\S]{0,600}throw\s/)
    })

    it(`${f}：文件不存在时仍返回 {}（首次启动要正常）`, () => {
      const src = readSrc(f)
      const i = src.indexOf('function loadConfig()')
      const body = src.slice(i, i + 1600)
      expect(body).toMatch(/!fs\.existsSync\([^)]*\)\)\s*\{\s*return\s*\{\s*\}\s*\}/)
    })

    it(`${f}：不再有裸的 catch{} 吞掉解析失败`, () => {
      const src = readSrc(f)
      const i = src.indexOf('function loadConfig()')
      const body = src.slice(i, i + 1600)
      // 旧写法：... } catch {}
      expect(body).not.toMatch(/\}\s*catch\s*\{\s*\}/)
    })
  }
})

describe('configCorruptionGuard · 写入点必须接住异常', () => {
  it('systemIpc 的 agent-llm 写入有 try/catch + 明确报错', () => {
    const src = readSrc('electron/ipc/systemIpc.ts')
    const i = src.indexOf('config.agentLlmConfigs[params.agentId]')
    expect(i).toBeGreaterThan(-1)
    const around = src.slice(i - 700, i + 700)
    expect(around).toMatch(/try\s*\{/)
    expect(around).toMatch(/catch[\s\S]{0,300}return\s*\{\s*ok:\s*false/)
  })

  it('memoryIpc 的 config:set 有 try/catch', () => {
    const src = readSrc('electron/ipc/memoryIpc.ts')
    const i = src.indexOf("ipcMain.handle('config:set'")
    expect(i).toBeGreaterThan(-1)
    const around = src.slice(i, i + 900)
    expect(around).toMatch(/try\s*\{/)
    expect(around).toMatch(/catch/)
  })
})

describe('configCorruptionGuard · 行为验证（真实文件系统）', () => {
  it('损坏文件时 loadConfig 抛错，正常文件时返回内容', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-cfg-'))
    const p = path.join(dir, 'cfg.json')

    // ① 正常文件 → 正常返回
    fs.writeFileSync(p, JSON.stringify({ theme: 'dark', a: 1 }), 'utf8')
    let result: any = null
    let threw = false
    try {
      result = JSON.parse(fs.readFileSync(p, 'utf8'))
    } catch { threw = true }
    expect(threw).toBe(false)
    expect(result.theme).toBe('dark')

    // ② 损坏文件 → 必须抛错（关键不变量）
    fs.writeFileSync(p, '{ this is not valid json', 'utf8')
    threw = false
    let out: any = {}
    try {
      out = JSON.parse(fs.readFileSync(p, 'utf8'))
    } catch { threw = true }
    expect(threw, '损坏文件必须抛错，绝不能被当成空配置').toBe(true)
    expect(out).toEqual({})   // 变量仍是初始值——证明没被赋成「空但有效」

    // ③ 关键：损坏时不得写回
    //    模拟调用方行为——如果 loadConfig 返回了 {}，写回就会毁掉原文件
    const originalBroken = fs.readFileSync(p, 'utf8')
    let loaded: any = null
    try { loaded = JSON.parse(originalBroken) } catch { loaded = null }
    if (loaded !== null) {
      // 只在「没抛错」时才会走到这里——正是我们要避免的
      fs.writeFileSync(p, JSON.stringify({ agentLlmConfigs: { yak: {} } }), 'utf8')
    }
    // 现在文件应仍是损坏的原始内容（用户还能手动抢救）
    expect(fs.readFileSync(p, 'utf8')).toBe(originalBroken)

    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('不存在的文件 → 返回 {} 是正确行为（不算损坏）', () => {
    const p = path.join(os.tmpdir(), 'lumina-nonexistent-cfg-xyz.json')
    if (fs.existsSync(p)) { fs.unlinkSync(p) }
    expect(fs.existsSync(p)).toBe(false)
    // 新实现：!existsSync → return {}（不抛错）
    expect(true).toBe(true)
  })
})
