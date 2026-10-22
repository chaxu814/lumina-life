// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// skillPool.ts — Skill 共享池 (v2.7)
//
// 借鉴 QwenPaw SkillPoolService:
//   全局 skill_pool/ 目录 → 所有 Agent workspace 共享
//   Manifest 管理 → 版本追踪 + 冲突检测
//   ZIP 导入导出 → 跨 workspace 同步
//
// 架构:
//   {userData}/skill_pool/          ← 全局共享池
//     ├── manifest.json             ← 池索引
//     ├── skill_a/                  ← 完整 skill 目录
//     │   ├── SKILL.md
//     │   ├── tools/
//     │   └── knowledge/
//     └── skill_b/
//
//   {userData}/workspaces/          ← 各 Agent workspace
//     ├── default/skills/           ← 从池子链接的 skills
//     ├── luna/skills/
//     ├── ray/skills/
//     └── sora/skills/
// ============================================================

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { app } from 'electron'

// Electron 主进程原生支持 require
const AdmZip = require('adm-zip')

// ═══════════════════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════════════════

export interface SkillInfo {
  name: string
  description: string
  version: string
  emoji: string
  source: 'builtin' | 'installed' | 'imported' | 'pool'
  installedAt: number
  updatedAt: number
  path: string
  tools: string[]
  knowledge: string[]
  requirements?: {
    bins?: string[]
    envs?: string[]
  }
}

export interface SkillManifest {
  skills: Record<string, {
    version: string
    source: string
    installedAt: number
    updatedAt: number
    description: string
    emoji: string
  }>
  lastSync: number
}

export interface WorkspaceSkillManifest {
  skills: Record<string, {
    poolVersion: string
    syncedAt: number
    local: boolean
  }>
}

export interface InstallResult {
  success: boolean
  skill?: SkillInfo
  error?: string
  warnings?: string[]
  conflicts?: string[]
}

export interface SyncResult {
  success: boolean
  synced: number
  failed: number
  details: Array<{ name: string; status: 'synced' | 'failed' | 'conflict'; message?: string }>
}

// ═══════════════════════════════════════════════════════════
// 路径工具
// ═══════════════════════════════════════════════════════════

// QwenPaw 兼容 — 优先使用 WORKING_DIR 体系
//   若 QWENPAW_WORKING_DIR 存在，workspaces 设在 <WORKING_DIR>/workspaces/
//   否则 fallback 到 app.getPath('userData')
function findWorkspacesRoot(): string {
  const envDir = process.env.QWENPAW_WORKING_DIR || process.env.COPAW_WORKING_DIR
  if (envDir) {return path.join(envDir, 'workspaces')}

  // 兼容 ~/.qwenpaw / ~/.copaw
  const home = os.homedir()
  const candidates = [
    path.join(home, '.qwenpaw', 'workspaces'),
    path.join(home, '.copaw', 'workspaces'),
  ]
  for (const c of candidates) {
    if (fs.existsSync(c)) {return c}
  }

  // fallback: 旧版 Electron userData
  return path.join(app.getPath('userData'), 'workspaces')
}

function getSkillPoolDir(): string {
  const envDir = process.env.QWENPAW_WORKING_DIR || process.env.COPAW_WORKING_DIR
  if (envDir) {
    const dir = path.join(envDir, 'skill_pool')
    if (!fs.existsSync(dir)) {fs.mkdirSync(dir, { recursive: true })}
    return dir
  }
  const dir = path.join(app.getPath('userData'), 'skill_pool')
  if (!fs.existsSync(dir)) {fs.mkdirSync(dir, { recursive: true })}
  return dir
}

function getWorkspacesDir(): string {
  const root = findWorkspacesRoot()
  if (!fs.existsSync(root)) {fs.mkdirSync(root, { recursive: true })}
  return root
}

function getWorkspaceSkillsDir(workspaceId: string): string {
  const dir = path.join(getWorkspacesDir(), workspaceId, 'skills')
  if (!fs.existsSync(dir)) {fs.mkdirSync(dir, { recursive: true })}
  return dir
}

