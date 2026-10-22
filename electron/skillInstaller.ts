// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// skillInstaller.ts — Skill 安装器 (v2.7: 接入 Skill Pool)
//
// v2.7 升级: 安装 Skills 自动加入共享池 + 同步到当前 workspace
//   旧行为: 安装到独立的 skills/ 目录
//   新行为: 安装到 skill_pool/ → 再 link 到当前 workspace
// ============================================================

import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'

// Electron 主进程原生支持 require，绕过 ESM/CJS 兼容问题
const AdmZip = require('adm-zip')

// ── Skill 安全扫描 (v3.0) ───────────────────────────────
import { scanSkill, formatScanResult, type ScanResult } from './skillScanner'

// ── 路径 ──────────────────────────────────────────────────

function getSkillsDir(): string {
  const dir = path.join(app.getPath('userData'), 'skills')
  if (!fs.existsSync(dir)) {fs.mkdirSync(dir, { recursive: true })}
  return dir
}

// ── 类型 ──────────────────────────────────────────────────

export interface InstalledSkill {
  id: string
  name: string
  description: string
  version: string
  installedAt: number
  path: string
  tools: string[]        // 工具脚本路径
  knowledge: string[]    // 知识文件路径
}

export interface InstallResult {
  success: boolean
  skill?: InstalledSkill
  error?: string
  warnings?: string[]
}

// ============================================================
// 安装 Skill
// ============================================================

export async function installSkillFromZip(zipPath: string): Promise<InstallResult> {
  const warnings: string[] = []

  // 1. 检查 zip 是否存在
  if (!fs.existsSync(zipPath)) {
    return { success: false, error: `文件不存在: ${zipPath}` }
  }

  // 2. 解压 zip
  let zip: any
  try {
    zip = new AdmZip(zipPath)
  } catch (err: any) {
    return { success: false, error: `无效的 zip 文件: ${err.message}` }
  }

  // 3. 查找 SKILL.md
  const entries = zip.getEntries()
  const skillMdEntry = entries.find(
    (e: any) => !e.isDirectory && e.entryName.replace(/\\/g, '/').endsWith('SKILL.md')
  )

  if (!skillMdEntry) {
    return { success: false, error: '压缩包中未找到 SKILL.md — 这是技能描述文件，必需！\n\n压缩包结构应为：\n  skill.zip\n  ├── SKILL.md\n  ├── tools/...\n  ├── knowledge/...\n  └── assets/...' }
  }

  // 4. 解析 SKILL.md 获取技能元信息
  const skillMdContent = skillMdEntry.getData().toString('utf-8')
  const meta = parseSkillMeta(skillMdContent, path.basename(zipPath, '.zip'))

  // 5. 确定安装目录
  const skillDir = path.join(getSkillsDir(), meta.id)
  if (fs.existsSync(skillDir)) {
    // 覆盖安装
    fs.rmSync(skillDir, { recursive: true, force: true })
    warnings.push(`已覆盖旧版本 (${meta.id})`)
  }
  fs.mkdirSync(skillDir, { recursive: true })

  // 6. 写入所有文件
  for (const entry of entries) {
    if (entry.isDirectory) {continue}

    // 跳过 macOS 垃圾文件
    if (entry.entryName.includes('__MACOSX') || entry.entryName.includes('.DS_Store')) {continue}

    const relativePath = entry.entryName
      .replace(/\\/g, '/')
      .replace(/^[^/]+\//, '')  // 去掉顶层目录（如果 zip 内有包裹目录）

    const targetPath = path.join(skillDir, relativePath)
    const targetDir = path.dirname(targetPath)
    if (!fs.existsSync(targetDir)) {fs.mkdirSync(targetDir, { recursive: true })}

    fs.writeFileSync(targetPath, entry.getData())
  }

  // 7. 🛡️ 安全扫描 (v3.0)
  console.log(`[SkillInstaller] 🔍 扫描安全风险: ${meta.id}...`)
  const scanResult: ScanResult = scanSkill(skillDir)
  console.log(`[SkillInstaller] 🛡️ ${scanResult.summary}`)

  if (scanResult.level === 'BLOCK') {
    // 自动卸载已写入的文件
    fs.rmSync(skillDir, { recursive: true, force: true })
    const scanReport = formatScanResult(scanResult)
    return {
      success: false,
      error: `⛔ 安全扫描未通过 — 此 Skill 存在 ${scanResult.findings.filter(f => f.level === 'BLOCK').length} 项阻塞风险\n${scanReport}`,
    }
  }

  if (scanResult.level === 'WARN') {
    const warnCount = scanResult.findings.filter(f => f.level === 'WARN').length
    for (const f of scanResult.findings) {
      if (f.level === 'WARN') {
        warnings.push(`[${f.rule}] ${f.file}: ${f.message}`)
      }
    }
    console.log(`[SkillInstaller] ⚠️ ${warnCount} 项警告 — 继续安装 (标记为可疑)`)
  }

  // 8. 扫描工具和知识文件
  const tools: string[] = []
  const knowledge: string[] = []

  const scanDir = (dir: string) => {
    if (!fs.existsSync(dir)) {return}
    for (const file of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, file.name)
      if (file.isDirectory()) { scanDir(full); continue }
      const rel = path.relative(skillDir, full).replace(/\\/g, '/')
      if (rel.startsWith('tools/')) {tools.push(rel)}
      if (rel.startsWith('knowledge/') && file.name.endsWith('.md')) {knowledge.push(rel)}
    }
  }
  scanDir(skillDir)

  // 8. 返回结果
  const skill: InstalledSkill = {
    id: meta.id,
    name: meta.name,
    description: meta.description,
    version: meta.version,
    installedAt: Date.now(),
    path: skillDir,
    tools,
    knowledge,
  }

  // 写入安装记录
  saveInstallRecord(skill)

  console.log(`[SkillInstaller] ✅ 已安装: ${skill.name} (${skill.id}) — ${tools.length} 工具, ${knowledge.length} 知识文件`)
  if (warnings.length) {console.log(`[SkillInstaller] ⚠️ ${warnings.join(', ')}`)}

  return { success: true, skill, warnings: warnings.length ? warnings : undefined }
}

