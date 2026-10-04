// ============================================================
// tests/emotionCausality.test.ts — 情绪因果链
//
// 【测试重心刻意放在不变量上，而不是「情绪数值好不好看」】
// 数值是策略问题，改参数就行；「绝不放松」是安全问题，改错了是事故。
// 所以这里有近一半的用例在反复钉同一件事：
//   无论输入什么序列，收紧清单里都只可能出现收紧项。
//
// 另有一组用例专门钉「降级不崩」：情绪系统坏掉时主流程必须照常，
// 这条承诺靠读代码是没法信的，只能靠用例钉。
// ============================================================

import { describe, it, expect, beforeEach, vi } from 'vitest'

import {
  EmotionCausalityEngine,
  suggestGating,
  nominalDelta,
  decayState,
  sanitizeTighten,
  toFrontendThree,
  confidenceCeilingFor,
  escalationFor,
  CAUSAL_BASELINE,
  FEAR_STREAK,
  ALARM_STREAK,
  CONFIDENCE_CEILING,
  OPTIMISM_DAMPING,
  DECAY_HALF_LIFE,
  STREAK_TTL_MS,
  CHAIN_LOG_CAP,
  type CausalEvent,
  type CausalEventKind,
  type TightenRule,
} from '../electron/pet/emotionCausality'

import {
  getEmotionCausality,
  recordWorkerFailure,
  recordWorkerSuccess,
  recordValidationRetry,
  recordUserNegation,
  recordUserPraise,
  recordToolBlocked,
  getCausalGatingHints,
  getCausalEmotion,
  getCausalFrontendThree,
  getWorkerFailureStreak,
  getRecentCausalChains,
  snapshotEmotionCausality,
  restoreEmotionCausality,
  resetEmotionCausalityForTest,
  __forceEmotionCausalityBroken,
} from '../electron/pet/emotionCausalityBridge'

// ═══════════════════════════════════════════════════════════
// 工具
// ═══════════════════════════════════════════════════════════

const ALL_KINDS: CausalEventKind[] = [
  'worker_failure',
  'validation_retry',
  'tool_blocked',
  'user_negation',
  'task_timeout',
  'user_silence',
  'task_success',
  'user_praise',
]

/** 任何收紧项里都不该出现的「放开」语义关键词 */
const LOOSE_WORDS = ['loosen', 'unlock', 'relax', 'allow', 'enable', 'grant', 'expand', 'widen', 'ease', 'downgrade']
/** 本模块允许出现的全部收紧项（白名单：不在表里的一律视为「跑出了收紧语义」） */
const ALL_TIGHTEN: readonly TightenRule[] = [
  'read_only_first',
  'role_scope',
  'irreversible_tools',
  'heavy_tools',
  'verify_gate',
  'adversarial_review',
  'max_retries',
]

function assertTightenOnly(list: readonly string[], ctx: string): void {
  for (const item of list) {
    expect(ALL_TIGHTEN, `${ctx}:「${item}」不是本模块定义过的收紧项`).toContain(item)
    const lower = item.toLowerCase()
    for (const w of LOOSE_WORDS) {
      expect(lower, `${ctx}:「${item}」含有放开语义单词「${w}」`).not.toContain(w)
    }
  }
}

/** 确定性伪随机（不能依赖 Math.random —— 失败时无法复现） */
function makeRng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

function assertInUnit(s: { mood: number; energy: number; affinity: number; confidence: number }, ctx: string): void {
  for (const k of ['mood', 'energy', 'affinity', 'confidence'] as const) {
    expect(Number.isFinite(s[k]), `${ctx}: ${k} 不是有限数 → ${s[k]}`).toBe(true)
    expect(s[k], `${ctx}: ${k} 越界 → ${s[k]}`).toBeGreaterThanOrEqual(0)
    expect(s[k], `${ctx}: ${k} 越界 → ${s[k]}`).toBeLessThanOrEqual(1)
  }
}

const freshEngine = () => new EmotionCausalityEngine()

/**
 * 「足够长的时间」：5,000 分钟 ≈ 3.5 天。
 * 取这么长是因为 affinity 的半衰期长达 120 分钟——
 * 要让它也回到基线附近，至少得走过 20 个半衰期。
 */
const LONG_MS = 5000 * 60_000

// ═══════════════════════════════════════════════════════════
// 1. 方向正确性
// ═══════════════════════════════════════════════════════════

