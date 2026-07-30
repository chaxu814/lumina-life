// ============================================================
// tools/impl/lsp.ts — LSP + AST 代码智能工具 (v3.5)
//
// 借鉴 QwenPaw lsp_tool + ast_search:
//   ast_search — TypeScript Compiler API 结构化搜索
//   lsp_symbols — 文件符号列表
//   lsp_references — 查找引用 (grep 降级)
// ============================================================

import type { ToolDef, ToolResult } from '../types'
import { astSearch, formatASTResults, type ASTSearchOptions } from '../../lsp/astSearch'
import * as path from 'path'
import * as fs from 'fs'

// ═══════════════════════════════════════════════════════════
// ast_search
// ═══════════════════════════════════════════════════════════

export const astSearchDef: ToolDef = {
  name: 'ast_search',
  description:
    '使用 TypeScript 编译器 API 结构化搜索代码符号。\n' +
    '支持模式: functions, classes, imports, exports, calls, all_symbols\n' +
    '比 grep 更精确 — 识别代码结构而非文本匹配。\n' +
    '支持 .ts, .tsx, .js, .jsx 文件。',
  params: {
    file: { type: 'string', description: '要搜索的文件路径', required: true },
    pattern: {
      type: 'string',
      description: '搜索模式: functions|classes|imports|exports|calls|all_symbols',
      required: false,
    },
    name: { type: 'string', description: '按名称过滤 (支持 * 通配符)', required: false },
    max_results: { type: 'number', description: '最大结果数 (默认 50)', required: false },
  },
  toolsets: ['code', 'lsp'],
}

export async function astSearchHandler(args: Record<string, unknown>): Promise<ToolResult> {
  const filePath = args.file as string
  const pattern = (args.pattern as ASTSearchOptions['pattern']) || 'all_symbols'
  const nameFilter = args.name as string | undefined
  const maxResults = (args.max_results as number) || 50
  const callId = args._callId as string || 'ast_search'

  if (!filePath) return { callId, ok: false, content: '缺少参数: file (文件路径)' }

  try {
    const results = astSearch(filePath, { pattern, nameFilter, maxResults })
    return { callId, ok: true, content: formatASTResults(results) }
  } catch (err: any) {
    return { callId, ok: false, content: '', error: `AST 搜索失败: ${err.message}` }
  }
}

// ═══════════════════════════════════════════════════════════
// lsp_symbols — 列出文件内所有符号
// ═══════════════════════════════════════════════════════════

export const lspSymbolsDef: ToolDef = {
  name: 'lsp_symbols',
  description:
    '列出文件内所有顶层符号（函数、类、接口、导出等）。\n' +
    '支持 .ts, .tsx, .js, .jsx 文件。',
  params: {
    file: { type: 'string', description: '文件路径', required: true },
  },
  toolsets: ['code', 'lsp'],
}

export async function lspSymbolsHandler(args: Record<string, unknown>): Promise<ToolResult> {
  const filePath = args.file as string
  const callId = args._callId as string || 'lsp_symbols'

  if (!filePath) return { callId, ok: false, content: '缺少参数: file (文件路径)' }

  try {
    const results = astSearch(filePath, { pattern: 'all_symbols', maxResults: 200 })
    return { callId, ok: true, content: formatASTResults(results) }
  } catch (err: any) {
    return { callId, ok: false, content: '', error: `符号搜索失败: ${err.message}` }
  }
}

// ═══════════════════════════════════════════════════════════
// lsp_references — 查找引用 (grep 降级)
// ═══════════════════════════════════════════════════════════

export const lspReferencesDef: ToolDef = {
  name: 'lsp_references',
  description:
    '在项目中搜索某个符号的所有引用位置。\n' +
    '使用 grep 文本搜索作为降级方案（当 LSP 不可用时）。\n' +
    '支持正则表达式搜索。',
  params: {
    symbol: { type: 'string', description: '要搜索的符号名或正则表达式', required: true },
    dir: { type: 'string', description: '搜索目录 (默认项目根)', required: false },
    file_pattern: { type: 'string', description: '文件匹配模式 (默认 "*.ts,*.tsx,*.js")', required: false },
    max_results: { type: 'number', description: '最大结果数 (默认 100)', required: false },
  },
  toolsets: ['code', 'lsp'],
}

export async function lspReferencesHandler(args: Record<string, unknown>): Promise<ToolResult> {
  const symbol = args.symbol as string
  const dir = (args.dir as string) || process.cwd()
  const filePattern = (args.file_pattern as string) || '*.ts'
  const maxResults = (args.max_results as number) || 100
  const callId = args._callId as string || 'lsp_references'

  if (!symbol) return { callId, ok: false, content: '缺少参数: symbol (符号名)' }

  try {
    // 用 grep 搜索符号引用 (LSP 降级方案)
    const { execSync } = require('child_process')

    // 构建 grep 命令
    const escapedSymbol = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    let cmd: string

    if (process.platform === 'win32') {
      // Windows: 使用 findstr (有限支持)
      const results: string[] = []
      const files = walkDir(dir, filePattern)
      for (const file of files.slice(0, 500)) {
        try {
          const content = fs.readFileSync(file, 'utf-8')
          const lines = content.split('\n')
          for (let i = 0; i < lines.length; i++) {
            if (results.length >= maxResults) break
            if (lines[i].includes(symbol)) {
              results.push(`${file}:${i + 1}: ${lines[i].trim()}`)
            }
          }
        } catch { /* skip binary/non-readable */ }
        if (results.length >= maxResults) break
      }
      return {
        callId, ok: true,
        content: results.length > 0
          ? `找到 ${results.length} 个引用:\n${results.join('\n')}`
          : `未找到 "${symbol}" 的引用（搜索了 ${files.slice(0, 500).length} 个 ${filePattern} 文件）`,
      }
    } else {
      // Unix: 使用 grep -rn
      cmd = `grep -rn --include="${filePattern}" "${escapedSymbol}" "${dir}" | head -n ${maxResults}`
      const output = execSync(cmd, { encoding: 'utf-8', timeout: 10_000, cwd: dir })
      const lines = output.trim().split('\n').filter(Boolean)
      return {
        callId, ok: true,
        content: lines.length > 0
          ? `找到 ${lines.length} 个引用:\n${lines.join('\n')}`
          : `未找到 "${symbol}" 的引用`,
      }
    }
  } catch (err: any) {
    if (err.message?.includes('Command failed') || err.stderr) {
      // No matches found
      return { callId, ok: true, content: `未找到 "${symbol}" 的引用` }
    }
    return { callId, ok: false, content: '', error: `引用搜索失败: ${err.message}` }
  }
}

// ═══════════════════════════════════════════════════════════
// 内部辅助
// ═══════════════════════════════════════════════════════════

function walkDir(dir: string, pattern: string): string[] {
  const results: string[] = []
  const ext = pattern.replace('*', '') // "*.ts" → ".ts"

  function walk(current: string) {
    if (results.length >= 500) return
    try {
      const entries = fs.readdirSync(current, { withFileTypes: true })
      for (const entry of entries) {
        if (results.length >= 500) return
        const fullPath = path.join(current, entry.name)
        // Skip node_modules, .git
        if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue
        if (entry.isDirectory()) {
          walk(fullPath)
        } else if (entry.isFile()) {
          if (pattern !== '*.ts' ? entry.name.includes(ext) : entry.name.endsWith(ext)) {
            results.push(fullPath)
          }
        }
      }
    } catch { /* skip permission errors */ }
  }

  walk(dir)
  return results
}
