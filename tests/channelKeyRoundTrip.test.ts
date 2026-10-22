// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// =============================================================
// tests/channelKeyRoundTrip.test.ts — 渠道配置主键往返守卫
//
// 【要锁住什么】
// 2026-10-04 修掉的一个真实缺陷：渠道配置的 **key（主键）在 IPC 边界上被销毁又伪造**。
//
//   ChannelManager.configs : Map<string, ChannelConfig>   ← key 是主键
//   getConfigs()           : Array.from(values)           ← 丢掉了 key
//   主进程 channel:get-configs 于是按下标编 key：`channel_${i}`
//   前端照单全收，也用 `channel_${i}` 当 key
//   updateConfig(key, …)   : configs.set(key, …)          ← 编出来的 key = 新增一条
//
// 后果（全部可复现）：
//   1. 保存一次渠道 → Map 里同时存在真 key 与 `channel_N` 两条 → 界面出现两张卡片，
//      其中一张是空的（用户会以为配置失败，反复点保存 → 卡片越点越多）
//   2. 首次保存前点「测试」→ startChannel('channel_0') 查无此 key → 必然失败
//   3. 两个渠道以上时，下标与真实 key 完全对不上，改 A 生效到 B
//
// 所以这里钉住：**key 必须从服务端原样往返，不允许任何一端重新编造。**
// =============================================================

import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

const root = path.join(__dirname, '..')
const read = (p: string): string => fs.readFileSync(path.join(root, p), 'utf8')

/**
 * 去掉 // 行注释与块注释。
 *
 * 【为什么必须去注释再断言】
 * 修复这些 bug 时，注释里必然要**引用旧的错误写法**（如「此前是 `channel_${i}`」）。
 * 不去注释的话，断言会把自己的修复说明判成违规 —— 守卫把自己卡死了。
 * 这与 agentQuality.test.ts / channelWiring.test.ts 是同一套做法。
 */