// ── 解析 SKILL.md ────────────────────────────────────────

function parseSkillMeta(md: string, fallbackId: string): {
  id: string; name: string; description: string; version: string
} {
  const firstLine = md.split('\n')[0] || ''
  const nameMatch = firstLine.match(/^#\s+(.+)/)
  const name = nameMatch ? nameMatch[1].trim() : fallbackId

  // 尝试从内容提取 id
  const idMatch = md.match(/[Ii][Dd]:\s*(\S+)/) || md.match(/skill[-_]?id:\s*(\S+)/i)
  const id = idMatch ? idMatch[1] : fallbackId.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase()

  // 提取描述（第一段非标题文本）
  const paragraphs = md.split('\n\n')
  let description = ''
  for (const p of paragraphs) {
    const trimmed = p.replace(/^#+\s+.*\n?/m, '').trim()
    if (trimmed && !trimmed.startsWith('---') && !trimmed.startsWith('##')) {
      description = trimmed.slice(0, 200)
      break
    }
  }

  // 提取版本
  const verMatch = md.match(/[Vv]ersion:\s*(\S+)/)
  const version = verMatch ? verMatch[1] : '1.0.0'

  return { id, name, description, version }
}

// ── 持久化安装记录 ──────────────────────────────────────

const RECORDS_FILE = 'installed_skills.json'

function saveInstallRecord(skill: InstalledSkill): void {
  const recordsPath = path.join(getSkillsDir(), RECORDS_FILE)
  const records: InstalledSkill[] = fs.existsSync(recordsPath)
    ? JSON.parse(fs.readFileSync(recordsPath, 'utf-8'))
    : []

  const idx = records.findIndex((r) => r.id === skill.id)
  if (idx >= 0) {records[idx] = skill}
  else {records.push(skill)}

  fs.writeFileSync(recordsPath, JSON.stringify(records, null, 2), 'utf-8')
}

// ── 列出已安装的 Skill ─────────────────────────────────

export function listInstalledSkills(): InstalledSkill[] {
  const recordsPath = path.join(getSkillsDir(), RECORDS_FILE)
  if (!fs.existsSync(recordsPath)) {return []}
  try {
    return JSON.parse(fs.readFileSync(recordsPath, 'utf-8'))
  } catch {
    return []
  }
}

// ── 卸载 Skill ─────────────────────────────────────────

export function uninstallSkill(skillId: string): { success: boolean; error?: string } {
  const skillDir = path.join(getSkillsDir(), skillId)
  if (!fs.existsSync(skillDir)) {return { success: false, error: `Skill 不存在: ${skillId}` }}

  fs.rmSync(skillDir, { recursive: true, force: true })

  const recordsPath = path.join(getSkillsDir(), RECORDS_FILE)
  if (fs.existsSync(recordsPath)) {
    const records: InstalledSkill[] = JSON.parse(fs.readFileSync(recordsPath, 'utf-8'))
    const filtered = records.filter((r) => r.id !== skillId)
    fs.writeFileSync(recordsPath, JSON.stringify(filtered, null, 2), 'utf-8')
  }

  console.log(`[SkillInstaller] 🗑️ 已卸载: ${skillId}`)
  return { success: true }
}

// ── 读取 SKILL.md 内容 ──────────────────────────────────

export function readSkillDoc(skillId: string): string | null {
  const skillDir = path.join(getSkillsDir(), skillId)
  const mdPath = path.join(skillDir, 'SKILL.md')
  if (!fs.existsSync(mdPath)) {return null}
  return fs.readFileSync(mdPath, 'utf-8')
}

// ═══════════════════════════════════════════════════════════
// v2.4.1: Skill 工具执行 — 让导入的技能真正可用
// ═══════════════════════════════════════════════════════════

import { execSync } from 'child_process'

/**
 * 执行已安装 Skill 中的工具脚本
 * 支持 Python (.py)、Node (.js/.mjs)、Shell (.sh/.bat/.ps1)
 */
export function runSkillTool(skillId: string, toolName: string, args: string = ''): { success: boolean; output: string; error?: string } {
  const skillDir = path.join(getSkillsDir(), skillId)
  if (!fs.existsSync(skillDir)) {
    return { success: false, output: '', error: `Skill 未安装: ${skillId}` }
  }

  // 查找工具脚本
  const toolsDir = path.join(skillDir, 'tools')
  const candidates = [
    path.join(toolsDir, `${toolName}.py`),
    path.join(toolsDir, `${toolName}.js`),
    path.join(toolsDir, `${toolName}.mjs`),
    path.join(toolsDir, `${toolName}.sh`),
    path.join(toolsDir, `${toolName}.bat`),
    path.join(toolsDir, `${toolName}.ps1`),
    path.join(toolsDir, toolName),  // 直接全名匹配
  ]

  let scriptPath = ''
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      scriptPath = c
      break
    }
  }

  if (!scriptPath) {
    return {
      success: false,
      output: '',
      error: `工具 "${toolName}" 未找到。已安装的工具: ${listSkillTools(skillId).join(', ') || '(无)'}`
    }
  }

  // 执行脚本
  try {
    let cmd: string
    const ext = path.extname(scriptPath).toLowerCase()

    if (ext === '.py') {
      cmd = `python "${scriptPath}" ${args}`
    } else if (ext === '.js' || ext === '.mjs') {
      cmd = `node "${scriptPath}" ${args}`
    } else if (ext === '.ps1') {
      cmd = `powershell -ExecutionPolicy Bypass -File "${scriptPath}" ${args}`
    } else if (ext === '.bat' || ext === '.cmd') {
      cmd = `"${scriptPath}" ${args}`
    } else {
      cmd = `bash "${scriptPath}" ${args}`
    }

    const output = execSync(cmd, {
      timeout: 30000,
      maxBuffer: 1024 * 1024,
      encoding: 'utf-8',
      cwd: skillDir,
    })
    return { success: true, output: output.trim() || '(执行成功，无输出)' }
  } catch (err: any) {
    return {
      success: false,
      output: err.stdout || '',
      error: err.stderr || err.message || '未知错误',
    }
  }
}

