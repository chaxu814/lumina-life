// ============================================================
// services/safeLoad.ts — 「加载失败」不得伪装成「空数据」
//
// 【要解决的问题：同一个 bug 的 7 个副本】
// 全项目扫描发现同一模式出现在 7 处：
//
//   const raw = localStorage.getItem(KEY)
//   try { return raw ? JSON.parse(raw) : [] }
//   catch { return [] }              // ← 解析失败 = 「没有数据」
//
//   removeBookmark() = load().filter(...)  →  save(...)
//   // 一次解析失败，用户删一条书签 → 全部收藏被清空
//
//   聊天记录、模型库、Agent 状态、任务 PRD、Loop 任务……全都一样。
//
// 根因是**把两个完全不同的状态合并成了同一个返回值**：
//   · 「本来就没有数据」 → 空，合法
//   · 「数据存在但解析失败」 → 也返回空，**危险**
//
// 后果：上层无法区分，于是「读 → 改 → 写」的通用模式
//   会把损坏的数据「修复」成只剩本次修改的那一项。
//   用户丢的是他主动保存的东西（收藏、对话历史、模型库），
//   而且没有任何提示——只能眼看着内容消失。
//
// 【本模块的做法】
// 不逐个改那 7 处（改了还会有人加第 8 处），而是提供
// 两种语义明确的加载器，让调用方必须想清楚自己要哪种：
//
//   safeLoadArray / safeLoadObject
//     → 解析失败时**抛错**，调用方必须显式决定怎么办
//     → 适合「读改写」链路：宁可报错，也不能覆盖原数据
//
//   safeLoadArrayOrBackup / safeLoadObjectOrBackup
//     → 解析失败时**不抛**，但把损坏原文备份到备份键
//     → 适合「尽力恢复」场景：用户还能手动找回
//
// 关键：两者都**不会**把损坏数据当成空数据静默返回。
// ============================================================

/** 损坏数据的备份键前缀（localStorage） */
const BACKUP_PREFIX = '__lumina_corrupted_backup__'

function backupKey(key: string): string {
  return `${BACKUP_PREFIX}${key}`
}

function isBrowser(): boolean {
  return typeof localStorage !== 'undefined'
}

// ═══════════════════════════════════════════════════════════
// 严格版：解析失败抛错（推荐用于读改写链路）
// ═══════════════════════════════════════════════════════════

export class CorruptedDataError extends Error {
  constructor(
    public readonly storageKey: string,
    public readonly rawBackupKey: string,
    cause: unknown,
  ) {
    super(
      `存储项「${storageKey}」已损坏，为避免覆盖原数据已中止。` +
      `原始内容已备份到「${rawBackupKey}」。`,
    )
    this.name = 'CorruptedDataError'
    this.cause = cause
  }
}

/** 读出并解析数组；损坏时抛 CorruptedDataError（并先备份原文） */
export function safeLoadArray<T>(key: string): T[] {
  if (!isBrowser()) {return []}
  const raw = localStorage.getItem(key)
  if (raw === null || raw === '') {return []}
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) {
      throw new TypeError('期望数组，实际不是')
    }
    return parsed as T[]
  } catch (e) {
    preserveCorrupted(key, raw)
    throw new CorruptedDataError(key, backupKey(key), e)
  }
}

/** 读出并解析对象；损坏时抛 CorruptedDataError */
export function safeLoadObject<T extends object>(key: string): T {
  if (!isBrowser()) {return {} as T}
  const raw = localStorage.getItem(key)
  if (raw === null || raw === '') {return {} as T}
  try {
    const parsed = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new TypeError('期望对象，实际不是')
    }
    return parsed as T
  } catch (e) {
    preserveCorrupted(key, raw)
    throw new CorruptedDataError(key, backupKey(key), e)
  }
}

// ═══════════════════════════════════════════════════════════
// 兜底版：解析失败不抛，但保留可恢复的备份
// ═══════════════════════════════════════════════════════════

/**
 * 读出并解析数组；损坏时返回 fallback，**并把原文备份**。
 *
 * ⚠️ 只在「这个数据丢了也不要紧」或「上层已有用户可见提示」时使用。
 *    绝不要用在「读 → 改 → 写回」链路上——
 *    那正是本 bug 的成因。
 */
export function safeLoadArrayOrBackup<T>(key: string, fallback: T[] = []): T[] {
  try {
    return safeLoadArray<T>(key)
  } catch (e) {
    console.warn(`[safeLoad] 「${key}」损坏，已使用兜底值。原始内容见 ${backupKey(key)}`, e)
    return fallback
  }
}

/** 同上，对象版本 */
export function safeLoadObjectOrBackup<T extends object>(key: string, fallback: T = {} as T): T {
  try {
    return safeLoadObject<T>(key)
  } catch (e) {
    console.warn(`[safeLoad] 「${key}」损坏，已使用兜底值。原始内容见 ${backupKey(key)}`, e)
    return fallback
  }
}

// ═══════════════════════════════════════════════════════════
// 工具
// ═══════════════════════════════════════════════════════════

/** 把损坏原文复制到备份键（不覆盖已有备份——第一次损坏的现场最宝贵） */
export function preserveCorrupted(key: string, raw: string): void {
  if (!isBrowser()) {return}
  const bk = backupKey(key)
  try {
    if (localStorage.getItem(bk) === null) {
      localStorage.setItem(bk, raw)
      console.error(
        `[safeLoad] 「${key}」解析失败，原始内容已备份到「${bk}」。` +
        `请勿清除该键——它可能是你唯一的恢复途径。`,
      )
    }
  } catch { /* 配额不足等：至少不影响主流程 */ }
}

/** 是否存在损坏备份（供设置页提示用户） */
export function hasCorruptedBackup(key: string): boolean {
  if (!isBrowser()) {return false}
  return localStorage.getItem(backupKey(key)) !== null
}

/** 列出全部损坏备份 */
export function listCorruptedBackups(): Array<{ originalKey: string; backupKey: string; size: number }> {
  if (!isBrowser()) {return []}
  const out: Array<{ originalKey: string; backupKey: string; size: number }> = []
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)
    if (!k || !k.startsWith(BACKUP_PREFIX)) {continue}
    out.push({
      originalKey: k.slice(BACKUP_PREFIX.length),
      backupKey: k,
      size: (localStorage.getItem(k) || '').length,
    })
  }
  return out
}

/** 尝试从备份恢复（成功后自动清掉备份键） */
export function restoreFromBackup(key: string): boolean {
  if (!isBrowser()) {return false}
  const bk = backupKey(key)
  const raw = localStorage.getItem(bk)
  if (raw === null) {return false}
  try {
    JSON.parse(raw)          // 先验证能解析
    localStorage.setItem(key, raw)
    localStorage.removeItem(bk)
    return true
  } catch {
    return false             // 备份本身也坏了
  }
}
