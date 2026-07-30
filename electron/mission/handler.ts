// ============================================================
// mission/handler.ts — Mission 命令处理器 (v3.5)
//
// 借鉴 QwenPaw Mission Mode command handler:
//   /mission <task> [--verify CMD] [--max-iterations N]
//   /mission status | list | help
// ============================================================

import * as path from 'path'
import * as fs from 'fs'
import type { MissionConfig } from './types'
import {
  createLoopDir, listLoopDirs, getActiveLoopDir,
  readPRD, writeLoopConfig, writeTaskMd, initProgressTxt,
  getStoryProgress, allStoriesPassed,
} from './state'

const DEFAULT_MAX_ITERATIONS = 20

export interface MissionCommandResult {
  type: 'info' | 'start_mission' | 'continue_mission' | 'error'
  message: string
  missionConfig?: MissionConfig
  loopDir?: string
}

/**
 * 解析 /mission 命令
 */
export function parseMissionCommand(
  query: string,
  workingDir: string,
): MissionCommandResult {
  const parts = query.trim().split(/\s+/)
  const subCommand = parts[1]?.toLowerCase()

  // /mission help
  if (!subCommand || subCommand === 'help') {
    return {
      type: 'info',
      message: [
        '📋 **Mission Mode** — 自主多步任务执行',
        '',
        '用法:',
        '  `/mission <任务描述> [--verify CMD] [--max-iterations N]`',
        '  `/mission status` — 查看当前 mission 进度',
        '  `/mission list` — 列出所有 mission',
        '  `/mission continue` — 继续未完成的 mission',
        '  `/mission help` — 显示此帮助',
        '',
        '示例:',
        '  `/mission 实现用户登录功能 --verify "npm test"`',
        '  `/mission 重构支付模块 --max-iterations 30`',
      ].join('\n'),
    }
  }

  // /mission status
  if (subCommand === 'status') {
    const activeDir = getActiveLoopDir(workingDir)
    if (!activeDir) {
      return { type: 'info', message: '没有活跃的 Mission。使用 `/mission <任务>` 创建新的。' }
    }
    const prd = readPRD(activeDir)
    if (!prd) {
      return { type: 'info', message: `Mission 目录存在但 PRD 未找到: ${activeDir}` }
    }
    const progress = getStoryProgress(prd)
    const stories = prd.stories.map(s =>
      `  ${s.status === 'done' ? '✅' : s.status === 'in_progress' ? '🔄' : s.status === 'blocked' ? '🚫' : '⏳'} ${s.id}: ${s.title}`
    ).join('\n')

    return {
      type: 'info',
      message: [
        `📋 **Mission: ${prd.title}**`,
        `进度: ${progress.done}/${progress.total} done, ${progress.pending} pending, ${progress.blocked} blocked`,
        `迭代: ${prd.currentIteration}/${prd.maxIterations}`,
        ``,
        `**Stories:**`,
        stories,
        ``,
        `验证命令: \`${prd.verifyCommands.join(', ') || '(无)'}\``,
        `目录: ${activeDir}`,
      ].join('\n'),
    }
  }

  // /mission list
  if (subCommand === 'list') {
    const dirs = listLoopDirs(workingDir)
    if (dirs.length === 0) {
      return { type: 'info', message: '没有历史 Mission。' }
    }
    const list = dirs.map(d => {
      const prd = readPRD(d)
      if (!prd) return `  📁 ${path.basename(d)} (无 PRD)`
      const progress = getStoryProgress(prd)
      const done = allStoriesPassed(prd) ? '✅' : '🔄'
      return `  ${done} ${path.basename(d)} — ${prd.title} (${progress.done}/${progress.total})`
    }).join('\n')
    return { type: 'info', message: `**历史 Mission:**\n${list}` }
  }

  // /mission continue
  if (subCommand === 'continue') {
    const activeDir = getActiveLoopDir(workingDir)
    if (!activeDir) {
      return { type: 'error', message: '没有可继续的 Mission。' }
    }
    const prd = readPRD(activeDir)
    if (!prd) {
      return { type: 'error', message: 'PRD 未找到，无法继续。' }
    }
    if (allStoriesPassed(prd)) {
      return { type: 'info', message: '✅ 此 Mission 已完成！使用 `/mission <新任务>` 创建新的。' }
    }
    const progress = getStoryProgress(prd)
    return {
      type: 'continue_mission',
      message: `继续 Mission: ${prd.title} (${progress.done}/${progress.total})`,
      loopDir: activeDir,
      missionConfig: {
        taskText: prd.title,
        workingDir,
        maxIterations: prd.maxIterations,
        verifyCommands: prd.verifyCommands.join(','),
      },
    }
  }

  // /mission <task> [--verify CMD] [--max-iterations N]
  return parseNewMission(query, workingDir)
}

function parseNewMission(query: string, workingDir: string): MissionCommandResult {
  const fullQuery = query.replace(/^\/mission\s+/i, '')

  // 解析参数
  let taskText = fullQuery
  let verifyCommands = ''
  let maxIterations = DEFAULT_MAX_ITERATIONS

  const verifyMatch = taskText.match(/--verify\s+"([^"]+)"/)
  if (verifyMatch) {
    verifyCommands = verifyMatch[1]
    taskText = taskText.replace(verifyMatch[0], '').trim()
  }

  const iterMatch = taskText.match(/--max-iterations\s+(\d+)/)
  if (iterMatch) {
    maxIterations = Math.max(1, Math.min(100, parseInt(iterMatch[1], 10)))
    taskText = taskText.replace(iterMatch[0], '').trim()
  }

  // 清理剩余 -- 参数
  taskText = taskText.replace(/--\w+(\s+\S+)?/g, '').trim()

  if (!taskText) {
    return { type: 'error', message: '请提供任务描述。用法: `/mission <任务描述>`' }
  }

  // 创建 mission 目录
  const missionName = taskText.slice(0, 30).replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, '_')
  const loopDir = createLoopDir(workingDir, missionName)

  const config: MissionConfig = {
    taskText,
    verifyCommands: verifyCommands || undefined,
    maxIterations,
    workingDir,
  }

  writeLoopConfig(loopDir, config)
  writeTaskMd(loopDir, taskText)
  initProgressTxt(loopDir, taskText)

  return {
    type: 'start_mission',
    message: [
      `🚀 **Mission 启动**`,
      `任务: ${taskText}`,
      `验证: ${verifyCommands || '(无)'}`,
      `最大迭代: ${maxIterations}`,
      `目录: ${loopDir}`,
      ``,
      `Phase 1: 探索代码库 → 生成 PRD`,
    ].join('\n'),
    missionConfig: config,
    loopDir,
  }
}

export function isMissionCommand(query: string): boolean {
  return /^\/mission/i.test(query)
}