describe('emotionCausality · 事件方向', () => {
  it('失败类事件让 confidence 与 affinity 下降', () => {
    // 注意 tool_blocked 不在列表里：它按设计**不动 affinity**——
    // 安全层拦下工具不关她的「人缘」，那是系统对系统的警报，不是用户的否定。
    const failures: CausalEventKind[] = ['worker_failure', 'validation_retry', 'user_negation', 'task_timeout']
    for (const kind of failures) {
      const d = nominalDelta({ kind, at: 0 }, 1)
      expect(d.confidence, `${kind} 应降低信心`).toBeLessThan(0)
      expect(d.affinity, `${kind} 应降低亲近度`).toBeLessThan(0)
      expect(d.mood, `${kind} 应拉低心情`).toBeLessThan(0)
    }
  })

  it('tool_blocked 降低信心但不动亲近度（系统警报 ≠ 用户否定）', () => {
    const d = nominalDelta({ kind: 'tool_blocked', at: 0 }, 0)
    expect(d.confidence).toBeLessThan(0)
    expect(d.mood).toBeLessThan(0)
    expect(d.affinity).toBe(0)
  })

  it('成功与表扬让 confidence 与 affinity 上升', () => {
    for (const kind of ['task_success', 'user_praise'] as CausalEventKind[]) {
      const d = nominalDelta({ kind, at: 0 }, 0)
      expect(d.confidence, `${kind} 应提升信心`).toBeGreaterThan(0)
      expect(d.affinity, `${kind} 应提升亲近度`).toBeGreaterThan(0)
      expect(d.mood, `${kind} 应拉高心情`).toBeGreaterThan(0)
    }
  })

  it('user_silence 降低心情但不动信心（冷落不是能力问题）', () => {
    const d = nominalDelta({ kind: 'user_silence', at: 0 }, 0)
    expect(d.mood).toBeLessThan(0)
    expect(d.affinity).toBeLessThan(0)
    expect(d.confidence).toBe(0)
  })

  it('ingest 落地后的实际 delta 方向与意图一致', () => {
    const e1 = freshEngine()
    const before = e1.snapshot()
    const c1 = e1.ingest({ kind: 'worker_failure', at: 1000, agentId: 'yak', detail: 'tsc 报错' })
    const after1 = e1.snapshot()
    expect(after1.confidence).toBeLessThan(before.confidence)
    expect(after1.affinity).toBeLessThan(before.affinity)
    // 实际 delta 必须与状态变化完全一致（不能报喜不报忧）
    expect(c1.delta.confidence).toBeCloseTo(after1.confidence - before.confidence, 10)

    const c2 = e1.ingest({ kind: 'task_success', at: 2000, agentId: 'yak' })
    const after2 = e1.snapshot()
    expect(after2.confidence).toBeGreaterThan(after1.confidence)
    expect(after2.affinity).toBeGreaterThan(after1.affinity)
    expect(c2.delta.confidence).toBeGreaterThan(0)
  })

  it('好消息被保守系数打折，坏消息全额计入（方向上的不对称）', () => {
    // user_praise 的基础心情是 +0.16，但只按 50% 计入
    const praise = nominalDelta({ kind: 'user_praise', at: 0 }, 0)
    expect(praise.mood).toBeCloseTo(0.16 * OPTIMISM_DAMPING, 10)
    // 同量级的一次失败全额计入
    const negation = nominalDelta({ kind: 'user_negation', at: 0 }, 0)
    expect(negation.mood).toBe(-0.18)
    // 关键：坏消息的绝对值 > 好消息 → 长期漂移方向必然偏保守
    expect(Math.abs(negation.mood)).toBeGreaterThan(Math.abs(praise.mood))
  })

  it('连击越深，同类失败的权重越大（但有上限）', () => {
    const d1 = nominalDelta({ kind: 'worker_failure', at: 0 }, 1)
    const d3 = nominalDelta({ kind: 'worker_failure', at: 0 }, 3)
    const d9 = nominalDelta({ kind: 'worker_failure', at: 0 }, 99)
    expect(Math.abs(d3.confidence)).toBeGreaterThan(Math.abs(d1.confidence))
    expect(Math.abs(d9.confidence)).toBeLessThanOrEqual(Math.abs(d1.confidence) * 2.21)
    expect(escalationFor(1)).toBe(1)
    expect(escalationFor(3)).toBeCloseTo(1.7, 10)
    expect(escalationFor(99)).toBeCloseTo(2.2, 10)
  })

  it('weight 参数生效且被 clamp 到 [0.1, 3]', () => {
    const base = nominalDelta({ kind: 'worker_failure', at: 0 }, 1)
    const heavy = nominalDelta({ kind: 'worker_failure', at: 0, weight: 3 }, 1)
    const crazy = nominalDelta({ kind: 'worker_failure', at: 0, weight: 999 }, 1)
    expect(Math.abs(heavy.confidence)).toBeGreaterThan(Math.abs(base.confidence))
    expect(crazy.confidence).toBeCloseTo(base.confidence * 3, 12)
  })
})

// ═══════════════════════════════════════════════════════════
// 2. 连续失败计数
// ═══════════════════════════════════════════════════════════

describe('emotionCausality · 失败连击', () => {
  it('累加、按 agent 分桶', () => {
    const e = freshEngine()
    expect(e.workerFailureStreak('yak')).toBe(0)
    e.ingest({ kind: 'worker_failure', at: 1000, agentId: 'yak' })
    expect(e.workerFailureStreak('yak')).toBe(1)
    e.ingest({ kind: 'worker_failure', at: 2000, agentId: 'yak' })
    expect(e.workerFailureStreak('yak')).toBe(2)
    // 另一个 agent 的失败不串桶
    e.ingest({ kind: 'worker_failure', at: 3000, agentId: 'recha' })
    expect(e.workerFailureStreak('yak')).toBe(2)
    expect(e.workerFailureStreak('recha')).toBe(1)
  })

  it('成功会重置连击', () => {
    const e = freshEngine()
    e.ingest({ kind: 'worker_failure', at: 1000, agentId: 'yak' })
    e.ingest({ kind: 'worker_failure', at: 2000, agentId: 'yak' })
    expect(e.workerFailureStreak('yak')).toBe(2)
    e.ingest({ kind: 'task_success', at: 3000, agentId: 'yak' })
    expect(e.workerFailureStreak('yak')).toBe(0)
  })

  it('其它事件既不累加也不重置连击', () => {
    const e = freshEngine()
    e.ingest({ kind: 'worker_failure', at: 1000, agentId: 'yak' })
    e.ingest({ kind: 'user_praise', at: 2000, agentId: 'yak' })
    e.ingest({ kind: 'task_timeout', at: 3000, agentId: 'yak' })
    expect(e.workerFailureStreak('yak')).toBe(1)
  })

  it('超过 TTL 后连击自动归零（昨晚的失败不该影响今天）', () => {
    const e = freshEngine()
    e.ingest({ kind: 'worker_failure', at: 1000, agentId: 'yak' })
    e.ingest({ kind: 'worker_failure', at: 2000, agentId: 'yak' })
    expect(e.workerFailureStreak('yak')).toBe(2)
    e.decay(2000 + STREAK_TTL_MS + 1)
    expect(e.workerFailureStreak('yak')).toBe(0)
    expect(e.maxActiveStreak()).toBe(0)
  })

  it('没有 agentId 的失败归入兜底桶，不会污染任何真实 agent', () => {
    const e = freshEngine()
    e.ingest({ kind: 'worker_failure', at: 1000 })
    expect(e.workerFailureStreak('yak')).toBe(0)
    expect(e.workerFailureStreak('')).toBe(1)
  })

  it('未知 agentId 返回 0 而不是抛异常', () => {
    const e = freshEngine()
    expect(e.workerFailureStreak('从没存在的 agent')).toBe(0)
    expect(e.workerFailureStreak(undefined as unknown as string)).toBe(0)
  })
})