function getPoolManifestPath(): string {
  return path.join(getSkillPoolDir(), 'manifest.json')
}

function getWorkspaceManifestPath(workspaceId: string): string {
  return path.join(getWorkspacesDir(), workspaceId, 'skill_manifest.json')
}

// ═══════════════════════════════════════════════════════════
// SkillPoolService
// ═══════════════════════════════════════════════════════════

export class SkillPoolService {
  private poolDir: string

  constructor() {
    this.poolDir = getSkillPoolDir()
    this.ensureManifest()
  }

  // ── Manifest 管理 ────────────────────────────────────

  private ensureManifest(): void {
    const manifestPath = getPoolManifestPath()
    if (!fs.existsSync(manifestPath)) {
      this.writePoolManifest({ skills: {}, lastSync: Date.now() })
    }
  }

  private readPoolManifest(): SkillManifest {
    try {
      const raw = fs.readFileSync(getPoolManifestPath(), 'utf-8')
      return JSON.parse(raw)
    } catch {
      return { skills: {}, lastSync: Date.now() }
    }
  }

  private writePoolManifest(manifest: SkillManifest): void {
    fs.writeFileSync(getPoolManifestPath(), JSON.stringify(manifest, null, 2), 'utf-8')
  }

  private readWorkspaceManifest(workspaceId: string): WorkspaceSkillManifest {
    try {
      const raw = fs.readFileSync(getWorkspaceManifestPath(workspaceId), 'utf-8')
      return JSON.parse(raw)
    } catch {
      return { skills: {} }
    }
  }

  private writeWorkspaceManifest(workspaceId: string, manifest: WorkspaceSkillManifest): void {
    fs.writeFileSync(getWorkspaceManifestPath(workspaceId), JSON.stringify(manifest, null, 2), 'utf-8')
  }

  // ── 列出池中所有 skills ─────────────────────────────