const code = (p: string): string =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map(line => (/^\s*\/\//.test(line) ? '' : line))
    .join('\n')

describe('渠道主键 · Map 层', () => {
  it('getConfigEntries 返回真实 key（而不是丢掉的 values）', () => {
    const src = read('electron/channels/channelManager.ts')
    expect(src).toMatch(/getConfigEntries\s*\(/)
    expect(src).toMatch(/Array\.from\(this\.configs\.entries\(\)\)/)
  })

  it('getConfigEntries 的实现确实带上 key 字段', () => {
    const src = read('electron/channels/channelManager.ts')
    // 返回形状必须是 { key, config }，否则调用方拿不到 key 又要自己编
    expect(src).toMatch(/\{\s*key,\s*config\s*\}/)
  })

  it('getConfigs() 保留但标注为「不含 key」，避免误用', () => {
    const src = read('electron/channels/channelManager.ts')
    // 注释里必须写明它丢 key、且不适合往外部传
    const doc = src.slice(0, src.indexOf('getConfigs():'))
    expect(doc.length).toBeGreaterThan(0)
    const m = src.match(/\/\*\*[\s\S]{0,300}?\*\/\s*getConfigs\(\): ChannelConfig\[\]/)
    expect(m, 'getConfigs 缺少「不含 key」的说明注释').not.toBeNull()
    expect(m![0]).toMatch(/不含 key|丢掉/)
  })
})

describe('渠道主键 · IPC 层不得编造 key', () => {
  it('channel:get-configs 用 getConfigEntries，不再按下标编 channel_N', () => {
    const src = read('electron/main.ts')
    const handler = src.slice(
      src.indexOf("ipcMain.handle('channel:get-configs'"),
      src.indexOf("ipcMain.handle('channel:update-config'"),
    )
    const handlerCode = handler
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split(/\r?\n/)
      .map(l => (/^\s*\/\//.test(l) ? '' : l))
      .join('\n')
    expect(handler).toContain('getConfigEntries()')
    // 关键：不得再出现按下标编 key 的写法
    expect(handlerCode, 'get-configs 仍在按下标编造 key').not.toMatch(/`channel_\$\{/)
    expect(handlerCode, 'get-configs 仍在用下标 i').not.toMatch(/\(\s*c\s*,\s*i\s*\)\s*=>/)
  })

  it('channel:update-config 不再把 key 解析成下标去猜旧配置', () => {
    const src = read('electron/main.ts')
    const handler = src.slice(
      src.indexOf("ipcMain.handle('channel:update-config'"),
      src.indexOf("ipcMain.handle('channel:get-status'"),
    )
    // 同一个 key 就是更新；解析下标会引入「编 key → 新增」的路径
    expect(handler).not.toMatch(/parseInt\(key\.replace/)
    expect(handler).not.toMatch(/\^channel_\\d/)
    expect(handler).toContain('cm.updateConfig(key,')
  })

  it('update-config 对缺 key 直接报错，不静默新建', () => {
    const src = read('electron/main.ts')
    const handler = src.slice(
      src.indexOf("ipcMain.handle('channel:update-config'"),
      src.indexOf("ipcMain.handle('channel:get-status'"),
    )
    expect(handler).toMatch(/if\s*\(\s*!key\s*\)/)
  })
})

describe('渠道主键 · 前端不得编造 key', () => {
  it('loadData 原样使用服务端返回的 key', () => {
    const src = read('src/panels/SettingsPanel.tsx')
    // 不得再出现 c.forEach((item, i) => configMap[`channel_${i}`] …) 的写法
    expect(code('src/panels/SettingsPanel.tsx'), '前端仍在按下标编 key')
      .not.toMatch(/configMap\[`channel_\$\{/)
    expect(src).toMatch(/if\s*\(\s*item\?\.key\s*\)/)
  })

  it('前端对 configs 为空/非数组有防御', () => {
    const src = read('src/panels/SettingsPanel.tsx')
    expect(src).toMatch(/Array\.isArray\(c\)\s*\?\s*c\s*:\s*\[\]/)
  })
})

describe('渠道主键 · 往返不变式（行为级）', () => {
  /**
   * 用一个最小 Map 复刻 updateConfig 的语义，验证「同一 key 往返 = 原地更新」。
   *
   * 【为什么不直接 import ChannelManager】
   * 它 import electron（app），在 vitest 的 node 环境下加载会炸。
   * 而这里要验证的语义是 Map 的主键语义 —— 与 electron 无关。
   */
  it('同一 key 往返不会产生重复条目', () => {
    const store = new Map<string, any>()
    // 1) 写入两条，key 是带时间戳的（与 handleAdd 的 new_${Date.now()} 一致）
    store.set('new_1700000000000', { type: 'telegram', credentials: { botToken: '' } })
    store.set('new_1700000000001', { type: 'qq', credentials: { appId: '' } })
    // 2) IPC 取出带 key 的条目
    const entries = Array.from(store.entries()).map(([key, config]) => ({ key, config }))
    expect(entries).toHaveLength(2)
    expect(entries.map(e => e.key)).toEqual(['new_1700000000000', 'new_1700000000001'])
    // 3) 前端编辑第一条后交回（编辑期用户可能增删过卡片，故按 key 定位而非下标）
    const target = entries.find(e => e.config.type === 'qq')!
    store.set(target.key, { ...target.config, credentials: { appId: '123' } })
    // 4) 不变式：条目数不变，且改的是 qq 那条
    expect(store.size).toBe(2)
    expect(store.get('new_1700000000001')!.credentials.appId).toBe('123')
    expect(store.get('new_1700000000000')!.credentials.botToken).toBe('')
  })

  it('若按下标编 key（旧的错误做法），条目数会翻倍', () => {
    // 这是反证：把错误做法跑一遍，证明守卫测的东西确实会坏
    const store = new Map<string, any>()
    store.set('new_1', { type: 'telegram' })
    const values = Array.from(store.values())
    // 旧 main.ts 的写法
    const forged = values.map((config, i) => ({ key: `channel_${i}`, config }))
    store.set(forged[0].key, forged[0].config)
    expect(store.size, '按下标编 key 会让条目翻倍').toBe(2)
  })
})
