// ============================================================
// skillPipeline.ts — SKILL.md → System Prompt 注入管道
//
// 借鉴 QwenPaw skills_manager.py 设计：
//   - Skill 不只是工具开关，而是能力注入
//   - SKILL.md 中的工作流指导自动注入 system prompt
//   - 按场景激活相关 Skill
// ============================================================

import * as fs from 'fs'
import * as path from 'path'

export interface SkillDefinition {
  id: string; name: string; description: string
  skillMd: string; workflowGuidance: string
  tools: string[]; triggers: string[]
  version: string; sourcePath: string
}

export class SkillPipeline {
  private skills: Map<string, SkillDefinition> = new Map()
  private activeSkillIds: Set<string> = new Set()
  private skillsDir: string

  constructor(skillsDir: string) {
    this.skillsDir = skillsDir
  }

  async discover(): Promise<SkillDefinition[]> {
    if (!fs.existsSync(this.skillsDir)) {return []}
    const entries = fs.readdirSync(this.skillsDir, { withFileTypes: true })
    const discovered: SkillDefinition[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) {continue}
      const skillDir = path.join(this.skillsDir, entry.name)
      const skillMdPath = path.join(skillDir, 'SKILL.md')
      if (!fs.existsSync(skillMdPath)) {continue}
      try {
        const skill = this._parseSkill(skillDir, skillMdPath, entry.name)
        if (skill) { this.skills.set(skill.id, skill); discovered.push(skill) }
      } catch (err: any) {
        console.warn(`[SkillPipeline] parse error ${entry.name}: ${err.message}`)
      }
    }
    return discovered
  }

  enable(id: string): boolean { if (!this.skills.has(id)) {return false;} this.activeSkillIds.add(id); return true }
  disable(id: string): boolean { return this.activeSkillIds.delete(id) }
  enableAll(ids: string[]): void { ids.forEach(id => { if (this.skills.has(id)) {this.activeSkillIds.add(id)} }) }

  matchSkills(userInput: string): SkillDefinition[] {
    const lower = userInput.toLowerCase()
    return Array.from(this.activeSkillIds)
      .map(id => this.skills.get(id)!)
      .filter(s => s && s.triggers.some(t => lower.includes(t.toLowerCase())))
      .sort((a, b) =>
        b.triggers.filter(t => lower.includes(t.toLowerCase())).length -
        a.triggers.filter(t => lower.includes(t.toLowerCase())).length
      )
  }

  getSkillPrompt(userInput?: string): string {
    if (this.activeSkillIds.size === 0) {return ''}
    const relevant = userInput ? this.matchSkills(userInput) : this.getEnabledSkills()
    if (relevant.length === 0) {return ''}
    const parts: string[] = ['## Agent Skills']
    parts.push('Each skill has a SKILL.md file. If you want to use a skill, read its SKILL.md first.')
    for (const s of relevant) {
      parts.push(`### ${s.name}`)
      parts.push(s.description)
      if (s.workflowGuidance) {parts.push(s.workflowGuidance)}
      parts.push(`Check "${s.sourcePath}/SKILL.md" for details.`)
    }
    return parts.join('\n')
  }

  getSkillMd(skillId: string): string | null { return this.skills.get(skillId)?.skillMd || null }
  getAllSkills(): SkillDefinition[] { return Array.from(this.skills.values()) }
  getEnabledSkills(): SkillDefinition[] {
    return Array.from(this.activeSkillIds).map(id => this.skills.get(id)!).filter(Boolean)
  }
  getEnabledTools(): string[] {
    const tools: string[] = []
    for (const id of this.activeSkillIds) {
      const s = this.skills.get(id); if (s) {tools.push(...s.tools)}
    }
    return [...new Set(tools)]
  }

  private _parseSkill(skillDir: string, skillMdPath: string, dirName: string): SkillDefinition | null {
    const raw = fs.readFileSync(skillMdPath, 'utf-8').trim()
    let desc = '', version = '0.1.0', content = raw
    if (raw.startsWith('---')) {
      const end = raw.indexOf('---', 3)
      if (end > 0) {
        const fm = raw.slice(3, end); content = raw.slice(end + 3).trim()
        for (const line of fm.split('\n')) {
          const ci = line.indexOf(':')
          if (ci > 0) { const k = line.slice(0, ci).trim(), v = line.slice(ci + 1).trim()
            if (k === 'description') {desc = v;} if (k === 'version') {version = v} }
        }
      }
    }
    const triggers = this._extractTriggers(content, dirName)
    const tools = this._extractTools(content)
    const workflow = content.slice(0, 300).trim()
    return { id: dirName, name: dirName, description: desc, skillMd: raw,
      workflowGuidance: workflow, tools, triggers, version, sourcePath: skillDir }
  }

  private _extractTriggers(content: string, dirName: string): string[] {
    const triggers = [dirName.toLowerCase()]
    const m = content.match(/(?:Triggers|触发(?:词|场景))[：:]\s*\n((?:\s*[-*]\s*.+\n?)+)/i)
    if (m) {for (const line of m[1].split('\n')) {
      const c = line.replace(/^\s*[-*]\s*/, '').trim()
      if (c && !c.startsWith('//')) {triggers.push(c.toLowerCase())}
    }}
    return [...new Set(triggers)]
  }

  private _extractTools(content: string): string[] {
    const tools: string[] = []
    const regex = /`([a-z_]+)`/g; let match: RegExpExecArray | null
    while ((match = regex.exec(content)) !== null) {
      if (match[1].length > 3 && !/^[A-Z]+$/.test(match[1])) {tools.push(match[1])}
    }
    return [...new Set(tools)].slice(0, 20)
  }
}

let _pipeline: SkillPipeline | null = null
export function getSkillPipeline(skillsDir?: string): SkillPipeline {
  if (!_pipeline) {_pipeline = new SkillPipeline(skillsDir || path.join(process.cwd(), 'skills'))}
  return _pipeline
}
export function resetSkillPipeline(): void { _pipeline = null }