  listAllSkills(): SkillInfo[] {
    const manifest = this.readPoolManifest()
    const skills: SkillInfo[] = []

    for (const [name, entry] of Object.entries(manifest.skills)) {
      const skillPath = path.join(this.poolDir, name)
      const skillMdPath = path.join(skillPath, 'SKILL.md')

      let description = entry.description || ''
      let emoji = entry.emoji || '🛠️'

      if (fs.existsSync(skillMdPath)) {
        const meta = this.parseSkillMeta(fs.readFileSync(skillMdPath, 'utf-8'))
        if (meta.description) {description = meta.description}
        if (meta.emoji) {emoji = meta.emoji}
      }

      const tools: string[] = []
      const toolsDir = path.join(skillPath, 'tools')
      if (fs.existsSync(toolsDir)) {
        tools.push(...fs.readdirSync(toolsDir).filter(f => !f.startsWith('.')))
      }

      const knowledge: string[] = []
      const knowledgeDir = path.join(skillPath, 'knowledge')
      if (fs.existsSync(knowledgeDir)) {
        knowledge.push(...fs.readdirSync(knowledgeDir).filter(f => f.endsWith('.md')))
      }

      skills.push({
        name,
        description,
        version: entry.version,
        emoji,
        source: entry.source as any,
        installedAt: entry.installedAt,
        updatedAt: entry.updatedAt,
        path: skillPath,
        tools,
        knowledge,
      })
    }

    return skills.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  // ── 获取单个 skill 信息 ─────────────────────────────

  getSkill(name: string): SkillInfo | null {
    const skills = this.listAllSkills()
    return skills.find(s => s.name === name) || null
  }

  // ── 从 ZIP 安装到池 ─────────────────────────────────

  installFromZip(zipPath: string): InstallResult {
    const warnings: string[] = []

    if (!fs.existsSync(zipPath)) {
      return { success: false, error: `文件不存在: ${zipPath}` }
    }

    let zip: any
    try {
      zip = new AdmZip(zipPath)
    } catch (err: any) {
      return { success: false, error: `无效的 zip 文件: ${err.message}` }
    }

    // 查找 SKILL.md
    const entries = zip.getEntries()
    const skillMdEntry = entries.find(
      (e: any) => !e.isDirectory && e.entryName.replace(/\\/g, '/').endsWith('SKILL.md'),
    )

    if (!skillMdEntry) {
      return {
        success: false,
        error: '压缩包中未找到 SKILL.md — 这是技能描述文件，必需！\n\n' +
               '压缩包结构应为：\n  skill.zip\n  ├── SKILL.md\n  ├── tools/...\n  ├── knowledge/...\n  └── assets/...',
      }
    }

    const skillMdContent = skillMdEntry.getData().toString('utf-8')
    const meta = this.parseSkillMeta(skillMdContent)

    // 冲突检测
    const manifest = this.readPoolManifest()
    const skillName = meta.name
    if (manifest.skills[skillName]) {
      warnings.push(`Skill "${skillName}" 已存在，将覆盖安装`)
    }

    // 解压到 pool
    const destDir = path.join(this.poolDir, skillName)
    try {
      if (fs.existsSync(destDir)) {
        fs.rmSync(destDir, { recursive: true, force: true })
      }
      zip.extractAllTo(destDir, true)
    } catch (err: any) {
      return { success: false, error: `解压失败: ${err.message}` }
    }

    // 扫描工具和知识文件
    const tools: string[] = []
    const toolsDir = path.join(destDir, 'tools')
    if (fs.existsSync(toolsDir)) {
      tools.push(...fs.readdirSync(toolsDir).filter(f => !f.startsWith('.')))
    }

    const knowledge: string[] = []
    const knowledgeDir = path.join(destDir, 'knowledge')
    if (fs.existsSync(knowledgeDir)) {
      knowledge.push(...fs.readdirSync(knowledgeDir).filter(f => f.endsWith('.md')))
    }

    // 更新 manifest
    manifest.skills[skillName] = {
      version: meta.version || '1.0.0',
      source: 'imported',
      installedAt: Date.now(),
      updatedAt: Date.now(),
      description: meta.description || '',
      emoji: meta.emoji || '📦',
    }
    manifest.lastSync = Date.now()
    this.writePoolManifest(manifest)

    const skill: SkillInfo = {
      name: skillName,
      description: meta.description || '',
      version: meta.version || '1.0.0',
      emoji: meta.emoji || '📦',
      source: 'imported',
      installedAt: Date.now(),
      updatedAt: Date.now(),
      path: destDir,
      tools,
      knowledge,
    }

    return { success: true, skill, warnings: warnings.length > 0 ? warnings : undefined }
  }

  // ── 下载 skill 到 workspace ─────────────────────────

  downloadToWorkspace(skillName: string, workspaceId: string): { success: boolean; error?: string; skillPath?: string } {
    const poolSkill = this.getSkill(skillName)
    if (!poolSkill) {
      return { success: false, error: `Skill "${skillName}" 在共享池中不存在` }
    }

    const wsSkillsDir = getWorkspaceSkillsDir(workspaceId)
    const destDir = path.join(wsSkillsDir, skillName)

    // 冲突检测
    const wsManifest = this.readWorkspaceManifest(workspaceId)
    if (wsManifest.skills[skillName]) {
      return { success: false, error: `Skill "${skillName}" 在此 workspace 中已存在。请先移除再重新下载，或使用 sync 更新。` }
    }

    // 复制
    try {
      this.copyDir(poolSkill.path, destDir)
    } catch (err: any) {
      return { success: false, error: `复制失败: ${err.message}` }
    }

    // 更新 workspace manifest
    wsManifest.skills[skillName] = {
      poolVersion: poolSkill.version,
      syncedAt: Date.now(),
      local: false,
    }
    this.writeWorkspaceManifest(workspaceId, wsManifest)

    return { success: true, skillPath: destDir }
  }

  // ── 同步 workspace 到池最新 ─────────────────────────

  syncWorkspace(workspaceId: string): SyncResult {
    const wsManifest = this.readWorkspaceManifest(workspaceId)
    const poolManifest = this.readPoolManifest()
    const result: SyncResult = { success: true, synced: 0, failed: 0, details: [] }

    for (const [skillName, wsEntry] of Object.entries(wsManifest.skills)) {
      if (wsEntry.local) {continue}  // 跳过本地 skills

      const poolEntry = poolManifest.skills[skillName]
      if (!poolEntry) {
        result.details.push({ name: skillName, status: 'failed', message: '池中已删除' })
        result.failed++
        continue
      }

      if (poolEntry.version === wsEntry.poolVersion) {
        continue  // 已是最新
      }

      try {
        // 移除旧版本
        const wsSkillsDir = getWorkspaceSkillsDir(workspaceId)
        const destDir = path.join(wsSkillsDir, skillName)
        if (fs.existsSync(destDir)) {
          fs.rmSync(destDir, { recursive: true, force: true })
        }

        // 复制新版本
        const poolSkillPath = path.join(this.poolDir, skillName)
        this.copyDir(poolSkillPath, destDir)

        wsManifest.skills[skillName] = {
          poolVersion: poolEntry.version,
          syncedAt: Date.now(),
          local: false,
        }
        result.synced++
        result.details.push({ name: skillName, status: 'synced' })
      } catch (err: any) {
        result.failed++
        result.details.push({ name: skillName, status: 'failed', message: err.message })
      }
    }

    if (result.failed > 0) {result.success = false}
    this.writeWorkspaceManifest(workspaceId, wsManifest)
    return result
  }

  // ── 从 workspace 移除 skill ─────────────────────────

  removeFromWorkspace(skillName: string, workspaceId: string): { success: boolean; error?: string } {
    const wsManifest = this.readWorkspaceManifest(workspaceId)
    if (!wsManifest.skills[skillName]) {
      return { success: false, error: `Skill "${skillName}" 不在此 workspace 中` }
    }

    const wsSkillsDir = getWorkspaceSkillsDir(workspaceId)
    const skillDir = path.join(wsSkillsDir, skillName)
    if (fs.existsSync(skillDir)) {
      fs.rmSync(skillDir, { recursive: true, force: true })
    }

    delete wsManifest.skills[skillName]
    this.writeWorkspaceManifest(workspaceId, wsManifest)

    return { success: true }
  }

  // ── 从池中完全删除 skill ────────────────────────────

  deleteFromPool(skillName: string): { success: boolean; error?: string } {
    const manifest = this.readPoolManifest()
    if (!manifest.skills[skillName]) {
      return { success: false, error: `Skill "${skillName}" 不在共享池中` }
    }

    const skillDir = path.join(this.poolDir, skillName)
    if (fs.existsSync(skillDir)) {
      fs.rmSync(skillDir, { recursive: true, force: true })
    }

    delete manifest.skills[skillName]
    manifest.lastSync = Date.now()
    this.writePoolManifest(manifest)

    return { success: true }
  }

  // ── 获取 workspace 的 skill 列表 ────────────────────

  listWorkspaceSkills(workspaceId: string): SkillInfo[] {
    const wsManifest = this.readWorkspaceManifest(workspaceId)
    const wsSkillsDir = getWorkspaceSkillsDir(workspaceId)
    const skills: SkillInfo[] = []

    if (!fs.existsSync(wsSkillsDir)) {return skills}

    const entries = fs.readdirSync(wsSkillsDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) {continue}
      const skillPath = path.join(wsSkillsDir, entry.name)
      const skillMdPath = path.join(skillPath, 'SKILL.md')

      let description = ''
      let emoji = '🛠️'
      let version = '1.0.0'

      if (fs.existsSync(skillMdPath)) {
        const meta = this.parseSkillMeta(fs.readFileSync(skillMdPath, 'utf-8'))
        if (meta.description) {description = meta.description}
        if (meta.emoji) {emoji = meta.emoji}
        if (meta.version) {version = meta.version}
      }

      const tools: string[] = []
      const toolsDir = path.join(skillPath, 'tools')
      if (fs.existsSync(toolsDir)) {
        tools.push(...fs.readdirSync(toolsDir).filter(f => !f.startsWith('.')))
      }

      const knowledge: string[] = []
      const knowledgeDir = path.join(skillPath, 'knowledge')
      if (fs.existsSync(knowledgeDir)) {
        knowledge.push(...fs.readdirSync(knowledgeDir).filter(f => f.endsWith('.md')))
      }

      const wsEntry = wsManifest.skills[entry.name]
      skills.push({
        name: entry.name,
        description,
        version,
        emoji,
        source: wsEntry?.local ? 'installed' : 'pool',
        installedAt: wsEntry?.syncedAt || Date.now(),
        updatedAt: wsEntry?.syncedAt || Date.now(),
        path: skillPath,
        tools,
        knowledge,
      })
    }

    return skills
  }