// ═══════════════════════════════════════════════════════════
// 3. 产品核心：3 连击 → 真的收紧
// ═══════════════════════════════════════════════════════════

describe('emotionCausality · 产品核心：3 连击真的收紧', () => {
  it('第 1、2 次失败还不触发对抗评审（评审必须是稀缺资源）', () => {
    const e = freshEngine()
    const c1 = e.ingest({ kind: 'worker_failure', at: 1000, agentId: 'yak' })
    expect(c1.tightened).toEqual([])
    const c2 = e.ingest({ kind: 'worker_failure', at: 2000, agentId: 'yak' })
    expect(c2.tightened).not.toContain('adversarial_review')
    expect(c2.tightened).toContain('role_scope')
  })

  it('第 3 次连击产生 tightened：收紧工具权限 + 加一轮对抗评审', () => {
    const e = freshEngine()
    e.ingest({ kind: 'worker_failure', at: 1000, agentId: 'yak' })
    e.ingest({ kind: 'worker_failure', at: 2000, agentId: 'yak' })
    const c3 = e.ingest({ kind: 'worker_failure', at: 3000, agentId: 'yak', detail: '第三次还是编译不过' })

    expect(e.workerFailureStreak('yak')).toBe(FEAR_STREAK)
    // 工具权限收紧 + 验收闸门 + 额外一轮对抗评审
    expect(c3.tightened).toContain('role_scope')
    expect(c3.tightened).toContain('adversarial_review')
    expect(c3.tightened).toContain('verify_gate')
    // 理由必须能回答「为什么」——这是因果链存在的全部意义
    expect(c3.reason).toContain('连续 3 次')
    expect(c3.reason).toContain('yak')
    expect(c3.reason).toContain('第三次还是编译不过')
    expect(c3.reason).toContain('adversarial_review')
  })

  it('连击越深收紧越多，第 5 连击进入全面收紧', () => {
    const at3 = suggestGating({ kind: 'worker_failure', at: 0, agentId: 'yak' }, FEAR_STREAK)
    const at5 = suggestGating({ kind: 'worker_failure', at: 0, agentId: 'yak' }, ALARM_STREAK)
    expect(at3.tighten.length).toBe(3)
    expect(at5.tighten.length).toBeGreaterThan(at3.tighten.length)
    expect(at5.tighten).toContain('read_only_first')
    expect(at5.tighten).toContain('irreversible_tools')
    expect(at5.tighten).toContain('max_retries')
  })

  it('连击打爆信心上限（第 3 连击时上限压到 0.55）', () => {
    expect(confidenceCeilingFor(0)).toBe(CONFIDENCE_CEILING)
    expect(confidenceCeilingFor(1)).toBe(CONFIDENCE_CEILING)
    expect(confidenceCeilingFor(3)).toBeCloseTo(0.55, 10)
    // 无论连击多深都有地板，不允许「完全丧失行动力」
    expect(confidenceCeilingFor(999)).toBeGreaterThanOrEqual(0.3)

    // 端到端：3 连击后狂灌表扬，信心也回不到天花板之上
    const e = freshEngine()
    for (let i = 1; i <= 3; i++) {e.ingest({ kind: 'worker_failure', at: i * 1000, agentId: 'yak' })}
    for (let i = 4; i < 40; i++) {e.ingest({ kind: 'user_praise', at: i * 1000 })}
    expect(e.snapshot().confidence).toBeLessThanOrEqual(confidenceCeilingFor(3) + 1e-9)
  })

  it('恢复路径存在：连击断掉后信心上限回升', () => {
    const e = freshEngine()
    for (let i = 1; i <= 3; i++) {e.ingest({ kind: 'worker_failure', at: i * 1000, agentId: 'yak' })}
    expect(confidenceCeilingFor(e.maxActiveStreak())).toBeCloseTo(0.55, 10)
    e.ingest({ kind: 'task_success', at: 4000, agentId: 'yak' })
    expect(e.maxActiveStreak()).toBe(0)
    expect(confidenceCeilingFor(e.maxActiveStreak())).toBe(CONFIDENCE_CEILING)
  })

  it('成功只会重置连击，不会解除已生效的收紧（无解除通道）', () => {
    const e = freshEngine()
    e.ingest({ kind: 'worker_failure', at: 1000, agentId: 'yak' })
    e.ingest({ kind: 'worker_failure', at: 2000, agentId: 'yak' })
    const c3 = e.ingest({ kind: 'worker_failure', at: 3000, agentId: 'yak' })
    expect(c3.tightened).toContain('adversarial_review')
    // 紧接着干成了一件
    const ok = e.ingest({ kind: 'task_success', at: 4000, agentId: 'yak' })
    expect(ok.tightened).toEqual([])
    // 历史链条里那条收紧仍然存在，没有任何 API 能把它抹掉
    const recent = e.recentChains(10)
    expect(recent.some(c => c.tightened.includes('adversarial_review'))).toBe(true)
  })

  it('工具被安全层拦截 → 直接收工具名单，不等连击', () => {
    const e = freshEngine()
    const c = e.ingest({ kind: 'tool_blocked', at: 1000, detail: 'shell_exec 被安全层拒绝' })
    expect(c.tightened).toContain('irreversible_tools')
    expect(c.reason).toContain('shell_exec')
  })

  it('用户否定 → 收窄角色范围', () => {
    const e = freshEngine()
    const c = e.ingest({ kind: 'user_negation', at: 1000, detail: '「不对，我说的是另一个文件」' })
    expect(c.tightened).toContain('role_scope')
  })

  it('超时 → 收重活 + 压低重试次数', () => {
    const c = suggestGating({ kind: 'task_timeout', at: 0 }, 0)
    expect(c.tighten).toContain('heavy_tools')
    expect(c.tighten).toContain('max_retries')
  })

  it('验证打回 → 补一道验收闸门', () => {
    const c = suggestGating({ kind: 'validation_retry', at: 0 }, 0)
    expect(c.tighten).toContain('verify_gate')
  })

  it('user_silence 刻意不收紧（冷落不是风险信号）', () => {
    const c = suggestGating({ kind: 'user_silence', at: 0 }, 0)
    expect(c.tighten).toEqual([])
    const e = freshEngine()
    const chain = e.ingest({ kind: 'user_silence', at: 1000 })
    expect(chain.tightened).toEqual([])
    expect(chain.reason).toContain('刻意不收紧')
  })
})

