// ============================================================
// impl/fileRead.ts — 文件读取工具 (v4.0: 🧱 沙箱集成)
//
// v4.0: 集成沙箱拦截层
//   — 读取非安全区文件 → 记录日志
//   — 读取敏感文件 (.env, .key, .pem) → 需要审批
//   — 目录读取绕过沙箱（安全可读）
// ============================================================

import fs from 'fs'
import type { ToolDef, ToolResult } from '../types'
import { tryResolvePath } from './pathResolver'

// 延迟加载沙箱
let _sandbox: any = null
async function getSandbox() {
  if (!_sandbox) {
    const mod = await import('../../sandbox')
    _sandbox = mod.getSandbox()
  }
  return _sandbox
}

export const fileReadDef: ToolDef = {
  name: 'file_read',
  description: '读取文本文件内容。支持指定起始行和结束行。已集成沙箱路径检查。',
  params: {
    filePath: { type: 'string', description: '文件绝对路径（必填）。例如："C:\\project\\README.md"', required: true },
    path: { type: 'string', description: 'filePath 的别名（二选一）', required: false },
    startLine: { type: 'number', description: '起始行 (1-based，可选)', required: false },
    endLine: { type: 'number', description: '结束行 (1-based，可选)', required: false },
  },
  toolsets: ['agent', 'chat'],
}

export async function fileRead(args: Record<string, any>): Promise<ToolResult> {
  // 兼容 filePath 和 path 两种参数名
  const rawFilePath: string = args.filePath || args.path
  const startLine = args.startLine || 1
  const endLine = args.endLine || 0
  const start = Date.now()

  try {
    // 智能路径解析 — 自动修正用户名
    const [filePath] = await tryResolvePath(rawFilePath)

    // ═══════════════════════════════════════════════════
    // 🧱 沙箱拦截 — 读取检查（敏感文件需要审批）
    // ═══════════════════════════════════════════════════
    try {
      const sandbox = await getSandbox()
      const agentId = args._agentId || 'lumina'
      const check = await sandbox.checkFileAccess(agentId, filePath, 'read')

      if (!check.allowed) {
        return {
          callId: '',
          ok: false,
          content: '',
          error: `⛔ 沙箱已拦截读取: ${check.reason}` +
            (check.suggestion ? `\n\n💡 建议: ${check.suggestion}` : ''),
          durationMs: Date.now() - start,
        }
      }
    } catch (sbErr) {
      console.warn('[Sandbox] 沙箱检查异常，放行读取:', sbErr)
    }

    // 检查文件是否存在
    let stat: fs.Stats
    try {
      stat = await fs.promises.stat(filePath)
    } catch {
      return { callId: '', ok: false, content: '', error: `文件不存在: ${rawFilePath}。请检查路径拼写或使用绝对路径。` }
    }

    // 目录 → 列出内容
    if (stat.isDirectory()) {
      let items: fs.Dirent[]
      try {
        items = await fs.promises.readdir(filePath, { withFileTypes: true })
      } catch {
        return { callId: '', ok: false, content: '', error: `无法读取目录: ${filePath}` }
      }
      const listing = items
        .slice(0, 50)
        .map((d) => `${d.isDirectory() ? '📁' : '📄'} ${d.name}`)
        .join('\n')
      return {
        callId: '',
        ok: true,
        content: `[${filePath}]\n${listing}${items.length > 50 ? `\n...还有 ${items.length - 50} 项未显示` : ''}`,
        durationMs: Date.now() - start,
      }
    }

    // 安全检查：限制文件大小
    if (stat.size > 5 * 1024 * 1024) {
      return { callId: '', ok: false, content: '', error: `文件过大 (${(stat.size / 1024 / 1024).toFixed(1)}MB)，请使用 startLine/endLine 分段读取` }
    }

    const content = await fs.promises.readFile(filePath, 'utf-8')
    const lines = content.split('\n')

    if (endLine > 0) {
      const selected = lines.slice(startLine - 1, endLine)
      return {
        callId: '',
        ok: true,
        content: selected.join('\n'),
        durationMs: Date.now() - start,
      }
    }

    return {
      callId: '',
      ok: true,
      content: lines.length > 500
        ? lines.slice(0, 500).join('\n') + `\n\n... (${lines.length - 500} 行未显示，共 ${lines.length} 行)`
        : content,
      durationMs: Date.now() - start,
    }
  } catch (err: any) {
    return { callId: '', ok: false, content: '', error: err.message }
  }
}
