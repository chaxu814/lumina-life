// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// gamificationIpcSerialization.test.ts — IPC 载荷必须可结构化克隆
//
// 【来源】2026-10-10 用户在 dev 控制台实测报错：
//   Error sending from webFrameMain:  Error: Failed to serialize arguments
//     at s.send (node:electron/js2c/browser_init:2:103455)
//     ...
//     at AchievementManager.checkAchievements
//
// 【根因】`achievements.checkAchievements()` 把**整个 Achievement 定义对象**发给事件总线：
//     globalEventBus.emit(ACHIEVEMENT_UNLOCKED, achievement)
//   而 `Achievement` 含 `condition: (stats) => boolean` —— **一个函数**。
//   `main.ts` 又把它原样 `webContents.send('gamification:achievement', …)`，
//   Electron IPC 走**结构化克隆**，函数无法克隆 → 抛错。
//
// 【影响不止「刷一行红字」】
//   消息压根到不了渲染进程 → **成就庆祝动画从来没显示过**（静默功能丢失）。
//
// 【本文件为什么用 structuredClone 断言】
//   Electron 的 IPC 序列化就是结构化克隆，Node 18+ 有同名全局函数。
//   所以「能不能 clone」在这里可以被**真行为**验证，而不是猜。
// ============================================================

import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { ACHIEVEMENTS, toPublicAchievement } from '../electron/gamification/achievements'

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), ...rel.split('/')), 'utf-8')

describe('成就事件的载荷必须可跨进程传输', () => {
  it('原始 Achievement 定义**确实**无法结构化克隆（这就是报错的来源）', () => {
    const raw = ACHIEVEMENTS[0]
    expect(raw, 'ACHIEVEMENTS 不应为空').toBeTruthy()
    expect(typeof (raw as any).condition, 'Achievement.condition 应是函数（正因如此才不能 clone）').toBe('function')

    // 若不抛错，说明这个测试的前提变了，需要重新评估
    expect(() => structuredClone(raw)).toThrow()
  })

  it('toPublicAchievement 的结果可以结构化克隆（修复生效）', () => {
    for (const raw of ACHIEVEMENTS) {
      const dto = toPublicAchievement(raw)
      expect(() => structuredClone(dto), `成就「${raw.id}」的 DTO 仍不可克隆`).not.toThrow()
    }
  })

  it('DTO 保留渲染端用到的字段，且不泄漏 condition', () => {
    const raw = ACHIEVEMENTS[0]
    const dto = toPublicAchievement(raw)
    expect(dto.id).toBe(raw.id)
    expect(dto.name).toBe(raw.name)
    expect(dto.description).toBe(raw.description)
    expect(dto.icon).toBe(raw.icon)
    expect(dto.category).toBe(raw.category)
    // 渲染端 GamificationPanel 只用到 icon / name / description
    expect(dto).not.toHaveProperty('condition')
  })

  it('emit 出去的是 DTO，不是原始定义对象', () => {
    const src = read('electron/gamification/achievements.ts')
    expect(src).toMatch(/globalEventBus\.emit\(BusEvents\.ACHIEVEMENT_UNLOCKED, toPublicAchievement\(achievement\)\)/)
    expect(src).not.toMatch(/globalEventBus\.emit\(BusEvents\.ACHIEVEMENT_UNLOCKED, achievement\)/)
  })

  it('main.ts 的转发走 safeSendToRenderer（再出错也只是一条带通道名的告警）', () => {
    const src = read('electron/main.ts')
    expect(src).toMatch(/const safeSendToRenderer = /)
    expect(src).toMatch(/safeSendToRenderer\(mainWindow, 'gamification:achievement'/)
    expect(src).toMatch(/载荷可能含函数等不可克隆值/)
  })

  it('其它游戏化事件（level-up / xp / quests）也不得夹带函数', () => {
    // 这三个的 emit 载荷都是纯数据；这里守住「别把定义对象直接发出去」
    const levels = read('electron/gamification/levels.ts')
    const quests = read('electron/gamification/quests.ts')
    expect(levels).not.toMatch(/emit\(BusEvents\.LEVEL_UP,\s*[A-Z_]+\[/)
    expect(quests).not.toMatch(/emit\(BusEvents\.QUEST_UPDATED,\s*QUEST/)
  })
})
