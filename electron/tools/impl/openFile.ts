// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// tools/impl/openFile.ts — 智能文件/程序打开 (v3.6 重写)
//
// v3.6: 彻底修复团队 Agent 打不开文件的根本问题
//   1. 强化路径修复 — LLM 传的损坏路径全面覆盖
//   2. Start Menu 扫描 — 不需要 PATH，直接搜所有已安装程序
//   3. 直接运行 exe 名 — 把 "chrome" 当成命令试试
//   4. 更清晰的失败诊断
// ============================================================

import { execFile } from 'child_process'
import fs from 'fs'
import path from 'path'
import os from 'os'
import type { ToolResult } from '../types'

// ═══════════════════════════════════════════════════════════
// 路径修复引擎 — LLM 经常传损坏的路径
// ═══════════════════════════════════════════════════════════

function repairPath(raw: string): string {
  let p = raw.trim()

  // 去掉 LLM 额外的引号嵌套: ""path"" → "path"
  p = p.replace(/^"+|"+$/g, '')

  // 1. 缺失冒号: "CProgram Files" / "CUsers" / "CWindows"
  p = p.replace(/^([A-Za-z])Program\s*Files\b/i, '$1:\\Program Files')
  p = p.replace(/^([A-Za-z])ProgramFiles\b/i, '$1:\\Program Files')
  p = p.replace(/^([A-Za-z])ProgramFiles\s*\(x86\)/i, '$1:\\Program Files (x86)')
  p = p.replace(/^([A-Za-z])Users\b/i, '$1:\\Users')
  p = p.replace(/^([A-Za-z])Windows\b/i, '$1:\\Windows')
  p = p.replace(/^([A-Za-z])Desktop\b/i, '$1:\\Users\\' + os.userInfo().username + '\\Desktop')
  p = p.replace(/^([A-Za-z])Downloads\b/i, '$1:\\Users\\' + os.userInfo().username + '\\Downloads')
  p = p.replace(/^([A-Za-z])Documents\b/i, '$1:\\Users\\' + os.userInfo().username + '\\Documents')
  p = p.replace(/^([A-Za-z])Projects?\b/i, '$1:\\Projects')
  p = p.replace(/^([A-Za-z])Games?\b/i, '$1:\\Games')
  p = p.replace(/^([A-Za-z])[Dd]ev\b/i, '$1:\\Dev')

  // 2. 缺失反斜杠: "C:Program Files" / "C:Users"
  p = p.replace(/^([A-Za-z]):(?!\\|\/)(.+)$/i, '$1:\\$2')

  // 3. 正斜杠 → 反斜杠
  if (!p.startsWith('http')) {
    p = p.replace(/\//g, '\\')
  }

  // 4. 双反斜杠归一化
  p = p.replace(/\\\\+/g, '\\')

  // 5. 特殊名称映射
  const NAME_MAP: Record<string, string> = {
    'chrome': 'chrome.exe',
    'firefox': 'firefox.exe',
    'edge': 'msedge.exe',
    'vscode': 'Code.exe',
    'code': 'Code.exe',
    'notepad': 'notepad.exe',
    'calc': 'calc.exe',
    'cmd': 'cmd.exe',
    'powershell': 'powershell.exe',
    'explorer': 'explorer.exe',
    'taskmgr': 'Taskmgr.exe',
    'terminal': 'wt.exe',
  }
  const basename = path.basename(p).toLowerCase()
  if (NAME_MAP[basename] || NAME_MAP[basename.replace('.exe', '')]) {
    const mapped = NAME_MAP[basename] || NAME_MAP[basename.replace('.exe', '')]
    p = p.replace(new RegExp(path.basename(p) + '$', 'i'), mapped)
  }

  return p
}

// ═══════════════════════════════════════════════════════════
// 程序搜索 — 多层回退，覆盖所有角落
// ═══════════════════════════════════════════════════════════

interface SearchResult {
  /** 搜索方法 */
  method: 'where' | 'startmenu' | 'path_scan' | 'program_files' | 'direct_run' | 'not_found'
  /** 找到的完整路径 */
  paths: string[]
}

/** 方法 1: where.exe (PATH 中的程序) */
function searchWhere(name: string): Promise<string[]> {
  return new Promise((resolve) => {
    execFile('where', [name], { timeout: 5000, windowsHide: true }, (err, stdout) => {
      if (err || !stdout) { resolve([]); return }
      const lines = String(stdout).trim().split(/\r?\n/)
        .filter(Boolean)
        .filter(l => l.toLowerCase().endsWith('.exe'))
      resolve(lines)
    })
  })
}

/** 方法 2: Get-StartApps PowerShell（开始菜单所有已安装程序） */
function searchStartMenu(name: string): Promise<string[]> {
  const psScript = `
$name = '${name.replace(/'/g, "''")}'
Get-StartApps | Where-Object {
  $_.Name -like "*$name*" -or $_.AppID -like "*$name*"
} | ForEach-Object {
  $_.AppID
} | Select-Object -First 10
`
  return new Promise((resolve) => {
    const b64 = Buffer.from(psScript, 'utf16le').toString('base64')
    execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', b64],
      { timeout: 10000, windowsHide: true },
      (err, stdout) => {
        if (err || !stdout) { resolve([]); return }
        const lines = String(stdout).trim().split(/\r?\n/).filter(Boolean)
        // 过滤只返回有路径的
        const paths = lines
          .filter(l => l.includes('\\') || l.includes('/'))
          .map(l => l.trim())
        resolve(paths)
      })
  })
}

