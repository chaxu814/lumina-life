// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// tests/emotionalMemory.test.ts
//
// 情绪记忆的契约测试。
//
// 【为什么这个模块的风险点特别集中】
// 情绪记忆是「AI 对你的感受」的持久化。如果写入条件太松，
// Lumina 会开始说一些**根本不存在的共同经历**（「我记得你当时很难过」）——
// 这不是文风问题，是**伪造记忆**，比记错事实严重得多。
// 所以下面半数用例都在测「不该记的时候确实没记」。
import { describe, it, expect } from 'vitest'
import {
  EmotionalMemoryStore, inferTagFromEvent, type EmotionTag,
} from '../electron/memory/emotionalMemory'

/**
 * 内存版 SQLite 替身。
 * 只实现本模块用到的四个操作，行为对齐 better-sqlite3 的 upsert 语义。
 */
function fakeDb() {
  const rows: Array<Record<string, unknown>> = []
  return {
    rows,
    exec: () => undefined,
    prepare: (sql: string) => {
      if (sql.includes('SELECT')) {
        return { all: (k: string) => rows.filter(r => r.content_key === k) }
      }
      if (sql.includes('DELETE')) {
        return { run: (cutoff: string) => {
          const before = rows.length
          for (let i = rows.length - 1; i >= 0; i--) {
            if (String(rows[i].ts) < cutoff) rows.splice(i, 1)
          }
          return { changes: before - rows.length }
        } }
      }
      // INSERT ... ON CONFLICT(content_key, tag)
      return {
        run: (content_key: string, tag: string, intensity: number, mood: number, energy: number, trigger: string | null, ts: string) => {
          const hit = rows.find(r => r.content_key === content_key && r.tag === tag)
          if (hit) {
            hit.intensity = intensity
            hit.mood = mood
            hit.energy = energy
            hit.trigger = trigger ?? hit.trigger
            hit.ts = ts
            hit.count = Number(hit.count) + 1
          } else {
            rows.push({ content_key, tag, intensity, mood, energy, trigger, ts, count: 1 })
          }
          return { changes: 1 }
        },
      }
    },
  } as never as Parameters<typeof EmotionalMemoryStore>[0]
}

const T0 = Date.parse('2026-10-03T22:14:00Z')
function storeAt(ts: number) {
  return new EmotionalMemoryStore(fakeDb(), { now: () => ts })
}

const FACT = '文件同步失败，配置项 key 写错了'

describe('情绪记忆写入', () => {
  it('attach 后能读回，且字段完整', () => {
    const s = storeAt(T0)
    s.attach({ contentKey: 'k1', tag: '焦躁', intensity: 0.7, mood: -0.4, energy: 0.3, trigger: 'task_failed' })
    const got = s.get('k1')
    expect(got).toHaveLength(1)
    expect(got[0].tag).toBe('焦躁')
    expect(got[0].trigger).toBe('task_failed')
    expect(got[0].count).toBe(1)
  })

  it('同一件事反复发生会累加 count，而不是覆盖', () => {
    const s = storeAt(T0)
    s.attach({ contentKey: 'k1', tag: '焦躁', intensity: 0.7, mood: -0.4, energy: 0.3 })
    s.attach({ contentKey: 'k1', tag: '焦躁', intensity: 0.8, mood: -0.5, energy: 0.2 })
    const got = s.get('k1')
    expect(got).toHaveLength(1)
    expect(got[0].count).toBe(2)          // 「让我焦躁过 2 次」≠「焦躁过 1 次」
    expect(got[0].intensity).toBe(0.8)   // 最近一次的强度
  })

  it('不同标签可以并存于同一条事实', () => {
    const s = storeAt(T0)
    s.attach({ contentKey: 'k1', tag: '焦躁', intensity: 0.7, mood: -0.4, energy: 0.3 })
    s.attach({ contentKey: 'k1', tag: '愧疚', intensity: 0.5, mood: -0.3, energy: 0.4 })
    expect(s.get('k1').map(x => x.tag).sort()).toEqual(['愧疚', '焦躁'])
  })

  it('空 contentKey 被拒；非法强度被夹到 0~1', () => {
    const s = storeAt(T0)
    s.attach({ contentKey: '', tag: '焦躁', intensity: 0.5, mood: 0, energy: 0 })
    s.attach({ contentKey: 'k2', tag: '焦躁', intensity: 99, mood: 0, energy: 0 })
    s.attach({ contentKey: 'k3', tag: '焦躁', intensity: -5, mood: 0, energy: 0 })
    expect(s.get('')).toHaveLength(0)
    expect(s.get('k2')[0].intensity).toBe(1)
    expect(s.get('k3')[0].intensity).toBe(0)
  })
})

