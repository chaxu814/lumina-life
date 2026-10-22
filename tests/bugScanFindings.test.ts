// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// tests/bugScanFindings.test.ts — 全项目扫描发现的 bug 回归防护
//
// 【背景】
// 2026-10-03 做了三轮并行 bug 扫描（静默吞数据 / 状态不持久 / 安全降级缺失），
// 本文件钉住其中**已修复**的项，防止回归。
//
// 每一条都对应一个真实缺陷，而不是「顺手加的测试」。
// 注释里写清楚「当初为什么会错」，因为这类 bug 最大的特点是
// 看起来完全合理——不写原因，下次重构就会把 bug 改回来。
// ============================================================

import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

function readSrc(rel: string): string {
  return fs.readFileSync(path.join(process.cwd(), ...rel.split('/')), 'utf-8')
}

// ═══════════════════════════════════════════════════════════
// 1. cron 任务：暂停了还在跑
// ═══════════════════════════════════════════════════════════

describe('bugScan · 定时任务同步（原为启动时一次性）', () => {
  const src = readSrc('src/App.tsx')

  it('同步 effect 依赖 cronTasks（不是空依赖）', () => {
    // 原为 `}, [])` —— 只在启动时推一次
    // 而 cronSyncAll 在主进程是全量替换语义（replaceAllCronEntries），
    // 于是 TasksPanel 的「⏸ 暂停 / 删除 / 新建」只写了 localStorage，
    // 主进程调度器里的任务仍武装着照常触发。
    // 用户以为暂停了，它照跑 —— 比丢数据更糟。
    //
    // 注意：依赖数组是跨行写的（注释在中间），所以用宽松匹配。
    const i = src.indexOf('cronSyncAll')
    expect(i).toBeGreaterThan(-1)
    // 窗口只到本 effect 结束（依赖数组那行），否则会跨到下一个
    // legitimately-empty 的 useEffect 而误报。
    const end = src.indexOf('[cronTasksForSync])', i)
    expect(end, '未找到 cronTasksForSync 依赖数组（说明修复被回退了）').toBeGreaterThan(i)
    const after = src.slice(i, end + 30)
      .split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
    expect(after, 'cronSyncAll 所在 effect 仍用空依赖').not.toMatch(/\},\s*\[\s*\]/)
    expect(after).toMatch(/\[cronTasksForSync\]\s*\)/)
  })

  it('仍然只同步 enabled 的任务', () => {
    expect(src).toMatch(/cronTasksForSync\.filter\(t => t\.enabled\)/)
  })
})

// ═══════════════════════════════════════════════════════════
// 2. 供应商快捷按钮：曾只改内存
// ═══════════════════════════════════════════════════════════

