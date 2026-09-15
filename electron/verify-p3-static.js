// ============================================================
// verify-p3-static.js — P3/P4 静态验证脚本
//
// 不运行 TS 代码，只检查：
//   1. 文件是否存在
//   2. 关键代码是否存在
//   3. 目录结构是否正确
// ============================================================

const fs = require('fs')
const path = require('path')

const LUMINA_ROOT = 'K:\\Lumina 2\\Lumina AI'

// ── 检查项 ──────────────────────────────────────────────────

const checks = {
  'P3-1: agent.json 拆分': [
    { type: 'file', path: 'userData/agents/lumina/agent.json' },
    { type: 'file', path: 'userData/agents/yak/agent.json' },
    { type: 'file', path: 'userData/agents/recha/agent.json' },
    { type: 'code', file: 'electron/agentProfileManager.ts', pattern: 'export class AgentProfileManager' },
    { type: 'code', file: 'electron/agentConfig.ts', pattern: 'buildRunConfig' },
    { type: 'code', file: 'electron/agentRunConfigBuilder.ts', pattern: 'export function buildAgentRunConfig' },
  ],
  'P3-2: chats.json 分离': [
    { type: 'file', path: 'userData/agents/lumina/chats.json' },
    { type: 'file', path: 'userData/agents/yak/chats.json' },
    { type: 'file', path: 'userData/agents/recha/chats.json' },
    { type: 'code', file: 'electron/agentChatsManager.ts', pattern: 'export class AgentChatsManager' },
  ],
  'P3-3: jobs.json 分离': [
    { type: 'file', path: 'userData/agents/lumina/jobs.json' },
    { type: 'file', path: 'userData/agents/yak/jobs.json' },
    { type: 'file', path: 'userData/agents/recha/jobs.json' },
    { type: 'code', file: 'electron/agentJobsManager.ts', pattern: 'export class AgentJobsManager' },
  ],
  'P3-4: MEMORY.md + memory/ 目录': [
    { type: 'file', path: 'userData/agents/lumina/memory/MEMORY.md' },
    { type: 'file', path: 'userData/agents/yak/memory/MEMORY.md' },
    { type: 'file', path: 'userData/agents/recha/memory/MEMORY.md' },
    { type: 'code', file: 'electron/agentMemoryManager.ts', pattern: 'export class AgentMemoryManager' },
  ],
  'P3-5: 跨 Agent 通信 (spawn_subagent fork)': [
    { type: 'code', file: 'electron/delegationManager.ts', pattern: 'getAsyncTaskManager' },
    { type: 'code', file: 'electron/delegationManager.ts', pattern: '_waitForTaskCompletion' },
    { type: 'code', file: 'electron/delegationManager.ts', pattern: '_buildWorkerSystemPrompt' },
    { type: 'code', file: 'electron/asyncTaskManager.ts', pattern: 'export function getAsyncTaskManager' },
  ],
  'P4-1: dialog/ 原始归档': [
    { type: 'code', file: 'electron/agentDialogManager.ts', pattern: 'export class AgentDialogManager' },
    { type: 'code', file: 'electron/agentDialogManager.ts', pattern: 'appendMessage' },
    { type: 'code', file: 'electron/agentDialogManager.ts', pattern: 'readByDate' },
  ],
  'P4-2: 后台任务持久化': [
    { type: 'code', file: 'electron/asyncTaskManager.ts', pattern: '_persist()' },
    { type: 'code', file: 'electron/asyncTaskManager.ts', pattern: '_load()' },
    { type: 'code', file: 'electron/asyncTaskManager.ts', pattern: 'PERSIST_INTERVAL' },
  ],
  'P4-3: Markdown 记忆': [
    { type: 'code', file: 'electron/agentMemoryManager.ts', pattern: 'MEMORY.md' },
    { type: 'code', file: 'electron/agentMemoryManager.ts', pattern: 'memory.json' },
  ],
  'P4-4: 混合检索': [
    { type: 'file', path: 'electron/hybridMemoryRetrieval.ts' },
    { type: 'code', file: 'electron/hybridMemoryRetrieval.ts', pattern: 'class BM25' },
    { type: 'code', file: 'electron/hybridMemoryRetrieval.ts', pattern: 'export class HybridMemoryRetrieval' },
  ],
  'P4-5: 自动精炼': [
    { type: 'file', path: 'electron/autoRefineManager.ts' },
    { type: 'code', file: 'electron/autoRefineManager.ts', pattern: 'export class AutoRefineManager' },
    { type: 'code', file: 'electron/autoRefineManager.ts', pattern: 'runRefine' },
  ],
  'P3-5: 统一入口': [
    { type: 'file', path: 'electron/agentWorkspaceManager.ts' },
    { type: 'code', file: 'electron/agentWorkspaceManager.ts', pattern: 'export class AgentWorkspaceManager' },
    { type: 'code', file: 'electron/agentWorkspaceManager.ts', pattern: 'initAgentWorkspaceManager' },
  ],
}

