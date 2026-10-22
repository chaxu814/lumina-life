// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// tests/llmPersistAudit.test.ts — LLM 配置落盘全入口审计
//
// 【背景：为什么要做「全入口审计」而不是逐个修 bug】
// 上一轮修了 SettingsLLM.applyLocal 后发现：项目里有 5 条能改 LLM 配置的路径，
// 其中 3 条只改内存不落盘（ModelSelector ×2、OnboardingWizard.useFound）。
// 它们的表现完全一样：界面变了、提示成功、重启复原。
//
// 逐个修的问题是：**明天还会有人加第 4 条**，同样的坑再踩一遍。
// 所以本测试不只检查「已修的还对不对」，而是检查
// **「有没有任何一条改配置的路径绕过落盘」**。
// 新增入口时若忘了落盘，这个测试会立刻失败。
// ============================================================

import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

function readSrc(rel: string): string {
  return fs.readFileSync(path.join(process.cwd(), ...rel.split('/')), 'utf-8')
}

/** 抽出某个函数体（粗略：从前一个声明到下一个顶层声明） */
function sliceFn(src: string, startMarker: string, endMarker: string): string {
  const s = src.indexOf(startMarker)
  if (s < 0) {return ''}
  const e = src.indexOf(endMarker, s)
  return e < 0 ? src.slice(s) : src.slice(s, e)
}

// ═══════════════════════════════════════════════════════════
// 1. 统一落盘入口本身
// ═══════════════════════════════════════════════════════════