/** 方法 3: 直接扫描 Program Files */
function scanProgramFiles(name: string): Promise<string[]> {
  return new Promise((resolve) => {
    const dirs = [
      'C:\\Program Files',
      'C:\\Program Files (x86)',
      `${process.env.LOCALAPPDATA}\\Programs`,
      `${process.env.APPDATA}`,
    ].filter(d => {
      try { return fs.existsSync(d) } catch { return false }
    })

    const results: string[] = []
    const searchName = name.toLowerCase()

    for (const dir of dirs) {
      try {
        // 先看顶级子目录名
        const entries = fs.readdirSync(dir, { withFileTypes: true })
        for (const entry of entries) {
          if (!entry.isDirectory()) {continue}
          if (entry.name.toLowerCase().includes(searchName)) {
            // 在这个目录里找 .exe
            try {
              const subs = fs.readdirSync(path.join(dir, entry.name))
              for (const sub of subs) {
                if (sub.toLowerCase().includes(searchName) && sub.endsWith('.exe')) {
                  results.push(path.join(dir, entry.name, sub))
                }
              }
            } catch { /* skip */ }
          }
        }
      } catch { /* skip */ }
    }

    resolve(results)
  })
}

// ═══════════════════════════════════════════════════════════
// 核心: 带完整诊断的 open_file
// ═══════════════════════════════════════════════════════════

