// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
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
// 「没做成」的统一口径（与 tools/registry.ts 的 buildNotExecutedResult 对齐）
//
// 为什么不 import registry 里那个函数：registry.ts 在主进程侧加载整张
//   工具表，工具实现再反向 import 它会形成 registry ↔ impl 循环依赖。
//   所以各文件各写一份本地小函数，用同一套文案保证行为一致。
//
// 为什么失败必须 ok:false：agentRunner 只在 ok:true 时把 content 原样回灌
//   给模型（ok:false 时回灌 `工具错误: ${error}`）。返回 ok:true 的失败
//   会以「这就是查询结果」的形状进上下文，模型会把「没搜到」当成事实，
//   比如据此断言「这个符号只在这一处定义」—— 编造就是这么来的。
//
// 边界口径：**确实搜过、确实 0 条命中**属于成功的查询，保持 ok:true，
//   只在 content 里写明「查询成功，0 条结果」。
// ═══════════════════════════════════════════════════════════
const NOT_EXECUTED_GUIDANCE =
  '禁止据此作答，也禁止把这段内容当作事实依据继续推理；请改用可用工具重试，或直接告诉用户你做不到以及原因。'

function notExecuted(callId: string, toolName: string, reason: string, detail: string): ToolResult {
  return {
    callId,
    ok: false,
    content: `⛔ 未执行成功（${toolName}，原因：${reason}）。以下是失败说明，不是结果。${NOT_EXECUTED_GUIDANCE}${detail ? `\n\n${detail}` : ''}`,
    error: `未执行成功（${toolName}，原因：${reason}）。${NOT_EXECUTED_GUIDANCE}${detail ? ` 实际错误/原始输出：${detail}` : ''}`,
  }
}

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
  toolsets: ['code', 'lsp', 'agent', 'developer'],
}

export async function astSearchHandler(args: Record<string, unknown>): Promise<ToolResult> {
  const filePath = args.file as string
  const pattern = (args.pattern as ASTSearchOptions['pattern']) || 'all_symbols'
  const nameFilter = args.name as string | undefined
  const maxResults = (args.max_results as number) || 50
  const callId = args._callId as string || 'ast_search'

  if (!filePath) {
    return notExecuted(callId, 'ast_search', '缺少参数 file（文件路径）', '请提供 file 参数。')
  }

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
  toolsets: ['code', 'lsp', 'agent', 'developer'],
}

export async function lspSymbolsHandler(args: Record<string, unknown>): Promise<ToolResult> {
  const filePath = args.file as string
  const callId = args._callId as string || 'lsp_symbols'

  if (!filePath) {
    return notExecuted(callId, 'lsp_symbols', '缺少参数 file（文件路径）', '请提供 file 参数。')
  }

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
  toolsets: ['code', 'lsp', 'agent', 'developer'],
}

export async function lspReferencesHandler(args: Record<string, unknown>): Promise<ToolResult> {
  const symbol = args.symbol as string
  const dir = (args.dir as string) || process.cwd()
  const filePattern = (args.file_pattern as string) || '*.ts'
  const maxResults = (args.max_results as number) || 100
  const callId = args._callId as string || 'lsp_references'

  if (!symbol) {
    return notExecuted(callId, 'lsp_references', '缺少参数 symbol（符号名）', '请提供 symbol 参数。')
  }

  // 提到 try 外：catch 里要把真实命令串透出来，作用域必须够到
  let cmd = ''

  try {
    // 用 grep 搜索符号引用 (LSP 降级方案)
    const { execSync } = require('child_process')

    // 构建 grep 命令
    const escapedSymbol = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

    if (process.platform === 'win32') {
      // Windows: 使用 findstr (有限支持)
      const results: string[] = []
      const files = walkDir(dir, filePattern)
      for (const file of files.slice(0, 500)) {
        try {
          const content = fs.readFileSync(file, 'utf-8')
          const lines = content.split('\n')
          for (let i = 0; i < lines.length; i++) {
            if (results.length >= maxResults) {break}
            if (lines[i].includes(symbol)) {
              results.push(`${file}:${i + 1}: ${lines[i].trim()}`)
            }
          }
        } catch { /* skip binary/non-readable */ }
        if (results.length >= maxResults) {break}
      }
      const scanned = files.slice(0, 500)
      if (scanned.length === 0) {
        // 一个文件都没扫到 ≠ 「搜过但没有引用」：这是目录/文件通配写错，
        // 必须显式失败，否则模型会把「没搜」当成「不存在」。
        return notExecuted(
          callId, 'lsp_references',
          `在目录 "${dir}" 下没有匹配 "${filePattern}" 的文件，本次实际没有搜索任何内容`,
          `搜索目录: ${dir}\n文件匹配模式: ${filePattern}\n请确认目录是否存在、通配符是否写对（例如 "*.ts,*.tsx"）。`,
        )
      }
      return {
        callId, ok: true,
        content: results.length > 0
          ? `找到 ${results.length} 个引用:\n${results.join('\n')}`
          : `✅ 查询成功，0 条结果：已搜索 ${scanned.length} 个 ${filePattern} 文件，未找到 "${symbol}" 的引用。这是「搜过了、没有」，不代表该符号未被使用。`,
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
          : `✅ 查询成功，0 条结果：已搜索 "${dir}" 下的 ${filePattern} 文件，未找到 "${symbol}" 的引用。这是「搜过了、没有」，不代表该符号未被使用。`,
      }
    }
  } catch (err: any) {
    // 🔴 原来这里把任何 "Command failed" / 有 stderr 的异常一律吞成
    //    「未找到 xxx 的引用」并返回 ok:true —— 目录不存在、grep 不存在、
    //    权限被拒、超时，全都伪装成「搜过了，没有」。
    //    现在把真实 stderr/stdout/状态码原样透出来，并显式失败。
    const stderr = String(err.stderr ?? '').trim()
    const stdout = String(err.stdout ?? '').trim()
    const exitCode = err.status ?? err.code ?? '未知'
    const detail = [
      `命令: ${cmd || '(未构造)'}`,
      `退出码: ${exitCode}`,
      stderr ? `stderr: ${stderr}` : 'stderr: (空)',
      stdout ? `stdout: ${stdout.slice(0, 500)}` : 'stdout: (空)',
      `原始错误: ${err.message || String(err)}`,
    ].join('\n')
    return notExecuted(callId, 'lsp_references', `引用搜索命令执行失败，未搜索到任何内容`, detail)
  }
}

// ═══════════════════════════════════════════════════════════
// 内部辅助
// ═══════════════════════════════════════════════════════════

function walkDir(dir: string, pattern: string): string[] {
  const results: string[] = []
  const ext = pattern.replace('*', '') // "*.ts" → ".ts"

  function walk(current: string) {
    if (results.length >= 500) {return}
    try {
      const entries = fs.readdirSync(current, { withFileTypes: true })
      for (const entry of entries) {
        if (results.length >= 500) {return}
        const fullPath = path.join(current, entry.name)
        // Skip node_modules, .git
        if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') {continue}
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
