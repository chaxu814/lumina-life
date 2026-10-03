// decisionService.test.ts — 决策征询系统测试
//
// 这里的测试重心不在「正常问答」，而在**异常路径**：
// 决策系统一旦挂住，会连带卡死 agent 的整个 ReAct 循环。
// 所以「绝不能阻塞」这件事必须被测试钉死。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  askDecision, submitDecisionAnswer, cancelDecision, cancelAllDecisions,
  getPendingDecisions, setDecisionConfig, getDecisionConfig,
  validateDecisionInput, onDecisionEvent,
  DEFAULT_DECISION_CONFIG, type DecisionAnswer,
} from '../electron/decisionService'

let unsubscribe: (() => void) | null = null

beforeEach(() => {
  cancelAllDecisions()
  setDecisionConfig({ ...DEFAULT_DECISION_CONFIG })
})

afterEach(() => {
  cancelAllDecisions()
  unsubscribe?.()
  unsubscribe = null
  vi.useRealTimers()
})

const OPTS = [
  { id: 'a', label: '方案 A', description: '快但糙' },
  { id: 'b', label: '方案 B', description: '慢但稳', recommended: true },
]

/** 挂一个假 UI 订阅者，模拟「有界面能显示卡片」 */
function fakeUI() {
  const seen: any[] = []
  unsubscribe = onDecisionEvent((ev) => seen.push(ev))
  return seen
}

// ═══════════════════════════════════════════════════════════
// 校验层
// ═══════════════════════════════════════════════════════════

describe('validateDecisionInput', () => {
  it('合法输入通过', () => {
    const v = validateDecisionInput({ question: '用哪个数据库？', options: OPTS })
    expect(v.ok).toBe(true)
    expect(v.options).toHaveLength(2)
    expect(v.errors).toHaveLength(0)
  })

  it('question 为空报错', () => {
    const v = validateDecisionInput({ question: '   ', options: OPTS })
    expect(v.ok).toBe(false)
    expect(v.errors.join()).toContain('question')
  })

  it('options 必须是数组且非空', () => {
    expect(validateDecisionInput({ question: 'x', options: [] }).ok).toBe(false)
    expect(validateDecisionInput({ question: 'x', options: undefined as any }).ok).toBe(false)
    expect(validateDecisionInput({ question: 'x', options: {} as any }).ok).toBe(false)
  })

  it('选项缺 label 被拒', () => {
    const v = validateDecisionInput({ question: 'x', options: [{ id: 'a' } as any] })
    expect(v.ok).toBe(false)
  })

  it('缺 id 时用 label 派生，保证 agent 侧引用稳定', () => {
    const v = validateDecisionInput({ question: 'x', options: [{ label: '用 Redis' }] })
    expect(v.ok).toBe(true)
    expect(v.options[0].id).toBe('opt_用 Redis')
  })

  it('重复 id 被拒', () => {
    const v = validateDecisionInput({
      question: 'x',
      options: [{ id: 'same', label: 'A' }, { id: 'same', label: 'B' }],
    })
    expect(v.ok).toBe(false)
  })

  it('多个 recommended 自动只保留第一个', () => {
    const v = validateDecisionInput({
      question: 'x',
      options: [
        { id: 'a', label: 'A', recommended: true },
        { id: 'b', label: 'B', recommended: true },
      ],
    })
    expect(v.options.filter(o => o.recommended)).toHaveLength(1)
  })

  it('选项过多被拒（卡片太长没人看）', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ id: `o${i}`, label: `选项${i}` }))
    expect(validateDecisionInput({ question: 'x', options: many }).ok).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════
// 正常路径
// ═══════════════════════════════════════════════════════════

