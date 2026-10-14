// ============================================================
// chatPersistenceGuard.test.ts — 会话持久化不能静默失败
//
// 【背景（2026-10-13 实测发现）】
//   主窗口对话存在 localStorage 的 `lumina_gc_<sid>` 键里，会话列表存在
//   `lumina_gc_sessions`。旧实现直接 `localStorage.setItem(...)`，**没有 try/catch**：
//   localStorage 上限约 5MB，而长会话很容易撞上（本仓实测已有单会话 7791 条）。
//   一旦超限，写入抛错、无人接住 → 用户重启后"最近聊的都没了"，
//   而控制台之外没有任何线索。
//
// 【修法】
//   1. 写入失败时**明确报错**（不再静默）
//   2. **降级重试**：逐步只保留最近 200/100/50/20 条 ——
//      宁可少留历史，也不能整段丢失。用户最在意的是"刚才说的话还在不在"。
// ============================================================

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { saveGCMessages, saveGCSessions, loadGCMessages } from '../src/chat/chatShared'

/** 可控容量的 localStorage 替身：超过 limit 字符即抛 QuotaExceededError */
class FakeStorage {
  private data = new Map<string, string>()
  /** 单个 value 的字符上限（模拟 5MB 配额） */
  public limit = Infinity
  public writes: string[] = []

  setItem(k: string, v: string): void {
    if (v.length > this.limit) {
      const err = new Error('QuotaExceededError') as Error & { name: string }
      err.name = 'QuotaExceededError'
      throw err
    }
    this.data.set(k, v)
    this.writes.push(k)
  }
  getItem(k: string): string | null { return this.data.get(k) ?? null }
  removeItem(k: string): void { this.data.delete(k) }
  clear(): void { this.data.clear(); this.writes = [] }
}

const mkMsg = (i: number) => ({
  id: `m${i}`,
  from: 'user',
  fromIcon: '',
  fromName: '',
  content: 'x'.repeat(100),   // 每条 100 字符，便于精确控制体积
  time: '',
  _animDone: true,
})

let fake: FakeStorage

beforeEach(() => {
  fake = new FakeStorage()
  vi.stubGlobal('localStorage', fake)
})

describe('saveGCMessages — 容量超限时必须降级而非静默丢失', () => {
  it('正常情况：完整写入', () => {
    const msgs = Array.from({ length: 30 }, (_, i) => mkMsg(i))
    saveGCMessages('s1', msgs)
    expect(loadGCMessages('s1')).toHaveLength(30)
  })

  it('超限时降级为「最近 N 条」，且最近的消息一定在', () => {
    // 容量只够存约 50 条（每条约 100+ 字符的 JSON）
    fake.limit = 7000
    const msgs = Array.from({ length: 200 }, (_, i) => ({
      ...mkMsg(i),
      content: `第${i}条` + 'x'.repeat(96),   // 内容可区分，验证保留的是最新的
    }))
    saveGCMessages('s2', msgs)

    const saved = loadGCMessages('s2')
    expect(saved.length).toBeGreaterThan(0)
    expect(saved.length).toBeLessThan(200)          // 确实降级了
    // 关键：保留的是**最后**那些（最新的对话），而不是最老的
    expect(saved[saved.length - 1].content).toContain('第199条')
  })

  it('连最小保留量都写不进去时，不抛异常（只报错）', () => {
    fake.limit = 10
    expect(() => saveGCMessages('s3', [mkMsg(1), mkMsg(2)])).not.toThrow()
  })

  it('空白气泡仍被过滤（降级逻辑不改变原有语义）', () => {
    const msgs = [
      { ...mkMsg(0), content: '' , _animDone: true },   // 空白且已完成 → 过滤
      mkMsg(1),
    ]
    saveGCMessages('s4', msgs)
    expect(loadGCMessages('s4')).toHaveLength(1)
  })
})

describe('saveGCSessions — 列表写入同样不能静默失败', () => {
  it('正常写入', () => {
    saveGCSessions([{ id: 'a', date: '2026/10/13', preview: 'hi', count: 3 }])
    expect(JSON.parse(fake.getItem('lumina_gc_sessions') || '[]')).toHaveLength(1)
  })

  it('超限时不抛异常（列表极小，但仍需兜住）', () => {
    fake.limit = 1
    expect(() => saveGCSessions([{ id: 'a', date: 'd', preview: 'p', count: 1 }])).not.toThrow()
  })
})