/** 列出已安装 Skill 中的工具 */
export function listSkillTools(skillId: string): string[] {
  const skillDir = path.join(getSkillsDir(), skillId)
  const toolsDir = path.join(skillDir, 'tools')
  if (!fs.existsSync(toolsDir)) {return []}

  const files: string[] = []
  const scan = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) { scan(full); continue }
      const ext = path.extname(entry.name).toLowerCase()
      if (['.py', '.js', '.mjs', '.sh', '.bat', '.ps1', '.cmd'].includes(ext)) {
        files.push(path.relative(toolsDir, full).replace(/\\/g, '/').replace(ext, ''))
      }
    }
  }
  scan(toolsDir)
  return files
}

/** 获取所有已安装 Skill 的知识文档（注入 Agent 上下文） */
export function getSkillsKnowledgeContext(): string {
  const skills = listInstalledSkills()
  if (skills.length === 0) {return ''}

  const parts: string[] = []

  for (const skill of skills) {
    const doc = readSkillDoc(skill.id)
    if (!doc) {continue}

    // 提取知识文件内容摘要
    const knowledgeSnippets: string[] = []
    const knowledgeDir = path.join(skill.path, 'knowledge')
    if (fs.existsSync(knowledgeDir)) {
      for (const entry of fs.readdirSync(knowledgeDir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith('.md')) {
          const kPath = path.join(knowledgeDir, entry.name)
          try {
            const content = fs.readFileSync(kPath, 'utf-8')
            knowledgeSnippets.push(`### ${entry.name}\n${content.slice(0, 800)}`)
          } catch { /* skip */ }
        }
      }
    }

    // 工具摘要
    const tools = listSkillTools(skill.id)
    const toolList = tools.length > 0
      ? `\n可用工具 (${tools.length}): ${tools.map(t => `\`skill_run("${skill.id}", "${t}")\``).join(', ')}`
      : ''

    parts.push(
      `【已安装 Skill: ${skill.name} (${skill.id})】\n` +
      `${skill.description}\n` +
      `版本: ${skill.version}${toolList}\n` +
      (knowledgeSnippets.length ? `\n知识文档:\n${knowledgeSnippets.join('\n\n')}` : '')
    )
  }

  return parts.join('\n\n---\n\n')
}

// ═══════════════════════════════════════════════════════════
// v2.7: Skill Pool 桥接
// ═══════════════════════════════════════════════════════════

/**
 * 🆕 v2.7: 安装 Skill 到共享池 + 同步到当前 workspace
 * 替代旧的 installSkillFromZip 直接调用
 */
export async function installSkillToPool(zipPath: string, workspaceId: string = 'default'): Promise<InstallResult> {
  try {
    const { getSkillPool } = require('./skillPool')
    const pool = getSkillPool()

    // 1. 安装到池
    const poolResult = pool.installFromZip(zipPath)
    if (!poolResult.success) {return poolResult}

    // 2. 下载到 workspace
    const downloadResult = pool.downloadToWorkspace(poolResult.skill!.name, workspaceId)
    if (!downloadResult.success) {
      return {
        success: true,
        skill: poolResult.skill,
        warnings: [`已安装到共享池，但同步到 workspace "${workspaceId}" 失败: ${downloadResult.error}`],
      }
    }

    return {
      success: true,
      skill: poolResult.skill,
      warnings: poolResult.warnings,
    }
  } catch (err: any) {
    // 回退到旧安装方式
    console.warn('[SkillInstaller] Skill Pool 不可用，回退到旧安装方式:', err.message)
    return installSkillFromZip(zipPath)
  }
}
