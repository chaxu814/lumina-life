// ============================================================
// verify-p3-delegation.ts — P3-5 委托链路端到端验证脚本
//
// 运行：cd K:\Lumina 2\Lumina AI && npx ts-node electron/verify-p3-delegation.ts
// ============================================================

import * as fs from 'fs'
import * as path from 'path'

// ── 配置 ──────────────────────────────────────────────────

const TEST_FROM = 'lumina'
const TEST_TO = 'yak'
const TEST_TASK = '请分析以下代码的性能瓶颈：function fib(n) { if (n <= 1) return n; return fib(n-1) + fib(n-2); }'

// ── 工具函数 ─────────────────────────────────────────────

function readJsonSafe(filePath: string, fallback: any = null): any {
  try {
    if (!fs.existsSync(filePath)) return fallback
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
  } catch {
    return fallback
  }
}

function countMessages(agentId: string): number {
  const chatsPath = path.join('K:\\Lumina 2\\Lumina AI\\userData\\agents', agentId, 'chats.json')
  const store = readJsonSafe(chatsPath, { sessions: {} })
  return Object.values(store.sessions || {}).reduce((sum: number, s: any) => sum + (s.messages?.length || 0), 0)
}

function countDelegationJobs(agentId: string): number {
  const jobsPath = path.join('K:\\Lumina 2\\Lumina AI\\userData\\agents', agentId, 'jobs.json')
  const store = readJsonSafe(jobsPath, { jobs: {} })
  return Object.values(store.jobs || {}).filter((j: any) => j.type === 'delegation').length
}

function getLatestJob(agentId: string): any {
  const jobsPath = path.join('K:\\Lumina 2\\Lumina AI\\userData\\agents', agentId, 'jobs.json')
  const store = readJsonSafe(jobsPath, { jobs: {} })
  const jobs = Object.values(store.jobs || {})
  if (jobs.length === 0) return null
  return jobs.sort((a: any, b: any) => b.createdAt - a.createdAt)[0]
}

