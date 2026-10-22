// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// impl/fileSearch.ts — 全盘递归文件搜索 (v3.6)
//
// 让团队 Agent 能跨盘搜索文件，支持通配符和递归深度控制。
// 只读：仅返回匹配的文件路径列表，不读取内容、不修改文件。
// 内部有安全限制：跳过系统保护目录、限制最大结果数。
// ============================================================

import * as fs from 'fs'
import * as path from 'path'
import * as child_process from 'child_process'
import type { ToolDef, ToolResult } from '../types'

export const fileSearchDef: ToolDef = {
  name: 'file_search',
  description:
    '全局递归搜索文件。支持按文件名模式（通配符）、扩展名搜索。' +
    '可以跨所有硬盘驱动器搜索。适合找 .exe 文件、项目文件、文档等。' +
    '纯只读操作 — 只返回文件路径列表，不读取内容。',
  params: {
    pattern: {
      type: 'string',
      description: '文件名或通配符模式。例如："*.exe"、"Lumina*"、"package.json"',
      required: true,
    },
    rootDir: {
      type: 'string',
      description:
        '搜索起始目录。**省略时只搜「当前项目目录 + 沙箱目录」**（快，推荐）。' +
        '支持盘符如 D:\\ 或具体路径 D:\\Games\\，' +
        '或填 "all_drives" 扫全盘。' +
        '⚠️ 全盘搜索实测要 30-60 秒（光扫完 C 盘就 60s+），请尽量指定具体目录。',
      required: false,
    },
    maxDepth: {
      type: 'number',
      description: '最大递归深度（默认 8，防止无限深入）。设为 99 表示不限制。',
      required: false,
    },
    maxResults: {
      type: 'number',
      description: '最大返回结果数（默认 50，最大 200）',
      required: false,
    },
    count: {
      type: 'boolean',
      description: '只统计匹配总数（不返回路径列表）。适合"有多少个 .ts 文件"这类计数问题，' +
        '返回**精确数量、不截断**，避免把多次搜索结果相加导致虚高。',
      required: false,
    },
    includeHidden: {
      type: 'boolean',
      description: '是否包含隐藏文件和目录（默认 false）',
      required: false,
    },
    type: {
      type: 'string',
      description: '只搜索特定类型：file（文件）、dir（目录）、all（全部），默认 file',
      required: false,
    },
  },
  toolsets: ['agent', 'files'],
}

// ═══════════════════════════════════════════════════════════
// 安全：跳过的系统/敏感目录
// ═══════════════════════════════════════════════════════════

const SKIP_DIRS = new Set([
  'C:\\Windows',
  'C:\\Windows\\System32',
  'C:\\Windows\\SysWOW64',
  'C:\\ProgramData\\Microsoft',
  'C:\\$Recycle.Bin',
  'C:\\System Volume Information',
  'C:\\Recovery',
  'C:\\MSOCache',
  'C:\\Config.Msi',
])

const SKIP_PREFIXES = [
  'C:\\Windows\\',
  'C:\\ProgramData\\Microsoft\\',
  'C:\\$Recycle.Bin\\',
  'C:\\System Volume Information\\',
  'C:\\Recovery\\',
]

/** v3.34: 沙箱根目录（写入重定向发生的地方）。
 *  用户刚让 agent 写出的文件都落在这里，所以默认搜索必须包含它 ——
 *  否则用户说「找一下刚生成的那个文件」会搜不到。 */
function sandboxRoot(): string | null {
  try {
    const { app } = require('electron')
    return path.join(app.getPath('userData'), 'sandbox')
  } catch { return null }
}

function isSkippableDir(dirPath: string): boolean {
  const normalized = path.normalize(dirPath).toUpperCase()
  if (SKIP_DIRS.has(normalized)) {return true}
  for (const prefix of SKIP_PREFIXES) {
    if (normalized.startsWith(prefix.toUpperCase())) {return true}
  }
  return false
}

// ═══════════════════════════════════════════════════════════
// 核心搜索
// ═══════════════════════════════════════════════════════════

interface SearchResult {
  fullPath: string
  name: string
  isDirectory: boolean
  sizeBytes: number
}

// 异步 exec 封装
function execAsync(cmd: string, opts: child_process.ExecOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    child_process.exec(cmd, {
      timeout: 60000,
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
      ...opts,
    }, (error, stdout) => {
      if (error) {reject(error)}
      else {resolve(stdout as string)}
    })
  })
}

