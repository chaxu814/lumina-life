// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// tests/decisionDebate.test.ts — 决策三栏（团队辩论可见化）单测
//
// 覆盖：
//   1. 三栏齐全的成功路径（含 Lumina 真综合）
//   2. 单角色超时/失败 → 该栏 missing，其余照常，degradedReasons 记录
//   3. Lumina 综合失败 → 规则模板兜底，source === 'template'
//   4. 空/截断输出 → 完整性补救一次；补救成功/仍失败两种走向
//   5. parseDecisionInvoke：普通对话不误触发；/decide 与"帮我决定 A 还是 B"触发
//   6. 结构化结果字段完整
//   7. 默认委托确实经 delegationManager 通道（from === 'lumina'，不绕过 rolePolicy）
// ============================================================

import { describe, it, expect, vi } from 'vitest'
import {
  runDecisionDebate,
  parseDecisionInvoke,
  createDefaultDecisionDeps,
  setDelegationGatewayResolver,
  type DecisionDelegate,
  type DelegateOutcome,
} from '../electron/decision/decisionDebate'

// ── 测试数据 ────────────────────────────────────────────────

const GOOD_YAK = JSON.stringify({
  approach: '先租一周试成本，再决定买不买',
  pros: ['日常通勤成本低', '不限行'],
  cons: ['要装充电桩', '保值率低'],
  steps: ['算一遍月度开销', '试驾一次', '查小区能不能装桩'],
  effort: '中成本',
})

const GOOD_RECHA = JSON.stringify({
  risks: ['冬季续航打对折', '电池换一次几万块'],
  worstCase: '三年后电池衰减到不敢跑长途',
  objections: ['贬值比油车快得多'],
  hardToReverse: '全款买车后半年想换，折旧损失最大',
})

function ok(content: string): DelegateOutcome {
  return { success: true, content }
}
function fail(error = '超时'): DelegateOutcome {
  return { success: false, content: '', error }
}

// 记录每次调用的假委托执行器
interface DelegateCall {
  to: 'yak' | 'recha'
  taskType: string
  task: string
}

function makeFakeDelegate(
  behavior: (to: 'yak' | 'recha', callIndex: number) => DelegateOutcome | Promise<DelegateOutcome>,
  calls: DelegateCall[] = [],
): { delegate: DecisionDelegate; calls: DelegateCall[] } {
  const index: Record<'yak' | 'recha', number> = { yak: 0, recha: 0 }
  const delegate: DecisionDelegate = async (to, task, meta) => {
    index[to] += 1
    calls.push({ to, taskType: meta.taskType, task })
    return behavior(to, index[to])
  }
  return { delegate, calls }
}

// ══════════════════════════════════════════════════════════

describe('决策三栏：成功路径', () => {
  it('三栏齐全，Lumina 真实综合时 source=llm', async () => {
    const { delegate } = makeFakeDelegate(to => (to === 'yak' ? ok(GOOD_YAK) : ok(GOOD_RECHA)))
    const result = await runDecisionDebate('买电动车还是油车？', ['电动车', '油车'], {
      delegate,
      luminaSynthesize: async () => ok(JSON.stringify({ summary: '执行者说能落地，审查员说电池有风险', recommendation: '先租一辆电动车试一个月' })),
    })

    expect(result.question).toBe('买电动车还是油车？')
    expect(result.options).toEqual(['电动车', '油车'])
    expect(result.columns.yak.status).toBe('ok')
    expect(result.columns.yak.body).toContain('落地思路')
    expect(result.columns.recha.status).toBe('ok')
    expect(result.columns.recha.body).toContain('最坏情况')
    expect(result.lumina.status).toBe('ok')
    expect(result.lumina.source).toBe('llm')
    expect(result.lumina.recommendation).toContain('电动车')
    expect(result.meta.durationMs).toBeGreaterThanOrEqual(0)
    expect(Array.isArray(result.meta.degradedReasons)).toBe(true)
  })

  it('委托按 rolePolicy 方向走：yak→logic_check，recha→risk_assess', async () => {
    const { delegate, calls } = makeFakeDelegate(to => (to === 'yak' ? ok(GOOD_YAK) : ok(GOOD_RECHA)))
    await runDecisionDebate('q', [], { delegate })
    const yak = calls.find(c => c.to === 'yak')!
    const recha = calls.find(c => c.to === 'recha')!
    expect(yak.taskType).toBe('logic_check')
    expect(recha.taskType).toBe('risk_assess')
  })
})

