// ============================================================
// tests/scanRound2Findings.test.ts — 第二轮复核：6 处已修项回归防护
//
// 【背景】
// 2026-10-03 深夜复核子代理报告里剩余的 9 条中低风险项，
// 逐条读源码核实后，确认其中 6 条成立并已修复。
//
// 【本轮最重要的发现】
// 子代理把 #7（`try { void async() } catch {}`）标为「影响面窄」——
// 这个判断是**错的**。全项目有 **338 处**这种写法，
// 而它们的 try/catch 抓不到 Promise reject；
// Electron 主进程遇到 unhandledRejection 的默认行为是**直接终止进程**。
// 单处影响小，338 处累计起来就是「随时可能崩」。
//
// 修法不是逐个改（改不完且会新增），而是装全局兜底：
//   crashGuard.ts 在 main.ts 最早期安装 unhandledRejection 处理器，
//   一处覆盖全部 338 处。
// ============================================================

import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

function readSrc(rel: string): string {
  return fs.readFileSync(path.join(process.cwd(), ...rel.split('/')), 'utf-8')
}

// ═══════════════════════════════════════════════════════════
// 1. 全局兜底（最高性价比）
// ═══════════════════════════════════════════════════════════

describe('round2 · 主进程全局异常兜底', () => {
  it('crashGuard 存在且处理两类异常', () => {
    const src = readSrc('electron/crashGuard.ts')
    expect(src).toMatch(/process\.on\('unhandledRejection'/)
    expect(src).toMatch(/process\.on\('uncaughtException'/)
  })

  it('unhandledRejection 不退出进程（这是 338 处 try{void} 的唯一防线）', () => {
    const src = readSrc('electron/crashGuard.ts')
    const i = src.indexOf("process.on('unhandledRejection'")
    const j = src.indexOf("process.on('uncaughtException'")
    const body = src.slice(i, j)
    // 绝不能在这段里 exit
    expect(body).not.toMatch(/process\.exit/)
  })

  it('uncaughtException 记盘后以非 0 码退出', () => {
    const src = readSrc('electron/crashGuard.ts')
    expect(src).toMatch(/process\.exit\(1\)/)
    expect(src).toMatch(/writeCrashRecord/)
  })

  it('崩溃记录有轮转（不会无限增长）', () => {
    const src = readSrc('electron/crashGuard.ts')
    expect(src).toMatch(/MAX_CRASH_REPORTS/)
    expect(src).toMatch(/slice\(0, Math\.max\(0, files\.length - MAX_CRASH_REPORTS\)\)/)
  })

  it('main.ts 在任何异步任务之前安装了兜底', () => {
    const src = readSrc('electron/main.ts')
    const i = src.indexOf('installCrashGuard()')
    expect(i, 'main.ts 未调用 installCrashGuard').toBeGreaterThan(-1)
    // 必须在文件靠前部分（早于 app.whenReady / 各 register*Ipc）
    const ready = src.indexOf('app.whenReady')
    const firstAsync = ready > 0 ? ready : src.indexOf('registerBrowserIpc')
    if (firstAsync > 0) {
      expect(i, '兜底安装得太晚，晚于 app.whenReady / IPC 注册').toBeLessThan(firstAsync)
    }
  })

  it('兜底自身不抛异常（这是最后一道防线）', () => {
    const src = readSrc('electron/crashGuard.ts')
    // 所有写盘都包在 try 里
    const writes = src.match(/writeCrashRecord|fs\.writeFileSync|fs\.mkdirSync/g) || []
    expect(writes.length).toBeGreaterThan(0)
    expect(src).toMatch(/catch \{ \/\* 写盘失败也不能抛——这是最后一道防线 \*\/ \}/)
  })
})

// ═══════════════════════════════════════════════════════════
// 2. try{void} 模式已改为 .catch()
// ═══════════════════════════════════════════════════════════

describe('round2 · dynamicWorker 的 fire-and-forget 已修', () => {
  const src = readSrc('electron/team/dynamicWorker.ts')

  it('不再有 try { void ... } 组合', () => {
    // try/catch 抓不到 Promise reject
    expect(src).not.toMatch(/try\s*\{\s*void/)
  })

  it('改用 .catch() 兜底', () => {
    expect(src).toMatch(/\.catch\(/)
  })
})

// ═══════════════════════════════════════════════════════════
// 3. 损坏时不得「清空后重写」
// ═══════════════════════════════════════════════════════════

describe('round2 · 损坏数据不得被覆盖', () => {
  const cases: Array<{ name: string; file: string; mustHave: RegExp }> = [
    {
      name: 'memoryEvidence（佐证记忆库）',
      file: 'electron/memoryEvidence.ts',
      mustHave: /MemoryEvidence: 记忆库已损坏/,
    },
    {
      name: 'lifeServices（桌宠模型库）',
      file: 'electron/pet/lifeServices.ts',
      mustHave: /ModelLibrary: 桌宠模型库已损坏/,
    },
  ]

  for (const c of cases) {
    it(`${c.name}：损坏时抛错并备份原文`, () => {
      const src = readSrc(c.file)
      expect(src, `${c.name} 未对损坏做保护`).toMatch(c.mustHave)
      // 都要备份
      expect(src).toMatch(/\.corrupted/)
    })
  }

  it('quests 不再把「文件损坏」当成「新的一天」', () => {
    const src = readSrc('electron/gamification/quests.ts')
    const i = src.indexOf('private _loadState')
    const body = src.slice(i, i + 2000)
    // 原先 catch 里直接 _checkDailyReset()（会导致 streak 归零）
    const catchIdx = body.indexOf('} catch')
    const catchBody = body.slice(catchIdx, catchIdx + 900)
    expect(catchBody).not.toMatch(/^\s*\}\s*catch[^{]*\{\s*this\._checkDailyReset\(\)/)
    // 现在要备份
    expect(catchBody).toMatch(/\.corrupted/)
  })

  it('modelLibrary 区分「不存在」与「损坏」', () => {
    const src = readSrc('electron/pet/lifeServices.ts')
    const i = src.indexOf('export function loadLibrary')
    const body = src.slice(i, i + 1800)
    expect(body).toMatch(/!existsSync\(file\)/)      // 不存在 → 空库
    expect(body).toMatch(/catch/)                     // 损坏 → 抛错
  })
})

// ═══════════════════════════════════════════════════════════
// 4. 静默失败改为留痕
// ═══════════════════════════════════════════════════════════

describe('round2 · 静默失败改为留痕', () => {
  it('layeredMemory 六条读取路径都有日志', () => {
    const src = readSrc('electron/memory/layeredMemoryAdapter.ts')
    const n = (src.match(/\[layeredMemory\] 读取/g) || []).length
    expect(n, '记忆读取失败应留下可诊断日志').toBeGreaterThanOrEqual(6)
  })

  it('mission PRD 损坏有日志（不丢数据但要可查）', () => {
    const src = readSrc('electron/mission/state.ts')
    expect(src).toMatch(/\[mission\] PRD 文件损坏/)
  })

  it('loopPersist 保存失败不再静默', () => {
    const src = readSrc('src/services/loopPersist.ts')
    expect(src).toMatch(/\[loopPersist\]/)
    expect(src).toMatch(/Loop 任务保存失败/)
  })
})

// ═══════════════════════════════════════════════════════════
// 5. 记忆写入假成功（上一轮修的）
// ═══════════════════════════════════════════════════════════

describe('round2 · 记忆写入不得假成功', () => {
  it('addMemory 失败会重抛（让上层如实回报）', () => {
    const src = readSrc('electron/memory/memoryStore.ts')
    const i = src.indexOf('addMemory(')
    const body = src.slice(i, i + 1200)
    // 必须有 throw
    expect(body).toMatch(/catch[\s\S]{0,400}throw/)
  })

  it('不再有「语义记忆表不存在时不崩溃」这种吞异常写法', () => {
    const src = readSrc('electron/memory/memoryStore.ts')
    expect(src).not.toContain('语义记忆表不存在时报错但不崩溃')
  })
})