/**
 * 优先用 PowerShell 的 Get-ChildItem -Recurse，比 Node.js 遍历快 10x+
 * 降级到 Node.js 纯遍历
 */
async function searchWithPowerShell(
  rootDir: string,
  filePattern: string,
  maxResults: number,
  includeHidden: boolean,
  searchType: string
): Promise<SearchResult[]> {
  const results: SearchResult[] = []
  try {
    const hiddenFlag = includeHidden ? '-Force' : ''
    const dirFilter = searchType === 'dir'
      ? '-Directory'
      : searchType === 'file'
        ? '-File'
        : ''

    const escapedRoot = rootDir.replace(/'/g, "''")
    const escapedPattern = filePattern.replace(/'/g, "''")

    // 用 PowerShell 做递归搜索，限制深度用 -Depth
    const psCmd = `Get-ChildItem -Path '${escapedRoot}' -Filter '${escapedPattern}' -Recurse ${dirFilter} -ErrorAction SilentlyContinue ${hiddenFlag} | Select-Object -First ${maxResults} FullName, Name, Length, PSIsContainer | ConvertTo-Csv -NoTypeInformation`

    const output = await execAsync(
      `powershell -NoProfile -Command "${psCmd.replace(/"/g, '\\"')}"`,
      { timeout: 60000, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }
    )

    const lines = output.split('\n').filter(l => l.trim())
    if (lines.length < 2) {return results} // 只有 header 或空

    const header = lines[0]
    const headerCols = header.split(',')

    // 找到各列索引
    const fullNameIdx = headerCols.findIndex(c => c.includes('FullName'))
    const nameIdx = headerCols.findIndex(c => c.includes('"Name"'))
    const lengthIdx = headerCols.findIndex(c => c.includes('"Length"'))
    const containerIdx = headerCols.findIndex(c => c.includes('PSIsContainer'))

    for (let i = 1; i < lines.length && results.length < maxResults; i++) {
      const cols = lines[i].split(',')
      const fullPath = cols[fullNameIdx]?.replace(/^"|"$/g, '')
      if (!fullPath) {continue}

      const normalizedPath = path.normalize(fullPath)

      // 跳过系统保护目录
      if (isSkippableDir(normalizedPath)) {continue}

      // 跳过隐藏目录（node_modules, .git 等）
      if (!includeHidden && isNodeInternal(normalizedPath)) {continue}

      const isDir = cols[containerIdx]?.includes('True') || false
      const size = parseInt(cols[lengthIdx]?.replace(/^"|"$/g, '') || '0') || 0

      results.push({
        fullPath: normalizedPath,
        name: cols[nameIdx]?.replace(/^"|"$/g, '') || path.basename(normalizedPath),
        isDirectory: isDir,
        sizeBytes: size,
      })
    }
  } catch {
    // PowerShell 失败，降级到 Node.js
    return []
  }
  return results
}

function isNodeInternal(filePath: string): boolean {
  const parts = filePath.split(path.sep)
  for (const p of parts) {
    if (p === 'node_modules' || p === '.git' || p === '__pycache__' || p === '.venv') {return true}
  }
  return false
}

/** Node.js 纯遍历降级 (v3.6: async) */
async function searchWithNodeJs(
  rootDir: string,
  filePattern: string,
  maxDepth: number,
  maxResults: number,
  includeHidden: boolean,
  searchType: string
): Promise<SearchResult[]> {
  const results: SearchResult[] = []

  function matchesPattern(name: string): boolean {
    // 简单通配符匹配
    const regex = new RegExp(
      '^' + filePattern.replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.') + '$',
      'i'
    )
    return regex.test(name)
  }

  async function walk(dir: string, depth: number) {
    if (results.length >= maxResults || depth > maxDepth) {return}
    if (isSkippableDir(dir)) {return}

    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true })
    } catch {
      return // 权限不足，跳过
    }

    for (const entry of entries) {
      if (results.length >= maxResults) {break}

      // 隐藏文件过滤
      if (!includeHidden && entry.name.startsWith('.')) {continue}

      const fullPath = path.join(dir, entry.name)

      if (entry.isDirectory()) {
        if (!includeHidden && isNodeInternal(fullPath)) {continue}

        if (searchType === 'all' || searchType === 'dir') {
          if (matchesPattern(entry.name)) {
            results.push({
              fullPath,
              name: entry.name,
              isDirectory: true,
              sizeBytes: 0,
            })
          }
        }
        // 递归
        if (depth < maxDepth && !isSkippableDir(fullPath)) {
          await walk(fullPath, depth + 1)
        }
      } else if (entry.isFile()) {
        if (searchType === 'all' || searchType === 'file') {
          if (matchesPattern(entry.name)) {
            let size = 0
            try { const s = await fs.promises.stat(fullPath); size = s.size } catch {}
            results.push({
              fullPath,
              name: entry.name,
              isDirectory: false,
              sizeBytes: size,
            })
          }
        }
      }
    }
  }

  await walk(rootDir, 0)
  return results
}