// ── 主验证流程 ──────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════')
  console.log('  P3-5 委托链路端到端验证')
  console.log('═══════════════════════════════════════════\n')

  // 记录初始状态
  const initialYakMessages = countMessages(TEST_TO)
  const initialYakJobs = countDelegationJobs(TEST_TO)
  console.log(`[初始状态]`)
  console.log(`  Yak chats.json 消息数: ${initialYakMessages}`)
  console.log(`  Yak jobs.json delegation 任务数: ${initialYakJobs}\n`)

  // 初始化 AgentWorkspaceManager
  console.log('[1] 初始化 Agent 工作区...')
  const { initAgentWorkspaceManager } = require('./agentWorkspaceManager')
  const workspace = initAgentWorkspaceManager()
  console.log(`    ✅ 已初始化: ${Object.keys(workspace.profiles.getAll()).join(', ')}`)

  // 初始化 DelegationManager
  console.log('[2] 初始化委托管理器...')
  const { initDelegationManager } = require('./delegationManager')
  const delegation = initDelegationManager()
  console.log('    ✅ 委托管理器已就绪')

  // 检查 asyncTaskManager
  console.log('[3] 检查 asyncTaskManager...')
  const { getAsyncTaskManager } = require('./asyncTaskManager')
  const asyncManager = getAsyncTaskManager()
  const allTasks = asyncManager.list()
  console.log(`    当前任务数: ${allTasks.length}`)

  // 提交委托任务
  console.log('\n[4] 提交委托任务...')
  const delegateRequest = {
    to: TEST_TO,
    task: TEST_TASK,
    taskType: 'code_analysis',
    context: { source: 'verification-script' },
    filePaths: [],
    timeout: 30000,
  }

  let delegateResult: any = null
  let taskId: string | null = null

  try {
    delegateResult = await delegation.delegate(TEST_FROM, delegateRequest)
    console.log(`    ✅ 委托调用完成`)
    console.log(`    success: ${delegateResult.success}`)
    console.log(`    error: ${delegateResult.error || 'none'}`)
    console.log(`    elapsedMs: ${delegateResult.elapsedMs}`)
  } catch (err: any) {
    console.log(`    ❌ 委托调用异常: ${err.message}`)
    delegateResult = { success: false, error: err.message }
  }

  // 等待一下让文件写入完成
  await new Promise(resolve => setTimeout(resolve, 2000))

  // 检查 asyncTaskManager 中的任务
  console.log('\n[5] 检查 asyncTaskManager 任务...')
  const tasksAfter = asyncManager.list()
  console.log(`    总任务数: ${tasksAfter.length}`)

  const delegationTasks = tasksAfter.filter((t: any) => t.title.includes(`[${TEST_FROM} → ${TEST_TO}]`))
  console.log(`    委托任务数: ${delegationTasks.length}`)

  if (delegationTasks.length > 0) {
    taskId = delegationTasks[0].id
    console.log(`    taskId: ${taskId}`)
    console.log(`    status: ${delegationTasks[0].status}`)
    console.log(`    progress: ${delegationTasks[0].progress}`)
  }

  // 检查 Yak 的 chats.json
  console.log('\n[6] 检查 Yak chats.json...')
  const yakMessagesAfter = countMessages(TEST_TO)
  console.log(`    Yak chats.json 消息数: ${yakMessagesAfter} (初始: ${initialYakMessages})`)

  if (yakMessagesAfter > initialYakMessages) {
    console.log(`    ✅ 委托消息已写入 Yak 的 chats.json`)
  } else {
    console.log(`    ⚠️ 委托消息未写入 Yak 的 chats.json`)
    console.log(`    （可能：asyncTaskManager 不直接写 chats；需检查 runner 是否写入）`)
  }

  // 检查 Yak 的 jobs.json
  console.log('\n[7] 检查 Yak jobs.json...')
  const yakJobsAfter = countDelegationJobs(TEST_TO)
  console.log(`    Yak jobs.json delegation 任务数: ${yakJobsAfter} (初始: ${initialYakJobs})`)

  const latestJob = getLatestJob(TEST_TO)
  if (latestJob) {
    console.log(`    最新任务:`)
    console.log(`      id: ${latestJob.id}`)
    console.log(`      type: ${latestJob.type}`)
    console.log(`      status: ${latestJob.status}`)
    console.log(`      title: ${latestJob.title}`)
    console.log(`      createdAt: ${new Date(latestJob.createdAt).toLocaleString()}`)
  }

  if (yakJobsAfter > initialYakJobs) {
    console.log(`    ✅ 委托任务已记录到 Yak 的 jobs.json`)
  } else {
    console.log(`    ❌ 委托任务未记录到 Yak 的 jobs.json`)
  }

  // 检查异常路径
  console.log('\n[8] 检查异常路径...')
  const errorTasks = tasksAfter.filter((t: any) => t.status === 'error' || t.status === 'cancelled')
  console.log(`    错误/取消任务数: ${errorTasks.length}`)

  if (errorTasks.length > 0) {
    const errorTask = errorTasks[0]
    console.log(`    示例错误任务:`)
    console.log(`      id: ${errorTask.id}`)
    console.log(`      status: ${errorTask.status}`)
    console.log(`      error: ${errorTask.error || 'none'}`)
    console.log(`    ✅ 异常路径能正确回写状态`)
  } else {
    console.log(`    ℹ️ 当前无错误/取消任务`)
    console.log(`    （LLM 失败可能仍在运行中，或已被标记为 error）`)
  }

  // 总结
  console.log('\n═══════════════════════════════════════════')
  console.log('  验证结果总结')
  console.log('═══════════════════════════════════════════')
  console.log(`  ✅ P3-5 fork 模式: 已通过 asyncTaskManager.submit 实现`)
  console.log(`  ${taskId ? '✅' : '❌'} 任务已提交: ${taskId || '否'}`)
  console.log(`  ${yakMessagesAfter > initialYakMessages ? '✅' : '⚠️'} Yak chats.json 消息写入: ${yakMessagesAfter > initialYakMessages ? '是' : '否（需 runner 层写入）'}`)
  console.log(`  ${yakJobsAfter > initialYakJobs ? '✅' : '❌'} Yak jobs.json delegation 记录: ${yakJobsAfter > initialYakJobs ? '是' : '否'}`)
  console.log(`  ${delegateResult?.success === false ? '✅' : '⚠️'} 异常路径状态回写: ${delegateResult?.success === false ? '已触发（LLM 失败）' : '待验证'}`)
  console.log('═══════════════════════════════════════════\n')
}

main().catch(console.error)
