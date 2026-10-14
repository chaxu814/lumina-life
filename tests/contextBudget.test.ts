import { describe, it, expect } from 'vitest'
import { trimToBudget, DEFAULT_CONTEXT_LIMIT, type BudgetMessage } from '../electron/agent/contextBudget'

// 与生产同口径的估算：中文 ≈1.5 字/token
const est = (t: string) => Math.ceil((t || '').length / 1.5)

interface M extends BudgetMessage { role: string; content: string }
const m = (role: string, content: string): M => ({ role, content })

/**
 * 复现 2026-10-12 的真实故障形状（数据取自 %APPDATA%/lumina-memory.db
 * 的 conversation_history，id 15969–15983）：
 *
 *   [system] AGENTS.md          9823 字   ← 身份提示
 *   [user]   (对话开始)            6 字
 *   [system] 操作知识库         1128 字
 *   [user]   尼古喵喵是什么        7 字   ← ★ 用户本轮的问题（必须保住）
 *   [tool]   BING 搜索…          × 5      ← ReAct 循环里的检索结果
 *   [assistant] （空）           × 4
 *   [user]   请根据本轮对话给出一个简洁的自然语言回复…   ← 总结轮指令
 *
 * 实测故障：system 提示词 ≈7300 token，若上下文窗口设为 8K，
 * safeLimit = 8192×0.85 = 6963 → historyBudget ≤ 0 → 走进"超预算"分支 →
 * 旧实现只留最后 3 条非 system（assistant空/tool/总结指令）→ **问题被丢掉** →
 * 模型对着一条指令作答，回复「抱歉，这是我们的第一次对话…」。
 */
function buildFailureShape(): { messages: M[]; question: M } {
  const question = m('user', '尼古喵喵是什么')
  const messages: M[] = [
    m('system', 'AGENTS.md 行为准则'.padEnd(9823, '甲')),
    m('user', '(对话开始)'),
    m('system', '【操作知识库】'.padEnd(1128, '乙')),
    question,
    m('tool', '🔍 BING 搜索: "尼古喵喵 动画 简介" …（CAPTCHA 失败）'),
    m('assistant', ''),
    m('tool', '🔍 BING 搜索: "尼古喵喵 Nya 动画 漫画 原作" …'),
    m('assistant', ''),
    m('tool', '🔍 BING 搜索: "尼古喵喵 动画 作者 田中道治" …'),
    m('assistant', ''),
    m('tool', '🔍 BING 搜索: "尼古喵喵 漫画 原作 山田隆司" …'),
    m('assistant', ''),
    m('tool', '🔍 BING 搜索: "尼古喵喵 Nya Nya Nyanko 动画 介绍 剧情" …'),
    m('user', '请根据本轮对话给出一个简洁的自然语言回复。不要调用工具，不要输出代码块。'),
  ]
  return { messages, question }
}

describe('① 复现故障：用户的问题绝不能被裁掉', () => {
  it('system 提示词超预算时（8K 窗口），问题仍在上下文中', () => {
    const { messages, question } = buildFailureShape()
    const r = trimToBudget(messages, 8192, est, { mustKeep: question })

    expect(r.overBudget).toBe(true)
    // ★ 核心断言：问题必须还在
    expect(r.messages.some(x => x === question)).toBe(true)
    // 并且身份提示也在（丢了模型就不知道自己的工具与身份）
    expect(r.messages[0]).toBe(messages[0])
  })

  it('超预算时问题之后要带上工具结果（模型需要素材）', () => {
    const { messages, question } = buildFailureShape()
    const r = trimToBudget(messages, 8192, est, { mustKeep: question })
    const after = r.messages.slice(r.messages.indexOf(question) + 1)
    expect(after.length).toBeGreaterThanOrEqual(3)
    expect(after.some(x => x.role === 'tool')).toBe(true)
  })

  it('裁剪结果必须以 user 开头（否则下游会整段删掉）', () => {
    const { messages, question } = buildFailureShape()
    const r = trimToBudget(messages, 8192, est, { mustKeep: question })
    const firstNonSystem = r.messages.find(m2 => m2.role !== 'system')
    expect(firstNonSystem?.role).toBe('user')
  })

  it('窗口充裕时同样保住问题（正常分支）', () => {
    const { messages, question } = buildFailureShape()
    const r = trimToBudget(messages, 200000, est, { mustKeep: question })
    expect(r.overBudget).toBe(false)
    expect(r.messages.some(x => x === question)).toBe(true)
  })
})

describe('② mustKeep 的兜底救援', () => {
  it('问题被预算挤出时会被强制插回最前，并标记 rescued', () => {
    // 造一段"问题很早、后面一长串消息"的历史
    const question = m('user', '最初的提问')
    const filler: M[] = []
    for (let i = 0; i < 40; i++) {
      filler.push(m('user', `后续问题 ${i} `.padEnd(200, '丙')))
      filler.push(m('assistant', `回答 ${i} `.padEnd(200, '丁')))
    }
    const messages: M[] = [m('system', '身份'), question, ...filler]

    const r = trimToBudget(messages, 4000, est, { mustKeep: question })
    expect(r.messages.some(x => x === question)).toBe(true)
    expect(r.mustKeepRescued).toBe(true)
    // 问题在最前（它是本轮最早的一条）
    expect(r.messages[1]).toBe(question)
  })

  it('没有 mustKeep 时不应崩溃，也不应把历史清空', () => {
    const { messages } = buildFailureShape()
    const r = trimToBudget(messages, 8192, est)
    expect(r.messages.length).toBeGreaterThan(0)
    expect(r.messages.some(x => x.role !== 'system')).toBe(true)
  })
})

describe('③ 不制造「孤立开头」', () => {
  it('尾部以 assistant/tool 开头时，裁掉它们直到 user', () => {
    const question = m('user', '问题')
    const messages: M[] = [
      m('system', '身份'),
      question,
      m('assistant', 'x'.repeat(4000)),
      m('tool', 'y'.repeat(4000)),
      m('assistant', 'z'.repeat(4000)),
    ]
    const r = trimToBudget(messages, 6000, est, { mustKeep: question })
    const firstNonSystem = r.messages.find(x => x.role !== 'system')
    expect(firstNonSystem?.role).toBe('user')
  })
})

describe('④ 边界情况', () => {
  it('contextLimit <= 0 时用保守缺省，不崩', () => {
    const { messages, question } = buildFailureShape()
    const r = trimToBudget(messages, 0, est, { mustKeep: question })
    expect(r.messages.some(x => x === question)).toBe(true)
    expect(DEFAULT_CONTEXT_LIMIT).toBe(32768)
  })

  it('空数组安全', () => {
    const r = trimToBudget([], 8192, est)
    expect(r.messages).toEqual([])
    expect(r.droppedHistory).toBe(0)
  })

  it('只有 system 时安全', () => {
    const r = trimToBudget([m('system', '身份')], 8192, est)
    expect(r.messages).toHaveLength(1)
  })

  it('droppedHistory 如实反映被裁掉的条数', () => {
    const { messages, question } = buildFailureShape()
    const r = trimToBudget(messages, 200000, est, { mustKeep: question })
    expect(r.droppedHistory).toBe(0)   // 窗口充裕 → 一条不裁
  })
})