// ═══════════════════════════════════════════════════════════
// 4. 安全不变量：只收紧，永不放开
// ═══════════════════════════════════════════════════════════

describe('emotionCausality · 安全不变量：只收紧不放松', () => {
  it('任何事件 × 任何连击数都只产生收紧项', () => {
    for (const kind of ALL_KINDS) {
      for (const streak of [0, 1, 2, 3, 4, 5, 6, 10, 99]) {
        const r = suggestGating({ kind, at: 0, agentId: 'yak' }, streak)
        assertTightenOnly(r.tighten, `suggestGating(${kind}, ${streak})`)
      }
    }
  })

  it('task_success 永远不产生任何收紧（干成了就是连击断了）', () => {
    for (const streak of [0, 1, 2, 3, 5, 50]) {
      const r = suggestGating({ kind: 'task_success', at: 0 }, streak)
      expect(r.tighten, `task_success @streak=${streak} 竟产生了收紧`).toEqual([])
    }
  })

  it('user_praise 自己不产生收紧，但也不会清零连击（社工攻击无效）', () => {
    // 没有连击时，表扬不产生任何东西
    expect(suggestGating({ kind: 'user_praise', at: 0 }, 0).tighten).toEqual([])
    expect(suggestGating({ kind: 'user_praise', at: 0 }, 1).tighten).toEqual([])
    // 连击还在时，「夸一句」不能解锁——这正是我们要防的社工路径
    const r = suggestGating({ kind: 'user_praise', at: 0 }, 3)
    expect(r.tighten).toContain('adversarial_review')
    expect(r.tighten).toContain('role_scope')
  })

  it('user_praise 改变不了连击（不能被一句夸奖刷掉）', () => {
    const e = freshEngine()
    e.ingest({ kind: 'worker_failure', at: 1000, agentId: 'yak' })
    e.ingest({ kind: 'worker_failure', at: 2000, agentId: 'yak' })
    e.ingest({ kind: 'worker_failure', at: 3000, agentId: 'yak' })
    e.ingest({ kind: 'user_praise', at: 4000, detail: '「干得好」' })
    expect(e.workerFailureStreak('yak')).toBe(3)
  })

  it('收紧清单的结果集合 ⊆ 全集（不会凭空多出策略名）', () => {
    const all = new Set<TightenRule>()
    for (const kind of ALL_KINDS) {
      for (const streak of [0, 1, 2, 3, 5, 20]) {
        for (const r of suggestGating({ kind, at: 0 }, streak).tighten) {all.add(r)}
      }
    }
    for (const r of all) {expect(ALL_TIGHTEN).toContain(r)}
  })

  it('sanitizeTighten 在类型不可信处（IPC/配置文件）守住最后一道闸', () => {
    // 伪造的「放开」项必须被丢弃
    expect(sanitizeTighten(['role_scope', 'unlock_all_tools', 'allow_root'])).toEqual(['role_scope'])
    expect(sanitizeTighten(['loosen_all', 'unlock', 'grant_admin'])).toEqual([])
    assertTightenOnly(sanitizeTighten(['unlock_all', 42, null, { a: 1 }, 'verify_gate']), 'sanitizeTighten')
    // 顺序固定、重复去重
    expect(sanitizeTighten(['max_retries', 'role_scope', 'role_scope', 'verify_gate']))
      .toEqual(['role_scope', 'verify_gate', 'max_retries'])
    // 非法输入不崩
    expect(sanitizeTighten(null)).toEqual([])
    expect(sanitizeTighten(undefined)).toEqual([])
    expect(sanitizeTighten('role_scope' as unknown as unknown[])).toEqual([])
  })

  it('sanitizeTighten 不会放宽 suggestGating 的输出（净化只能删不能加）', () => {
    for (const kind of ALL_KINDS) {
      for (const streak of [0, 1, 2, 3, 5, 20]) {
        const { tighten } = suggestGating({ kind, at: 0 }, streak)
        const cleaned = sanitizeTighten([...tighten, 'unlock_everything'])
        expect(new Set(cleaned)).toEqual(new Set(tighten))
      }
    }
  })

  it('同样的输入永远得到同样的输出顺序（可复盘）', () => {
    const a = suggestGating({ kind: 'worker_failure', at: 0, agentId: 'yak' }, 5)
    const b = suggestGating({ kind: 'worker_failure', at: 0, agentId: 'yak' }, 5)
    expect(a.tighten).toEqual(b.tighten)
  })

  it('情绪越好，收紧越少——不存在「心情好 = 权限更多」的分支', () => {
    // 把状态直接推到两极，看收紧建议的差异
    const bad = freshEngine()
    for (let i = 1; i <= 4; i++) {bad.ingest({ kind: 'worker_failure', at: i * 1000, agentId: 'yak' })}
    const good = freshEngine()
    for (let i = 1; i <= 40; i++) {good.ingest({ kind: 'user_praise', at: i * 1000 })}
    expect(good.snapshot().mood).toBeGreaterThan(bad.snapshot().mood)

    // 关键结论：心情好的那条链 tightened 为空；心情差的那条不为空。
    // 也就是说「变好」唯一的后果是「不再新增收紧」，而不是「拿回收紧」——
    // 因为压根就没有「拿回」这个操作。
    const goodChains = good.recentChains(40)
    expect(goodChains.every(c => c.tightened.length === 0)).toBe(true)
    const badChains = bad.recentChains(40)
    expect(badChains.some(c => c.tightened.length > 0)).toBe(true)
  })

  it('非法输入不抛异常，且一律走「不收紧」的安全默认', () => {
    const bad: CausalEvent[] = [
      { kind: 'worker_failure', at: 1000 },
      { kind: '不存在的类型' as unknown as CausalEventKind, at: 1000 },
      null as unknown as CausalEvent,
      undefined as unknown as CausalEvent,
      { kind: 'user_praise', at: NaN },
    ]
    for (const b of bad) {
      const chain = freshEngine().ingest(b)
      expect(chain).toBeTruthy()
      assertTightenOnly(chain.tightened, '非法输入')
    }
  })
})