describe('决策三栏：降级', () => {
  it('Yak 失败 → yak 栏 missing，recha 照常，记录降级原因', async () => {
    const { delegate } = makeFakeDelegate(to => (to === 'yak' ? fail('timeout') : ok(GOOD_RECHA)))
    const result = await runDecisionDebate('q', [], { delegate })

    expect(result.columns.yak.status).toBe('missing')
    expect(result.columns.yak.body).toContain('没说上话')
    expect(result.columns.recha.status).toBe('ok')
    expect(result.meta.degradedReasons).toContain('yak_no_response')
    // Lumina 综合不缺席：无综合器 → template 兜底
    expect(result.lumina.status).toBe('template')
    expect(result.lumina.source).toBe('template')
    expect(result.lumina.recommendation.length).toBeGreaterThan(0)
  })

  it('Lumina 综合抛错 → template 兜底，标注来源 template', async () => {
    const { delegate } = makeFakeDelegate(to => (to === 'yak' ? ok(GOOD_YAK) : ok(GOOD_RECHA)))
    const result = await runDecisionDebate('q', [], {
      delegate,
      luminaSynthesize: async () => { throw new Error('LLM 挂了') },
    })
    expect(result.lumina.status).toBe('template')
    expect(result.lumina.source).toBe('template')
    expect(result.meta.degradedReasons).toContain('lumina_synthesize_failed')
  })

  it('Lumina 综合返回不可解析的垃圾 → template 兜底', async () => {
    const { delegate } = makeFakeDelegate(to => (to === 'yak' ? ok(GOOD_YAK) : ok(GOOD_RECHA)))
    const result = await runDecisionDebate('q', [], {
      delegate,
      luminaSynthesize: async () => ok('这不是 JSON 也没说清楚'),
    })
    expect(result.lumina.source).toBe('template')
  })
})

describe('决策三栏：完整性兜底', () => {
  it('首栏过短（截断）→ 补请求一次，补全成功后 status=ok', async () => {
    const { delegate, calls } = makeFakeDelegate(to => {
      if (to === 'yak') return ok(GOOD_YAK)
      // recha 第一次返回过短 → 触发补救；第二次给完整内容
      return calls.filter(c => c.to === 'recha').length <= 1 ? ok('太短') : ok(GOOD_RECHA)
    })
    const result = await runDecisionDebate('q', [], { delegate })
    const rechaCalls = calls.filter(c => c.to === 'recha')
    expect(rechaCalls.length).toBe(2)
    expect(rechaCalls[1].task).toContain('上次输出有问题')
    expect(result.columns.recha.status).toBe('ok')
    expect(result.meta.degradedReasons).not.toContain('recha_truncated')
  })

  it('补救后仍过短 → 该栏 degraded 并记录原因', async () => {
    const { delegate } = makeFakeDelegate(() => ok('还是很短'))
    const result = await runDecisionDebate('q', [], { delegate })
    expect(result.columns.yak.status).toBe('degraded')
    expect(result.columns.recha.status).toBe('degraded')
    expect(result.meta.degradedReasons.some(r => r.startsWith('yak_truncated'))).toBe(true)
  })
})

describe('parseDecisionInvoke：触发解析', () => {
  it('普通对话不触发', () => {
    expect(parseDecisionInvoke('今天天气怎么样').triggered).toBe(false)
    expect(parseDecisionInvoke('帮我写个脚本').triggered).toBe(false)
    expect(parseDecisionInvoke('刚才那段话什么意思').triggered).toBe(false)
  })

  it('/decide 触发，并抽出问题', () => {
    const r = parseDecisionInvoke('/decide 买不买电动车')
    expect(r.triggered).toBe(true)
    expect(r.question).toBe('买不买电动车')
  })

  it('"帮我决定 A 还是 B" 触发', () => {
    const r = parseDecisionInvoke('帮我决定买电动车还是油车')
    expect(r.triggered).toBe(true)
    expect(r.question).toContain('电动车')
  })

  it('有决策动词但无二选一信号 → 不过度触发', () => {
    expect(parseDecisionInvoke('帮我选一台电脑').triggered).toBe(false)
  })

  it('空串不触发', () => {
    expect(parseDecisionInvoke('').triggered).toBe(false)
  })
})

describe('决策三栏：委托通道断言', () => {
  it('默认执行器确实经 delegationManager.delegate(from=lumina) 通道，不绕过 rolePolicy', async () => {
    const calls: Array<{ from: string; to: string }> = []
    const fakeDm = {
      delegate: vi.fn(async (from: string, req: { to: string; task: string }) => {
        calls.push({ from, to: req.to })
        return { success: true, content: req.to === 'yak' ? GOOD_YAK : GOOD_RECHA, error: undefined }
      }),
    }
    // 注入假网关（生产实现内部就是 require('../delegationManager').getDelegationManager()）
    setDelegationGatewayResolver(() => fakeDm as any)

    try {
      const deps = createDefaultDecisionDeps()
      await runDecisionDebate('q', [], deps)

      expect(fakeDm.delegate).toHaveBeenCalledTimes(2)
      for (const c of calls) {
        // 铁则：from 恒为 lumina，后台成员不直接对用户入口负责
        expect(c.from).toBe('lumina')
        expect(['yak', 'recha']).toContain(c.to)
      }
    } finally {
      setDelegationGatewayResolver(null)
    }
  })
})
