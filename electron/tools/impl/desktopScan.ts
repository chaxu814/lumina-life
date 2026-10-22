// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// impl/desktopScan.ts — 桌面快捷扫描 + 智能启动 (v3.6)
//
// 解决团队 Agent "看不到桌面程序" 的核心问题：
//   1. 扫描用户桌面上的所有 .exe / .lnk / .url
//   2. 自动解析快捷方式的目标路径
//   3. 返回 Markdown 格式的程序清单，Agent 可直接用 open_file 启动
//   4. 支持模糊匹配：用户说"打开那个游戏"，Agent 扫桌面后自动匹配
//
// 仅读取列表 + 解析 .lnk 目标 → 不修改任何文件
// 实际启动需通过 open_file / shell_exec → 进入审批流
// ============================================================

import fs from 'fs'
import path from 'path'
import os from 'os'
import { execFile } from 'child_process'
import type { ToolDef, ToolResult } from '../types'

export const desktopScanDef: ToolDef = {
  name: 'desktop_scan',
  description:
    '扫描用户桌面，列出所有可执行程序（.exe）、快捷方式（.lnk）和网址链接（.url）。\n' +
    '自动解析快捷方式的目标路径。\n' +
    '用户的 Desktop 以及 Public Desktop 都会扫描。\n' +
    '当用户说"打开桌面上的XX"但你不确定桌面有什么时，先调用此工具。\n' +
    '纯只读操作 — 只返回列表，不启动任何程序。',
  params: {
    filter: {
      type: 'string',
      description: '按名称过滤，支持部分匹配。例如："游戏"、"Chrome"、"VSCode"',
      required: false,
    },
    includePublic: {
      type: 'boolean',
      description: '是否包含公共桌面（默认 true）',
      required: false,
    },
    maxResults: {
      type: 'number',
      description: '最大返回条目数（默认 30）',
      required: false,
    },
  },
  toolsets: ['agent', 'computer_use'],
}

// ═══════════════════════════════════════════════════════════
// 快捷方式 (.lnk) 解析 — 用 PowerShell COM 对象
// ═══════════════════════════════════════════════════════════