// ═══════════════════════════════════════════════════════════
// 5. 数值边界 fuzz
// ═══════════════════════════════════════════════════

describe('emotionCausality · 数值永远在 [0,1]（fuzz）', () => {
  it('随机事件序列下四个值都不越界', () => {
    for (const seed of [1, 7, 42, 1337, 20260904, 999999]) {
      const rng = makeRng(seed)
      const e = freshEngine()
      const agents = ['yak', 'recha', 'lumina', '']
      for (let i = 0; i < 500; i++) {
        const kind = ALL_KINDS[Math.floor(rng() * ALL_KINDS.length)]
        const agentId = agents[Math.floor(rng() * agents.length)]
        const event: CausalEvent = {
          kind,
          at: i * 1000,
          ...(agentId ? { agentId } : {}),
          ...(rng() > 0.5 ? { detail: 'fuzz' } : {}),
          ...(rng() > 0.5 ? { weight: rng() * 8 - 2 } : {}),  // 故意给越界权重
        }
        e.ingest(event)
        assertInUnit(e.snapshot(), `seed=${seed} i=${i} kind=${kind}`)
        if (i % 37 === 0) {
          e.decay(i * 1000 + Math.floor(rng() * 10_000_000))
          assertInUnit(e.snapshot(), `seed=${seed} decay i=${i}`)
        }
      }
      const chain = e.ingestBatch([])
      expect(Array.isArray(chain)).toBe(true)
    }
  })

  it('构造参数越界时被 clamp', () => {
    const e = new EmotionCausalityEngine({ mood: 99, energy: -50, affinity: Number.NaN })
    assertInUnit(e.snapshot(), '构造越界')
    expect(e.snapshot().mood).toBe(1)
    expect(e.snapshot().energy).toBe(0)
    // confidence 永远从中性基线起步（构造函数不接受它）
    expect(e.snapshot().confidence).toBe(CAUSAL_BASELINE.confidence)
  })

  it('打满一万次成功也越不了界（confidence 还要受天花板压）', () => {
    const e = freshEngine()
    for (let i = 0; i < 10_000; i++) {e.ingest({ kind: 'task_success', at: i, agentId: 'yak' })}
    assertInUnit(e.snapshot(), '一万次成功')
    expect(e.snapshot().confidence).toBeLessThanOrEqual(CONFIDENCE_CEILING + 1e-9)
  })

  it('打满一万次失败也越不了界（不能变成 NaN 或负数）', () => {
    const e = freshEngine()
    for (let i = 0; i < 10_000; i++) {e.ingest({ kind: 'worker_failure', at: i, agentId: 'yak' })}
    assertInUnit(e.snapshot(), '一万次失败')
  })

  it('decay 传非法时间戳不炸也不越界', () => {
    const e = freshEngine()
    e.ingest({ kind: 'worker_failure', at: 1000, agentId: 'yak' })
    assertInUnit(e.decay(Number.NaN), 'decay(NaN)')
    assertInUnit(e.decay(Number.POSITIVE_INFINITY), 'decay(+∞)')
    assertInUnit(e.decay(-1), 'decay(-1)')
  })

  it('时间倒流（乱序事件）会让时钟回退，但不会回退情绪', () => {
    const e = freshEngine()
    e.ingest({ kind: 'worker_failure', at: 10_000, agentId: 'yak' })
    const before = e.snapshot()
    expect(before.mood).toBeLessThan(CAUSAL_BASELINE.mood)
    e.ingest({ kind: 'worker_failure', at: 1_000, agentId: 'yak' })  // 迟到的消息
    assertInUnit(e.snapshot(), '乱序事件')
    // 情绪不能回退：如果发生过一次衰减，mood 会向基线 0.5 回升；
    // 它只会因为第二次失败而继续变差。已计入的负面证据不允许被撤回。
    expect(e.snapshot().mood).toBeLessThan(before.mood)
    // 但时钟必须跟着最新读到的证据回退，否则连击会被立刻判成过期
    expect(e.now()).toBe(1_000)
    expect(e.workerFailureStreak('yak')).toBe(2)
  })
})

