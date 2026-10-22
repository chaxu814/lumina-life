// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// skillLoader.ts — 动态 Skill 加载系统 (v4.0)
//
// 借鉴 QwenPaw resolve_effective_skills + materialize_skill：
//   1. 启动时扫描 skills/*/SKILL.md → 构建运行时注册表
//   2. buildSystemPrompt() 动态注入 skill 列表
//   3. use_skill(name) 工具 → 按需加载完整 SKILL.md 到上下文
//
// 与旧 agentSkills.ts 的区别：
//   旧：SKILLS 是硬编码在代码里的静态字典
//   新：从文件系统动态扫描，安装 skill 即时生效，无需重新编译
// ============================================================

import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'

// ═══════════════════════════════════════════════════════════
// Skill 运行时定义
// ═══════════════════════════════════════════════════════════

export interface SkillDef {
  /** Skill 唯一 ID（来自目录名） */
  id: string
  /** 名称 */
  name: string
  /** 描述 */
  description: string
  /** 适用场景触发词 */
  triggers: string[]
  /** 完整工作流指导（SKILL.md 正文） */
  workflow: string
  /** 建议使用的工具 */
  suggestedTools: string[]
  /** 适合哪些 agent */
  bestFor: string[]
  /** 不适合哪些 agent */
  notFor: string[]
  /** 示例 */
  examplePrompt: string
  exampleOutput: string
  /** 来源路径 */
  sourcePath: string
  /** 版本 */
  version?: string
}

/**
 * 从 SKILL.md 的 frontmatter 块中解析元数据。
 * 支持 YAML 风格 frontmatter (--- ... ---) 和简化格式。
 */