describe('askDecision — 正常问答', () => {
  it('用户选推荐项 → summary 正确', async () => {
    fakeUI()
    const p = askDecision({ askedBy: 'lumina', question: '用哪个数据库？', options: OPTS })
    const req = getPendingDecisions()[0]
    expect(req.status).toBe('pending')
    expect(req.question).toBe('用哪个数据库？')

    submitDecisionAnswer({ id: req.id, selectedIds: ['b'] })
    const r = await p
    expect(r.status).toBe('answered')
    expect(r.answer?.selectedIds).toEqual(['b'])
    expect(r.summary).toContain('方案 B')
  })

  it('多选返回多个选项', async () => {
    fakeUI()
    const p = askDecision({ askedBy: 'lumina', question: '选哪些？', options: OPTS, multiSelect: true })
    const req = getPendingDecisions()[0]
    submitDecisionAnswer({ id: req.id, selectedIds: ['a', 'b'] })
    const r = await p
    expect(r.answer?.selectedIds).toHaveLength(2)
    expect(r.summary).toContain('方案 A')
    expect(r.summary).toContain('方案 B')
  })

  it('选选项 + 补充说明，summary 两段都在', async () => {
    fakeUI()
    const p = askDecision({ askedBy: 'lumina', question: 'q', options: OPTS })
    const req = getPendingDecisions()[0]
    submitDecisionAnswer({ id: req.id, selectedIds: ['a'], customText: '但要兼容旧数据' })
    const r = await p
    expect(r.summary).toContain('方案 A')
    expect(r.summary).toContain('兼容旧数据')
  })

  it('不选任何选项只填自定义 → 也算有效回答', async () => {
    fakeUI()
    const p = askDecision({ askedBy: 'lumina', question: 'q', options: OPTS })
    const req = getPendingDecisions()[0]
    const res = submitDecisionAnswer({ id: req.id, selectedIds: [], customText: '你看着办' })
    expect(res.ok).toBe(true)
    const r = await p
    expect(r.summary).toContain('你看着办')
  })

  it('带 context 的请求会带出 context', async () => {
    fakeUI()
    const p = askDecision({ askedBy: 'yak', question: 'q', context: '我发现两边都有坑', options: OPTS })
    const req = getPendingDecisions()[0]
    expect(req.context).toBe('我发现两边都有坑')
    expect(req.askedBy).toBe('yak')
    submitDecisionAnswer({ id: req.id, selectedIds: ['a'] })
    await p
  })

  it('默认允许自定义回答、默认单选', async () => {
    fakeUI()
    const p = askDecision({ askedBy: 'lumina', question: 'q', options: OPTS })
    const req = getPendingDecisions()[0]
    expect(req.allowCustomAnswer).toBe(true)
    expect(req.multiSelect).toBe(false)
    submitDecisionAnswer({ id: req.id, selectedIds: ['a'] })
    await p
  })
})

// ═══════════════════════════════════════════════════════════
// 异常路径 —— 绝不能阻塞 agent（最关键）
// ═══════════════════════════════════════════════════════════

