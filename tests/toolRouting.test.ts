// ============================================================
// toolRouting.test.ts — 工具按需筛选（2026-10-07）
//
// 【背景】修复前每轮把整档工具全量塞进 function list：
//   agent 67 个 ≈ 9,700 tokens / developer 93 个 ≈ 12,400 tokens，
//   **每一次模型调用都重发一遍**。实测 601 次真实调用只用到 22 个工具。
//
// 【本文件守什么】
//   1. 核心工具永远在（不能因为筛选让模型「没工具可用」）
//   2. 关键词命中就加组（功能不能丢）
//   3. 粘性生效（不能「上一轮能用下一轮没了」）
//   4. **失败开放**：拿不到输入 / 裁得太少 → 退回全量
//   5. 🔴 **提示词教过的工具必须常驻** —— 这是最容易踩的坑：
//      `agentTeamPersonas` 明确教模型调 delegate_to / hire_worker /
//      adversarial_review / git_worktree / save_context 等，
//      如果把它们挪进按需组，提示词就会让模型去调一个不在列表里的工具。
//   6. 真的省了 token（不是"路由了但体积没变"）
// ============================================================

import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { registerAllTools, getToolDef, resolveToolset, toOpenAIFunctions } from '../electron/tools/index'
import {
  routeTools, matchGroups, resetToolRouting, _resetAllToolRouting,
  CORE_TOOLS, DEVELOPER_CORE_TOOLS, CAPABILITY_GROUPS,
} from '../electron/tools/toolRouter'

const agentTools = () => resolveToolset('agent')
const devTools = () => resolveToolset('developer')

const schemaTokens = (names: string[]) => {
  const defs = names.map(n => getToolDef(n)).filter(Boolean)
  return Math.round(JSON.stringify(toOpenAIFunctions(defs as any[])).length / 3.5)
}

/**
 * 提示词里**明确教模型调用**的工具 —— 必须常驻，不能进按需组。
 * 依据：electron/agentTeamPersonas.ts（TEAM_LUMINA.systemPrompt）与
 *       electron/prompts/systemPrompt.ts 的实际文本。
 * 改动这张表前，请先去那两个文件里确认提示词是否也改了。
 */
const PROMPT_TAUGHT_TOOLS = [
  'delegate_to', 'delegate_chain', 'team_message', 'team_mailbox', 'team_tasks',
  'hire_worker', 'workflow', 'adversarial_review', 'git_worktree',
  'write_notice', 'read_notices', 'save_context', 'load_context',
]

describe('① 核心工具永远在', () => {
  beforeAll(() => { registerAllTools() })
  beforeEach(() => { _resetAllToolRouting() })

  it('无论用户问什么，CORE_TOOLS 里的工具都不会被裁掉', () => {
    for (const input of ['你好', '帮我搜一下今天的新闻', '写个快排', '整理桌面']) {
      const r = routeTools(agentTools(), 'agent', input, 's1')
      const missing = CORE_TOOLS.filter(t => agentTools().includes(t) && !r.tools.includes(t))
      expect(missing, `输入「${input}」时核心工具被裁掉了：${missing.join(', ')}`).toEqual([])
    }
  })

  it('developer 档额外常驻 git / lsp / 浏览器工具', () => {
    const r = routeTools(devTools(), 'developer', '看看这个 bug', 's1')
    const missing = DEVELOPER_CORE_TOOLS.filter(t => devTools().includes(t) && !r.tools.includes(t))
    expect(missing, `developer 常驻工具被裁掉了：${missing.join(', ')}`).toEqual([])
  })
})

