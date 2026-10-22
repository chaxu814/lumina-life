// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// capabilityMatching.test.ts — 端到端能力匹配审查（2026-10-10）
//
// 【这份测试在回答什么问题】
//   「Lumina 现在到底会不会按问题类型灵活、智能、高效地选能力，
//     而不是死板地一起用工具？」
//
//   它从三个层面**实测**，不是看代码接线：
//     ① 工具暴露面：复刻 getToolsForMode 的管线，看每种问法实际拿到哪些工具
//     ② 提示词注入：真的调用 buildSystemPrompt，看本轮指引有没有进去
//     ③ 效率：量出每类问题的工具 schema token 开销
//
//   核心不变量：
//     · 纯推理题 → 工具清单里**没有** web_search（模型想搜也搜不了）
//     · 实时信息 → 工具清单里**有** web_search
//     · 用户显式要搜 → 仍然有 web_search（尊重用户）
// ============================================================

import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { registerAllTools, resolveToolset, getToolDef, toOpenAIFunctions } from '../electron/tools/index'
import { routeTools, _resetAllToolRouting } from '../electron/tools/toolRouter'
import { profileTask, SEARCH_TOOLS } from '../electron/orchestration/taskProfiler'
import { buildSystemPrompt } from '../electron/prompts/systemPrompt'

const SEARCH = SEARCH_TOOLS as readonly string[]

/** 工具 schema 的近似 token 数（与 toolRouting.test.ts 同一算法） */
const schemaTokens = (names: string[]): number => {
  const defs = names.map(n => getToolDef(n)).filter(Boolean)
  return Math.round(JSON.stringify(toOpenAIFunctions(defs as any[])).length / 3.5)
}

/** 复刻 getToolsForMode 的「按需筛选 + 能力匹配收紧」两步 */
function exposedTools(input: string): {
  tools: string[]; kind: string; searchable: boolean; tokens: number
} {
  // 每次探测都清空粘性 —— 测「单看这一句会暴露什么」，不是累积后的结果
  _resetAllToolRouting()
  const base = resolveToolset('agent')
  const routed = routeTools(base, 'agent', input, 'audit', true)
  let tools = routed.tools
  const profile = profileTask(input)
  if (profile.suppressSearch) {
    tools = tools.filter(t => !SEARCH.includes(t))
  }
  return {
    tools,
    kind: profile.kind,
    searchable: tools.some(t => SEARCH.includes(t)),
    tokens: schemaTokens(tools),
  }
}

const REASONING_CASES = [
  '集合 C={1,2,3,...,13} 子集 N 个元素 不含五个连续整数 概率',
  '证明根号2是无理数',
  '从 10 个人里选 3 个人有多少种组合',
  '解方程 x^2 - 5x + 6 = 0',
  '帮我算一下 2 的 10 次方等于多少',
  '5 的平方根是多少',
  '这个算法的复杂度是多少',
]

const REALTIME_CASES = [
  '今天北京天气怎么样',
  '最新的 AI 新闻有哪些',
  '茅台今天股价多少',
  '现在几点了',
]

describe('① 工具暴露面：按问题类型灵活选能力', () => {
  beforeAll(() => { registerAllTools() })
  beforeEach(() => { _resetAllToolRouting() })

  it('纯推理题：联网工具被拿掉（模型只能自己推）', () => {
    for (const q of REASONING_CASES) {
      const r = exposedTools(q)
      expect(r.kind, `「${q}」应判为 reasoning`).toBe('reasoning')
      expect(r.searchable, `「${q}」是纯推理题，本轮却仍暴露了联网工具`).toBe(false)
    }
  })

  it('实时信息：联网工具必须在（否则查不到实时数据）', () => {
    for (const q of REALTIME_CASES) {
      const r = exposedTools(q)
      expect(r.kind, `「${q}」应判为 realtime`).toBe('realtime')
      expect(r.searchable, `「${q}」是实时信息，本轮却没给联网工具`).toBe(true)
    }
  })

  it('用户显式要搜 → 推理题也保留联网工具（尊重用户）', () => {
    const r = exposedTools('帮我搜一下这个概率公式的推导过程')
    expect(r.kind).toBe('reasoning')
    expect(r.searchable, '用户明确要搜，不该被抑制').toBe(true)
  })

  it('知识解释：保留联网能力（但 prompt 引导优先用自身知识）', () => {
    const r = exposedTools('什么是量子纠缠')
    expect(r.kind).toBe('knowledge')
    expect(r.searchable).toBe(true)
  })

  it('编程请求 → coding（不被「帮我写」写作信号抢走）', () => {
    for (const q of ['帮我写一个爬虫脚本', '实现一个登录接口', '调试一下这个报错']) {
      expect(profileTask(q).kind, `「${q}」应判为 coding`).toBe('coding')
    }
  })

  it('工具清单不会因为筛选而空掉（失败开放）', () => {
    for (const q of [...REASONING_CASES, ...REALTIME_CASES, '你好呀', '随便聊聊']) {
      expect(exposedTools(q).tools.length, `「${q}」筛选后工具过少`).toBeGreaterThan(8)
    }
  })
})

