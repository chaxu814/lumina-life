// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// lib/pasteInsert.ts — 受控输入框的显式粘贴处理
//
// 【为什么需要】
// 用户实测：Ctrl+V 粘贴的内容**不落到**发送框。受控 <textarea> 理论上
// 原生支持粘贴（会触发 onChange），但在 Electron 桌面应用里，桌面宠物
// 窗口抢焦点、自定义键盘处理、失焦重挂载等情况会让原生粘贴落空。
//
// 【做法】显式接管 onPaste：读剪贴板纯文本 → 在光标处插入 → preventDefault
// 阻止默认行为，避免"原生 + 手动"双份插入。光标在 React 重渲染后复位。
// ============================================================

import type React from 'react'

type InputEl = HTMLTextAreaElement | HTMLInputElement

/**
 * 把剪贴板里的纯文本插入到受控输入框的光标处。
 * @param e        React 的 onPaste 事件
 * @param value    当前值（受控）
 * @param setValue 更新函数
 */
export function handlePasteInsert(
  e: React.ClipboardEvent<InputEl>,
  value: string,
  setValue: (v: string) => void,
): void {
  const text = e.clipboardData?.getData('text')
  if (!text) {return}
  e.preventDefault()
  const el = e.currentTarget
  const start = el.selectionStart ?? value.length
  const end = el.selectionEnd ?? value.length
  const next = value.slice(0, start) + text + value.slice(end)
  setValue(next)
  const caret = start + text.length
  // 等 React 完成重渲染后再复位光标（否则会被 value 回写覆盖）
  requestAnimationFrame(() => {
    try { el.selectionStart = el.selectionEnd = caret } catch { /* 元素已卸载 */ }
  })
}
