// ============================================================
// impl/fileList.ts — 目录列表 (v4.0.1: 智能路径解析)
// ============================================================

import fs from 'fs'
import path from 'path'
import type { ToolDef, ToolResult } from '../types'
import { tryResolvePath } from './pathResolver'

export const fileListDef: ToolDef = {
  name: 'file_list',
  description:
    '列出目录中的文件和子目录。' +
    '支持递归模式（recursive=true）查看所有子目录结构。' +
    '用于浏览任何盘符下的文件夹内容，如 D:\\Games\\。纯只读操作。',
  params: {
    dirPath: {
      type: 'string',
      description:
        '目录路径（必填）。支持任何盘符，例如：' +
        '"D:\\"、"C:\\Users\\xxx\\Desktop"、"E:\\Projects\\"',
      required: true,
    },
    path: { type: 'string', description: 'dirPath 的别名（二选一）', required: false },
    pattern: { type: 'string', description: '文件名匹配模式 (如 *.ts, *.exe)', required: false },
    recursive: {
      type: 'boolean',
      description: '是否递归列出所有子目录（默认 false，只列出一层）。递归深度上限 3 层。',
      required: false,
    },
    maxEntries: {
      type: 'number',
      description: '最大条目数（默认 200，最大 500）',
      required: false,
    },
  },
  toolsets: ['agent', 'files'],
}

// 异步递归目录遍历
async function walkDir(
  dir: string,
  pattern: string,
  maxDepth: number,
  maxEntries: number,
  prefix: string
): Promise<string[]> {
  const results: string[] = []
  if (maxDepth < 0 || results.length >= maxEntries) {return results}

  let entries: fs.Dirent[]
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true })
  } catch {
    return results
  }

  // 先排目录，再排文件
  const dirs = entries.filter(e => e.isDirectory())
  const files = entries.filter(e => e.isFile())

  for (const entry of [...dirs, ...files]) {
    if (results.length >= maxEntries) {break}
    const type = entry.isDirectory() ? '[DIR]' : '[FILE]'
    const fullPath = path.join(dir, entry.name)

    if (pattern && !entry.isDirectory()) {
      const regex = new RegExp('^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$')
      if (!regex.test(entry.name)) {continue}
    }

    results.push(`${prefix}${type} ${entry.name}`)

    if (entry.isDirectory() && maxDepth > 0) {
      const sub = await walkDir(fullPath, pattern, maxDepth - 1, maxEntries - results.length, prefix + '  ')
      results.push(...sub)
    }
  }

  return results
}

export async function fileList(args: Record<string, any>): Promise<ToolResult> {
  // 兼容 dirPath 和 path 两种参数名
  const rawDirPath: string = args.dirPath || args.path
  const pattern: string = args.pattern || ''
  const recursive: boolean = args.recursive === true
  const maxEntries: number = Math.min(args.maxEntries || 200, 500)
  const start = Date.now()

  try {
    // v4.0.1: 智能路径解析 — 自动修正用户名
    const [dirPath, wasResolved] = await tryResolvePath(rawDirPath)
    const resolvedNote = wasResolved ? ` (路径已自动修正: ${rawDirPath} → ${dirPath})` : ''

    // 异步 I/O
    let stat: fs.Stats
    try {
      stat = await fs.promises.stat(dirPath)
    } catch {
      return { callId: '', ok: false, content: '', error: `目录不存在: ${rawDirPath}` }
    }

    if (!stat.isDirectory()) {
      return { callId: '', ok: false, content: '', error: `路径不是目录: ${dirPath}` }
    }

    const items: string[] = []

    if (recursive) {
      const walked = await walkDir(dirPath, pattern, 3, maxEntries, '')
      items.push(...walked)
    } else {
      const entries = await fs.promises.readdir(dirPath, { withFileTypes: true })
      for (const entry of entries.slice(0, maxEntries)) {
        const type = entry.isDirectory() ? '[DIR]' : '[FILE]'
        if (pattern && !entry.isDirectory()) {
          const regex = new RegExp('^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$')
          if (!regex.test(entry.name)) {continue}
        }
        items.push(`${type} ${entry.name}`)
      }
    }

    const header = recursive
      ? `📁 ${dirPath}${resolvedNote} (递归, 深度≤3)\n`
      : `📁 ${dirPath}${resolvedNote}\n`

    return {
      callId: '',
      ok: true,
      content: header + (items.join('\n') || '(空目录)'),
      durationMs: Date.now() - start,
    }
  } catch (err: any) {
    return { callId: '', ok: false, content: '', error: err.message }
  }
}