describe('情绪记忆衰减与召回', () => {
  it('没有情绪标注的事实，strongest 返回 null（不伪造记忆）', () => {
    const s = storeAt(T0)
    expect(s.strongest('never-seen')).toBeNull()
  })

  it('时间越久权重越低（半衰期 21 天）', () => {
    const db = fakeDb() as unknown as { rows: Array<Record<string, unknown>> }
    // 写入时固定为一个过去时间戳，之后只推进「现在」——这样才能真正测出衰减
    const s = new EmotionalMemoryStore(db as never, { now: () => T0 })
    s.attach({ contentKey: 'k', tag: '焦躁', intensity: 0.7, mood: 0, energy: 0 })
    db.rows[0].ts = new Date(T0).toISOString()

    const w0 = s.strongest('k')!.weight
    expect(w0).toBeCloseTo(0.7, 2)   // 刚发生、无复现 → 约等于原强度

    // 推进 21 天（一个半衰期）→ 权重减半
    const s21 = new EmotionalMemoryStore(db as never, { now: () => T0 + 21 * 86_400_000 })
    const w21 = s21.strongest('k')!.weight
    expect(w21).toBeCloseTo(0.35, 2)
    expect(w21).toBeLessThan(w0)

    // 推进 42 天（两个半衰期）→ 再减半
    const s42 = new EmotionalMemoryStore(db as never, { now: () => T0 + 42 * 86_400_000 })
    expect(s42.strongest('k')!.weight).toBeCloseTo(0.175, 2)
  })

  it('复现次数提高权重，但用对数封顶（不会一次顶满）', () => {
    const db = fakeDb() as unknown as { rows: Array<Record<string, unknown>> }
    const s = new EmotionalMemoryStore(db as never, { now: () => T0 })
    s.attach({ contentKey: 'once', tag: '焦躁', intensity: 0.5, mood: 0, energy: 0 })
    s.attach({ contentKey: 'many', tag: '焦躁', intensity: 0.5, mood: 0, energy: 0 })
    for (let i = 0; i < 5; i++) s.attach({ contentKey: 'many', tag: '焦躁', intensity: 0.5, mood: 0, energy: 0 })
    db.rows.forEach(r => { r.ts = new Date(T0).toISOString() })

    const once = s.strongest('once')!.weight
    const many = s.strongest('many')!.weight
    expect(many).toBeGreaterThan(once)
    expect(many).toBeLessThanOrEqual(1)     // 封顶
  })

  it('超过保留期的记录权重归零，且不再被注入', () => {
    const db = fakeDb() as unknown as { rows: Array<Record<string, unknown>> }
    const s = new EmotionalMemoryStore(db as never, { now: () => T0, retentionDays: 90 })
    s.attach({ contentKey: 'k', tag: '焦躁', intensity: 0.9, mood: 0, energy: 0 })
    db.rows[0].ts = new Date(T0 - 200 * 86_400_000).toISOString()

    const later = new EmotionalMemoryStore(db as never, {
      now: () => T0, retentionDays: 90,
    })
    expect(later.strongest('k')!.weight).toBe(0)
    expect(later.enrich([{ contentKey: 'k', factText: FACT }]).block).toBe('')
  })

  it('强度最高的那条情绪胜出', () => {
    const s = storeAt(T0)
    s.attach({ contentKey: 'k', tag: '焦躁', intensity: 0.3, mood: 0, energy: 0 })
    s.attach({ contentKey: 'k', tag: '安心', intensity: 0.9, mood: 0.5, energy: 0.5 })
    expect(s.strongest('k')!.tag.tag).toBe('安心')
  })

  it('enrich 只标注命中情绪的事实，byKey 可供调用方逐条合并', () => {
    const s = storeAt(T0)
    s.attach({ contentKey: 'hot', tag: '焦躁', intensity: 0.7, mood: 0, energy: 0 })
    const hits = [
      { contentKey: 'hot', factText: FACT },
      { contentKey: 'cold', factText: '用户用 Rust 写工具链' },
    ]
    const { byKey, block } = s.enrich(hits)

    expect([...byKey.keys()]).toEqual(['hot'])          // 只有命中情绪的那条
    expect(block).toContain('情绪记忆')
    expect(block).toContain('焦躁')
    expect(block).not.toContain('用户用 Rust 写工具链')   // 未命中的不进 block
    // 调用方仍拿得到全部事实，自己决定怎么拼
    expect(hits).toHaveLength(2)
  })

  it('block 里的每行都能对回具体事实（没有靠字符串匹配的余地）', () => {
    const s = storeAt(T0)
    s.attach({ contentKey: 'a', tag: '焦躁', intensity: 0.7, mood: 0, energy: 0 })
    s.attach({ contentKey: 'b', tag: '安心', intensity: 0.8, mood: 0, energy: 0 })
    const { block } = s.enrich([
      { contentKey: 'a', factText: '事实甲' },
      { contentKey: 'b', factText: '事实乙' },
    ])
    expect(block).toContain('· 事实甲（')
    expect(block).toContain('· 事实乙（')
  })

  it('全部没有情绪时不产出任何 prompt 片段（零污染）', () => {
    const s = storeAt(T0)
    const r = s.enrich([{ contentKey: 'a', factText: 'x' }, { contentKey: 'b', factText: 'y' }])
    expect(r.block).toBe('')
    expect(r.byKey.size).toBe(0)
  })

  it('提示词措辞是「复述既有经历」而不是「请表演情绪」', () => {
    // 这条是防角色扮演式表演的关键：措辞一旦变成祈使句，模型就会开始演
    const s = storeAt(T0)
    s.attach({ contentKey: 'k', tag: '焦躁', intensity: 0.7, mood: 0, energy: 0 })
    const hint = s.strongest('k')!.hint
    expect(hint).toContain('当时你的感觉')
    expect(hint).not.toMatch(/请(表现|假装|扮演|表现出)/)
  })

  it('prune 只删过期记录', () => {
    const db = fakeDb() as unknown as { rows: Array<Record<string, unknown>> }
    const s = new EmotionalMemoryStore(db as never, { now: () => T0, retentionDays: 1 })
    s.attach({ contentKey: 'old', tag: '焦躁', intensity: 0.7, mood: 0, energy: 0 })
    // 造一条很久以前的
    db.rows[0].ts = '2020-01-01T00:00:00.000Z'
    const n = s.prune()
    expect(n).toBe(1)
    expect(s.get('old')).toHaveLength(0)
  })
})

describe('情绪标签推断（保守映射）', () => {
  it('用户纠正 → 委屈；被拦截 → 担忧；失败 → 焦躁；成功 → 安心', () => {
    expect(inferTagFromEvent({ success: false, userCorrected: true })).toBe('委屈')
    expect(inferTagFromEvent({ success: true, userCorrected: true })).toBe('委屈')  // 纠正优先
    expect(inferTagFromEvent({ success: true, blocked: true })).toBe('担忧')
    expect(inferTagFromEvent({ success: false })).toBe('焦躁')
    expect(inferTagFromEvent({ success: true })).toBe('安心')
  })

  it('只用客观信号，不让 LLM 去猜情绪', () => {
    // 签名里刻意没有「用户说了什么」这类参数 ——
    // 靠文本做情感分析会把「模型觉得用户应该什么情绪」写成用户的记忆
    const fn = inferTagFromEvent as unknown as (e: Record<string, unknown>) => EmotionTag | null
    expect(fn({ success: true, text: '我真的很难过' })).toBe('安心')  // 文本不参与判断
  })
})