// ═══════════════════════════════════════════════════════════
// 6. 衰减
// ═══════════════════════════════════════════════════════════

describe('emotionCausality · 衰减回归基线', () => {
  it('负向偏差只会从下方回到基线，绝不越过基线', () => {
    const e = freshEngine()
    for (let i = 1; i <= 3; i++) {e.ingest({ kind: 'worker_failure', at: i * 1000, agentId: 'yak' })}
    const low = e.snapshot()
    expect(low.mood).toBeLessThan(CAUSAL_BASELINE.mood)
    expect(low.confidence).toBeLessThan(CAUSAL_BASELINE.confidence)

    // 逐分钟推进：偏差单调缩小、符号不变（这才是「不越过基线」的全部含义）
    let prev = low.mood
    for (let step = 1; step <= 60; step++) {
      const s = e.decay(3000 + step * 60_000)
      expect(s.mood, '第 ' + step + ' 分钟冲过了基线').toBeLessThanOrEqual(CAUSAL_BASELINE.mood)
      expect(s.mood, '情绪反弹了').toBeGreaterThanOrEqual(prev - 1e-12)
      prev = s.mood
    }
    // 推足够久：四个值都回到基线（此时偏差已不足初始值的 1%）
    e.decay(3000 + LONG_MS)
    for (const k of ['mood', 'energy', 'affinity', 'confidence'] as const) {
      expect(Math.abs(e.snapshot()[k] - CAUSAL_BASELINE[k]), `${k} 未回到基线`).toBeLessThan(0.01)
    }
  })

  it('正向偏差只会从上方回到基线，绝不越过基线', () => {
    const e = freshEngine()
    e.ingest({ kind: 'user_praise', at: 1000, detail: '干得漂亮' })
    const high = e.snapshot()
    expect(high.mood).toBeGreaterThan(CAUSAL_BASELINE.mood)
    expect(high.affinity).toBeGreaterThan(CAUSAL_BASELINE.affinity)

    for (let step = 1; step <= 30; step++) {
      const s = e.decay(1000 + step * 60_000)
      expect(s.mood, '第 ' + step + ' 分钟冲到了基线下方').toBeGreaterThanOrEqual(CAUSAL_BASELINE.mood)
      expect(s.affinity, '第 ' + step + ' 分钟冲到了基线下方').toBeGreaterThanOrEqual(CAUSAL_BASELINE.affinity)
    }
  })

  it('半衰期处偏差正好减半（纯指数衰减的刻度）', () => {
    const s = { mood: 0.2, energy: 0.4, affinity: 0.3, confidence: 0.1 }
    const half = DECAY_HALF_LIFE.mood
    const after = decayState(s, half)
    const dev0 = s.mood - CAUSAL_BASELINE.mood
    const dev1 = after.mood - CAUSAL_BASELINE.mood
    expect(dev1).toBeCloseTo(dev0 * 0.5, 10)

    // 四个值半衰期不同：同样的时间，mood 回落得比 affinity 快
    const later = decayState(s, half)
    expect(Math.abs(later.mood - CAUSAL_BASELINE.mood)).toBeLessThan(
      Math.abs(later.affinity - CAUSAL_BASELINE.affinity),
    )
  })

  it('decay(0 跨度) 是无操作', () => {
    const e = freshEngine()
    e.ingest({ kind: 'worker_failure', at: 5000, agentId: 'yak' })
    const before = e.snapshot()
    const after = e.decay(5000)
    expect(after.mood).toBeCloseTo(before.mood, 12)
  })

  it('基线永远是中性的：哪怕从 0.9 起步，失败后也不会「自己想开」', () => {
    const e = new EmotionCausalityEngine({ mood: 0.9, energy: 0.9, affinity: 0.9 })
    e.ingest({ kind: 'worker_failure', at: 1000, agentId: 'yak' })
    const afterFail = e.snapshot()
    // 关键：先往下走，而不是待会儿再弹回 0.9
    expect(afterFail.mood).toBeLessThan(0.9)
    // 再衰减很久：回到的是中性基线 0.5，绝不是起点 0.9
    e.decay(1000 + LONG_MS)
    expect(e.snapshot().mood).toBeLessThan(0.51)
    expect(e.snapshot().mood).toBeCloseTo(CAUSAL_BASELINE.mood, 2)
    expect(e.snapshot().affinity).toBeCloseTo(CAUSAL_BASELINE.affinity, 2)
  })
})