// ── 执行检查 ──────────────────────────────────────────────

function checkFile(relPath) {
  const fullPath = path.join(LUMINA_ROOT, relPath)
  return fs.existsSync(fullPath)
}

function checkCode(relFile, pattern) {
  const fullPath = path.join(LUMINA_ROOT, relFile)
  if (!fs.existsSync(fullPath)) return false
  const content = fs.readFileSync(fullPath, 'utf-8')
  return content.includes(pattern)
}

function runChecks() {
  console.log('═══════════════════════════════════════════')
  console.log('  P3/P4 静态验证报告')
  console.log('═══════════════════════════════════════════\n')

  let totalChecks = 0
  let passedChecks = 0

  for (const [category, items] of Object.entries(checks)) {
    console.log(`[${category}]`)
    let categoryPassed = true

    for (const item of items) {
      totalChecks++
      let passed = false

      if (item.type === 'file') {
        passed = checkFile(item.path)
        console.log(`  ${passed ? '✅' : '❌'} ${item.path}`)
      } else if (item.type === 'code') {
        passed = checkCode(item.file, item.pattern)
        console.log(`  ${passed ? '✅' : '❌'} ${item.file} 包含 "${item.pattern}"`)
      }

      if (passed) passedChecks++
      else categoryPassed = false
    }

    console.log(`  结果: ${categoryPassed ? '✅ 全部通过' : '❌ 存在缺失'}\n`)
  }

  console.log('═══════════════════════════════════════════')
  console.log(`  总计: ${passedChecks}/${totalChecks} 项检查通过`)
  console.log(`  通过率: ${((passedChecks / totalChecks) * 100).toFixed(1)}%`)
  console.log('═══════════════════════════════════════════\n')

  // 列出所有 Agent 目录结构
  console.log('[Agent 目录结构]')
  const agents = ['lumina', 'yak', 'recha']
  for (const agent of agents) {
    const agentDir = path.join(LUMINA_ROOT, 'userData/agents', agent)
    if (fs.existsSync(agentDir)) {
      const files = fs.readdirSync(agentDir).filter(f => !f.startsWith('.'))
      console.log(`  ${agent}/: ${files.join(', ')}`)
    } else {
      console.log(`  ${agent}/: ❌ 目录不存在`)
    }
  }

  // 列出 asyncTaskManager 持久化文件
  const asyncTaskPath = path.join(LUMINA_ROOT, 'userData/async-tasks.json')
  if (fs.existsSync(asyncTaskPath)) {
    const data = JSON.parse(fs.readFileSync(asyncTaskPath, 'utf-8'))
    console.log(`\n[AsyncTaskManager 持久化]`)
    console.log(`  任务数: ${data.tasks?.length || 0}`)
    console.log(`  队列: ${data.queue?.length || 0}`)
  }
}

runChecks()