describe('askDecision — 异常路径不阻塞', () => {
  it('无 UI 订阅者 → 立即返回默认，不挂起', async () => {
    // 注意：不挂 fakeUI，listeners 为空
    const r = await askDecision({ askedBy: 'lumina', question: 'q', options: OPTS })
    expect(r.status).toBe('timeout')
    expect(r.summary).toContain('方案 B') // 默认走推荐项
    expect(getPendingDecisions()).toHaveLength(0)
  })

  it('开关关闭 → 立即返回默认', async () => {
    fakeUI()
    setDecisionConfig({ enabled: false })
    const r = await askDecision({ askedBy: 'lumina', question: 'q', options: OPTS })
    expect(r.summary).toContain('已关闭')
    expect(getPendingDecisions()).toHaveLength(0)
  })

  it('参数非法 → 立即返回错误说明，不挂起', async () => {
    fakeUI()
    const r = await askDecision({ askedBy: 'lumina', question: '', options: [] })
    expect(r.status).toBe('cancelled')
    expect(r.summary).toContain('无效')
    expect(getPendingDecisions()).toHaveLength(0)
  })

  it('挂起数超上限 → 立即返回默认', async () => {
    fakeUI()
    setDecisionConfig({ maxPending: 2 })
    const p1 = askDecision({ askedBy: 'lumina', question: 'q1', options: OPTS })
    const p2 = askDecision({ askedBy: 'lumina', question: 'q2', options: OPTS })
    expect(getPendingDecisions()).toHaveLength(2)
    const r3 = await askDecision({ askedBy: 'lumina', question: 'q3', options: OPTS })
    expect(r3.status).toBe('timeout')
    expect(r3.summary).toContain('上限')
    // 清理
    cancelAllDecisions()
    await Promise.all([p1, p2])
  })

  it('超时后按推荐项继续（agent 不会永远等）', async () => {
    fakeUI()
    vi.useFakeTimers()
    const p = askDecision({ askedBy: 'lumina', question: 'q', options: OPTS, timeoutMs: 1000 })
    vi.advanceTimersByTime(1500)
    const r = await p
    expect(r.status).toBe('timeout')
    expect(r.answer?.selectedIds).toEqual(['b']) // 推荐项
    expect(getPendingDecisions()).toHaveLength(0)
  })

  it('取消 → agent 拿到明确信号', async () => {
    fakeUI()
    const p = askDecision({ askedBy: 'lumina', question: 'q', options: OPTS })
    const req = getPendingDecisions()[0]
    cancelDecision(req.id)
    const r = await p
    expect(r.status).toBe('cancelled')
    expect(r.summary).toContain('取消')
  })

  it('用户点 ✕（走 submitDecisionAnswer 的 cancelled）同样生效', async () => {
    fakeUI()
    const p = askDecision({ askedBy: 'lumina', question: 'q', options: OPTS })
    const req = getPendingDecisions()[0]
    submitDecisionAnswer({ id: req.id, selectedIds: [], cancelled: true })
    const r = await p
    expect(r.status).toBe('cancelled')
  })
})

// ═══════════════════════════════════════════════════════════
// 并发与生命周期
// ═══════════════════════════════════════════════════════════

