// ============================================================
// skillsLoader.ts — 技能目录加载器 (v14.0, QwenPaw 风格)
//
// QwenPaw 的做法：技能定义在 SKILL.md 文件中，运行时按需加载。
// Lumina v14.0: 从 electron/skills/<name>/SKILL.md 读取技能描述，
//   转成 ToolDef[] 供 reactEngine 和 registry 使用。
//
// 目录结构：
//   electron/skills/
//     files_core/SKILL.md    — 文件操作（核心）
//     shell/SKILL.md         — 终端命令
//     web_search/SKILL.md    — 搜索+抓取+浏览器
//     memory/SKILL.md        — 记忆系统
//     tasks/SKILL.md         — 任务与定时器
//     system/SKILL.md        — 系统工具
//     team/SKILL.md          — 团队协作
//     git/SKILL.md           — Git 操作
//     mcp/SKILL.md           — MCP 服务器连接（选装）
//
// 加载流程：
//   loadAllSkills() → 扫描 skills/ 目录 → 解析 SKILL.md → 返回 ToolDef[]
//   合并到 registry.ts 的 TOOLSETS 中
// ============================================================

import * as fs from 'fs'
import * as path from 'path'
import type { ToolDef } from '../tools/types'

const SKILLS_DIR = path.resolve(__dirname, '..', 'skills')

// ============================================================
// 用户技能目录（v15.0）
//   - 位置: <userData>/skills/（与 Lumina 其它数据同目录）
//   - 用户技能与内置技能同名时，用户技能覆盖内置技能
//   - 启用状态: <userData>/skills/disabled.json 记录被禁用的技能名列表；
//     单个用户技能目录下也可放一个 `.disabled` 空文件作为禁用标记
// ============================================================

/** 获取用户技能目录（Electron userData/skills）；非 Electron 环境返回空串 */
function getUserSkillsDir(): string {
  try {
    // 复用 paths.ts 的优雅解析（Electron 可用时返回 app.getPath('userData')）
    const { appDataDir } = require('../paths')
    if (typeof appDataDir === 'function') {
      return path.join(appDataDir(), 'skills')
    }
  } catch { /* paths 不可用 */ }
  return ''
}

/** 读取被禁用的技能名集合（来自 disabled.json） */
function readDisabledSet(): Set<string> {
  const dir = getUserSkillsDir()
  if (!dir) {return new Set()}
  try {
    const file = path.join(dir, 'disabled.json')
    if (fs.existsSync(file)) {
      const arr = JSON.parse(fs.readFileSync(file, 'utf-8'))
      if (Array.isArray(arr)) {
        return new Set(arr.filter((x: unknown) => typeof x === 'string') as string[])
      }
    }
  } catch (err) {
    console.warn('[SkillsLoader] 读取 disabled.json 失败:', err)
  }
  return new Set()
}

/** 写回被禁用的技能名集合 */
function writeDisabledSet(set: Set<string>): void {
  const dir = getUserSkillsDir()
  if (!dir) {return}
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'disabled.json'),
      JSON.stringify([...set], null, 2),
      'utf-8',
    )
  } catch (err) {
    console.warn('[SkillsLoader] 写入 disabled.json 失败:', err)
  }
}

/** 判断技能是否被禁用（全局 disabled.json 或目录内 .disabled 标记） */
function isSkillDisabled(name: string, skillDir?: string): boolean {
  if (readDisabledSet().has(name)) {return true}
  if (skillDir) {
    try {
      if (fs.existsSync(path.join(skillDir, '.disabled'))) {return true}
    } catch { /* ignore */ }
  }
  return false
}

