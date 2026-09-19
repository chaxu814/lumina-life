// ============================================================
// codingMode.ts — Coding Mode (v3.5)
//
// 借鉴 QwenPaw inline diff (light_context_manager):
//   使用 unified diff 格式精确显示代码变更
//   LLM 输出 diff block → 解析 → 自动应用到文件
//
// 格式:
//   ```diff
//   --- a/path/to/file.ts
//   +++ b/path/to/file.ts
//   @@ -5,7 +5,8 @@
//    old line
//   -removed line
//   +added line
//   ```
// ============================================================

import * as fs from 'fs'
import * as path from 'path'

export interface DiffBlock {
  filePath: string
  hunks: string[]
  raw: string
}

export interface ApplyResult {
  success: boolean
  filePath: string
  hunksApplied: number
  error?: string
}

/**
 * 从文本中提取所有 diff block
 */
export function extractDiffBlocks(text: string): DiffBlock[] {
  const diffRegex = /```diff\s*\n([\s\S]*?)```/g
  const blocks: DiffBlock[] = []
  let match

  while ((match = diffRegex.exec(text)) !== null) {
    const raw = match[1]
    const lines = raw.split('\n')
    let filePath = ''

    for (const line of lines) {
      // --- a/path/to/file.ts
      const fromMatch = line.match(/^---\s+a\/(.+)$/)
      if (fromMatch) {
        filePath = fromMatch[1]
        break
      }
      // +++ b/path/to/file.ts
      const toMatch = line.match(/^\+\+\+\s+b\/(.+)$/)
      if (toMatch && !filePath) {
        filePath = toMatch[1]
      }
    }

    if (filePath) {
      blocks.push({ filePath, hunks: lines, raw })
    }
  }

  return blocks
}

/**
 * 应用 diff block 到文件
 * 简单实现：按行号 patch
 */
export function applyDiffBlock(block: DiffBlock, baseDir: string): ApplyResult {
  const filePath = path.resolve(baseDir, block.filePath)

  if (!fs.existsSync(filePath)) {
    return { success: false, filePath: block.filePath, hunksApplied: 0, error: `文件不存在: ${block.filePath}` }
  }

  const original = fs.readFileSync(filePath, 'utf-8')
  const originalLines = original.split('\n')

  // 解析 hunks
  const hunks = parseHunks(block.hunks)
  let applied = 0

  for (const hunk of hunks) {
    try {
      applyHunk(originalLines, hunk)
      applied++
    } catch (err: any) {
      return { success: false, filePath: block.filePath, hunksApplied: applied, error: `Hunk 应用失败: ${err.message}` }
    }
  }

  // 写回
  const result = originalLines.join('\n')
  fs.writeFileSync(filePath, result, 'utf-8')

  return { success: true, filePath: block.filePath, hunksApplied: applied }
}

interface Hunk {
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  lines: HunkLine[]
}

interface HunkLine {
  type: 'context' | 'remove' | 'add'
  content: string
}

/** 解析 diff hunk 头: @@ -5,7 +5,8 @@ */
function parseHunks(lines: string[]): Hunk[] {
  const hunks: Hunk[] = []
  let currentHunk: Hunk | null = null

  for (const line of lines) {
    const hunkMatch = line.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/)
    if (hunkMatch) {
      if (currentHunk) {hunks.push(currentHunk)}
      currentHunk = {
        oldStart: parseInt(hunkMatch[1]),
        oldCount: parseInt(hunkMatch[2] || '1'),
        newStart: parseInt(hunkMatch[3]),
        newCount: parseInt(hunkMatch[4] || '1'),
        lines: [],
      }
      continue
    }

    if (currentHunk) {
      if (line.startsWith('-')) {
        currentHunk.lines.push({ type: 'remove', content: line.slice(1) })
      } else if (line.startsWith('+')) {
        currentHunk.lines.push({ type: 'add', content: line.slice(1) })
      } else if (line.startsWith(' ') || line === '') {
        currentHunk.lines.push({ type: 'context', content: line.startsWith(' ') ? line.slice(1) : '' })
      }
      // skip other lines (like \ No newline at end of file)
    }
  }

  if (currentHunk) {hunks.push(currentHunk)}
  return hunks
}

/** 将单个 hunk 应用到 lines 数组（原地修改） */
function applyHunk(lines: string[], hunk: Hunk): void {
  const lineIdx = hunk.oldStart - 1 // 0-based
  const result: string[] = []
  let consumed = 0

  // Copy lines before hunk
  result.push(...lines.slice(0, lineIdx))

  // Apply hunk
  for (const hl of hunk.lines) {
    if (hl.type === 'context') {
      result.push(hl.content)
      consumed++
    } else if (hl.type === 'remove') {
      consumed++
      // skip (removed line)
    } else if (hl.type === 'add') {
      result.push(hl.content)
    }
  }

  // Copy remaining lines after the hunk
  const afterIdx = hunk.oldStart - 1 + consumed
  result.push(...lines.slice(afterIdx))

  // Replace in place
  lines.length = 0
  lines.push(...result)
}

/**
 * 格式化 diff block 预览（供 UI 显示）
 */
export function formatDiffPreview(block: DiffBlock): string {
  const header = `📝 **${block.filePath}**`
  const info: string[] = []

  let added = 0, removed = 0
  for (const line of block.hunks) {
    if (line.startsWith('+') && !line.startsWith('+++')) {added++}
    if (line.startsWith('-') && !line.startsWith('---')) {removed++}
  }

  info.push(`${added} additions, ${removed} deletions`)

  // 格式化 hunks
  const previewLines = block.hunks
    .filter(l => l.startsWith('@@') || l.startsWith('-') || l.startsWith('+'))
    .slice(0, 20)

  return [
    header,
    `_${info.join(', ')}_`,
    '```diff',
    ...previewLines,
    '```',
  ].join('\n')
}
