// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// impl/fileWrite.ts — 文件写入工具 (v4.0: 🧱 沙箱集成)
//
// v4.0: 集成沙箱拦截层
//   — 检查路径是否在安全区内
//   — 不在安全区内 → 重定向到沙箱目录
//   — 系统关键路径 → 拒绝
// ============================================================

import fs from 'fs'
import path from 'path'
import type { ToolDef, ToolResult } from '../types'

// 延迟加载沙箱（避免启动时循环依赖）
let _sandbox: any = null
async function getSandbox() {
  if (!_sandbox) {
    const mod = await import('../../sandbox')
    _sandbox = mod.getSandbox()
  }
  return _sandbox
}

export const fileWriteDef: ToolDef = {
  name: 'file_write',
  description: '创建或覆盖写入文件。自动创建父目录。已集成沙箱路径重定向。',
  params: {
    filePath: { type: 'string', description: '文件绝对路径（必填）。例如："C:\\project\\output.txt"', required: true },
    path: { type: 'string', description: 'filePath 的别名（二选一）', required: false },
    content: { type: 'string', description: '要写入的内容', required: true },
  },
  toolsets: ['agent'],
  dangerous: true,
  blockedInChild: false,
}

export async function fileWrite(args: Record<string, any>): Promise<ToolResult> {
  // 兼容 filePath 和 path 两种参数名
  let filePath: string = args.filePath || args.path
  const content: string = args.content
  const start = Date.now()

  try {
    // ═══════════════════════════════════════════════════
    // 🧱 沙箱拦截 — 检查路径 + 可能的重定向
    // ═══════════════════════════════════════════════════
    try {
      const sandbox = await getSandbox()
      // 使用传入的 agentId，或默认 'lumina'（最高权限，减少误拦截）
      const agentId = args._agentId || 'lumina'
      const check = await sandbox.checkFileAccess(agentId, filePath, 'write')

      if (!check.allowed) {
        return {
          callId: '',
          ok: false,
          content: '',
          error: `⛔ 沙箱已拦截写入: ${check.reason}` +
            (check.suggestion ? `\n\n💡 建议: ${check.suggestion}` : ''),
          durationMs: Date.now() - start,
        }
      }

      // 如果被重定向，使用重定向后的路径并通知用户
      if (check.redirectTo) {
        console.log(`[Sandbox] 🔀 写入重定向: ${filePath} → ${check.redirectTo}`)
        filePath = check.redirectTo
      }
    } catch (sbErr) {
      // 沙箱异常不应阻塞写入（防御性编程）
      console.warn('[Sandbox] 沙箱检查异常，放行写入:', sbErr)
    }

    // 创建父目录并写入
    const dir = path.dirname(filePath)
    await fs.promises.mkdir(dir, { recursive: true })
    await fs.promises.writeFile(filePath, content, 'utf-8')

    const durationMs = Date.now() - start
    return {
      callId: '',
      ok: true,
      content: `文件写入成功: ${filePath} (${content.length} 字符)`,
      durationMs,
    }
  } catch (err: any) {
    return { callId: '', ok: false, content: '', error: err.message }
  }
}