describe('② 关键词命中即加组（功能不能丢）', () => {
  beforeAll(() => { registerAllTools() })
  beforeEach(() => { _resetAllToolRouting() })

  // [输入, 期望激活的组, 该组里应出现的工具, 用哪个档位验证]
  //   ⚠️ computer_use / browser_actions 的工具只在 developer 档，
  //     在 agent 档里这两个组即使被命中也不会带来新工具 —— 这是预期行为
  //     （agent 档本来就不该给电脑操控能力）。所以用 developer 档验证它们。
  const cases: Array<[string, string, string, 'agent' | 'developer']> = [
    ['帮我整理一下桌面，太乱了', 'desktop_tidy', 'desktop_tidy', 'agent'],
    ['明天有什么日程安排', 'calendar', 'calendar_add', 'agent'],
    ['每天下午三点提醒我喝水', 'tasks_schedule', 'cron_schedule', 'agent'],
    ['帮我截个图', 'system_extra', 'screenshot', 'agent'],
    ['你还记得我之前说过什么吗', 'memory_deep', 'memory_summarize', 'agent'],
    ['帮我操作一下这个软件界面', 'computer_use', 'desktop_click', 'developer'],
    ['去这个网站登录填表', 'browser_actions', 'browser_type', 'developer'],
    ['团队一起做个完整项目', 'team_advanced', 'hire_worker', 'agent'],
  ]

  it.each(cases)('「%s」→ 激活 %s（含 %s，%s 档）', (input, group, expectedTool, mode) => {
    const base = mode === 'developer' ? devTools() : agentTools()
    const r = routeTools(base, mode, input, 's1')
    expect(r.groups, `没匹配到 ${group} 组`).toContain(group)
    expect(r.tools, `激活了组但工具没进去: ${expectedTool}`).toContain(expectedTool)
  })

  it('matchGroups 大小写不敏感、中英都能命中', () => {
    expect(matchGroups('SCHEDULE a meeting')).toContain('calendar')
    expect(matchGroups('用 worktree 并行开发')).toContain('team_advanced')
    expect(matchGroups('随便聊聊天')).toEqual([])
  })
})

describe('③ 粘性：上一轮能用，下一轮还在', () => {
  beforeAll(() => { registerAllTools() })
  beforeEach(() => { _resetAllToolRouting() })

  it('第二轮没有关键词时，第一轮激活的组仍然生效', () => {
    const first = routeTools(agentTools(), 'agent', '帮我整理桌面', 'sess-A')
    expect(first.groups).toContain('desktop_tidy')

    // 第二轮完全无关键词 —— 若没有粘性，desktop_tidy 就会消失
    const second = routeTools(agentTools(), 'agent', '再帮我看看别的', 'sess-A')
    expect(second.groups, '粘性失效：第二轮丢了上一轮激活的组').toContain('desktop_tidy')
    expect(second.tools).toContain('desktop_tidy')
  })

  it('不同会话之间互不影响', () => {
    routeTools(agentTools(), 'agent', '帮我整理桌面', 'sess-A')
    const other = routeTools(agentTools(), 'agent', '你好', 'sess-B')
    expect(other.groups, '会话 B 不该继承会话 A 的组').not.toContain('desktop_tidy')
  })

  it('resetToolRouting 能清掉粘性', () => {
    routeTools(agentTools(), 'agent', '帮我整理桌面', 'sess-C')
    resetToolRouting('sess-C')
    const after = routeTools(agentTools(), 'agent', '你好', 'sess-C')
    expect(after.groups).not.toContain('desktop_tidy')
  })
})

describe('④ 🔓 失败开放：宁可多花 token 也不能没工具', () => {
  beforeAll(() => { registerAllTools() })
  beforeEach(() => { _resetAllToolRouting() })

  it('拿不到用户输入 → 退回全量', () => {
    for (const input of ['', '   ', undefined]) {
      const r = routeTools(agentTools(), 'agent', input as any, 's1')
      expect(r.narrowed, `输入 ${JSON.stringify(input)} 时不该裁剪`).toBe(false)
      expect(r.tools.length).toBe(agentTools().length)
    }
  })

  it('总开关关闭 → 退回全量', () => {
    const r = routeTools(agentTools(), 'agent', '帮我整理桌面', 's1', false)
    expect(r.narrowed).toBe(false)
    expect(r.tools.length).toBe(agentTools().length)
  })

  it('chat 档本来就是最小集，不做裁剪', () => {
    const r = routeTools(['web_search', 'file_read'], 'chat', '你好', 's1')
    expect(r.narrowed).toBe(false)
  })

  it('裁剪结果过少时自动退回全量（保护「读→改→验」闭环）', () => {
    // 只给 5 个候选，远低于阈值 8
    const tiny = ['web_search', 'file_read', 'file_write', 'shell_exec', 'datetime']
    const r = routeTools(tiny, 'agent', '你好', 's1')
    expect(r.narrowed, '候选过少时该退回而不是裁成 3 个').toBe(false)
    expect(r.tools.length).toBe(tiny.length)
  })
})