describe('bugScan · 供应商按钮落盘', () => {
  const src = readSrc('src/panels/settings/SettingsLLM.tsx')

  it('不再有裸的 switchLLMProvider(p.id ...) 调用', () => {
    const bare = (src.match(/switchLLMProvider\(p\.id/g) || []).length
    expect(bare, '仍有按钮只改内存不落盘').toBe(0)
  })

  it('每个供应商按钮组都落盘（主区走 switchAndPersist，Team Agent 走 handleAgentProvider）', () => {
    // 供应商按钮组现为：2 组主区（本地 / 云端）+ 2 组 Team Agent。
    // 原先断言 `switchAndPersist >= 3` 只是把「按钮数量」当成了「落盘覆盖」的代理指标；
    // 且它没覆盖 Team Agent 区（那里按设计走 handleAgentProvider，不是 switchAndPersist）。
    // 真正的不变式是：没有任何供应商按钮绕开落盘入口。上面那条「零裸调用」是这个不变式的硬保证，
    // 这里再确认两条落盘路径都还在、且都被实际调用。
    const groups = (src.match(/LLM_PROVIDERS\.filter\([^)]*\)\.map/g) || [])
    expect(groups.length, '供应商按钮组数量异常').toBe(4)

    // 主区（本地组 + 云端组）
    const mainPersist = (src.match(/switchAndPersist\(useStore\.getState\(\)/g) || []).length
    expect(mainPersist, '主区供应商按钮有未落盘的').toBe(2)

    // Team Agent 区（本地组 + 云端组）
    const agentPersist = (src.match(/handleAgentProvider\(p\.id/g) || []).length
    expect(agentPersist, 'Team Agent 供应商按钮有未落盘的').toBe(2)
  })
})

// ═══════════════════════════════════════════════════════════
// 3. 保存按钮：曾硬编码上下文窗口
// ═══════════════════════════════════════════════════════════

describe('bugScan · 上下文窗口不再被丢弃', () => {
  const src = readSrc('src/panels/settings/SettingsLLM.tsx')

  it('保存路径使用用户设置值', () => {
    expect(src).toMatch(/maxContextTokens:\s*st\.llmConfig\.contextWindow\s*\|\|\s*256000/)
  })

  it('不再出现硬编码的 256000 尾参形式', () => {
    expect(src).not.toMatch(/maxContextTokens:\s*256000,/)
  })
})

// ═══════════════════════════════════════════════════════════
// 4. auditLogs / toolTraces：曾漏出持久化白名单
// ═══════════════════════════════════════════════════════════

describe('bugScan · 审计日志与工具轨迹持久化', () => {
  const src = readSrc('src/stores/appStore.ts')

  it('auditLogs 在 partialize 白名单里', () => {
    // SecurityPanel 会展示「N 条记录」，用户查安全事件时
    // 明明有面板有数据，重启后却是「暂无审计记录」——最伤信任。
    const pz = src.slice(src.indexOf('partialize'))
    expect(pz).toMatch(/auditLogs:\s*state\.auditLogs/)
  })

  it('toolTraces 在 partialize 白名单里', () => {
    const pz = src.slice(src.indexOf('partialize'))
    expect(pz).toMatch(/toolTraces:\s*state\.toolTraces/)
  })

  it('两者都有容量上限（不会撑爆 localStorage）', () => {
    // toolTraces 原本无上限（只 push 不截断）——加上持久化后
    // 会成为 localStorage 膨胀源，一并限流。
    expect(src).toMatch(/auditLogs[\s\S]{0,160}slice\(0,\s*\d+\)/)
    expect(src).toMatch(/addToolTrace[\s\S]{0,160}slice\(-?\d+\)/)
  })
})

// ═══════════════════════════════════════════════════════════
// 5. 安全闸门：fail-open 已改为 fail-closed
// ═══════════════════════════════════════════════════════════

describe('bugScan · 安全闸门 fail-closed', () => {
  const src = readSrc('electron/securityGuard.ts')

  it('JSON 解析失败不再放行', () => {
    expect(src).not.toContain('参数解析失败，放行')
  })

  it('改为拦截并要求审批', () => {
    const i = src.indexOf('args = JSON.parse(toolCall.function.arguments)')
    const body = src.slice(i, i + 2600)
      .split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
    expect(body).toMatch(/allowed:\s*false/)
    expect(body).toMatch(/requiresApproval:\s*true/)
  })
})

// ═══════════════════════════════════════════════════════════
// 6. 死代码提醒（不是 bug，但值得记录）
// ═══════════════════════════════════════════════════════════

describe('bugScan · 死代码现状（供后续决策）', () => {
  it('preload 暴露了 desktop:* 通道，但主进程未注册', () => {
    const preload = readSrc('electron/preload.ts')
    const hasChannels = /desktop:click/.test(preload)
    expect(hasChannels).toBe(true)

    // 全仓扫 ipcMain 注册
    const files: string[] = []
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === 'dist' || e.name === 'out') {continue}
        const p = path.join(dir, e.name)
        if (e.isDirectory()) {walk(p)}
        else if (e.name.endsWith('.ts')) {files.push(p)}
      }
    }
    walk(path.join(process.cwd(), 'electron'))
    const registered = files.some(f =>
      /ipcMain\.(handle|on)\('desktop:/.test(fs.readFileSync(f, 'utf-8')))
    // 当前状态：未注册（死代码）。若将来注册了，这条会失败提醒更新本注释。
    expect(registered, 'desktop:* 通道现在已注册，请更新本测试与死代码说明').toBe(false)
  })
})
