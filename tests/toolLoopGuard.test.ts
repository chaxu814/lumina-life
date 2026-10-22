// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// tests/toolLoopGuard.test.ts
//
// 【这是行为级验证，不是源码文本断言】
//   直接把 2026-10-11 截图里的真实场景跑出来，证明修复有效。
//
//   背景：用户问「使命召唤 23 的发布日期」，Lumina 连续搜索了多次（每次换关键词），
//   旧判据「同名 ≥5 次」把搜索工具封了 → 模型只能凭记忆硬答 → 编出
//   「Call of Duty: Modern III，2010 年 11 月 9 日」（产品名是编的，日期也是错的）。
// ============================================================

import { describe, it, expect } from 'vitest'
import {
  detectToolLoop,
  buildToolSignature,
  buildLoopStopMessage,
  describeLoopTrigger,
  IDENTICAL_LOOP_THRESHOLD,
  TOOL_OVERUSE_THRESHOLD,
} from '../electron/agent/toolLoopGuard'

/** 造一批「同名但不同参数」的调用（模拟真实的多轮检索） */
function varied(tool: string, queries: string[]) {
  return {
    names: queries.map(() => tool),
    sigs: queries.map(q => buildToolSignature(tool, { query: q })),
  }
}

describe('★ 回归场景：复杂问答连续检索不应被封（截图里的真实故障）', () => {
  it('连续 5 次 web_search、每次不同关键词 → 不封禁', () => {
    const { names, sigs } = varied('web_search', [
      '使命召唤 23 发布日期',
      'Call of Duty 2025 release date',
      '使命召唤 最新作品',
      'COD Modern Warfare 发行时间',
      '使命召唤 新作 官方公告',
    ])
    const v = detectToolLoop(names, sigs)
    expect(v.tool, '不同关键词的连续检索绝不能被判成死循环').toBeNull()
    expect(v.reason).toBeNull()
  })

  it('连续 9 次同名不同参数 → 仍不封禁（低于兜底上限）', () => {
    const { names, sigs } = varied('web_search', Array.from({ length: 9 }, (_, i) => `查询${i}`))
    expect(detectToolLoop(names, sigs).tool).toBeNull()
  })

  it('检索之间夹杂其它工具 → 不封禁', () => {
    const names = ['web_search', 'file_read', 'web_search', 'web_search', 'web_search', 'file_read']
    const sigs = names.map((n, i) => buildToolSignature(n, { i }))
    expect(detectToolLoop(names, sigs).tool).toBeNull()
  })
})

describe('真死循环仍要拦住', () => {
  it('同一工具 + 完全相同的参数 重复 3 次 → 封禁', () => {
    const { names, sigs } = varied('web_search', ['同一个查询', '同一个查询', '同一个查询'])
    const v = detectToolLoop(names, sigs)
    expect(v.tool).toBe('web_search')
    expect(v.reason).toBe('identical-loop')
    expect(v.count).toBe(3)
  })

  it('重复 2 次还没到阈值 → 不封禁', () => {
    const { names, sigs } = varied('web_search', ['同一个查询', '同一个查询'])
    expect(detectToolLoop(names, sigs).tool).toBeNull()
  })

  it('同名调用达到 10 次（即使参数各不相同）→ 兜底封禁', () => {
    const { names, sigs } = varied('shell_exec', Array.from({ length: 10 }, (_, i) => `cmd${i}`))
    const v = detectToolLoop(names, sigs)
    expect(v.tool).toBe('shell_exec')
    expect(v.reason).toBe('overuse')
    expect(v.count).toBe(10)
  })

  it('阈值常量与实现一致（防止有人改了常量忘了改判据）', () => {
    expect(IDENTICAL_LOOP_THRESHOLD).toBe(3)
    expect(TOOL_OVERUSE_THRESHOLD).toBe(10)
  })
})

describe('签名必须带上参数（否则退化成"只看名字"）', () => {
  it('同名不同参数 → 签名不同', () => {
    expect(buildToolSignature('web_search', { q: 'a' }))
      .not.toBe(buildToolSignature('web_search', { q: 'b' }))
  })

  it('同名同参数 → 签名相同', () => {
    expect(buildToolSignature('web_search', { q: 'a' }))
      .toBe(buildToolSignature('web_search', { q: 'a' }))
  })

  it('参数是字符串形式（模型常直接给 JSON 字符串）也能正确区分', () => {
    expect(buildToolSignature('t', '{"q":"a"}')).not.toBe(buildToolSignature('t', '{"q":"b"}'))
  })

  it('参数为 null/循环引用不抛错', () => {
    expect(() => buildToolSignature('t', null)).not.toThrow()
    const cyc: Record<string, unknown> = {}; cyc.self = cyc
    expect(() => buildToolSignature('t', cyc)).not.toThrow()
  })
})

describe('停止提示：不再鼓励编造、不再泄漏机制', () => {
  const msg = buildLoopStopMessage(3, 'identical-loop')

  it('明确标注为内部状态、禁止向用户提及', () => {
    expect(msg).toContain('内部状态')
    expect(msg).toContain('禁止向用户提及')
    expect(msg).toContain('不要向用户提到任何工具名称')
  })

  it('明确禁止凭记忆猜事实（这是幻觉的直接对策）', () => {
    expect(msg).toContain('不要凭记忆猜测事实性问题')
    expect(msg).toContain('查不到')
    expect(msg).toContain('宁可承认不知道')
  })

  it('绝不出现旧文案「请用已有信息直接回复」', () => {
    expect(msg).not.toContain('请用已有信息直接回复')
    expect(msg).not.toContain('用已有信息直接回复')
  })

  it('两种触发原因都能生成可用文案', () => {
    expect(buildLoopStopMessage(10, 'overuse')).toContain('超过单轮上限')
    expect(buildLoopStopMessage(3, 'identical-loop')).toContain('完全相同的参数')
  })

  it('思考面板的原因文案可读', () => {
    expect(describeLoopTrigger('identical-loop')).toBe('以完全相同的参数重复调用')
    expect(describeLoopTrigger('overuse')).toBe('调用次数过多')
  })
})

describe('边界与健壮性', () => {
  it('空输入不抛错、不误报', () => {
    expect(detectToolLoop([], [])).toEqual({ tool: null, reason: null, count: 0 })
    expect(detectToolLoop(undefined as never, undefined as never).tool).toBeNull()
  })

  it('签名里含 | 也不会误判工具名（只取第一段）', () => {
    const sig = buildToolSignature('t', { a: 'x|y' })
    const v = detectToolLoop(['t', 't', 't'], [sig, sig, sig])
    expect(v.tool).toBe('t')
  })
})