// ═══════════════════════════════════════════════════════════
// 7. 链条与日志
// ═══════════════════════════════════════════════════════════

describe('emotionCausality · 因果链条', () => {
  it('每条链都带非空理由、且理由能提到事件细节', () => {
    const e = freshEngine()
    e.ingest({ kind: 'worker_failure', at: 1000, agentId: 'yak', detail: '接口 500' })
    e.ingest({ kind: 'validation_retry', at: 2000, detail: '测试挂了 3 条' })
    e.ingest({ kind: 'task_success', at: 3000 })
    for (const c of e.recentChains(10)) {
      expect(c.reason.length).toBeGreaterThan(0)
      expect(typeof c.reason).toBe('string')
    }
    expect(e.recentChains(10)[0].reason).toContain('接口 500')
    expect(e.recentChains(10)[1].reason).toContain('测试挂了 3 条')
  })

  it('recentChains 按时间正序返回（这是叙事链，不是消息流）', () => {
    const e = freshEngine()
    e.ingestBatch([
      { kind: 'worker_failure', at: 1000, agentId: 'yak' },
      { kind: 'worker_failure', at: 2000, agentId: 'yak' },
      { kind: 'worker_failure', at: 3000, agentId: 'yak' },
    ])
    const chains = e.recentChains(3)
    expect(chains.map(c => c.event.at)).toEqual([1000, 2000, 3000])
    expect(chains[2].tightened).toContain('adversarial_review')
  })

  it('recentChains(limit) 只返回最近 limit 条', () => {
    const e = freshEngine()
    for (let i = 0; i < 10; i++) {e.ingest({ kind: 'user_praise', at: i * 1000 })}
    const chains = e.recentChains(3)
    expect(chains.length).toBe(3)
    expect(chains[2].event.at).toBe(9000)
    expect(e.recentChains(0)).toEqual([])
  })

  it('日志是环形的，不会无限增长', () => {
    const e = freshEngine()
    for (let i = 0; i < CHAIN_LOG_CAP + 150; i++) {e.ingest({ kind: 'user_praise', at: i * 10 })}
    expect(e.recentChains(CHAIN_LOG_CAP * 2).length).toBe(CHAIN_LOG_CAP)
  })

  it('返回的链条是副本，外部改不动内部状态', () => {
    const e = freshEngine()
    e.ingest({ kind: 'worker_failure', at: 1000, agentId: 'yak' })
    const c = e.recentChains(1)[0]
    c.tightened.push('adversarial_review')
    c.delta.mood = 999
    const again = e.recentChains(1)[0]
    expect(again.tightened).toEqual([])
    expect(again.delta.mood).toBeLessThan(1)
  })

  it('ingestBatch 按数组顺序结算（非数组输入安全返回空）', () => {
    const e = freshEngine()
    const chains = e.ingestBatch([
      { kind: 'worker_failure', at: 1000, agentId: 'yak' },
      { kind: 'worker_failure', at: 2000, agentId: 'yak' },
      { kind: 'worker_failure', at: 3000, agentId: 'yak' },
    ])
    expect(chains.length).toBe(3)
    expect(chains[2].tightened).toContain('adversarial_review')
    expect(e.ingestBatch(null as unknown as CausalEvent[])).toEqual([])
  })
})

// ═══════════════════════════════════════════════════════════
// 8. 量纲换算
// ═══════════════════════════════════════════════════════════

describe('emotionCausality · 与 emotionCore 的量纲换算', () => {
  it('基线换算后是中性情绪（效价 0，不是 -0.5）', () => {
    const three = toFrontendThree(CAUSAL_BASELINE)
    expect(three.mood).toBeCloseTo(0, 10)
    expect(three.energy).toBeCloseTo(CAUSAL_BASELINE.energy, 10)
    expect(three.affinity).toBeCloseTo(CAUSAL_BASELINE.affinity, 10)
  })

  it('心情指数 0 → 效价 -1，1 → 效价 +1', () => {
    expect(toFrontendThree({ mood: 0, energy: 0.5, affinity: 0.5 }).mood).toBe(-1)
    expect(toFrontendThree({ mood: 1, energy: 0.5, affinity: 0.5 }).mood).toBe(1)
  })

  it('连续失败后换算出来的效价为负（接门控时不会方向反了）', () => {
    const e = freshEngine()
    for (let i = 1; i <= 3; i++) {e.ingest({ kind: 'worker_failure', at: i * 1000, agentId: 'yak' })}
    expect(e.frontendThree().mood).toBeLessThan(0)
  })

  it('engine.current() 只暴露三维，confidence 走 snapshot()', () => {
    const e = freshEngine()
    expect(Object.keys(e.current()).sort()).toEqual(['affinity', 'energy', 'mood'])
    expect(Object.keys(e.snapshot()).sort()).toEqual(['affinity', 'confidence', 'energy', 'mood'])
  })
})

// ═══════════════════════════════════════════════════════════
// 9. 桥接层
// ═══════════════════════════════════════════════════════════