/**
 * 精确计数匹配项（不返回路径列表）。用于 `count:true` 模式，给"有多少个"类
 * 问题一个不受 maxResults 截断的准确数字，避免模型把多次搜索结果相加虚高。
 * 以 cap 为上限保护性能；达到 cap 则返回 capped=true（"超过 N 个"）。
 */
async function countMatches(
  rootDir: string,
  filePattern: string,
  maxDepth: number,
  includeHidden: boolean,
  searchType: string,
  cap: number,
): Promise<{ count: number; capped: boolean }> {
  let count = 0
  let capped = false

  const regex = new RegExp(
    '^' + filePattern.replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.') + '$',
    'i'
  )
  const matchesPattern = (name: string) => regex.test(name)

  async function walk(dir: string, depth: number) {
    if (capped || depth > maxDepth) {return}
    if (isSkippableDir(dir)) {return}
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true })
    } catch { return }
    for (const entry of entries) {
      if (capped) {break}
      if (!includeHidden && entry.name.startsWith('.')) {continue}
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!includeHidden && isNodeInternal(fullPath)) {continue}
        if (searchType === 'all' || searchType === 'dir') {
          if (matchesPattern(entry.name)) {
            count++
            if (count >= cap) {capped = true; break}
          }
        }
        if (depth < maxDepth && !isSkippableDir(fullPath)) {await walk(fullPath, depth + 1)}
      } else if (entry.isFile()) {
        if (searchType === 'all' || searchType === 'file') {
          if (matchesPattern(entry.name)) {
            count++
            if (count >= cap) {capped = true; break}
          }
        }
      }
    }
  }

  await walk(rootDir, 0)
  return { count, capped }
}

// ═══════════════════════════════════════════════════════════
// 获取所有本地硬盘根目录
// ═══════════════════════════════════════════════════════════

async function getAllDriveRoots(): Promise<string[]> {
  const roots: string[] = []
  try {
    const output = await execAsync(
      'wmic logicaldisk where "DriveType=3" get DeviceID /format:csv',
      { timeout: 5000, encoding: 'utf-8' }
    )
    for (const line of output.split('\n')) {
      const cols = line.split(',')
      if (cols.length >= 2) {
        const id = cols[1]?.trim()
        if (id && id.match(/^[A-Z]:$/)) {
          roots.push(id + '\\')
        }
      }
    }
  } catch {
    // 降级
    for (let code = 65; code <= 90; code++) {
      const root = `${String.fromCharCode(code)}:\\`
      try {
        const st = await fs.promises.stat(root)
        if (st.isDirectory()) {roots.push(root)}
      } catch {}
    }
  }
  return roots
}

// ═══════════════════════════════════════════════════════════
// 导出执行函数
// ═══════════════════════════════════════════════════════════

