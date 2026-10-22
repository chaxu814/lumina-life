// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// lib/ime.ts — 中文输入法（IME）回车判定
//
// 【为什么需要】
//   中文/日文等输入法在「选词」时按回车只是**确认候选词**，并不是
//   「提交 / 发送」。若不判 `isComposing`，用户拼音打字按回车会把
//   半截内容（甚至空字符串）当成消息发出去 —— 用户感知就是
//   「聊天断断续续」「模型说这一轮没看到问题」。
//
//   实测：2026-10-10 全仓 `onKeyDown` 无一处判 `isComposing`，
//   对中文用户是系统性缺陷（项目面向中文用户，几乎必踩）。
//
// 【用法】
//   onKeyDown={e => {
//     if (isImeComposing(e)) return          // ← 组词中，忽略回车
//     if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() }
//   }}
//
// 注：`keyCode === 229` 是部分输入法 / 浏览器的等价信号，一并兜住。
// ============================================================

/** 只依赖结构，不依赖 React 类型 —— 便于单测与跨组件复用 */
interface ImeKeyEventLike {
  nativeEvent?: { isComposing?: boolean } | null
  keyCode?: number
}

/**
 * 该按键事件是否属于「输入法正在组词」。
 * 为 true 时**不应**把这次回车当成提交/发送。
 */
export function isImeComposing(e: ImeKeyEventLike | null | undefined): boolean {
  if (!e) {return false}
  return !!e.nativeEvent?.isComposing || e.keyCode === 229
}