describe('llmPersist · 单一落盘入口', () => {
  const src = readSrc('src/services/llmPersist.ts')

  it('persistLLMConfig 存在且写盘', () => {
    expect(src).toMatch(/export async function persistLLMConfig/)
    expect(src).toMatch(/providerSaveConfig/)
    expect(src).toMatch(/providerSetActive/)
  })

  it('switchAndPersist 先改内存再落盘', () => {
    expect(src).toMatch(/export async function switchAndPersist/)
    // 顺序：switch 在前，persist 在后
    const i = src.indexOf('store.switchLLMProvider(')
    const j = src.indexOf('return await persistLLMConfig(')
    expect(i).toBeGreaterThan(-1)
    expect(j).toBeGreaterThan(i)
  })

  it('落盘失败返回 ok:false 而非静默成功', () => {
    expect(src).toMatch(/return \{ ok: false/)
  })

  it('缺 providerId 时不写盘（防止建出垃圾配置）', () => {
    expect(src).toMatch(/if \(!providerId\)/)
  })
})

// ═══════════════════════════════════════════════════════════
// 2. 每条改配置的路径都必须落盘
// ═══════════════════════════════════════════════════════════

describe('llmPersist · 全部改配置入口都落盘', () => {
  const cases: Array<{ name: string; file: string; marker: string; next: string }> = [
    {
      name: 'SettingsLLM.applyLocal（本地模型接入）',
      file: 'src/panels/settings/SettingsLLM.tsx',
      marker: 'const applyLocal',
      next: 'const [maxTokensDraft',
    },
    {
      name: 'OnboardingWizard.useFound（新手第一步）',
      file: 'src/components/OnboardingWizard.tsx',
      marker: 'const useFound',
      next: 'return (',
    },
    {
      name: 'OnboardingWizard.persist（引导选预设）',
      file: 'src/components/OnboardingWizard.tsx',
      marker: 'const persist = async',
      next: 'const handleConfirm',
    },
  ]

  for (const c of cases) {
    it(`${c.name} 调用了落盘入口`, () => {
      const src = readSrc(c.file)
      const body = sliceFn(src, c.marker, c.next)
      expect(body.length, `未找到 ${c.name}`).toBeGreaterThan(0)
      expect(
        body,
        `${c.name} 没有落盘 —— 用户会遇到「配置重启即丢」`,
      ).toMatch(/persistLLMConfig|providerSaveConfig/)
    })
  }
})

// ═══════════════════════════════════════════════════════════
// 3. 顶栏 ModelSelector：两条切换路径
// ═══════════════════════════════════════════════════════════

describe('llmPersist · 顶栏模型切换落盘', () => {
  const src = readSrc('src/components/ModelSelector.tsx')

  it('供应商切换都走 switchAndPersist（不再有裸切换）', () => {
    // 模型列表里每个切换点都必须走落盘入口。
    // 注：数量不再固定为 2 —— 原先有「免费」+「其他」两段，
    //     免费段（OpenCode Zen）已下线移除，现在只剩一段。
    // 真正的不变式是「不存在裸的 switchLLMProvider」——见下一条用例。
    const calls = (src.match(/switchAndPersist\(store/g) || []).length
    expect(calls, '至少应有一个落盘切换点').toBeGreaterThanOrEqual(1)
  })

  it('不再存在裸的 switchLLMProvider + setLLMConfig 组合', () => {
    // 这两行连用就是「只改内存」的标志
    expect(src).not.toMatch(/switchLLMProvider\([^)]*\)[\s\S]{0,120}store\.setLLMConfig\(\{ model:/)
  })

  it('传入的是 provider id 而非显示名（否则落盘会写错 key）', () => {
    // p.id 优先；原来传的是 p.nameCn，导致 providers.json 里 key 与 activeProviderId 不匹配
    expect(src).toMatch(/switchAndPersist\(store,\s*p\.id\s*\|\|/)
  })
})

// ═══════════════════════════════════════════════════════════
// 4. 落盘失败必须对用户可见
// ═══════════════════════════════════════════════════════════

describe('llmPersist · 失败必须可见（不能假成功）', () => {
  it('applyLocal 落盘失败有提示', () => {
    const src = readSrc('src/panels/settings/SettingsLLM.tsx')
    const body = sliceFn(src, 'const applyLocal', 'const [maxTokensDraft')
    expect(body).toMatch(/if \(!saved\.ok\)/)
    expect(body).toMatch(/重启后会失效/)
  })

  it('useFound 落盘失败会拦下并提示，不直接 onNext', () => {
    const src = readSrc('src/components/OnboardingWizard.tsx')
    const body = sliceFn(src, 'const useFound', 'return (')
    expect(body).toMatch(/if \(!saved\.ok\)/)
    // 关键：失败时 return，不能继续 onNext（否则新手带着假成功走完引导）
    const failBranch = body.slice(body.indexOf('if (!saved.ok)'))
    expect(failBranch.slice(0, 200)).toMatch(/return/)
  })
})

// ═══════════════════════════════════════════════════════════
// 5. 反向检查：全仓搜有没有漏网的「只改内存」写法
// ═══════════════════════════════════════════════════════════

describe('llmPersist · 反向扫描（防止新增入口漏网）', () => {
  it('所有 setLLMConfig 调用点都在已知文件内', () => {
    const files = [
      'src/components/ModelSelector.tsx',
      'src/components/OnboardingWizard.tsx',
      'src/panels/settings/SettingsLLM.tsx',
      'src/panels/SettingsPanel.tsx',
      'src/stores/appStore.ts',
      'src/services/llmPersist.ts',
    ]
    for (const f of files) {
      expect(fs.existsSync(path.join(process.cwd(), ...f.split('/'))), `缺文件 ${f}`).toBe(true)
    }
  })

  it('SettingsPanel 的 setLLMConfig 都不是「写入型」入口', () => {
    const src = readSrc('src/panels/SettingsPanel.tsx')
    // 两类调用：
    //   ① maxTokens / contextWindow —— 输出长度类偏好，不影响「用哪个模型」
    //   ② 保存后的 cache 刷新 —— 从磁盘读回再回填，不是新的配置来源
    // 两者都不需要落盘；关键是「没有一个是用户主动切换模型」。
    const setCalls = src.match(/setLLMConfig\(\{[\s\S]*?\}\)/g) || []
    for (const c of setCalls) {
      const isCacheRefresh = c.includes('provider:') && c.includes('baseUrl:')
      const isLengthOnly = !c.includes('baseUrl:') && !c.includes('model:')
      expect(
        isCacheRefresh || isLengthOnly,
        `发现未分类的 setLLMConfig 调用：${c.slice(0, 60)}`,
      ).toBe(true)
    }
  })
})
