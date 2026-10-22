// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// tests/silentDataLossGuard.test.ts — 「加载失败不得伪装成空数据」
//
// 【要解决的问题：同一个 bug 的多个副本】
// 模式：
//   const raw = localStorage.getItem(KEY)
//   try { return raw ? JSON.parse(raw) : [] }
//   catch { return [] }              // ← 解析失败 = 「没有数据」
//
// 而所有写操作都是「读 → 改 → 写回」：
//   removeBookmark = loadBookmarks().filter(...) → saveBookmarks(...)
//   → 一次解析失败，用户删一条书签 = 清空全部收藏
//
// 根因：**把「本来就没有」和「有但损坏」合并成了同一个返回值**。
// 上层无法区分，于是「读改写」把损坏数据「修复」成只剩本次修改。
//
// 本文件覆盖已修复的 5 处 + 统一加载器本身的语义。
// ============================================================

import { describe, it, expect, beforeEach } from 'vitest'

// ═══════════════════════════════════════════════════════════
// localStorage 替身
// ═══════════════════════════════════════════════════════════
class MemStorage {
  private m = new Map<string, string>()
  get length() { return this.m.size }
  key(i: number) { return Array.from(this.m.keys())[i] ?? null }
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null }
  setItem(k: string, v: string) { this.m.set(k, String(v)) }
  removeItem(k: string) { this.m.delete(k) }
  clear() { this.m.clear() }
}

let store: MemStorage
beforeEach(() => {
  store = new MemStorage()
  ;(globalThis as any).localStorage = store
})

// ═══════════════════════════════════════════════════════════
// 1. safeLoad 本身
// ═══════════════════════════════════════════════════════════

describe('safeLoad · 语义正确性', () => {
  it('键不存在 → 返回空（首次启动，合法）', async () => {
    const { safeLoadArray, safeLoadObject } = await import('../src/services/safeLoad')
    expect(safeLoadArray('nope')).toEqual([])
    expect(safeLoadObject('nope')).toEqual({})
  })

  it('正常数据 → 原样返回', async () => {
    const { safeLoadArray, safeLoadObject } = await import('../src/services/safeLoad')
    store.setItem('k1', JSON.stringify([1, 2, 3]))
    store.setItem('k2', JSON.stringify({ a: 1 }))
    expect(safeLoadArray('k1')).toEqual([1, 2, 3])
    expect(safeLoadObject('k2')).toEqual({ a: 1 })
  })

  it('🔑 损坏数据 → 抛错（绝不返回空）', async () => {
    const { safeLoadArray, safeLoadObject, CorruptedDataError } = await import('../src/services/safeLoad')
    store.setItem('bad1', '{ not json')
    store.setItem('bad2', '[1,2,')

    expect(() => safeLoadArray('bad1')).toThrow(CorruptedDataError)
    expect(() => safeLoadArray('bad2')).toThrow(CorruptedDataError)
    expect(() => safeLoadObject('bad1')).toThrow(CorruptedDataError)
  })

  it('🔑 类型不符也算损坏（数组位置放了对象）', async () => {
    const { safeLoadArray, safeLoadObject } = await import('../src/services/safeLoad')
    store.setItem('wrong1', '{"a":1}')       // 期望数组
    store.setItem('wrong2', '[1,2]')         // 期望对象
    expect(() => safeLoadArray('wrong1')).toThrow()
    expect(() => safeLoadObject('wrong2')).toThrow()
  })

  it('损坏时原文被备份（用户还能手动抢救）', async () => {
    const { safeLoadArray, hasCorruptedBackup, listCorruptedBackups, restoreFromBackup } =
      await import('../src/services/safeLoad')
    store.setItem('bm', '{ broken data')

    try { safeLoadArray('bm') } catch { /* expected */ }

    expect(hasCorruptedBackup('bm')).toBe(true)
    const list = listCorruptedBackups()
    expect(list.length).toBe(1)
    expect(list[0].originalKey).toBe('bm')

    // 修复后恢复
    store.setItem('bm', '[{"id":"a"}]')
    expect(restoreFromBackup('bm')).toBe(false)  // 备份本身是坏的，恢复不了
  })

  it('备份只在首次损坏时写入（保留最早现场）', async () => {
    const { safeLoadArray } = await import('../src/services/safeLoad')
    store.setItem('k', '{ v1')
    try { safeLoadArray('k') } catch {}
    const bk = '__lumina_corrupted_backup__k'
    const first = store.getItem(bk)

    store.setItem('k', '{ v2')
    try { safeLoadArray('k') } catch {}
    expect(store.getItem(bk)).toBe(first)   // 没有被覆盖
  })

  it('兜底版不抛但保留备份', async () => {
    const { safeLoadArrayOrBackup, hasCorruptedBackup } = await import('../src/services/safeLoad')
    store.setItem('x', 'not-json')
    const r = safeLoadArrayOrBackup('x', ['fallback'])
    expect(r).toEqual(['fallback'])
    expect(hasCorruptedBackup('x')).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════
// 2. 端到端：收藏不再被「删一条清空全部」
// ═══════════════════════════════════════════════════════════

describe('safeLoad · 收藏数据不再静默清空', () => {
  it('🔑 损坏状态下删除书签会抛错，而不是清空全部', async () => {
    const bm = await import('../src/services/messageBookmarks')
    // 正常流程：加两条
    bm.addBookmark({ content: 'A', from: 'user', fromName: 'U', fromIcon: '👤', source: 'chat' })
    bm.addBookmark({ content: 'B', from: 'user', fromName: 'U', fromIcon: '👤', source: 'chat' })
    expect(bm.loadBookmarks()).toHaveLength(2)

    // 模拟数据损坏
    store.setItem('lumina_bookmarked_messages', '{ corrupted')

    // 关键：删除必须失败，而不是把全部清空
    expect(() => bm.removeBookmark('whatever')).toThrow()

    // 原始损坏内容仍在（没有被覆盖成只剩一条）
    expect(store.getItem('lumina_bookmarked_messages')).toBe('{ corrupted')
  })

  it('损坏状态下添加书签也抛错（不会把收藏替换成刚加的那一条）', async () => {
    const bm = await import('../src/services/messageBookmarks')
    store.setItem('lumina_bookmarked_messages', 'garbage')
    expect(() => bm.addBookmark({
      content: 'C', from: 'user', fromName: 'U', fromIcon: '👤', source: 'chat',
    })).toThrow()
  })

  it('正常状态下增删仍然工作', async () => {
    const bm = await import('../src/services/messageBookmarks')
    const a = bm.addBookmark({ content: 'X', from: 'user', fromName: 'U', fromIcon: '👤', source: 'chat' })
    bm.addBookmark({ content: 'Y', from: 'user', fromName: 'U', fromIcon: '👤', source: 'chat' })
    expect(bm.loadBookmarks()).toHaveLength(2)

    bm.removeBookmark(a.id)
    const left = bm.loadBookmarks()
    expect(left).toHaveLength(1)
    expect(left[0].content).toBe('Y')
  })
})