describe('② 提示词注入：本轮针对性指引确实进了 prompt', () => {
  it('纯推理题 → prompt 含能力匹配 + 明确"不要联网"', () => {
    const p = buildSystemPrompt('lumina', undefined, { userInput: '证明根号2是无理数', injectSkills: false })
    expect(p).toContain('## 🎯 能力匹配（术有专攻）')
    expect(p, '推理题必须明确告诉模型不要联网').toContain('不要调用 web_search')
  })

  it('实时信息 → prompt 含"必须联网"', () => {
    const p = buildSystemPrompt('lumina', undefined, { userInput: '今天北京天气怎么样', injectSkills: false })
    expect(p).toContain('## 🎯 能力匹配（术有专攻）')
    expect(p, '实时信息必须要求联网').toContain('web_search 联网查询')
  })

  it('闲聊 → 不注入能力匹配段（保持轻松、不啰嗦）', () => {
    const p = buildSystemPrompt('lumina', undefined, { userInput: '你好呀', injectSkills: false })
    expect(p).not.toContain('## 🎯 能力匹配（术有专攻）')
  })

  it('总则含"单点打击"纪律（不要并调不相关工具）', () => {
    const p = buildSystemPrompt('lumina', undefined, { userInput: '帮我写个爬虫', injectSkills: false })
    expect(p).toContain('单点打击')
    expect(p).toContain('只调最相关的那一个')
  })
})

describe('③ 效率：按需筛选 + 能力匹配确实省 token', () => {
  beforeAll(() => { registerAllTools() })
  beforeEach(() => { _resetAllToolRouting() })

  it('推理题的工具开销显著低于 agent 档全量', () => {
    const full = schemaTokens(resolveToolset('agent'))
    const r = exposedTools(REASONING_CASES[0])
    const saved = 1 - r.tokens / full
    expect(
      saved,
      `推理题工具开销 ${r.tokens} tokens vs 全量 ${full}，只省了 ${Math.round(saved * 100)}%`,
    ).toBeGreaterThan(0.5)
  })

  it('推理题比实时信息更省（不加载联网/天气/新闻等组）', () => {
    const reasoning = exposedTools(REASONING_CASES[0]).tokens
    const realtime = exposedTools(REALTIME_CASES[1]).tokens // 「最新的 AI 新闻」
    expect(reasoning, '推理题应比实时信息更精简').toBeLessThan(realtime)
  })
})

describe('④ 审查报告（人工复核用）', () => {
  beforeAll(() => { registerAllTools() })

  it('打印各类问法实际暴露的联网能力与 token 开销', () => {
    const probe = [
      ...REASONING_CASES,
      ...REALTIME_CASES,
      '什么是量子纠缠',
      '帮我写一个爬虫脚本',
      '帮我审查一下这段代码的风险',
      '你好呀',
    ]
    const full = schemaTokens(resolveToolset('agent'))
    const rows = probe.map(q => {
      const r = exposedTools(q)
      const saved = Math.round((1 - r.tokens / full) * 100)
      return `${r.searchable ? '✅可联网' : '⛔不可联网'}  [${r.kind.padEnd(9)}] 工具${String(r.tools.length).padStart(3)} · ${String(r.tokens).padStart(4)}tok(省${String(saved).padStart(2)}%)  ${q.length > 30 ? q.slice(0, 30) + '…' : q}`
    })
    // eslint-disable-next-line no-console
    console.log('\n=== 能力匹配审查表（agent 档 · 全量 ' + full + ' tok）===\n' + rows.join('\n') + '\n')
    expect(rows.length).toBeGreaterThan(0)
  })
})
