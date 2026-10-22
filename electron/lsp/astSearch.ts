// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// lsp/astSearch.ts — AST 结构化代码搜索 (v3.5)
//
// 借鉴 QwenPaw ast_search: 用 TypeScript Compiler API 做结构化搜索
//   不要求文件能编译 — 使用宽松模式解析
//   支持: 查找函数定义、类定义、import、export、调用关系
// ============================================================

// 仅引用类型：运行时按需懒加载，避免在未打包 typescript 的环境（如 MCP 发布版）
// 于模块加载阶段直接 require 失败。
import type * as ts from 'typescript'
import * as fs from 'fs'
import * as path from 'path'

let cachedTs: typeof ts | null = null

function loadTs(): typeof ts {
  if (cachedTs) {return cachedTs}
  try {
    cachedTs = require('typescript') as typeof ts
    return cachedTs
  } catch {
    throw new Error(
      'AST 结构化搜索需要 TypeScript 编译器：开发环境已内置；在未打包 typescript 的环境（如 MCP 发布版）此能力不可用。',
    )
  }
}

export interface ASTSearchOptions {
  /** 搜索模式 */
  pattern: 'functions' | 'classes' | 'imports' | 'exports' | 'calls' | 'all_symbols'
  /** 按名称过滤 (支持通配符 *) */
  nameFilter?: string
  /** 最大结果数 */
  maxResults?: number
  /** 是否包含位置信息 */
  includePosition?: boolean
}

export interface ASTSymbol {
  name: string
  kind: string
  file: string
  line: number
  column: number
  /** 附加信息 (如函数参数、类继承) */
  detail?: string
}

/**
 * 使用 TypeScript Compiler API 做 AST 搜索
 * 不要求完整项目配置 — 单文件即可
 */
export function astSearch(
  filePath: string,
  options: ASTSearchOptions = { pattern: 'all_symbols' },
): ASTSymbol[] {
  const ts = loadTs()
  const absPath = path.resolve(filePath)
  if (!fs.existsSync(absPath)) {
    throw new Error(`文件不存在: ${absPath}`)
  }

  const sourceText = fs.readFileSync(absPath, 'utf-8')
  const sourceFile = ts.createSourceFile(
    absPath,
    sourceText,
    ts.ScriptTarget.Latest,
    true, // setParentNodes
    absPath.endsWith('.tsx') || absPath.endsWith('.jsx')
      ? ts.ScriptKind.TSX
      : ts.ScriptKind.TS,
  )

  const results: ASTSymbol[] = []
  const maxResults = options.maxResults || 50

  function getLineCol(node: ts.Node): { line: number; column: number } {
    const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
    return { line: pos.line + 1, column: pos.character + 1 }
  }

  function addResult(name: string, kind: string, node: ts.Node, detail?: string) {
    if (results.length >= maxResults) {return}
    if (options.nameFilter && !matchFilter(name, options.nameFilter)) {return}

    const { line, column } = getLineCol(node)
    results.push({
      name,
      kind,
      file: `${path.basename(absPath)}:${line}:${column}`,
      line,
      column,
      detail,
    })
  }

  function visit(node: ts.Node) {
    // 函数/方法定义
    if (options.pattern === 'all_symbols' || options.pattern === 'functions') {
      if (ts.isFunctionDeclaration(node) && node.name) {
        const params = node.parameters.map(p => p.name.getText(sourceFile)).join(', ')
        addResult(node.name.text, 'function', node, `(${params})`)
      }
      if (ts.isMethodDeclaration(node) && node.name) {
        const name = ts.isIdentifier(node.name) ? node.name.text : '[computed]'
        const params = node.parameters.map(p => p.name.getText(sourceFile)).join(', ')
        addResult(name, 'method', node, `(${params})`)
      }
      if (ts.isArrowFunction(node) && node.parent) {
        if (ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) {
          addResult(node.parent.name.text, 'arrow_function', node)
        }
      }
    }

    // 类定义
    if (options.pattern === 'all_symbols' || options.pattern === 'classes') {
      if (ts.isClassDeclaration(node) && node.name) {
        const heritage = node.heritageClauses?.map(h =>
          h.types.map(t => t.getText(sourceFile)).join(', ')
        ).join(' extends ') || ''
        addResult(node.name.text, 'class', node, heritage || undefined)
      }
      if (ts.isInterfaceDeclaration(node) && node.name) {
        addResult(node.name.text, 'interface', node)
      }
    }

    // Import
    if (options.pattern === 'all_symbols' || options.pattern === 'imports') {
      if (ts.isImportDeclaration(node)) {
        const moduleSpec = node.moduleSpecifier.getText(sourceFile).replace(/['"]/g, '')
        if (node.importClause?.name) {
          addResult(node.importClause.name.text, 'default_import', node, `from ${moduleSpec}`)
        }
        if (node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
          for (const el of node.importClause.namedBindings.elements) {
            addResult(el.name.text, 'named_import', el, `from ${moduleSpec}`)
          }
        }
      }
    }

    // Export
    if (options.pattern === 'all_symbols' || options.pattern === 'exports') {
      if (ts.isExportDeclaration(node)) {
        const moduleSpec = node.moduleSpecifier?.getText(sourceFile)?.replace(/['"]/g, '') || ''
        addResult('export', 're_export', node, moduleSpec || undefined)
      }
      if (ts.isExportAssignment(node)) {
        addResult('default_export', 'default_export', node)
      }
    }

    // 调用关系
    if (options.pattern === 'calls') {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const name = node.expression.text
        if (!options.nameFilter || matchFilter(name, options.nameFilter)) {
          addResult(name, 'call', node, `${node.arguments.length} args`)
        }
      }
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return results
}

/** 通配符匹配 */
function matchFilter(name: string, filter: string): boolean {
  if (!filter || filter === '*') {return true}
  const regex = new RegExp('^' + filter.replace(/\*/g, '.*') + '$', 'i')
  return regex.test(name)
}

/** 格式化为可读输出 */
export function formatASTResults(results: ASTSymbol[]): string {
  if (results.length === 0) {return '未找到匹配的符号。'}

  const byKind: Record<string, ASTSymbol[]> = {}
  for (const r of results) {
    (byKind[r.kind] ||= []).push(r)
  }

  const lines: string[] = []
  for (const [kind, symbols] of Object.entries(byKind)) {
    lines.push(`\n### ${kind} (${symbols.length})`)
    for (const s of symbols) {
      const detail = s.detail ? ` — ${s.detail}` : ''
      lines.push(`  ${s.name} \`${s.file}\`${detail}`)
    }
  }
  return lines.join('\n')
}
