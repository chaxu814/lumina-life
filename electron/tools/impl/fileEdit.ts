// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// impl/fileEdit.ts — 文件编辑工具 (查找替换) (v4.0: 🧱 沙箱集成)
// ============================================================

import fs from 'fs'
import type { ToolDef, ToolResult } from '../types'

// 延迟加载沙箱
let _sandbox: any = null
async function getSandbox() {
  if (!_sandbox) {
    const mod = await import('../../sandbox')
    _sandbox = mod.getSandbox()
  }
  return _sandbox
}

export const fileEditDef: ToolDef = {
  name: 'file_edit',
  description: '在文件中查找并替换文本。所有匹配项都会被替换。已集成沙箱路径检查。',
  params: {
    filePath: { type: 'string', description: '文件路径 (绝对路径)', required: true },
    path: { type: 'string', description: 'filePath 的别名（二选一）', required: false },
    oldText: { type: 'string', description: '要查找的文本 (精确匹配)', required: true },
    newText: { type: 'string', description: '替换后的文本', required: true },
  },
  toolsets: ['agent'],
  dangerous: true,
  blockedInChild: false,
}

export async function fileEdit(args: Record<string, any>): Promise<ToolResult> {
  // 兼容 filePath 和 path 两种参数名
  const filePath: string = args.filePath || args.path
  const oldText: string = args.oldText
  const newText: string = args.newText
  const start = Date.now()

  try {
    // ═══════════════════════════════════════════════════
    // 🧱 沙箱拦截 — 编辑操作需在安全区内或用户确认
    // ═══════════════════════════════════════════════════
    try {
      const sandbox = await getSandbox()
      const agentId = args._agentId || 'lumina'
      const check = await sandbox.checkFileAccess(agentId, filePath, 'edit')

      if (!check.allowed) {
        return {
          callId: '',
          ok: false,
          content: '',
          error: `⛔ 沙箱已拦截编辑: ${check.reason}` +
            (check.suggestion ? `\n\n💡 建议: ${check.suggestion}` : ''),
          durationMs: Date.now() - start,
        }
      }
    } catch (sbErr) {
      console.warn('[Sandbox] 沙箱检查异常，放行编辑:', sbErr)
    }

    // 读取文件
    let content: string
    try {
      content = await fs.promises.readFile(filePath, 'utf-8')
    } catch {
      return { callId: '', ok: false, content: '', error: `文件不存在: ${filePath}` }
    }

    if (!content.includes(oldText)) {
      return { callId: '', ok: false, content: '', error: '未找到匹配文本' }
    }

    const replaced = content.split(oldText).join(newText)
    const count = (content.length - replaced.length) / (newText.length - oldText.length)

    await fs.promises.writeFile(filePath, replaced, 'utf-8')
    return {
      callId: '',
      ok: true,
      content: `文件编辑成功: ${filePath} (替换了 ${Math.abs(Math.round(count))} 处)`,
      durationMs: Date.now() - start,
    }
  } catch (err: any) {
    return { callId: '', ok: false, content: '', error: err.message }
  }
}