function parseSkillFrontmatter(content: string): Partial<SkillDef> {
  const meta: Partial<SkillDef> = {}

  // 尝试解析 YAML frontmatter (--- 分隔)
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n/)
  if (fmMatch) {
    const fmText = fmMatch[1]
    // 解析简单的 key: value 和 key: [list]
    const lines = fmText.split('\n')
    for (const line of lines) {
      const colonIdx = line.indexOf(':')
      if (colonIdx === -1) {continue}
      const key = line.slice(0, colonIdx).trim()
      const value = line.slice(colonIdx + 1).trim()

      switch (key) {
        case 'name':
          meta.name = value.replace(/['"]/g, '')
          break
        case 'description':
          meta.description = value.replace(/['"]/g, '')
          break
        case 'version':
          meta.version = value.replace(/['"]/g, '')
          break
        case 'triggers':
          meta.triggers = value
            .replace(/^\[|\]$/g, '')
            .split(',')
            .map((s) => s.trim().replace(/['"]/g, ''))
            .filter(Boolean)
          break
        case 'tools':
        case 'suggestedTools':
          meta.suggestedTools = value
            .replace(/^\[|\]$/g, '')
            .split(',')
            .map((s) => s.trim().replace(/['"]/g, ''))
            .filter(Boolean)
          break
        case 'bestFor':
          meta.bestFor = value
            .replace(/^\[|\]$/g, '')
            .split(',')
            .map((s) => s.trim().replace(/['"]/g, ''))
            .filter(Boolean)
          break
        case 'notFor':
          meta.notFor = value
            .replace(/^\[|\]$/g, '')
            .split(',')
            .map((s) => s.trim().replace(/['"]/g, ''))
            .filter(Boolean)
          break
      }
    }
  }

  return meta
}

/**
 * 从 SKILL.md 内容中提取简介（第一段有意义的话）
 */
function extractBrief(content: string): string {
  // 去掉 frontmatter 块
  const body = content.replace(/^---[\s\S]*?---\s*\n?/, '').trim()
  // 找到第一行非空非标题行
  const lines = body.split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('---')) {
      return trimmed.length > 120 ? trimmed.slice(0, 117) + '...' : trimmed
    }
  }
  return '(无描述)'
}

/**
 * 从 SKILL.md 正文中提取工作流部分
 */
function extractWorkflow(content: string): string {
  const body = content.replace(/^---[\s\S]*?---\s*\n?/, '').trim()

  // 查找 "## 工作流" 或 "## Workflow" section
  const workflowMatch = body.match(/##\s*(?:工作流 |Workflow|工作流|Workflow|##\s*工作流)([\s\S]*?)(?=\n##\s|\n---\s*$|$)/)
  if (workflowMatch) {
    return workflowMatch[0].trim()
  }

  // fallback：返回整个正文
  return body.length > 800 ? body.slice(0, 797) + '...' : body
}

/**
 * 从单一 SKILL.md 文件构建 SkillDef
 */
function buildSkillDef(skillDir: string, skillMdPath: string, dirName: string): SkillDef | null {
  try {
    const content = fs.readFileSync(skillMdPath, 'utf-8')
    const meta = parseSkillFrontmatter(content)

    const name = meta.name || dirName
    const description = meta.description || extractBrief(content)

    return {
      id: dirName,
      name,
      description,
      triggers: meta.triggers || [],
      workflow: extractWorkflow(content),
      suggestedTools: meta.suggestedTools || [],
      bestFor: meta.bestFor || [],
      notFor: meta.notFor || [],
      examplePrompt: '',
      exampleOutput: '',
      sourcePath: skillMdPath,
      version: meta.version,
    }
  } catch (err) {
    console.error(`[SkillLoader] 解析 ${skillMdPath} 失败:`, err)
    return null
  }
}

// ═══════════════════════════════════════════════════════════
// DynamicSkillLoader — 核心类
// ═══════════════════════════════════════════════════════════

export class DynamicSkillLoader {
  private skills: Map<string, SkillDef> = new Map()
  private skillsDirs: string[] = []
  private loaded = false

  constructor(skillsDir?: string) {
    // 多个搜索路径：项目 skills/ → userData skills/ → skill_pool/
    const dirs: string[] = []
    if (skillsDir) {
      dirs.push(skillsDir)
    }
    try {
      const userDataSkills = path.join(app.getPath('userData'), 'skills')
      dirs.push(userDataSkills)
      dirs.push(path.join(app.getPath('userData'), 'skill_pool'))
    } catch {}
    // 也搜索项目根目录下的 skills/
    dirs.push(path.join(process.cwd(), 'skills'))
    this.skillsDirs = dirs
  }

  /**
   * 设置 skills 目录（用于测试或自定义路径）
   */
  setSkillsDir(dir: string): void {
    this.skillsDirs = [dir]
    this.loaded = false
  }

  /**
   * 添加额外的搜索目录
   */
  addSkillsDir(dir: string): void {
    if (!this.skillsDirs.includes(dir)) {
      this.skillsDirs.push(dir)
      this.loaded = false
    }
  }

  /**
   * 扫描所有 skills 目录，加载所有 SKILL.md
   */
  loadAll(): SkillDef[] {
    if (this.loaded) {return Array.from(this.skills.values())}
    this.skills.clear()

    for (const skillsDir of this.skillsDirs) {
      if (!fs.existsSync(skillsDir)) {continue}

      try {
        const entries = fs.readdirSync(skillsDir, { withFileTypes: true })
        for (const entry of entries) {
          if (!entry.isDirectory()) {continue}
          // 跳过已经加载的同名 skill
          if (this.skills.has(entry.name)) {continue}

          const skillMdPath = path.join(skillsDir, entry.name, 'SKILL.md')
          if (!fs.existsSync(skillMdPath)) {continue}

          const skill = buildSkillDef(skillsDir, skillMdPath, entry.name)
          if (skill) {
            this.skills.set(skill.id, skill)
            console.log(`[SkillLoader] ✅ 加载: ${skill.name} (${skill.id}) ← ${skillsDir}`)
          }
        }
      } catch (err) {
        console.warn(`[SkillLoader] 扫描 ${skillsDir} 失败:`, err)
      }
    }

    this.loaded = true
    console.log(`[SkillLoader] 共加载 ${this.skills.size} 个 Skills (来自 ${this.skillsDirs.length} 个目录)`)
    return Array.from(this.skills.values())
  }

  /**
   * 强制重新加载
   */
  reload(): SkillDef[] {
    this.loaded = false
    return this.loadAll()
  }

  /**
   * 获取单个 Skill
   */
  getSkill(id: string): SkillDef | undefined {
    if (!this.loaded) {this.loadAll()}
    return this.skills.get(id)
  }

  /**
   * 获取所有已加载的 Skills
   */
  getAllSkills(): SkillDef[] {
    if (!this.loaded) {this.loadAll()}
    return Array.from(this.skills.values())
  }

  /**
   * 为指定 agent 匹配推荐的 Skills
   */
  getSkillsForAgent(agentId: string): SkillDef[] {
    if (!this.loaded) {this.loadAll()}
    return Array.from(this.skills.values()).filter(
      (s) =>
        (s.bestFor.length === 0 || s.bestFor.includes(agentId)) &&
        !s.notFor.includes(agentId)
    )
  }

  /**
   * 根据任务描述匹配最合适的 Skill
   */
  matchSkill(taskDescription: string): SkillDef | null {
    if (!this.loaded) {this.loadAll()}
    const lower = taskDescription.toLowerCase()
    let bestMatch: SkillDef | null = null
    let bestScore = 0

    for (const skill of this.skills.values()) {
      let score = 0
      // 名称匹配权重高
      if (lower.includes(skill.name.toLowerCase())) {score += 3}
      // 触发词匹配
      for (const trigger of skill.triggers) {
        if (lower.includes(trigger.toLowerCase())) {score += 1}
      }
      // 描述匹配
      if (lower.includes(skill.description.toLowerCase())) {score += 1}

      if (score > bestScore) {
        bestScore = score
        bestMatch = skill
      }
    }

    return bestMatch
  }

  /**
   * 列出所有可用 Skill（供 list_skills 工具使用）
   */
  listSkills(): { id: string; name: string; description: string; version?: string }[] {
    if (!this.loaded) {this.loadAll()}
    return Array.from(this.skills.values()).map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      version: s.version,
    }))
  }

  /**
   * 构建注入到 system prompt 的 Skill 上下文
   */
  getSkillsContextForPrompt(agentId: string): string {
    if (!this.loaded) {this.loadAll()}
    const agentSkills = this.getSkillsForAgent(agentId)
    if (agentSkills.length === 0) {return ''}

    const lines = ['\n## 可用 Skills\n', '以下 Skills 提供了专业工作流指导。调用 `use_skill(name)` 加载详细内容。\n']

    for (const skill of agentSkills) {
      lines.push(`- **${skill.name}** (\`${skill.id}\`): ${skill.description}`)
    }

    lines.push(
      '\n💡 Skills 不是工具，是"方法论"。严格按工作流执行，不要跳过步骤。'
    )
    return lines.join('\n')
  }

  /**
   * 为 use_skill 工具加载完整的 Skill 上下文
   */
  materializeSkill(skillId: string): string {
    const skill = this.getSkill(skillId)
    if (!skill) {return `❌ Skill 不存在: ${skillId}\n\n可用 Skills: ${this.listSkills().map(s => s.id).join(', ')}`}

    return `\n【已加载 Skill：${skill.name}】\n${skill.description}\n\n${skill.workflow}\n\n💡 严格按工作流执行，不要跳过步骤。`
  }
}

// 单例
let _dynamicLoader: DynamicSkillLoader | null = null
export function getDynamicSkillLoader(): DynamicSkillLoader {
  if (!_dynamicLoader) {_dynamicLoader = new DynamicSkillLoader()}
  return _dynamicLoader
}

/** 重置单例（测试用） */
export function resetDynamicSkillLoader(): void {
  _dynamicLoader = null
}