export async function openFileV2(target: string): Promise<ToolResult> {
  const original = target
  const repaired = repairPath(target)
  const repairedForLog = repaired !== original ? ` (已修复: ${repaired})` : ''

  // ── URL → 浏览器打开 ──
  if (/^https?:\/\//i.test(repaired)) {
    try {
      const { shell } = require('electron')
      await shell.openExternal(repaired)
      return { callId: '', ok: true, content: `✅ 已在浏览器中打开: ${repaired}` }
    } catch (e: any) {
      return { callId: '', ok: false, content: '', error: `浏览器打开失败: ${e.message}` }
    }
  }

  // ── 路径已存在 → 直接打开 ──
  try {
    const absPath = path.resolve(repaired)
    if (fs.existsSync(absPath)) {
      return doOpenPath(absPath, path.extname(absPath).toLowerCase() === '.exe' ? '程序' : '文件')
    }
  } catch { /* 继续搜索 */ }

  // ── .exe 或程序名 → 多层搜索 ──
  const isApp = repaired.toLowerCase().endsWith('.exe') ||
                !repaired.includes('\\') ||
                repaired.includes('Program Files')

  if (isApp) {
    const name = path.basename(repaired, '.exe')
    const diagnostics: string[] = [`🔍 搜索程序 "${name}" ...`]
    const allPaths: { method: string; paths: string[] }[] = []

    // Level 1: where.exe
    const whereResults = await searchWhere(name)
    allPaths.push({ method: 'where (PATH)', paths: whereResults })
    if (whereResults.length > 0) {
      const msg = doOpenPath(whereResults[0], '程序')
      return msg
    }

    // Level 2: Start Menu
    diagnostics.push('  ⏳ 扫描开始菜单...')
    const startResults = await searchStartMenu(name)
    allPaths.push({ method: '开始菜单', paths: startResults })
    if (startResults.length > 0) {
      const msg = doOpenPath(startResults[0], '程序')
      return msg
    }

    // Level 3: Program Files 扫描
    diagnostics.push('  ⏳ 扫描 Program Files...')
    const scanResults = await scanProgramFiles(name)
    allPaths.push({ method: 'Program Files 扫描', paths: scanResults })
    if (scanResults.length > 0) {
      const msg = doOpenPath(scanResults[0], '程序')
      return msg
    }

    // Level 4: 直接当命令运行
    diagnostics.push('  ⏳ 尝试直接运行...')
    try {
      const { exec } = require('child_process')
      await new Promise<void>((resolve, reject) => {
        exec(`start "" "${name}"`, { timeout: 5000, windowsHide: true },
          (err: any) => err ? reject(err) : resolve())
      })
      return { callId: '', ok: true, content: `✅ 已运行: ${name}` }
    } catch {
      diagnostics.push('  ❌ 直接运行也失败了')
    }

    // 失败 — 返回完整诊断
    const allFound = allPaths.filter(p => p.paths.length > 0)
    return {
      callId: '', ok: true, content:
        `❌ 未找到程序: ${name}\n原始请求: ${original}${repairedForLog}\n\n` +
        diagnostics.join('\n') + '\n\n' +
        `💡 请尝试:\n` +
        `  1. 用完整路径: open_file(target="C:\\完整路径\\${name}.exe")\n` +
        `  2. 用 shell_exec("${name}") 试试\n` +
        `  3. 用 file_list 查看 Program Files 目录确认安装位置`,
    }
  }

  // ── 普通文件不存在 → 诊断 ──
  const absPath = path.resolve(repaired)
  const parentDir = path.dirname(absPath)
  const parentExists = fs.existsSync(parentDir)

  let suggestion = ''
  if (parentExists) {
    try {
      const files = fs.readdirSync(parentDir).slice(0, 10)
      suggestion = `\n同级目录有: ${files.join(', ')}`
    } catch { /* skip */ }
  }

  return {
    callId: '', ok: true, content:
      `❌ 文件不存在: ${absPath}\n` +
      `原始: ${original}${repairedForLog}\n` +
      `父目录${parentExists ? '存在' : '不存在'}: ${parentDir}${suggestion}\n\n` +
      `💡 用 file_list(path="${parentDir}") 查看目录`,
  }
}

// ═══════════════════════════════════════════════════════════
// 内部: 打开文件
// ═══════════════════════════════════════════════════════════

function doOpenPath(absPath: string, typeLabel: string): ToolResult {
  try {
    const { shell } = require('electron')
    const errorMsg = shell.openPath(absPath)
    if (!errorMsg) {return { callId: '', ok: true, content: `✅ 已打开${typeLabel}: ${absPath}` }}
    throw new Error(errorMsg)
  } catch {
    // 回退: cmd start
    execFile('cmd.exe', ['/c', 'start', '', absPath],
      { timeout: 5000, windowsHide: true }, () => {})
    return { callId: '', ok: true, content: `✅ 已打开${typeLabel}: ${absPath}` }
  }
}