/** 批量解析 .lnk 文件目标路径 */
function resolveShortcutTargets(lnkPaths: string[]): Promise<Map<string, string>> {
  return new Promise((resolve) => {
    if (lnkPaths.length === 0) { resolve(new Map()); return }

    const results = new Map<string, string>()

    // 用 PowerShell WScript.Shell COM 对象批量解析
    const psScript = `
$shell = New-Object -ComObject WScript.Shell
$paths = @(
${lnkPaths.map(p => `  '${p.replace(/'/g, "''")}'`).join(',\n')}
)
foreach ($p in $paths) {
  try {
    $lnk = $shell.CreateShortcut($p)
    $target = $lnk.TargetPath
    Write-Host "$([System.IO.Path]::GetFileName($p))|$target|$($lnk.Arguments)|$($lnk.WorkingDirectory)"
  } catch {
    Write-Host "$([System.IO.Path]::GetFileName($p))|ERROR|"
  }
}
`

    const b64 = Buffer.from(psScript, 'utf16le').toString('base64')
    execFile('powershell', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-EncodedCommand', b64,
    ], { timeout: 10000, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err || !stdout) { resolve(new Map()); return }

      for (const line of String(stdout).trim().split('\n')) {
        const parts = line.split('|')
        if (parts.length >= 2 && parts[1] !== 'ERROR') {
          results.set(parts[0].trim(), parts[1].trim())
        }
      }
      resolve(results)
    })
  })
}

// ═══════════════════════════════════════════════════════════
// .url 文件解析
// ═══════════════════════════════════════════════════════════

async function parseUrlFile(filePath: string): Promise<string | null> {
  try {
    const content = await fs.promises.readFile(filePath, 'utf-8')
    const match = content.match(/^URL\s*=\s*(.+)$/im)
    return match ? match[1].trim() : null
  } catch {
    return null
  }
}

// ═══════════════════════════════════════════════════════════
// 桌面条目定义
// ═══════════════════════════════════════════════════════════

interface DesktopEntry {
  name: string
  displayName: string   // 去掉扩展名的友好名称
  fullPath: string
  type: 'exe' | 'lnk' | 'url' | 'dir'
  /** .lnk 的目标路径或 .url 的网址 */
  target?: string
  /** 来自哪个桌面 */
  source: 'user' | 'public'
  sizeBytes: number
}

// ═══════════════════════════════════════════════════════════
// 核心扫描
// ═══════════════════════════════════════════════════════════

async function scanDesktop(
  desktopDir: string,
  source: 'user' | 'public',
  maxResults: number,
  allEntries: DesktopEntry[],
): Promise<void> {
  if (allEntries.length >= maxResults) {return}

  let entries: fs.Dirent[]
  try {
    entries = await fs.promises.readdir(desktopDir, { withFileTypes: true })
  } catch {
    return // 桌面不存在或无法访问
  }

  const lnkFiles: string[] = []

  for (const entry of entries) {
    if (allEntries.length >= maxResults) {break}

    // 跳过隐藏文件和系统文件
    if (entry.name.startsWith('.') || entry.name.startsWith('~')) {continue}
    if (entry.name === 'desktop.ini') {continue}

    const fullPath = path.join(desktopDir, entry.name)

    if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase()
      let size = 0
      try { const s = await fs.promises.stat(fullPath); size = s.size } catch {}

      if (ext === '.exe') {
        allEntries.push({
          name: entry.name,
          displayName: entry.name.replace('.exe', ''),
          fullPath,
          type: 'exe',
          source,
          sizeBytes: size,
        })
      } else if (ext === '.lnk') {
        lnkFiles.push(fullPath)
      } else if (ext === '.url') {
        const urlTarget = await parseUrlFile(fullPath)
        allEntries.push({
          name: entry.name,
          displayName: entry.name.replace('.url', ''),
          fullPath,
          type: 'url',
          target: urlTarget || undefined,
          source,
          sizeBytes: size,
        })
      }
    } else if (entry.isDirectory() && !entry.name.startsWith('.')) {
      // 检查目录里是否有 .exe（某些程序以文件夹形式存在）
      try {
        const subs = await fs.promises.readdir(fullPath, { withFileTypes: true })
        const hasExe = subs.some(s => s.isFile() && s.name.toLowerCase().endsWith('.exe'))
        if (hasExe) {
          allEntries.push({
            name: entry.name,
            displayName: entry.name,
            fullPath,
            type: 'dir',
            source,
            sizeBytes: 0,
          })
        }
      } catch { /* skip */ }
    }
  }

  // 批量解析 .lnk 目标
  if (lnkFiles.length > 0 && allEntries.length < maxResults) {
    const targets = await resolveShortcutTargets(lnkFiles)
    for (const lnkPath of lnkFiles) {
      if (allEntries.length >= maxResults) {break}
      const baseName = path.basename(lnkPath)
      const target = targets.get(baseName)
      allEntries.push({
        name: baseName,
        displayName: baseName.replace('.lnk', ''),
        fullPath: lnkPath,
        type: 'lnk',
        target: target || undefined,
        source,
        sizeBytes: 0,
      })
    }
  }
}

// ═══════════════════════════════════════════════════════════
// 导出执行函数
// ═══════════════════════════════════════════════════════════

export async function desktopScan(args: Record<string, any>): Promise<ToolResult> {
  const filter: string = (args.filter || '').toLowerCase()
  const includePublic: boolean = args.includePublic !== false
  const maxResults: number = Math.min(args.maxResults || 30, 50)
  const start = Date.now()

  try {
    const allEntries: DesktopEntry[] = []

    // 用户桌面
    const userDesktop = path.join(os.homedir(), 'Desktop')
    await scanDesktop(userDesktop, 'user', maxResults, allEntries)

    // 公共桌面
    if (includePublic) {
      const publicDesktop = 'C:\\Users\\Public\\Desktop'
      await scanDesktop(publicDesktop, 'public', maxResults, allEntries)
    }

    // 过滤
    let filtered = allEntries
    if (filter) {
      const tokens = filter.split(/\s+/)
      filtered = allEntries.filter(entry => {
        const searchStr = `${entry.displayName} ${entry.name} ${entry.target || ''}`.toLowerCase()
        return tokens.every(token => searchStr.includes(token))
      })
    }

    // 格式化输出
    if (filtered.length === 0) {
      const totalCount = allEntries.length
      const scope = filter ? `匹配 "${filter}"` : ''
      return {
        callId: '',
        ok: true,
        content:
          `🖥️ 桌面上${scope}未找到可执行程序。\n` +
          `共扫描到 ${totalCount} 个程序/快捷方式。\n` +
          `💡 提示: 尝试更宽泛的关键词，或用 file_search(rootDir="${userDesktop}", pattern="*.exe") 精确搜索。`,
        durationMs: Date.now() - start,
      }
    }

    const lines: string[] = [
      `🖥️ 桌面程序清单 — ${filtered.length} 个结果：\n`,
    ]

    // 按类型分组显示
    const exeEntries = filtered.filter(e => e.type === 'exe')
    const lnkEntries = filtered.filter(e => e.type === 'lnk')
    const urlEntries = filtered.filter(e => e.type === 'url')
    const dirEntries = filtered.filter(e => e.type === 'dir')

    if (exeEntries.length > 0) {
      lines.push('### 📄 可执行程序 (.exe)')
      lines.push('你可以直接用 `open_file(target="<路径>")` 打开：')
      for (const e of exeEntries) {
        const sizeStr = e.sizeBytes > 0 ? ` (${formatSize(e.sizeBytes)})` : ''
        lines.push(`  🎮 **${e.displayName}**\n    路径: \`${e.fullPath}\`${sizeStr}`)
      }
      lines.push('')
    }

    if (lnkEntries.length > 0) {
      lines.push('### 🔗 快捷方式 (.lnk)')
      lines.push('使用 open_file 打开这些快捷方式，系统会自动启动目标程序：')
      for (const e of lnkEntries) {
        const targetInfo = e.target ? ` → ${e.target}` : ''
        lines.push(`  📌 **${e.displayName}**\n    路径: \`${e.fullPath}\`${targetInfo}`)
      }
      lines.push('')
    }

    if (urlEntries.length > 0) {
      lines.push('### 🌐 网页链接 (.url)')
      for (const e of urlEntries) {
        lines.push(`  🔗 **${e.displayName}**: ${e.target || e.fullPath}`)
      }
      lines.push('')
    }

    if (dirEntries.length > 0) {
      lines.push('### 📁 程序文件夹')
      for (const e of dirEntries) {
        lines.push(`  📂 **${e.displayName}**\n    路径: \`${e.fullPath}\``)
      }
      lines.push('')
    }

    // 使用提示
    lines.push('---')
    lines.push('💡 **如何使用以上结果：**')
    lines.push('  要打开某个程序，调用 `open_file` 并传入上述路径。')
    lines.push('  例如: `open_file(target="C:\\Users\\xxx\\Desktop\\Game.exe")`')
    lines.push('')
    lines.push('⚠️ 启动 .exe 文件可能需要用户确认（审批流）。')

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
  if (bytes < 1024 * 1024) {return `${(bytes / 1024).toFixed(0)}KB`}
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}