export async function fileSearch(args: Record<string, any>): Promise<ToolResult> {
  const pattern: string = args.pattern || '*'
  const rootDir: string = args.rootDir || ''
  const maxDepth: number = Math.min(args.maxDepth || 8, 99)
  const maxResults: number = Math.min(args.maxResults || 50, 200)
  const includeHidden: boolean = args.includeHidden === true
  const searchType: string = args.type || 'file'
  const countOnly: boolean = args.count === true
  const start = Date.now()

  try {
    const allResults: SearchResult[] = []

    // 确定搜索根目录
    // ── v3.34: 默认作用域从「全盘」改为「当前工作目录 + 沙箱」 ─────────
    //
    // 旧行为：rootDir 省略时直接 getAllDriveRoots() 逐盘扫。实测单次调用
    //   [fileSearch] C:\  1 结果, 63806ms
    //   [fileSearch] F:\  0 结果, 15049ms
    //   [fileSearch] J:\  0 结果, 16180ms
    // 用户一句「帮我找下那个文件」可能让对话卡住一分钟以上，而且大概率什么都
    // 找不到 —— 真正想要的结果通常就在项目目录里。
    //
    // 现在的行为：
    //   · 给了 rootDir        → 照旧
    //   · 省略                → 只搜「项目目录 + 沙箱目录」（用户刚放过文件的地方）
    //   · rootDir="all_drives" → 显式要求全盘（代价已在参数说明里写明）
    let searchRoots: string[]
    if (rootDir === 'all_drives' || rootDir === '*') {
      searchRoots = await getAllDriveRoots()
      if (searchRoots.length === 0) {
        return { callId: '', ok: false, content: '', error: '无法检测到任何硬盘驱动器。' }
      }
    } else if (rootDir) {
      searchRoots = [rootDir]
    } else {
      searchRoots = []
      for (const cand of [process.cwd(), sandboxRoot()]) {
        if (cand && fs.existsSync(cand) && !searchRoots.includes(cand)) searchRoots.push(cand)
      }
      if (searchRoots.length === 0) searchRoots = [process.cwd()]
    }

    // 🔢 计数模式：返回精确匹配总数（不截断），适合"有多少个"类问题
    if (countOnly) {
      const CAP = 200000
      let total = 0
      let capped = false
      for (const root of searchRoots) {
        const c = await countMatches(root, pattern, maxDepth, includeHidden, searchType, CAP - total)
        total += c.count
        if (c.capped) { capped = true; break }
      }
      const scope = rootDir ? `"${rootDir}"` : '项目目录 + 沙箱'
      const content = capped
        ? `🔢 匹配 "${pattern}" 的文件超过 ${CAP} 个（已停止统计）。请缩小搜索范围获得精确数字。`
        : `🔢 匹配 "${pattern}" 的文件共 ${total} 个（已完整统计，未截断）。\n范围: ${scope}\n用时: ${((Date.now() - start) / 1000).toFixed(1)}s`
      return { callId: '', ok: true, content, durationMs: Date.now() - start }
    }

    // 逐个盘搜索
    for (const root of searchRoots) {
      if (allResults.length >= maxResults) {break}

      const rootStart = Date.now()
      let rootResults: SearchResult[]

      // 优先 PowerShell（全盘搜索时快得多）
      if (searchType !== 'all') {
        rootResults = await searchWithPowerShell(root, pattern, maxResults - allResults.length, includeHidden, searchType)
      } else {
        rootResults = []
      }

      // 降级到 Node.js
      if (rootResults.length === 0) {
        rootResults = await searchWithNodeJs(
          root, pattern, maxDepth,
          maxResults - allResults.length, includeHidden, searchType
        )
      }

      allResults.push(...rootResults)

      console.log(
        `[fileSearch] ${root}: ${rootResults.length} 结果, ${Date.now() - rootStart}ms`
      )
    }

    // 格式化输出
    if (allResults.length === 0) {
      const scope = rootDir ? `"${rootDir}"` : '所有本地硬盘'
      return {
        callId: '',
        ok: true,
        content: `在 ${scope} 中未找到匹配 "${pattern}" 的文件。\n💡 提示：尝试调整搜索模式或指定 rootDir。`,
        durationMs: Date.now() - start,
      }
    }

    const lines: string[] = [
      `🔍 搜索 "${pattern}" — 找到 ${allResults.length} 个结果：\n`,
    ]

    // 按盘符分组
    const grouped = new Map<string, SearchResult[]>()
    for (const r of allResults) {
      const drive = r.fullPath.substring(0, 2)
      if (!grouped.has(drive)) {grouped.set(drive, [])}
      grouped.get(drive)!.push(r)
    }

    for (const [drive, items] of grouped) {
      lines.push(`📀 ${drive}:`)
      for (const item of items) {
        const icon = item.isDirectory ? '📁' : '📄'
        const sizeStr = item.sizeBytes > 0
          ? ` (${formatSize(item.sizeBytes)})`
          : ''
        lines.push(`  ${icon} ${item.fullPath}${sizeStr}`)
      }
    }

    if (allResults.length >= maxResults) {
      lines.push(`\n⚠️ 结果已截断（上限 ${maxResults} 条）。请缩小搜索范围获得更精确的结果。`)
    }

    lines.push(`\n用时: ${((Date.now() - start) / 1000).toFixed(1)}s`)

    return {
      callId: '',
      ok: true,
      content: lines.join('\n'),
      durationMs: Date.now() - start,
    }
  } catch (err: any) {
    return { callId: '', ok: false, content: '', error: err.message }
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) {return `${bytes}B`}
  if (bytes < 1024 * 1024) {return `${(bytes / 1024).toFixed(1)}KB`}
  if (bytes < 1024 * 1024 * 1024) {return `${(bytes / 1024 / 1024).toFixed(1)}MB`}
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)}GB`
}
