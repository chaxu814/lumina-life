// ============================================================
// messageBookmarks.ts — 消息收藏服务 (v2.14)
//
// 🔧 P0 修复（静默丢数据）
//   旧实现：loadBookmarks() 解析失败 → return []
//   而所有写操作都是「读 → 改 → 写回」：
//     removeBookmark = loadBookmarks().filter(...) → saveBookmarks(...)
//   于是一次解析失败（配额/写入截断/其他脚本干扰）后，
//   用户**删一条书签就等于清空全部收藏**，且毫无提示。
//
//   书签是用户主动保存的数据（不是缓存），删了就没了。
//   现在改用 safeLoad：解析失败时**抛错**并备份原文，
//   宁可操作失败也不能毁掉用户数据。
// ============================================================

import {
  safeLoadArray, CorruptedDataError, hasCorruptedBackup, restoreFromBackup,
} from './safeLoad'

export interface BookmarkedMessage {
  id: string
  content: string
  from: string       // agent id or 'user'
  fromName: string
  fromIcon: string
  timestamp: number
  source: string     // 'chat' | 'group' | conversation id
  tags?: string[]
}

const BOOKMARKS_KEY = 'lumina_bookmarked_messages'

export function loadBookmarks(): BookmarkedMessage[] {
  return safeLoadArray<BookmarkedMessage>(BOOKMARKS_KEY)
}

/** 收藏数据是否已损坏（设置页可据此提示用户） */
export function bookmarksCorrupted(): boolean {
  return hasCorruptedBackup(BOOKMARKS_KEY)
}

/** 尝试从备份恢复（供设置页「修复收藏」用） */
export function repairBookmarks(): boolean {
  return restoreFromBackup(BOOKMARKS_KEY)
}

export function saveBookmarks(bookmarks: BookmarkedMessage[]): void {
  localStorage.setItem(BOOKMARKS_KEY, JSON.stringify(bookmarks))
}

export function addBookmark(msg: Omit<BookmarkedMessage, 'id' | 'timestamp'>): BookmarkedMessage {
  const entry: BookmarkedMessage = {
    ...msg,
    id: `bm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
  }
  // 🔧 损坏时**不写**，而不是写入一个空列表把原数据覆盖掉。
  // 用户会看到报错 toast，而不是发现收藏凭空消失。
  const bookmarks = loadBookmarks()
  bookmarks.unshift(entry) // 最新的在前
  saveBookmarks(bookmarks)
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('bookmarks:changed'))
  }
  return entry
}

export function removeBookmark(id: string): void {
  const bookmarks = loadBookmarks().filter(b => b.id !== id)
  saveBookmarks(bookmarks)
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('bookmarks:changed'))
  }
}

export function exportBookmarks(): string {
  return JSON.stringify(loadBookmarks(), null, 2)
}
