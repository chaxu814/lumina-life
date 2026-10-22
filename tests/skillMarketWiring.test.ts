// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// =============================================================
// tests/skillMarketWiring.test.ts — 技能市场接线守卫
//
// 【要防的是什么】
// 2026-10-04 发现的缺陷：主进程 `skillMarketIpc.ts` 注册了 **17 个**通道，
// 但 **preload 一个都没暴露**（只暴露 `luminaAPI`）。
// 而 `SkillMarketPanel.tsx` 绕道调用 `(window as any).electron.ipcRenderer.invoke(...)`
// —— `window.electron` 这个通道**根本不存在**（preload 只 expose 了 `luminaAPI`）。
//
// 后果：每次点击都是 `Cannot read properties of undefined (reading 'ipcRenderer')`。
// 界面能正常渲染，按钮点了没反应，日志里只有一串异常。
//
// **为什么测试和人工检查都没抓到**
// 1. 主进程侧「注册了」看起来像接好了
// 2. 面板侧代码写得像正常调用
// 3. 真正的接缝在 preload，而那 17 个通道此前**一行都没有**
//
// 这是本项目反复出现的同一类问题（打包 require 断链、团队动态 import、
// 渠道 key 伪造），所以本测试把「三层都得有」钉成不变式。
// =============================================================

import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

const root = path.join(__dirname, '..')
const read = (p: string): string => fs.readFileSync(path.join(root, p), 'utf8')
const code = (p: string): string =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map(line => (/^\s*\/\//.test(line) ? '' : line))
    .join('\n')

/** 面板实际会用到的 7 个通道（其余 10 个是预留的，不强求暴露） */
const REQUIRED = [
  'skill-market:installed',
  'skill-market:search',
  'skill-market:modelscope-search',
  'skill-market:install-community',
  'skill-market:install-local',
  'skill-market:uninstall',
  'skill-market:toggle',
]

describe('技能市场 · 三层接线都得在', () => {
  it('① 主进程注册了全部 7 个通道', () => {
    const src = read('electron/ipc/skillMarketIpc.ts')
    for (const ch of REQUIRED) {
      expect(src, `主进程未注册 ${ch}`).toContain(`ipcMain.handle('${ch}'`)
    }
  })

  it('② preload 暴露了对应的 luminaAPI 方法', () => {
    const src = code('electron/preload.ts')
    // 每个通道都要有一个 invoke 到它的方法
    for (const ch of REQUIRED) {
      expect(src, `preload 未暴露 ${ch}`).toMatch(new RegExp(`invoke\\('${ch.replace(':', '\\:')}'`))
    }
  })

  it('③ types.d.ts 声明了这些方法（否则 TS 不知道，编译期就红）', () => {
    const src = read('src/types.d.ts')
    for (const m of [
      'skillMarketInstalled', 'skillMarketSearch', 'skillMarketModelScopeSearch',
      'skillMarketInstallCommunity', 'skillMarketInstallLocal',
      'skillMarketUninstall', 'skillMarketToggle',
    ]) {
      expect(src, `types.d.ts 未声明 ${m}`).toContain(m)
    }
  })

  it('面板只走 luminaAPI，不再绕 window.electron', () => {
    const src = code('src/panels/SkillMarketPanel.tsx')
    // 旧写法：`(window as any).electron.ipcRenderer` —— 这个通道不存在
    expect(src, '面板仍在使用不存在的 window.electron 旁路')
      .not.toMatch(/electron\.ipcRenderer/)
    expect(src).toMatch(/luminaAPI\?\.skillMarket/)
  })
})

describe('技能市场 · 注册表健康度必须可见', () => {
  it('④ 主进程暴露 registry-health', () => {
    expect(code('electron/ipc/skillMarketIpc.ts'))
      .toContain("ipcMain.handle('skill-market:registry-health'")
  })

  it('⑤ SkillMarket 有 getRegistryHealth 且记录远端失败', () => {
    const src = code('electron/skillMarket.ts')
    expect(src).toMatch(/getRegistryHealth\s*\(/)
    expect(src).toMatch(/registryHealth\s*=/)
  })

  it('⑥ 搜索失败不再被静默吞掉（原来 catch { continue } 什么都不留）', () => {
    const src = code('electron/skillMarket.ts')
    const m = src.match(/async searchCommunity[\s\S]{0,1400}?\n {2}\}/)
    expect(m, '未找到 searchCommunity').not.toBeNull()
    expect(m![0], 'searchCommunity 里仍有裸 catch { continue }，失败不留痕')
      .not.toMatch(/catch\s*\{\s*continue\s*\}/)
    expect(m![0]).toMatch(/failures\.push/)
  })

  it('⑦ 注册表地址可覆盖（生态要能长出来，得先有地方长）', () => {
    const src = code('electron/skillMarket.ts')
    expect(src).toContain('LUMINA_SKILL_REGISTRY')
  })
})