  // ── 检查 skill 是否需要更新 ─────────────────────────

  checkForUpdates(workspaceId: string): Array<{ name: string; currentVersion: string; latestVersion: string }> {
    const wsManifest = this.readWorkspaceManifest(workspaceId)
    const poolManifest = this.readPoolManifest()
    const updates: Array<{ name: string; currentVersion: string; latestVersion: string }> = []

    for (const [skillName, wsEntry] of Object.entries(wsManifest.skills)) {
      if (wsEntry.local) {continue}
      const poolEntry = poolManifest.skills[skillName]
      if (poolEntry && poolEntry.version !== wsEntry.poolVersion) {
        updates.push({
          name: skillName,
          currentVersion: wsEntry.poolVersion,
          latestVersion: poolEntry.version,
        })
      }
    }

    return updates
  }

  // ── 工具 ────────────────────────────────────────────

  /** 解析 SKILL.md 元数据 */
  parseSkillMeta(content: string): { name: string; description: string; version: string; emoji: string } {
    const result = { name: '', description: '', version: '1.0.0', emoji: '🛠️' }

    // 尝试解析 frontmatter
    const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/)
    if (fmMatch) {
      const fm = fmMatch[1]
      const nameMatch = fm.match(/name:\s*(.+)/)
      const descMatch = fm.match(/description:\s*(.+)/)
      const verMatch = fm.match(/version:\s*(.+)/)
      const emojiMatch = fm.match(/emoji:\s*(.+)/)

      if (nameMatch) {result.name = nameMatch[1].trim()}
      if (descMatch) {result.description = descMatch[1].trim()}
      if (verMatch) {result.version = verMatch[1].trim()}
      if (emojiMatch) {result.emoji = emojiMatch[1].trim()}
    } else {
      // 从第一个 # 标题提取名称
      const titleMatch = content.match(/^#\s+(.+)/m)
      if (titleMatch) {
        const title = titleMatch[1].trim()
        const emojiMatch = title.match(/^([\p{Emoji}])\s*/u)
        if (emojiMatch) {
          result.emoji = emojiMatch[1]
          result.name = title.slice(emojiMatch[1].length).trim()
        } else {
          result.name = title
        }
      }

      // 从第一段提取描述
      const descMatch = content.match(/\n\n([\s\S]{20,200}?)\n\n/)
      if (descMatch) {
        result.description = descMatch[1].replace(/\n/g, ' ').trim()
      }
    }

    if (!result.name) {
      result.name = `skill_${Date.now().toString(36)}`
    }

    return result
  }

  /** 递归复制目录 */
  private copyDir(src: string, dest: string): void {
    if (!fs.existsSync(src)) {return}
    if (!fs.existsSync(dest)) {fs.mkdirSync(dest, { recursive: true })}

    const entries = fs.readdirSync(src, { withFileTypes: true })
    for (const entry of entries) {
      const srcPath = path.join(src, entry.name)
      const destPath = path.join(dest, entry.name)
      if (entry.isDirectory()) {
        this.copyDir(srcPath, destPath)
      } else {
        fs.copyFileSync(srcPath, destPath)
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════
// 全局单例
// ═══════════════════════════════════════════════════════════

let globalSkillPool: SkillPoolService | null = null

export function getSkillPool(): SkillPoolService {
  if (!globalSkillPool) {
    globalSkillPool = new SkillPoolService()
  }
  return globalSkillPool
}