describe('并发与清理', () => {
  it('多个决策可并存且各自独立', async () => {
    fakeUI()
    const p1 = askDecision({ askedBy: 'lumina', question: 'q1', options: OPTS })
    const p2 = askDecision({ askedBy: 'yak', question: 'q2', options: OPTS })
    const [r1, r2] = getPendingDecisions()
    expect(r1.question).toBe('q1')
    expect(r2.question).toBe('q2')

    // 反序回答，验证不串
    submitDecisionAnswer({ id: r2.id, selectedIds: ['a'] })
    submitDecisionAnswer({ id: r1.id, selectedIds: ['b'] })
    const [a, b] = await Promise.all([p1, p2])
    expect(a.answer?.selectedIds).toEqual(['b'])
    expect(b.answer?.selectedIds).toEqual(['a'])
  })

  it('重复回答同一条只生效一次（迟到的回答被忽略）', async () => {
    fakeUI()
    const p = askDecision({ askedBy: 'lumina', question: 'q', options: OPTS })
    const req = getPendingDecisions()[0]
    submitDecisionAnswer({ id: req.id, selectedIds: ['a'] })
    const second = submitDecisionAnswer({ id: req.id, selectedIds: ['b'] })
    expect(second.ok).toBe(false) // 已解决，第二次被拒
    const r = await p
    expect(r.answer?.selectedIds).toEqual(['a'])
  })

  it('回答不存在的 id 返回错误而非抛异常', () => {
    expect(() => submitDecisionAnswer({ id: 'nope', selectedIds: ['a'] })).not.toThrow()
    expect(submitDecisionAnswer({ id: 'nope', selectedIds: ['a'] }).ok).toBe(false)
  })

  it('提交非法选项 id 被拒，不污染答案', async () => {
    fakeUI()
    const p = askDecision({ askedBy: 'lumina', question: 'q', options: OPTS })
    const req = getPendingDecisions()[0]
    const res = submitDecisionAnswer({ id: req.id, selectedIds: ['不存在的选项'] })
    expect(res.ok).toBe(false)
    // 仍处于挂起，可正常回答
    submitDecisionAnswer({ id: req.id, selectedIds: ['a'] })
    await p
  })

  it('单选时提交多个被拒', async () => {
    fakeUI()
    const p = askDecision({ askedBy: 'lumina', question: 'q', options: OPTS })
    const req = getPendingDecisions()[0]
    expect(submitDecisionAnswer({ id: req.id, selectedIds: ['a', 'b'] }).ok).toBe(false)
    submitDecisionAnswer({ id: req.id, selectedIds: ['a'] })
    await p
  })

  it('空回答（不选也不填）被拒', async () => {
    fakeUI()
    const p = askDecision({ askedBy: 'lumina', question: 'q', options: OPTS })
    const req = getPendingDecisions()[0]
    expect(submitDecisionAnswer({ id: req.id, selectedIds: [] }).ok).toBe(false)
    submitDecisionAnswer({ id: req.id, selectedIds: ['a'] })
    await p
  })

  it('cancelAllDecisions 一次清空所有', async () => {
    fakeUI()
    const ps = [
      askDecision({ askedBy: 'lumina', question: 'q1', options: OPTS }),
      askDecision({ askedBy: 'lumina', question: 'q2', options: OPTS }),
    ]
    const n = cancelAllDecisions()
    expect(n).toBe(2)
    expect(getPendingDecisions()).toHaveLength(0)
    const rs = await Promise.all(ps)
    expect(rs.every(r => r.status === 'cancelled')).toBe(true)
  })

  it('订阅者抛异常不影响决策本身', async () => {
    const bad = onDecisionEvent(() => { throw new Error('UI 崩了') })
    const p = askDecision({ askedBy: 'lumina', question: 'q', options: OPTS })
    // 坏订阅者存在，所以 listeners.size > 0，能挂起
    const req = getPendingDecisions()[0]
    submitDecisionAnswer({ id: req.id, selectedIds: ['a'] })
    const r = await p
    expect(r.status).toBe('answered')
    bad()
  })

  it('取消订阅后视为无 UI', async () => {
    const seen = fakeUI()
    unsubscribe?.()
    unsubscribe = null
    const r = await askDecision({ askedBy: 'lumina', question: 'q', options: OPTS })
    expect(r.status).toBe('timeout')
    expect(seen).toHaveLength(0)
  })
})

// ═══════════════════════════════════════════════════════════
// 配置
// ═══════════════════════════════════════════════════════════

describe('配置', () => {
  it('可改超时与并发上限', () => {
    const c = setDecisionConfig({ defaultTimeoutMs: 1234, maxPending: 9 })
    expect(c.defaultTimeoutMs).toBe(1234)
    expect(c.maxPending).toBe(9)
  })

  it('非法超时被夹回原值（不能让 setTimeout 永不触发）', () => {
    const before = getDecisionConfig().defaultTimeoutMs
    setDecisionConfig({ defaultTimeoutMs: -5 as any })
    expect(getDecisionConfig().defaultTimeoutMs).toBe(before)
    setDecisionConfig({ defaultTimeoutMs: NaN as any })
    expect(getDecisionConfig().defaultTimeoutMs).toBe(before)
  })

  it('maxPending 至少为 1', () => {
    expect(setDecisionConfig({ maxPending: 0 }).maxPending).toBe(1)
    expect(setDecisionConfig({ maxPending: -3 }).maxPending).toBe(1)
  })

  it('可指定无回答时的默认选项', async () => {
    setDecisionConfig({ defaultOptionId: 'a' })
    fakeUI()
    const p = askDecision({ askedBy: 'lumina', question: 'q', options: OPTS, timeoutMs: 50 })
    vi.useFakeTimers()
    vi.advanceTimersByTime(100)
    const r = await p
    expect(r.answer?.selectedIds).toEqual(['a'])
  })
})
