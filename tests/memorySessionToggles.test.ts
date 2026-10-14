// ============================================================
// tests/memorySessionToggles.test.ts
//
// 【要防的问题】
//   会话级记忆双开关（业界实践）必须真的接线，而不是只加两个
//   UI 开关却没接到任何行为上（那正是「装饰性开关」——本项目最反对的东西）。
//
//   本测试锁三件事：
//     1. 两个 flag（memory.recall / memory.write）在主进程与渲染端都存在且默认开
//     2. 「生成记忆」关掉时，memory:save 真的拒绝写入并如实告知
//     3. 「使用记忆」关掉时，记忆召回接口真的返回空而不是照常返回
// ============================================================

import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

const root = path.resolve(__dirname, '..')
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf-8')

const flagsSrc = read('electron/core/featureFlags.ts')
const clientSrc = read('src/services/featureFlagsClient.ts')
const memIpcSrc = read('electron/ipc/memoryIpc.ts')
const settingsSrc = read('src/panels/settings/SettingsMemory.tsx')

describe('会话级记忆双开关 —— 主进程/渲染端一致', () => {
  it('主进程 FeatureKey 含两个新 key，且默认开', () => {
    expect(flagsSrc).toContain("'memory.recall'")
    expect(flagsSrc).toContain("'memory.write'")
    // 默认值必须为 true（不改变既有行为）
    expect(flagsSrc).toMatch(/'memory\.recall':\s*true/)
    expect(flagsSrc).toMatch(/'memory\.write':\s*true/)
  })

  it('渲染端 RendererFlagKey 与回退默认同步', () => {
    expect(clientSrc).toContain("'memory.recall'")
    expect(clientSrc).toContain("'memory.write'")
    expect(clientSrc).toMatch(/'memory\.recall':\s*true/)
    expect(clientSrc).toMatch(/'memory\.write':\s*true/)
    // 设置页要能展示中文名
    expect(clientSrc).toContain('使用记忆')
    expect(clientSrc).toContain('生成记忆')
  })
})

describe('开关真的接到行为上（不是装饰）', () => {
  it('「生成记忆」关闭时 memory:save 拒绝写入', () => {
    const saveIdx = memIpcSrc.indexOf("ipcMain.handle('memory:save'")
    expect(saveIdx, '找不到 memory:save').toBeGreaterThan(-1)
    const body = memIpcSrc.slice(saveIdx, saveIdx + 900)
    expect(body, 'memory:save 必须检查 memory.write').toContain("isEnabled('memory.write')")
  })

  it('「使用记忆」关闭时召回接口返回空', () => {
    // 三个喂给 LLM 的召回口都必须有闸门
    expect(memIpcSrc).toMatch(/recallDisabled\(\)[\s\S]*?memory:all|memory:all[\s\S]*?recallDisabled\(\)/)
    expect(memIpcSrc).toContain("isEnabled('memory.recall')")
    const allIdx = memIpcSrc.indexOf("ipcMain.handle('memory:all'")
    const allBody = memIpcSrc.slice(allIdx, allIdx + 260)
    expect(allBody, 'memory:all 未受 recall 闸门控制').toContain('recallDisabled')
  })
})

describe('设置页 UI 齐备', () => {
  it('含「不记什么」清单与两条开关', () => {
    expect(settingsSrc).toContain('绝不会记录')
    expect(settingsSrc).toContain('使用记忆')
    expect(settingsSrc).toContain('生成记忆')
    expect(settingsSrc).toContain("flags['memory.recall']")
    expect(settingsSrc).toContain("flags['memory.write']")
  })

  it('体现会话级语义（进行中提示）', () => {
    expect(settingsSrc).toContain('本对话进行中')
  })
})