describe('⑤ 🔴 设计不变量：提示词教过的工具必须常驻', () => {
  beforeAll(() => { registerAllTools() })

  it('PROMPT_TAUGHT_TOOLS 全部在核心层（核心 ∪ developer 额外）', () => {
    const alwaysOn = new Set([...CORE_TOOLS, ...DEVELOPER_CORE_TOOLS])
    const missing = PROMPT_TAUGHT_TOOLS.filter(t => !alwaysOn.has(t))
    expect(
      missing,
      `这些工具在 agentTeamPersonas / systemPrompt 里被明确教给模型，\n` +
      `却被放进了按需组 —— 后果是提示词让模型调一个不在 function list 里的工具，\n` +
      `模型只能幻觉或失败。请把它们移回 CORE_TOOLS：\n  ${missing.join('\n  ')}`,
    ).toEqual([])
  })

  it('反向检查：按需组里没有"提示词教过"的工具', () => {
    const alwaysOn = new Set([...CORE_TOOLS, ...DEVELOPER_CORE_TOOLS])
    const offenders: string[] = []
    for (const [name, g] of Object.entries(CAPABILITY_GROUPS)) {
      for (const t of g.tools) {
        if (PROMPT_TAUGHT_TOOLS.includes(t) && !alwaysOn.has(t)) {
          offenders.push(`${t}（在组 ${name}）`)
        }
      }
    }
    expect(offenders, `按需组里混入了提示词教过的工具：${offenders.join(', ')}`).toEqual([])
  })

  it('按需组引用的工具名都真实存在（防止改名后静默失效）', () => {
    const all = new Set([...resolveToolset('full')])
    const ghost: string[] = []
    for (const [name, g] of Object.entries(CAPABILITY_GROUPS)) {
      for (const t of g.tools) {
        if (!all.has(t)) {ghost.push(`${name}.${t}`)}
      }
    }
    expect(
      ghost,
      `按需组引用了不存在的工具（改名后忘了同步，会导致该组"激活了但没工具"）：\n  ${ghost.join('\n  ')}`,
    ).toEqual([])
  })

  it('CORE_TOOLS 里的工具名也都真实存在', () => {
    const all = new Set([...resolveToolset('full')])
    const ghost = [...CORE_TOOLS, ...DEVELOPER_CORE_TOOLS].filter(t => !all.has(t))
    expect(ghost, `核心工具表里有不存在的名字：${ghost.join(', ')}`).toEqual([])
  })
})

describe('⑥ 真的省了 token', () => {
  beforeAll(() => { registerAllTools() })
  beforeEach(() => { _resetAllToolRouting() })

  it('agent 档：普通问题（无关键词）至少省 40%', () => {
    const full = schemaTokens(agentTools())
    const r = routeTools(agentTools(), 'agent', '你好，今天过得怎么样', 's1')
    const now = schemaTokens(r.tools)
    const saved = 1 - now / full
    expect(
      saved,
      `agent 档只省了 ${Math.round(saved * 100)}%（${full} → ${now} tokens），低于预期的 40%。\n` +
      `若刚往 CORE_TOOLS 里加了工具，请重新评估这笔固定开销。`,
    ).toBeGreaterThan(0.40)
  })

  it('developer 档：普通问题也至少省 40%', () => {
    const full = schemaTokens(devTools())
    const r = routeTools(devTools(), 'developer', '帮我看看这个 bug', 's1')
    const now = schemaTokens(r.tools)
    const saved = 1 - now / full
    expect(saved, `developer 档只省了 ${Math.round(saved * 100)}%`).toBeGreaterThan(0.40)
  })

  it('即使激活了团队进阶组，仍比全量小', () => {
    const full = schemaTokens(agentTools())
    const r = routeTools(agentTools(), 'agent', '团队一起做个完整项目', 's1')
    const now = schemaTokens(r.tools)
    expect(now, '激活大组后不该反而超过全量').toBeLessThan(full)
  })

  it('核心层本身必须是"小而够用"的（≤ 32 个工具）', () => {
    // 31 个的构成：21 个基础能力 + 14 个提示词教过的团队工具（- 4 重叠）
    // 这个上限不是拍脑袋：它是「每轮固定开销」的直接决定因素。
    expect(
      CORE_TOOLS.length,
      `CORE_TOOLS 已膨胀到 ${CORE_TOOLS.length} 个。核心层每加一个工具，` +
      `每次调用都要多付一次 schema 开销 —— 请先确认它真的该常驻，` +
      `或者考虑把它挪进按需组。`,
    ).toBeLessThanOrEqual(32)
  })
})
