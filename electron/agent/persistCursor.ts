/**
 * persistCursor — 增量持久化的游标计算（纯函数，可单测）
 *
 * ============================================================
 * 【它解决的真实故障】
 *
 * `agentRunner` 要把消息增量写入三个地方（SQLite / chats.json / dialog）。
 * 旧实现各持一个**索引**游标（`lastPersistedIndex` 等），假设
 * 「`this.messages` 只会向后追加」。
 *
 * 但 `this.messages` 会被**整体重建** —— 实测有 **13 处**：
 *   `_stripTransientMessages` 的 filter、scroll 裁剪、压缩重建、
 *   `setHistory`、全路径恢复、总结轮重建、`slice(-10)` …
 * 而修正逻辑只在其中 **1 处**做过，其余 12 处全部失准。
 *
 * 实测后果（从落库数据反查）：
 *   · SQLite 重复写入 **50%**（system 4083→2037；一条内部指令被写了 1209 次）
 *   · dialog **漏写**（同一天同一会话：后端 55 条 / dialog 仅 34 条）
 *
 * 【为什么用对象引用而不是索引】
 *   引用只要那条消息**还在数组里**，`indexOf` 就能定位到它当前的位置；
 *   数组怎么重建都不影响。这也是项目约定「不要用索引跟踪 this.messages」
 *   的直接应用。
 *
 * 【找不到游标时为什么从头写】
 *   说明那条消息已经被裁出数组（数组变短了）。此时：
 *     · 从头写 → 可能重复，但**不会漏**
 *     · 跳过写 → 会漏掉新内容
 *   日志的用途是**留痕**，重复的代价远小于漏写。而且数组既然被裁过，
 *   长度已经不大，全量重写的开销可接受。
 * ============================================================
 */

/**
 * 算出本轮增量写入的起始下标。
 *
 * @param messages 当前消息数组
 * @param cursor   上一次已写入的最后一条消息（对象引用）；null 表示从未写过
 * @returns 起始下标（含）。`messages.length` 表示"无需写入"
 */
export function computePersistStart(
  messages: readonly unknown[],
  cursor: unknown,
): number {
  if (!cursor) {return 0}
  if (!Array.isArray(messages)) {return 0}
  const idx = messages.indexOf(cursor)
  return idx >= 0 ? idx + 1 : 0
}

/**
 * 游标推进：记录"这次写到哪儿了"。
 * 数组为空时返回 null（下次从头写，语义一致）。
 */
export function advanceCursor<T>(messages: readonly T[]): T | null {
  if (!Array.isArray(messages) || messages.length === 0) {return null}
  return messages[messages.length - 1] ?? null
}
