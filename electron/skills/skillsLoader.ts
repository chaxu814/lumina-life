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
  let inTable = false
  let inCodeBlock = false
  const lines = md.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // 跳过代码块
    if (line.trimStart().startsWith('```')) {
      inCodeBlock = !inCodeBlock
      continue
    }
    if (inCodeBlock) continue

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

/** 从 electron/skills/ 加载所有技能 */
export function loadAllSkills(): SkillManifest[] {
  const results: SkillManifest[] = []

  if (!fs.existsSync(SKILLS_DIR)) {
    console.warn('[SkillsLoader] skills 目录不存在:', SKILLS_DIR)
    return results
  }

  const entries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const skillDir = path.join(SKILLS_DIR, entry.name)
      const manifest = loadSingleSkill(skillDir)
      if (manifest) {
        results.push(manifest)
      }
    }
  }

  return results
}

/** 按技能名加载单个技能 */
export function loadSkill(name: string): SkillManifest | null {
  const skillDir = path.join(SKILLS_DIR, name)
  if (!fs.existsSync(skillDir) || !fs.statSync(skillDir).isDirectory()) {
    return null
  }
  return loadSingleSkill(skillDir)
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
