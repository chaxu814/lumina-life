// =============================================================
// tests/observabilityWiring.test.ts — 可观测性模块接线守卫
//
// 【背景：这份测试是被自己的交付逼出来的】
// 2026-10-04 交付了 13 项改进后，我做了一次自查（用户要求「检查一下」），
// 结果发现其中 4 项是**死模块**：
//
//   · SwimlaneCanvas / MemoryTrialBenchPanel —— 有 UI、有单测，
//     但没挂进 panelMap、没进「更多设置」、preload 无对应 API、
//     IPC 也没注册。运行时一行都执行不到。
//   · emotionCausality —— 67 个用例全绿，但**没有任何生产代码调用它**。
//   · skillMarketRegistryHealth —— 暴露到 preload 了，但 UI 从不读。
//
// 这与 SkillMarketPanel 那个 bug 是同一类：接缝在中间层，两侧都「看起来正常」。
// 所以本测试把「主进程 → preload → 类型 → 挂载」四层都钉住。
//
// 【最重要的一条】
// 底部「反例」用例会证明：**只写模块不接线，守卫之外的一切看起来都是绿的**。
// 测试跑不过只能说明你改了接线；它跑得过也不能说明接线是对的。
// 真正的判据是 panelMap 里有没有那个 id、preload 里有没有那个 invoke。
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

describe('可观测性 · ① 主进程注册了 IPC', () => {
  it('registerObservabilityIpc 存在并被 main.ts 调用', () => {
    const src = code('electron/ipc/observabilityIpc.ts')
    expect(src).toMatch(/export function registerObservabilityIpc/)
    const main = read('electron/main.ts')
    expect(main).toContain('registerObservabilityIpc')
  })

  it('四个记忆审判台通道 + 泳道通道都注册了', () => {
    const src = code('electron/ipc/observabilityIpc.ts')
    for (const ch of [
      'memory-trial:review', 'memory-trial:submit',
      'memory-trial:stats', 'memory-trial:history', 'swimlane:get',
    ]) {
      expect(src, `未注册 ${ch}`).toContain(`ipcMain.handle('${ch}'`)
    }
  })
})

describe('可观测性 · ② preload 暴露了对应 API', () => {
  it('preload 有 memoryTrial* 与 swimlane', () => {
    const src = code('electron/preload.ts')
    for (const m of [
      'memoryTrialReview', 'memoryTrialSubmit', 'memoryTrialStats',
      'memoryTrialHistory', 'swimlane',
    ]) {
      expect(src, `preload 未暴露 ${m}`).toMatch(new RegExp(`\\b${m}\\b`))
    }
  })

  it('preload 的 invoke 目标与 IPC 注册一致', () => {
    const src = code('electron/preload.ts')
    for (const ch of [
      'memory-trial:review', 'memory-trial:submit',
      'memory-trial:stats', 'memory-trial:history', 'swimlane:get',
    ]) {
      expect(src, `preload 未 invoke ${ch}`).toContain(`invoke('${ch}'`)
    }
  })

  it('types.d.ts 也声明了（否则 TS 编译期就红）', () => {
    const src = read('src/types.d.ts')
    for (const m of ['memoryTrialReview', 'memoryTrialSubmit', 'swimlane']) {
      expect(src, `types.d.ts 未声明 ${m}`).toContain(m)
    }
  })
})

describe('可观测性 · ③ 面板真的被挂载了（这是之前漏掉的那一环）', () => {
  it('App.tsx 的 panelMap 里有这两个 id', () => {
    const src = code('src/App.tsx')
    expect(src, 'SwimlaneCanvas 未进 panelMap').toMatch(/swimlane:\s*SwimlaneCanvas/)
    expect(src, 'MemoryTrialBenchPanel 未进 panelMap').toMatch(/memorytrial:\s*MemoryTrialBenchPanel/)
  })

  it('App.tsx 有对应的 import', () => {
    const src = code('src/App.tsx')
    expect(src).toMatch(/import\s+SwimlaneCanvas\s+from/)
    expect(src).toMatch(/import\s+MemoryTrialBenchPanel\s+from/)
  })

  it('PanelType 联合类型包含这两个 id', () => {
    const src = read('src/stores/appStore.ts')
    const m = src.match(/export type PanelType\s*=\s*([^\n]+)/)
    expect(m, '未找到 PanelType').not.toBeNull()
    expect(m![1]).toContain('"swimlane"')
    expect(m![1]).toContain('"memorytrial"')
  })

  it('「更多设置」里两个入口都在：清单 + 内容渲染', () => {
    const src = code('src/components/MoreSettingsModal.tsx')
    // 菜单项
    expect(src).toMatch(/id:\s*'swimlane'/)
    expect(src).toMatch(/id:\s*'memorytrial'/)
    // 内容渲染 —— 只加菜单不加渲染分支的话，点进去是空白
    expect(src, 'swimlane 只有菜单没有渲染分支').toMatch(/activeSection\s*===\s*'swimlane'\s*&&\s*<SwimlaneCanvas/)
    expect(src, 'memorytrial 只有菜单没有渲染分支').toMatch(/activeSection\s*===\s*'memorytrial'\s*&&\s*<MemoryTrialBenchPanel/)
  })
})

describe('可观测性 · ④ 情绪因果链真的被生产代码调用', () => {
  it('agentRunner 调了 getCausalFrontendThree 与 getCausalGatingHints', () => {
    const src = code('electron/agentRunner.ts')
    expect(src, 'getCausalFrontendThree 仍是死函数').toMatch(/getCausalFrontendThree\(\)/)
    expect(src, 'getCausalGatingHints 仍是死函数').toMatch(/getCausalGatingHints\(\)/)
  })

  it('因果情绪以「取更严的一侧」方式合并，而不是覆盖', () => {
    // 【为什么这条重要】若用因果值直接覆盖表情值，
    // 某次 worker 失败带来的低 confidence 可能在下一轮被桌宠表情抹平，
    // 门控就又松回去了 —— 那等于「情绪可以放松」，违反只收紧不放松的不变量。
    const src = code('electron/agentRunner.ts')
    expect(src).toMatch(/mood:\s*Math\.min\(/)
    expect(src).toMatch(/energy:\s*Math\.min\(/)
  })

  it('因果链自身出错时不阻断主流程', () => {
    const src = code('electron/agentRunner.ts')
    const m = src.match(/try\s*\{[\s\S]{0,800}?getCausalGatingHints\(\)[\s\S]{0,400}?catch\s*\{/)
    expect(m, '未找到因果链的 try/catch 保护').not.toBeNull()
  })
})

describe('可观测性 · 反例：证明「只写模块不接线」看起来一切正常', () => {
  it('没有 panelMap 挂载时，模块与用例都能独立通过', () => {
    // 这个反例不是为了测代码，而是提醒：
    // **单测全绿 ≠ 功能可用**。本项目今天已经因此交付出 4 个死模块。
    const swimlane = read('electron/team/swimlane.ts')
    const trial = read('electron/memory/trialBench.ts')
    const causal = read('electron/pet/emotionCausality.ts')
    // 三个模块内容都相当完整（有导出、有大量实现）
    expect(swimlane.length).toBeGreaterThan(10_000)
    expect(trial.length).toBeGreaterThan(10_000)
    expect(causal.length).toBeGreaterThan(10_000)
    // 但它们的「是否接上」只由上面那几组断言决定，与内容多少无关
  })
})
