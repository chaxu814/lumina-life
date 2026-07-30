// ============================================================
// mission/state.ts — Mission 状态管理 (v3.5)
//
// 管理 PRD 文件读写、进度追踪、loop 目录
// ============================================================

import * as fs from 'fs'
import * as path from 'path'
import type { PRD, UserStory, MissionConfig, MissionPhase } from './types'

export function createLoopDir(workingDir: string, missionName: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const dirName = `mission_${missionName}_${timestamp}`
  const loopDir = path.join(workingDir, '.missions', dirName)
  fs.mkdirSync(loopDir, { recursive: true })
  return loopDir
}

export function listLoopDirs(workingDir: string): string[] {
  const missionsDir = path.join(workingDir, '.missions')
  if (!fs.existsSync(missionsDir)) return []
  return fs.readdirSync(missionsDir)
    .filter(d => d.startsWith('mission_'))
    .map(d => path.join(missionsDir, d))
}

export function getActiveLoopDir(workingDir: string): string | null {
  const dirs = listLoopDirs(workingDir)
  if (dirs.length === 0) return null
  // 返回最新的
  return dirs.sort().reverse()[0]
}

export function readPRD(loopDir: string): PRD | null {
  const prdPath = path.join(loopDir, 'prd.json')
  if (!fs.existsSync(prdPath)) return null
  try {
    return JSON.parse(fs.readFileSync(prdPath, 'utf-8'))
  } catch {
    return null
  }
}

export function writePRD(loopDir: string, prd: PRD): void {
  const prdPath = path.join(loopDir, 'prd.json')
  prd.updatedAt = new Date().toISOString()
  fs.writeFileSync(prdPath, JSON.stringify(prd, null, 2), 'utf-8')
}

export function updateStoryStatus(loopDir: string, storyId: string, status: UserStory['status']): boolean {
  const prd = readPRD(loopDir)
  if (!prd) return false
  const story = prd.stories.find(s => s.id === storyId)
  if (!story) return false
  story.status = status
  if (status === 'done') story.completedAt = new Date().toISOString()
  writePRD(loopDir, prd)
  return true
}

export function initProgressTxt(loopDir: string, taskText: string): void {
  const progressPath = path.join(loopDir, 'progress.txt')
  const content = [
    `# Mission Progress`,
    `任务: ${taskText}`,
    `开始时间: ${new Date().toISOString()}`,
    `状态: 初始化中...`,
    ``,
  ].join('\n')
  fs.writeFileSync(progressPath, content, 'utf-8')
}

export function appendProgress(loopDir: string, text: string): void {
  const progressPath = path.join(loopDir, 'progress.txt')
  const timestamp = new Date().toISOString().slice(11, 19)
  fs.appendFileSync(progressPath, `[${timestamp}] ${text}\n`, 'utf-8')
}

export function readLoopConfig(loopDir: string): { taskText: string; maxIterations: number } | null {
  const configPath = path.join(loopDir, 'config.json')
  if (!fs.existsSync(configPath)) return null
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf-8'))
  } catch {
    return null
  }
}

export function writeLoopConfig(loopDir: string, config: MissionConfig): void {
  const configPath = path.join(loopDir, 'config.json')
  fs.writeFileSync(configPath, JSON.stringify({
    taskText: config.taskText,
    maxIterations: config.maxIterations || 20,
    verifyCommands: config.verifyCommands || '',
  }, null, 2), 'utf-8')
}

export function writeTaskMd(loopDir: string, taskText: string): void {
  const taskPath = path.join(loopDir, 'TASK.md')
  fs.writeFileSync(taskPath, `# 任务\n\n${taskText}\n\n---\n自动生成于 ${new Date().toISOString()}`, 'utf-8')
}

export function detectGitContext(workingDir: string): string {
  const gitDir = path.join(workingDir, '.git')
  if (fs.existsSync(gitDir)) {
    return `Git 项目: ${path.basename(workingDir)}`
  }
  return ''
}

// ═══════════════════════════════════════════════════════════
// PRD 验证
// ═══════════════════════════════════════════════════════════

export function validatePRD(prd: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = []
  if (!prd || typeof prd !== 'object') {
    return { valid: false, errors: ['PRD 不是有效的 JSON 对象'] }
  }
  const p = prd as Record<string, unknown>
  if (!p.title) errors.push('缺少 title')
  if (!p.summary) errors.push('缺少 summary')
  if (!Array.isArray(p.stories)) {
    errors.push('stories 必须是数组')
  } else if (p.stories.length === 0) {
    errors.push('stories 不能为空')
  } else {
    for (let i = 0; i < p.stories.length; i++) {
      const s = p.stories[i] as Record<string, unknown>
      if (!s.id) errors.push(`stories[${i}].id 缺失`)
      if (!s.title) errors.push(`stories[${i}].title 缺失`)
      if (!Array.isArray(s.acceptanceCriteria)) {
        errors.push(`stories[${i}].acceptanceCriteria 必须是数组`)
      }
    }
  }
  if (!Array.isArray(p.verifyCommands)) errors.push('verifyCommands 必须是数组')

  return { valid: errors.length === 0, errors }
}

export function allStoriesPassed(prd: PRD): boolean {
  if (!prd.stories || prd.stories.length === 0) return false
  return prd.stories.every(s => s.status === 'done' || s.status === 'skipped')
}

export function getStoryProgress(prd: PRD): { total: number; done: number; pending: number; blocked: number } {
  return {
    total: prd.stories.length,
    done: prd.stories.filter(s => s.status === 'done').length,
    pending: prd.stories.filter(s => s.status === 'pending' || s.status === 'in_progress').length,
    blocked: prd.stories.filter(s => s.status === 'blocked').length,
  }
}
