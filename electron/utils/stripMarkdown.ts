// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// stripMarkdown.ts — Markdown 语法清洗工具
//
// 将 LLM 生成的 Markdown 格式文本清洗为纯文本，
// 用于 Windows 系统通知、推送标题等不支持富文本的场景。
// ============================================================

/**
 * 清洗 Markdown 语法，返回纯文本。
 * 处理：### 标题、**加粗**、*斜体*、`代码`、[链接](url)、> 引用、列表符号等。
 */
export function stripMarkdown(text: string): string {
  if (!text) {return text}
  const result = text
    // 移除标题标记 (### / ## / #)
    .replace(/^#{1,6}\s+/gm, '')
    // 移除加粗 **text** 或 __text__
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    // 移除斜体 *text* 或 _text_（注意不要和加粗冲突，用非贪婪）
    .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '$1')
    .replace(/(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g, '$1')
    // 移除行内代码 `code`
    .replace(/`([^`]+)`/g, '$1')
    // 移除链接 [text](url) → text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // 移除图片 ![alt](url)
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    // 移除引用块标记 >
    .replace(/^>\s+/gm, '')
    // 移除水平线 --- / *** / ___
    .replace(/^[-*_]{3,}\s*$/gm, '')
    // 移除无序列表标记 - / * / +
    .replace(/^[\s]*[-*+]\s+/gm, '')
    // 移除有序列表标记 1. / 2. 等
    .replace(/^[\s]*\d+\.\s+/gm, '')
    // 移除删除线 ~~text~~
    .replace(/~~(.+?)~~/g, '$1')
    // 移除 HTML 标签（简单处理）
    .replace(/<[^>]+>/g, '')
    // 合并连续空行为单个换行
    .replace(/\n{3,}/g, '\n\n')
    // 去除首尾空白
    .trim()

  return result
}