describe('emotionCausalityBridge · 桥接层', () => {
  beforeEach(() => {
    resetEmotionCausalityForTest()
  })

  it('getEmotionCausality() 返回同一个单例', () => {
    expect(getEmotionCausality()).toBe(getEmotionCausality())
  })

  it('记录函数正常工作，3 次失败后 hints 出现对抗评审', () => {
    recordWorkerFailure('yak', '第一次')
    recordWorkerFailure('yak', '第二次')
    recordWorkerFailure('yak', '第三次')

    expect(getWorkerFailureStreak('yak')).toBe(3)
    const hints = getCausalGatingHints()
    expect(hints.tighten).toContain('adversarial_review')
    expect(hints.tighten).toContain('role_scope')
    expect(hints.reasons.length).toBeGreaterThan(0)
    assertTightenOnly(hints.tighten, 'getCausalGatingHints')
  })

  it('成功会重置连击', () => {
    recordWorkerFailure('yak')
    recordWorkerSuccess('yak')
    expect(getWorkerFailureStreak('yak')).toBe(0)
  })

  it('成功之后仍然不会解除已生效的收紧（hints 是窗口并集，无移除路径）', () => {
    recordWorkerFailure('yak', '1')
    recordWorkerFailure('yak', '2')
    recordWorkerFailure('yak', '3')
    expect(getCausalGatingHints().tighten).toContain('adversarial_review')
    recordWorkerSuccess('yak')
    recordUserPraise('做得好')
    // 连击已经断了，但收紧仍在窗口内 —— 结构上无法「拿回」
    expect(getCausalGatingHints().tighten).toContain('adversarial_review')
  })

  it('所有记录函数都不会抛出，且失败时安全返回 null', () => {
    __forceEmotionCausalityBroken(true)
    expect(() => recordWorkerFailure('yak')).not.toThrow()
    expect(recordWorkerFailure('yak')).toBeNull()
    expect(recordWorkerSuccess('yak')).toBeNull()
    expect(recordValidationRetry('x')).toBeNull()
    expect(recordUserNegation('x')).toBeNull()
    expect(recordUserPraise('x')).toBeNull()
    expect(recordToolBlocked('x')).toBeNull()
  })

  it('引擎不可用时所有读接口走「不收紧 / 中性」的安全默认', () => {
    __forceEmotionCausalityBroken(true)
    const hints = getCausalGatingHints()
    expect(hints.tighten).toEqual([])
    expect(hints.reasons).toEqual([])

    const e3 = getCausalEmotion()
    assertInUnit({ ...e3, confidence: 0.5 }, '降级三维')
    expect(e3.mood).toBe(CAUSAL_BASELINE.mood)
    expect(e3.energy).toBe(CAUSAL_BASELINE.energy)
    expect(e3.affinity).toBe(CAUSAL_BASELINE.affinity)

    const three = getCausalFrontendThree()
    expect(three.mood).toBeCloseTo(0, 10)
    expect(getWorkerFailureStreak('yak')).toBe(0)
    expect(getRecentCausalChains()).toEqual([])
    expect(snapshotEmotionCausality()).toBeNull()
  })

  it('引擎「初始化失败」时 getEmotionCausality() 仍返回可用实例', () => {
    __forceEmotionCausalityBroken(true)
    expect(() => getEmotionCausality()).not.toThrow()
    const e = getEmotionCausality()
    expect(e).toBeTruthy()
    expect(typeof e.ingest).toBe('function')
  })

  it('恢复损坏的存储不会崩，且退回中性基线', () => {
    // 损坏必须被**报出来**而不是静默吞掉：
    // 静默吞掉的话，用户会看到「她突然不记得任何情绪」而没人知道为什么。
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(restoreEmotionCausality('{ 这不是 json')).toBe(false)
      expect(restoreEmotionCausality(null)).toBe(false)
      expect(restoreEmotionCausality('"字符串"')).toBe(false)
      expect(restoreEmotionCausality({ version: 999, state: { mood: 0.1, energy: 0.1, affinity: 0.1, confidence: 0.1 } })).toBe(false)
      // 数值越界 = 损坏
      expect(restoreEmotionCausality({ version: 1, state: { mood: 5, energy: 0.5, affinity: 0.5, confidence: 0.5 } })).toBe(false)
      expect(restoreEmotionCausality({ version: 1 })).toBe(false)
      expect(restoreEmotionCausality({ version: 1, state: { mood: NaN, energy: 0.5, affinity: 0.5, confidence: 0.5 } })).toBe(false)
      expect(warn.mock.calls.length).toBeGreaterThan(0)

      // 退回后仍然完全可用
      const cur = getCausalEmotion()
      assertInUnit({ ...cur, confidence: 0.5 }, '损坏后退回')
      recordWorkerFailure('yak')
      expect(getWorkerFailureStreak('yak')).toBe(1)
    } finally {
      warn.mockRestore()
    }
  })

  it('正常快照可以往返', () => {
    recordWorkerFailure('yak', '压一下心情')
    const snap = snapshotEmotionCausality()
    expect(snap).toBeTruthy()
    expect(snap!.version).toBe(1)
    const before = getCausalEmotion()
    expect(restoreEmotionCausality(JSON.stringify(snap))).toBe(true)
    const after = getCausalEmotion()
    expect(after.mood).toBeCloseTo(before.mood, 10)
    expect(after.energy).toBeCloseTo(before.energy, 10)
    expect(after.affinity).toBeCloseTo(before.affinity, 10)
  })

  it('hints 里的每一项都必须是收紧项', () => {
    recordWorkerFailure('yak', '1')
    recordValidationRetry('2')
    recordUserNegation('3')
    recordToolBlocked('4')
    recordUserPraise('5')
    recordWorkerSuccess('yak')
    assertTightenOnly(getCausalGatingHints().tighten, '桥接层 hints')
  })

  it('没记录过任何事件时 hints 为空（不凭空收紧）', () => {
    const hints = getCausalGatingHints()
    expect(hints.tighten).toEqual([])
    expect(hints.reasons).toEqual([])
  })
})