/** 从 SKILL.md 内容提取首行标题（`# xxx`），作为展示用描述 */
function firstTitle(md: string): string {
  const m = md.match(/^#\s+(.+)$/m)
  return m ? m[1].trim() : ''
}

export interface SkillManifest {
  /** 技能名称 = 目录名 */
  name: string
  /** SKILL.md 的完整内容 */
  description: string
  /** SKILL.md 解析出的工具列表 (从 markdown 表格提取工具名) */
  tools: string[]
  /** 技能目录路径 */
  dir: string
}

/** 从 SKILL.md 内容中提取工具列表（解析 Markdown 表格的 `|名称|描述|` 行） */
function extractToolNames(md: string): string[] {
  const tools: string[] = []
  // 匹配 Markdown 表格行: | tool_name | 描述 |
  const tableRowRegex = /^\|\s*(`[^`]+`|\w+)\s*\|/gm
  const inTable = false
  let inCodeBlock = false
  const lines = md.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // 跳过代码块
    if (line.trimStart().startsWith('```')) {
      inCodeBlock = !inCodeBlock
      continue
    }
    if (inCodeBlock) {continue}

    // 检测表格区域（以 | 开头且包含 --- 的行是表头分隔）
    if (line.trim().startsWith('|') && line.includes('---')) {
      // 这是表头分隔行，跳过
      continue
    }

    // 提取表格行
    if (line.trim().startsWith('|') && line.trim().endsWith('|') && !line.includes('---')) {
      const cells = line.split('|').filter(c => c.trim())
      if (cells.length >= 1) {
        const nameCell = cells[0]?.trim()
        // 去除反引号 (如 `file_read`)
        const toolName = nameCell.replace(/`/g, '').trim()
        if (toolName && /^[a-z_]+$/i.test(toolName)) {
          tools.push(toolName)
        }
      }
    }
  }

  return [...new Set(tools)] // 去重
}

/** 加载单个技能目录的 SKILL.md */
function loadSingleSkill(skillDir: string): SkillManifest | null {
  const name = path.basename(skillDir)
  const skillFile = path.join(skillDir, 'SKILL.md')

  if (!fs.existsSync(skillFile)) {
    return null
  }

  try {
    const mdContent = fs.readFileSync(skillFile, 'utf-8')
    const tools = extractToolNames(mdContent)

    return {
      name,
      description: mdContent,
      tools,
      dir: skillDir,
    }
  } catch (err) {
    console.warn(`[SkillsLoader] 加载技能 "${name}" 失败:`, err)
    return null
  }
}

/** 扫描某个目录下的所有技能目录，返回 SkillManifest[]（已过滤禁用项） */
function scanSkillDirs(rootDir: string): SkillManifest[] {
  const results: SkillManifest[] = []
  if (!fs.existsSync(rootDir)) {return results}

  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true })
  } catch (err) {
    console.warn(`[SkillsLoader] 读取目录失败 ${rootDir}:`, err)
    return results
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {continue}
    // 隐藏目录（如 .git）跳过；但保留用户可放技能的普通目录
    if (entry.name.startsWith('.')) {continue}

    const skillDir = path.join(rootDir, entry.name)
    if (isSkillDisabled(entry.name, skillDir)) {continue}

    const manifest = loadSingleSkill(skillDir)
    if (manifest) {
      results.push(manifest)
    }
  }
  return results
}

/**
 * 加载所有技能（内置 + 用户）。
 * - 先加载内置技能 electron/skills/
 * - 再加载用户技能 <userData>/skills/；同名时用户技能覆盖内置技能
 * - 被禁用的技能（disabled.json 或 .disabled 标记）不会出现
 */
export function loadAllSkills(): SkillManifest[] {
  const results: SkillManifest[] = []

  // 1) 内置技能
  const builtin = scanSkillDirs(SKILLS_DIR)
  for (const m of builtin) {
    const idx = results.findIndex(r => r.name === m.name)
    if (idx >= 0) {results[idx] = m} else {results.push(m)}
  }

  // 2) 用户技能（优先覆盖同名内置技能）
  const userDir = getUserSkillsDir()
  if (userDir) {
    const userSkills = scanSkillDirs(userDir)
    for (const m of userSkills) {
      const idx = results.findIndex(r => r.name === m.name)
      if (idx >= 0) {results[idx] = m} else {results.push(m)}
    }
  }

  return results
}

/** 按技能名加载单个技能（用户目录优先，再回退到内置目录） */
export function loadSkill(name: string): SkillManifest | null {
  // 1) 用户目录优先
  const userDir = getUserSkillsDir()
  if (userDir) {
    const userSkillDir = path.join(userDir, name)
    try {
      if (fs.existsSync(userSkillDir) && fs.statSync(userSkillDir).isDirectory()) {
        const m = loadSingleSkill(userSkillDir)
        if (m) {return m}
      }
    } catch { /* ignore */ }
  }

  // 2) 回退到内置目录
  const skillDir = path.join(SKILLS_DIR, name)
  if (!fs.existsSync(skillDir) || !fs.statSync(skillDir).isDirectory()) {
    return null
  }
  return loadSingleSkill(skillDir)
}

// ============================================================
// 用户技能管理（v15.0）
// ============================================================

export interface UserSkillInfo {
  /** 技能名 = 目录名 */
  name: string
  /** SKILL.md 首行标题 */
  title: string
  /** 是否启用（未被禁用） */
  enabled: boolean
  /** 技能目录绝对路径 */
  dir: string
  /** 来源: builtin 内置 / user 用户 */
  source: 'builtin' | 'user'
}

/** 列出用户技能目录下的所有技能（含启用状态） */
export function listUserSkills(): UserSkillInfo[] {
  const result: UserSkillInfo[] = []
  const disabled = readDisabledSet()
  const userDir = getUserSkillsDir()
  if (!userDir || !fs.existsSync(userDir)) {return result}

  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(userDir, { withFileTypes: true })
  } catch {
    return result
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) {continue}
    const skillDir = path.join(userDir, entry.name)
    const skillFile = path.join(skillDir, 'SKILL.md')
    if (!fs.existsSync(skillFile)) {continue}

    let title = entry.name
    try {
      title = firstTitle(fs.readFileSync(skillFile, 'utf-8')) || entry.name
    } catch { /* ignore */ }

    const hasMarker = fs.existsSync(path.join(skillDir, '.disabled'))
    const enabled = !disabled.has(entry.name) && !hasMarker

    result.push({
      name: entry.name,
      title,
      enabled,
      dir: skillDir,
      source: 'user',
    })
  }

  return result.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * 启用技能：从 disabled.json 移除该技能名，并删除用户技能目录下的 .disabled 标记。
 * 返回是否状态发生了变化。
 */
export function enableSkill(name: string): boolean {
  const set = readDisabledSet()
  const wasDisabled = set.delete(name)

  // 同时删除用户技能目录下的 .disabled 标记
  let markerRemoved = false
  const userDir = getUserSkillsDir()
  if (userDir) {
    const marker = path.join(userDir, name, '.disabled')
    try {
      if (fs.existsSync(marker)) {
        fs.unlinkSync(marker)
        markerRemoved = true
      }
    } catch (err) {
      console.warn(`[SkillsLoader] 删除 .disabled 失败 (${name}):`, err)
    }
  }

  if (wasDisabled) {
    writeDisabledSet(set)
  }
  return wasDisabled || markerRemoved
}

/**
 * 禁用技能：把技能名加入 disabled.json。
 * 对内置技能同样生效（加载时会跳过）。
 * 返回是否状态发生了变化。
 */
export function disableSkill(name: string): boolean {
  const set = readDisabledSet()
  const wasPresent = set.has(name)
  set.add(name)
  writeDisabledSet(set)
  return !wasPresent
}

/** 合并到 registry 的 TOOLSETS：将每个技能映射为 tools[] 定义 */
export function skillsToToolsetDefs(): Record<string, { description: string; tools: string[] }> {
  const skills = loadAllSkills()
  const result: Record<string, { description: string; tools: string[] }> = {}

  for (const skill of skills) {
    if (skill.tools.length > 0) {
      result[skill.name] = {
        description: skill.description,
        tools: skill.tools,
      }
    }
  }

  return result
}
