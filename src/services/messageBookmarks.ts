// ============================================================
// messageBookmarks.ts — 消息收藏服务 (v2.14)
// ============================================================

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
  try {
    const raw = localStorage.getItem(BOOKMARKS_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

export function saveBookmarks(bookmarks: BookmarkedMessage[]): void {
  localStorage.setItem(BOOKMARKS_KEY, JSON.stringify(bookmarks))
}

export function addBookmark(msg: Omit<BookmarkedMessage, 'id' | 'timestamp'>): BookmarkedMessage {
  const bookmarks = loadBookmarks()
  const entry: BookmarkedMessage = {
    ...msg,
    id: `bm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
  }
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
