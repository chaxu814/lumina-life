// ============================================================
// delegationManager.ts — Lumina 委托管理器 (Phase 1/2/3 循环升级)
//
// Phase 1: 核心委托重试 — delegate() 失败后自动重试+降级
// Phase 2: AgentLoop 结构体 — 统一循环控制+收敛检测
// Phase 3: 情感感知循环 — 情绪影响重试策略
//
// v9.0 新增:
//   - autoVerifyOnDelegate: 自动验证闭环（Yak 写完代码后自动跑测试/修复）
//   - phaseGatedDelegate: 复杂任务分阶段执行（Research→Plan→Execute→Verify→Review）
//   - 两种模式：直派(simple) / 分阶段门控(complex)
//
// v8.0: 每个 Agent 拥有独立 AgentRunner，通过消息路由通信。
//   Lumina → 委托 → DelegationManager → 路由到 Yak/热茶的独立 Runner
//   各 Runner 保持独立上下文，不再 splice 消息。
// ============================================================

import type {
  DelegationRequest, DelegationResult, TeamMemberId, NoticeEntry, TeamContextEntry,
  AgentLoopConfig, AgentLoopContext, LoopStepRecord, LoopStopCondition, LoopPhase,
} from './agentTeamTypes'
import { DEFAULT_AGENT_LOOP_CONFIG } from './agentTeamTypes'
import { TEAM_MEMBERS } from './agentTeamPersonas'
import { matchSkill } from './agentSkills'
import { getTeamRegistry } from './core/teamRegistry'
import { getTeamContextManager } from './agentTeamContext'
import { AgentRunner } from './agentRunner'
// 验证闭环 & 阶段门控
import { autoFixLoop, runVerification, detectProjectRoot, detectProjectProfile, taskMayNeedVerification, defaultConvergenceCheck } from './orchestration/verifyLoop'
import { assessComplexity } from './orchestration/complexityAnalyzer'
import { emitTheaterBeat, getCurrentEmotion3D } from './orchestration/theaterBridge'
import type { TheaterRole } from './orchestration/theater'
import { PhaseGate, getPhasesFromComplexity } from './orchestration/phaseGate'
// v02: Worker 委托 Prompt 构建（传递完整上下文）
import { buildWorkerSystemPrompt, buildWorkerFirstMessage, type WorkerPromptContext } from './orchestration/delegationPrompt'
import { resolveToolset } from './tools/registry'
// v0.1.1: 委托结果驱动 Agent 间动态关系
import { getRelationshipStore } from './agentRelationships'
import { getTaskBoard } from './orchestration/taskBoard'
import type { PhaseName } from './orchestration/phaseGate'
import type { ComplexityAnalysis } from './orchestration/complexityAnalyzer'
// 🆕 Lucky 模式集成 — 多 Agent 循环控制
import { getLuckyDelegationControl, shouldStopDelegationLoop, getConfig as getLuckyConfig, getCurrentMood, getCurrentMode } from './luckyModeIntegration'
// 🆕 P3-5: spawn_subagent fork 模式集成
import { getAsyncTaskManager } from './asyncTaskManager'
import { getAgentWorkspaceManager } from './agentWorkspaceManager'

// ═══════════════════════════════════════════════════════════
// 通知板 & 共享上下文 持久化路径
// ═══════════════════════════════════════════════════════════

const TEAM_NOTICES_PATH = process.cwd() + '/memory/team-notices.json'
const TEAM_CONTEXT_PATH = process.cwd() + '/memory/team-context.json'

function ensureDir(p: string): void {
  const dir = p.substring(0, p.lastIndexOf('/'))
  try { require('fs').mkdirSync(dir, { recursive: true }) } catch {}
}

function readJson<T>(filePath: string, fallback: T): T {
  try {
    if (require('fs').existsSync(filePath)) {
      return JSON.parse(require('fs').readFileSync(filePath, 'utf-8'))
    }
  } catch {}
  return fallback
}

function writeJson(filePath: string, data: any): void {
  ensureDir(filePath)
  try { require('fs').writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8') } catch {}
}

// ═══════════════════════════════════════════════════════════
// DelegationManager (v8.1 团队协作升级)
// v8.1 新增:
//   - 反问解析: Worker 可用 [QUESTION]...[/QUESTION] 标记需要确认的问题
//   - 通知板: Workers 可在任务中留言给 Lumina
//   - 共享上下文: 所有团队成员可读写的项目级记忆
// ═══════════════════════════════════════════════════════════
// 🆕 P4 优化: 委托结果缓存 — 相同 task+context 在 60s 内直接返回
// ═══════════════════════════════════════════════════════════

interface CacheEntry {
  result: DelegationResult
  expiresAt: number
}

const CACHE_TTL_MS = 60_000 // 60 秒 TTL

function _cacheKey(from: string, to: string, task: string, taskType: string, context?: string): string {
  return `${from}:${to}:${taskType}:${task.slice(0, 200)}:${(context || '').slice(0, 200)}`
}

// ═══════════════════════════════════════════════════════════

export class DelegationManager {
  /**
   * v8.0: 独立 Agent Runner 映射
   * 每个团队成员有自己的 Runner，独立 LLM、独立上下文、独立记忆
   */
  private runners: Map<string, AgentRunner> = new Map()
  /** 🆕 P4: 委托结果缓存，key 见 _cacheKey()，value 见 CacheEntry */
  private runnerResultCache: Map<string, CacheEntry> = new Map()

  /**
   * 注册 Agent Runner（由 AgentPool / main.ts 在创建时注册）
   */
  registerRunner(id: string, runner: AgentRunner): void {
    this.runners.set(id, runner)
    const member = getTeamRegistry().getMember(id) || (TEAM_MEMBERS as any)[id]
    console.log(`[DelegationManager] ✅ ${member?.icon || '?'} ${id} Runner 已注册`)
  }

  /**
   * 获取已注册的 Runner
   */
  getRunner(id: string): AgentRunner | undefined {
    return this.runners.get(id)
  }

  /** 检查成员是否已配置 */
  isConfigured(memberId: string): boolean {
    return this.runners.has(memberId)
  }

  /** 获取团队配置状态 */
  getTeamConfigStatus(): Array<{
    memberId: string
    name: string
    icon: string
    configured: boolean
  }> {
    const allMembers = getTeamRegistry().getAllMembers()
    return allMembers.map(member => ({
      memberId: member.id,
      name: member.name,
      icon: member.icon,
      configured: this.runners.has(member.id),
    }))
  }

  // ═══ P2: 社交引擎通知（非阻塞，捕获所有异常） ═══
  private _notifyEngine(event: 'start' | 'end'): void {
    try {
      const { getOrchestrator } = require('./core/agentOrchestrator')
      if (event === 'start') {getOrchestrator().socialEngine?.onCodingTaskStart?.()}
      else {getOrchestrator().socialEngine?.onCodingTaskEnd?.()}
    } catch { /* ignore */ }
  }

  /** P2: 记录委托日志到团队上下文；v0.1.1 同时驱动 Agent 间动态关系 */
  private _logDelegation(from: string, to: string, task: string, summary: string, success: boolean, elapsed: number, taskType?: string): void {
    try {
      getTeamContextManager().logDelegation(from, to, task, summary, success, elapsed)
    } catch { /* ignore */ }
    // v0.1.1: 真实委托结果改变两人关系（成功→协作/信任上升，失败→信任下降）
    try {
      getRelationshipStore().recordInteraction(
        from, to,
        success ? 'delegation_ok' : 'delegation_fail',
        taskType,
      )
    } catch { /* ignore */ }
  }

  // ═══ 委托 ═══

  // ═══════════════════════════════════════════════════════════
  // 🆕 Phase 1/2/3: 循环上下文工厂 & 收敛检测
  // ═══════════════════════════════════════════════════════════

  /**
   * 构建 AgentLoop 运行时上下文
   */
  private _buildLoopContext(request: DelegationRequest): AgentLoopContext {
    const loopConfig: AgentLoopConfig = {
      ...DEFAULT_AGENT_LOOP_CONFIG,
      ...(request.loopConfig || {}),
    }

    return {
      config: loopConfig,
      currentIteration: 0,
      currentRetry: 0,
      isDegraded: false,
      steps: [],
      recentOutputs: [],
      currentMood: getCurrentMood(),
      moodIntensity: 0,
    }
  }

  /**
   * 🆕 Phase 2: 收敛检测 — 连续 N 轮输出相似度超阈值视为收敛
   */
  private _isConverged(ctx: AgentLoopContext): boolean {
    if (ctx.recentOutputs.length < ctx.config.convergenceWindow) {return false}
    const window = ctx.recentOutputs.slice(-ctx.config.convergenceWindow)
    // 计算相邻对的相似度
    let similarCount = 0
    for (let i = 1; i < window.length; i++) {
      const sim = this._textSimilarity(window[i - 1], window[i])
      if (sim >= ctx.config.convergenceThreshold) {similarCount++}
    }
    return similarCount >= window.length - 1
  }

  /**
   * 🆕 Phase 2: 文本相似度（Jaccard 简化版）
   */
  private _textSimilarity(a: string, b: string): number {
    const setA = new Set(a.toLowerCase().split(/\s+/).filter(s => s.length > 2).slice(0, 50))
    const setB = new Set(b.toLowerCase().split(/\s+/).filter(s => s.length > 2).slice(0, 50))
    if (setA.size === 0 || setB.size === 0) {return 0}
    let intersection = 0
    for (const word of setA) {
      if (setB.has(word)) {intersection++}
    }
    const union = setA.size + setB.size - intersection
    return union === 0 ? 0 : intersection / union
  }

  /**
   * 🆕 Phase 1: 重试延迟（指数退避，但受情绪影响）
   */
  private _retryDelay(attempt: number, mood?: string): number {
    let base = Math.min(1000 * Math.pow(2, attempt - 1), 10000)
    // Phase 3: 情绪感知 — 不耐烦时缩短延迟
    if (mood === 'impatient' || mood === 'stressed') {
      base = Math.min(base, 2000) // 不耐烦时不等太久
    }
    // 加点随机抖动
    const jitter = Math.random() * base * 0.3
    return Math.floor(base + jitter)
  }

  /**
   * 🆕 Phase 3: 情绪对重试策略的影响
   */
  private _adjustRetryByMood(
    baseMaxRetries: number,
    mood?: string,
    moodIntensity?: number,
  ): { maxRetries: number; degradeFaster: boolean } {
    const intensity = moodIntensity ?? 0.5
    if (!mood || intensity < 0.4) {
      return { maxRetries: baseMaxRetries, degradeFaster: false }
    }

    switch (mood) {
      case 'happy':
      case 'playful':
        // 好心情：更多耐心，多试几次
        return {
          maxRetries: Math.min(baseMaxRetries + 1, 5),
          degradeFaster: false,
        }
      case 'tired':
      case 'stressed':
        // 累/压力：减少重试，尽快出结果
        return {
          maxRetries: Math.max(1, Math.ceil(baseMaxRetries * (1 - intensity * 0.5))),
          degradeFaster: intensity > 0.6,
        }
      case 'impatient':
        // 不耐烦：几乎不重试
        return {
          maxRetries: Math.max(0, baseMaxRetries - 2),
          degradeFaster: true,
        }
      default:
        return { maxRetries: baseMaxRetries, degradeFaster: false }
    }
  }

  /**
   * 🆕 Phase 1: 降级任务 — 重试时改变策略
   */
  private _buildDegradedTask(
    originalTask: string,
    attempt: number,
    lastError: string,
    strategy: 'same' | 'simplify' | 'escalate',
  ): string {
    if (strategy === 'same') {
      // 第 1 次重试：原样重新提交，加错误提示
      return `【第 ${attempt} 次重试 — 上次报错如下】

原始任务:
${originalTask}

━━━━━━━━━━━━━━━━━━━━━━━━━━
上次错误:
${lastError.slice(0, 2000)}
━━━━━━━━━━━━━━━━━━━━━━━━━━

【重试要求】
1. 仔细阅读上次的报错
2. 使用不同的方法来完成任务，避开之前失败的方式
3. 如果上次的尝试太复杂，请简化方案
4. 如果仍然不确定，先读取更多上下文再执行`
    }

    if (strategy === 'simplify') {
      // 简化版：缩小范围
      return `【降级重试 — 简化版】

请用最简单的方式完成以下目标（不要追求完美，只求可用）
原始任务参考：
${originalTask.slice(0, 1000)}

【重要】
- 使用最小可行方案
- 不要写复杂的架构
- 如果完整实现太复杂，先做功能验证（proof of concept）
- 不需要考虑边界情况，先跑通主流程

上次错误（供参考）:
${lastError.slice(0, 1000)}`
    }

    // escalate：寻求帮助或报告
    return `【升级重试 — 需要重新评估】

以下任务已失败 ${attempt} 次：
${originalTask.slice(0, 800)}

最后错误:
${lastError.slice(0, 1000)}

请重新评估这个任务：
1. 是否因为信息不足而失败？
2. 是否需要读取更多代码/文档？
3. 是否需要换一个实现方法？
4. 如果确实无法完成，请明确说明原因和需要的帮助`
  }

  /**
   * 🆕 Phase 1/2/3: 增强版 delegate — 带重试+循环控制+情绪感知
   *
   * v8.0: 从源 Agent 委托任务给目标 Agent
   * - 不再使用共享 Runner，路由到目标 Agent 的独立 Runner
   * - 目标 Runner 保留完整上下文
   *
   * Phase 1 新增:
   * - 失败自动重试（指数退避）
   * - 重试降级策略（same/simplify/escalate）
   * - 重试信息记录到 DelegationResult.retryInfo
   *
   * Phase 2 新增:
   * - AgentLoopConfig 控制循环参数
   * - 收敛检测（连续相似输出视为完成）
   * - 停止条件追踪
   *
   * Phase 3 新增:
   * - 情绪影响重试次数和策略
   * - 情绪影响延迟时间
   *
   * @param from - 发起委托的 Agent ID
   * @param request - 委托请求
   */
  async delegate(from: string, request: DelegationRequest): Promise<DelegationResult> {
    const startTime = Date.now()
    const { to, task, taskType, context, filePaths, timeout } = request

    // 先查内置成员，再查动态成员
    const member = (TEAM_MEMBERS as any)[to] || getTeamRegistry().getMember(to)
    if (!member) {
      return {
        success: false, content: '', error: `未知成员: ${to}`,
        toolCallsCount: 0, elapsedMs: Date.now() - startTime,
      }
    }

    // 🆕 P3-5: 检查目标 Agent 是否已配置（通过 agentWorkspaceManager）
    const workspace = getAgentWorkspaceManager()
    const targetProfile = workspace.profiles.get(to)
    if (!targetProfile) {
      return {
        success: false, content: '',
        error: `${member.name}(${to}) 未就绪（Agent 未配置）`,
        toolCallsCount: 0, elapsedMs: Date.now() - startTime,
      }
    }

    console.log(`[DelegationManager] 🔀 ${from} → ${member.name}(${to}): "${task.slice(0, 80)}..."`)

    // 🆕 创新功能 2：团队可见性剧场 — 记录「派活」这一幕
    //   情绪取当前真实 mood 换算出的三维，不编造。
    emitTheaterBeat({
      kind: 'delegate',
      role: (from === 'lumina' || from === 'yak' || from === 'recha') ? from : 'lumina',
      text: task.slice(0, 120),
      emotion: getCurrentEmotion3D(),
      detail: `${from} → ${to}`,
    })

    // 🆕 P4: 缓存命中检查
    const cacheKey = _cacheKey(from, to, task, taskType, context)
    const cached = this.runnerResultCache.get(cacheKey)
    if (cached && Date.now() < cached.expiresAt) {
      console.log(`[DelegationManager] 💾 缓存命中: ${cacheKey.slice(0, 80)} (剩余 ${Math.round((cached.expiresAt - Date.now()) / 1000)}s)`)
      this._notifyEngine('end')
      return cached.result
    }
    for (const [key, entry] of this.runnerResultCache) {
      if (Date.now() >= entry.expiresAt) {this.runnerResultCache.delete(key)}
    }

    // 🆕 Phase 1/2/3: 构建循环上下文
    const loopCtx = this._buildLoopContext(request)

    // 🆕 Phase 3: 情绪调整重试参数
    const mood = getCurrentMood()
    const moodAdj = this._adjustRetryByMood(
      request.maxRetries ?? loopCtx.config.maxRetries,
      mood,
      // 粗略从情绪强度推断 — 如果情绪非 neutral 则强度高
      mood && mood !== 'neutral' ? 0.7 : 0.3,
    )
    const effectiveMaxRetries = request.maxRetries ?? moodAdj.maxRetries
    const degradeFaster = moodAdj.degradeFaster

    // 通知社交引擎
    this._notifyEngine('start')

    // ═══ 核心重试循环 ═══
    const attemptErrors: string[] = []
    let lastError = ''
    let wasDegraded = false
    let recoveredByDegrade = false
    let finalCleanText = ''
    let finalQuestions: string[] | undefined
    let finalToolCallsCount = 0

    const maxAttempts = 1 + effectiveMaxRetries // 首次 + 重试次数

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // 当前是否处于重试状态
      const isRetry = attempt > 1

      // 🆕 Phase 2: 收敛检查 — 如果最近输出已收敛，提前结束
      if (loopCtx.recentOutputs.length >= loopCtx.config.convergenceWindow) {
        if (this._isConverged(loopCtx)) {
          console.log(`[DelegationManager] 🔁 输出已收敛（连续 ${loopCtx.config.convergenceWindow} 轮相似），提前终止重试`)
          loopCtx.stopCondition = 'converged'
          loopCtx.stopReason = `输出已收敛，连续 ${loopCtx.config.convergenceWindow} 轮相似度 > ${loopCtx.config.convergenceThreshold}`
          break
        }
      }

      // 🆕 Phase 2: 迭代次数上限
      if (loopCtx.currentIteration >= loopCtx.config.maxIterations) {
        console.log(`[DelegationManager] ⛔ 达到最大迭代次数 ${loopCtx.config.maxIterations}`)
        loopCtx.stopCondition = 'max_iterations'
        loopCtx.stopReason = `达到最大迭代次数 ${loopCtx.config.maxIterations}`
        break
      }

      loopCtx.currentIteration++
      loopCtx.currentRetry = attempt - 1

      // 🆕 Phase 1: 重试时使用降级策略
      let currentTask = task
      if (isRetry && lastError) {
        const strategy = this._pickRetryStrategy(attempt, maxAttempts, degradeFaster, mood)
        currentTask = this._buildDegradedTask(task, attempt, lastError, strategy)
        if (strategy !== 'same') {wasDegraded = true}
        // 重试前指数退避
        const delay = this._retryDelay(attempt - 1, mood)
        console.log(`[DelegationManager] ⏳ 第 ${attempt} 次重试 (策略: ${strategy})，等待 ${delay}ms...`)
        await new Promise(resolve => setTimeout(resolve, delay))
      }

      try {
        // 🆕 P3-5: spawn_subagent fork 模式 — 使用 asyncTaskManager 提交后台任务
        const workspace = getAgentWorkspaceManager()
        const targetProfile = workspace.profiles.get(to)
        
        // v02(问题D): 组装完整上下文 —— 任务目标+对话历史+可用工具+项目上下文
        const workerCtx = this._buildWorkerPromptContext(request, currentTask, taskType, from, to)
        const childConfig = workspace.config.buildRunConfig(to as any, targetProfile, {
          systemPrompt: buildWorkerSystemPrompt(workerCtx),
          personaId: to,
        })
        
        // v02 修复：之前只提交前50字标题，Worker 看不到完整任务；现在提交完整首轮消息
        const asyncManager = getAsyncTaskManager()
        const firstMessage = buildWorkerFirstMessage(workerCtx)
        const taskId = asyncManager.submit(
          firstMessage,
          childConfig,
          {
            title: `[${from}→${to}] ${currentTask.slice(0, 40)}`,
            tags: ['delegation', `${to}`],
            assignee: to,
          }
        )
        
        console.log(`[DelegationManager] 🧬 spawn_subagent fork: ${from} → ${to}, taskId=${taskId}`)
        
        // 记录委托到目标 Agent 的独立 jobs.json
        try {
          workspace.jobs.addJob(to, {
            agentId: to,
            type: 'delegation',
            status: 'running',
            title: `[${from} → ${to}] ${currentTask.slice(0, 50)}`,
            description: currentTask,
            metadata: {
              parentJobId: undefined,
              taskId,
            }
          })
        } catch (e) {
          console.warn('[DelegationManager] 记录委托任务失败:', e)
        }
        
        // 等待任务完成（轮询进度）
        const result = await this._waitForTaskCompletion(asyncManager, taskId, timeout ?? 300_000)
        
        if (result.error) {
          lastError = result.error
          attemptErrors.push(result.error)
          console.log(`[DelegationManager] ❌ 第 ${attempt}/${maxAttempts} 次失败: ${result.error.slice(0, 100)}`)

          if (attempt >= maxAttempts) {
            // 最后一次仍失败
            this._logDelegation(from, to, task, result.error, false, Date.now() - startTime, request.taskType)
            this._notifyEngine('end')

            const finalResult: DelegationResult = {
              success: false, content: '',
              error: result.error,
              toolCallsCount: 0,
              elapsedMs: Date.now() - startTime,
              retryInfo: {
                totalRetries: attempt - 1,
                attemptErrors,
                wasDegraded,
                recoveredByDegrade: false,
              },
            }
            this.runnerResultCache.set(cacheKey, { result: finalResult, expiresAt: Date.now() + CACHE_TTL_MS })
            return finalResult
          }
          continue // 继续重试
        }

        // ✅ 成功
        const rawText = result.result || ''
        const { cleanText, questions } = this._parseQuestions(rawText)
        finalCleanText = cleanText
        finalQuestions = questions.length > 0 ? questions : undefined
        finalToolCallsCount = 0 // fork 模式暂不统计 tool calls

        // 🆕 Phase 2: 记录本轮输出用于收敛检测
        loopCtx.recentOutputs.push(cleanText.slice(0, 500))
        if (loopCtx.recentOutputs.length > loopCtx.config.convergenceWindow * 2) {
          loopCtx.recentOutputs.shift()
        }

        // 🆕 Phase 1: 如果经过重试才成功，记录恢复信息
        if (isRetry) {
          recoveredByDegrade = wasDegraded
          console.log(`[DelegationManager] ✅ 第 ${attempt} 次重试成功 (${cleanText.length} 字符)`)
        }

        // 自动验证闭环
        if (taskMayNeedVerification(taskType)) {
          try {
            const verifyResult = await this._autoVerifyAfterDelegation(
              from, to, member, task, cleanText,
            )
            if (verifyResult.autoFixed) {
              finalCleanText = `【原始输出】\n${cleanText}\n\n【自动修复记录】\n${verifyResult.fixLog}`
              if (verifyResult.finalContent) {
                finalCleanText = verifyResult.finalContent
              }
            }
          } catch (verifyErr: any) {
            console.warn(`[DelegationManager] ⚠️ 自动验证异常:`, verifyErr.message)
          }
        }

        this._logDelegation(from, to, task, cleanText.slice(0, 200), true, Date.now() - startTime, request.taskType)
        this._notifyEngine('end')

        const retryInfo = attempt > 1 ? {
          totalRetries: attempt - 1,
          attemptErrors,
          wasDegraded,
          recoveredByDegrade,
        } : undefined

        const resultVal: DelegationResult = {
          success: true,
          content: finalCleanText,
          questions: finalQuestions,
          toolCallsCount: finalToolCallsCount,
          elapsedMs: Date.now() - startTime,
          retryInfo,
        }
        this.runnerResultCache.set(cacheKey, { result: resultVal, expiresAt: Date.now() + CACHE_TTL_MS })
        // 🆕 创新功能 2：剧场收尾幕（真实耗时 + 真实结论，不编造）
        emitTheaterBeat({
          kind: finalToolCallsCount > 0 ? 'worker_done' : 'speech',
          role: to as TheaterRole,
          text: finalCleanText.slice(0, 120) || '已完成',
          emotion: getCurrentEmotion3D(),
          detail: `${Math.round((Date.now() - startTime) / 100) / 10}s · ${finalToolCallsCount} 次工具调用`,
        })
        return resultVal
      } catch (err: any) {
        lastError = err.message
        attemptErrors.push(err.message)
        console.error(`[DelegationManager] ❌ 第 ${attempt}/${maxAttempts} 次异常: ${err.message}`)

        if (attempt >= maxAttempts) {
          this._notifyEngine('end')
          // 🆕 创新功能 2：失败也是一幕（事故也是剧情，且必须诚实记录）
          emitTheaterBeat({
            kind: 'incident',
            role: to as TheaterRole,
            text: err.message.slice(0, 120),
            emotion: getCurrentEmotion3D(),
            detail: `重试 ${attempt} 次仍未成功`,
          })
          return {
            success: false, content: '',
            error: err.message,
            toolCallsCount: 0,
            elapsedMs: Date.now() - startTime,
            retryInfo: {
              totalRetries: attempt - 1,
              attemptErrors,
              wasDegraded,
              recoveredByDegrade: false,
            },
          }
        }
      }
    }

    // 循环自然结束（无结果）
    this._notifyEngine('end')
    const fallbackResult: DelegationResult = {
      success: false,
      content: finalCleanText || '',
      error: loopCtx.stopReason || '委托异常终止',
      toolCallsCount: finalToolCallsCount,
      elapsedMs: Date.now() - startTime,
      retryInfo: attemptErrors.length > 0 ? {
        totalRetries: attemptErrors.length,
        attemptErrors,
        wasDegraded,
        recoveredByDegrade: false,
      } : undefined,
    }
    return fallbackResult
  }

  /**
   * 🆕 Phase 1: 选择重试策略
   */
  private _pickRetryStrategy(
    attempt: number,
    maxAttempts: number,
    degradeFaster: boolean,
    mood?: string,
  ): 'same' | 'simplify' | 'escalate' {
    // 第 1 次重试：原样重试（可能只是临时问题）
    if (attempt === 2) {return 'same'}

    // 情绪感知 — 不耐烦时快速降级
    if (degradeFaster && attempt >= 2) {return 'simplify'}

    // 第 2 次重试（即 attempt=3）：简化
    if (attempt === 3) {return 'simplify'}

    // 后续重试：升级寻求帮助
    if (attempt >= 4) {return 'escalate'}

    return 'same'
  }

  // ═══ P3-5: spawn_subagent fork 模式 ═══

  /** 等待 asyncTaskManager 任务完成 */
  private async _waitForTaskCompletion(
    asyncManager: any,
    taskId: string,
    timeout: number
  ): Promise<{ result?: string; error?: string }> {
    const startTime = Date.now()
    const pollInterval = 500 // 500ms 轮询一次
    
    while (Date.now() - startTime < timeout) {
      const task = asyncManager.get(taskId)
      
      if (!task) {
        return { error: '任务不存在' }
      }
      
      if (task.status === 'done') {
        return { result: task.result }
      }
      
      if (task.status === 'error') {
        return { error: task.error || '任务执行失败' }
      }
      
      if (task.status === 'cancelled') {
        return { error: '任务已取消' }
      }
      
      // 等待后继续轮询
      await new Promise(resolve => setTimeout(resolve, pollInterval))
    }
    
    return { error: '任务超时' }
  }

  /**
   * v02(问题 D): 组装 Worker 委托上下文。
   * 把 DelegationRequest 里的对话历史/任务目标/可用工具/项目上下文
   * 全部喂给 Worker，避免它"只看到孤零零一条消息"。
   */
  private _buildWorkerPromptContext(
    request: DelegationRequest,
    task: string,
    taskType: string,
    from: string,
    to: string,
  ): WorkerPromptContext {
    // Worker 实际可用工具：agent toolset 过滤 child-blocked 与黑名单
    let availableTools: string[] = []
    try {
      availableTools = resolveToolset('agent', new Set(), true)
      const blacklist = (request as any).disabledTools as string[] | undefined
      if (blacklist && blacklist.length > 0) {
        const set = new Set(blacklist)
        availableTools = availableTools.filter(t => !set.has(t))
      }
    } catch {
      availableTools = []
    }

    // 兼容旧字段 request.context（agentRunner.delegate 传入的"用户/Lumina"摘要）
    let conversationHistory = request.conversationHistory
    if ((!conversationHistory || conversationHistory.length === 0) && request.context) {
      conversationHistory = [{ role: 'system' as const, content: request.context }]
    }

    return {
      to,
      from,
      taskType,
      task,
      taskGoal: request.taskGoal || task,
      availableTools,
      conversationHistory,
      projectContext: request.projectContext || {
        cwd: process.cwd(),
        relevantFiles: request.filePaths,
        techStack: 'TypeScript/Electron',
      },
      legacyContext: request.context,
    }
  }

  /** 构建子任务系统提示词（继承父任务上下文） */
  private _buildWorkerSystemPrompt(task: string, taskType: string, from: string, to: string): string {
    const parts: string[] = []
    
    parts.push(`你是 ${to}，正在执行来自 ${from} 的委托任务。`)
    parts.push(`这是一个子任务（spawn_subagent fork），你有独立的上下文空间。`)
    parts.push('')
    parts.push('## 任务信息')
    parts.push(`- 任务类型: ${taskType}`)
    parts.push(`- 委托方: ${from}`)
    parts.push(`- 执行方: ${to}`)
    parts.push('')
    parts.push('## 执行规则')
    parts.push('① 直接执行任务，返回结果')
    parts.push('② 如果遇到问题，使用 [QUESTION]...[/QUESTION] 标记需要确认的问题')
    parts.push('③ 不要寒暄，直接输出结果')
    
    return parts.join('\n')
  }


  // ═══ Worker 输入构建 ═══

  private _buildWorkerInput(
    task: string,
    taskType: string,
    context?: string,
    filePaths?: string[],
  ): string {
    const parts: string[] = []

    parts.push(`【委托任务】`)
    parts.push(`任务类型: ${taskType}`)
    parts.push(`\n【核心任务】\n${task}`)

    // 🆕 FIX-3: fetch_content 类型 — 将 URL 提取为显式指令
    if (taskType === 'fetch_content') {
      const urlMatch = task.match(/https?:\/\/[^\s\)\]》》},;，。]+/g)
      if (urlMatch) {
        parts.push(`\n【目标 URL】`)
        urlMatch.forEach((url, i) => parts.push(`  ${i + 1}. ${url}`))
        parts.push(`\n请使用 web_fetch 读取以上 URL 的内容，然后总结要点返回。`)
      }
    }

    // 🆕 FIX-3: web_research 类型 — 提示使用 web_search
    if (taskType === 'web_research') {
      parts.push(`\n请使用 web_search 搜索相关信息，然后整理研究结果返回。`)
    }

    const matchedSkill = matchSkill(task)
    if (matchedSkill) {
      parts.push(`\n【匹配 Skill】`)
      parts.push(`- ${matchedSkill.name}: ${matchedSkill.description}`)
      if (matchedSkill.executeConstraints) {
        parts.push(`\n【Skill 约束】\n${matchedSkill.executeConstraints}`)
      }
      if (matchedSkill.workflow) {
        parts.push(`\n【工作流】\n${matchedSkill.workflow}`)
      }
    } else {
      parts.push(`\n【匹配 Skill】未命中明确 Skill；先读取上下文/文件后再行动。`)
    }

    // 精简执行规则 — 原来 8 条冗余且 LLM 内置常识，浓缩为 3 条核心
    parts.push(`\n## 执行规则`)
    parts.push(`① 先读文件/运行命令确认现状，不假设`)
    parts.push(`② 只改必须改的，每次改完立刻验证`)
    parts.push(`③ 卡住时用 [QUESTION]你的问题[/QUESTION] 向 Lumina 确认`)

    // 上下文从 6000 字降到 2000 字（减少 Worker 系统提示词膨胀）
    if (context) {
      parts.push(`\n【上下文】\n${context.slice(0, 2000)}`)
    }

    // 团队上下文精简 — 只带最相关信息
    try {
      const tcm = getTeamContextManager()
      const recentLogs = tcm.getRecentDelegations(2)
      if (recentLogs && !recentLogs.startsWith('暂无委托记录')) {
        parts.push(`\n【近期委托】\n${recentLogs.slice(0, 1000)}`)
      }
    } catch {
      // 团队上下文不可用不影响主流程
    }

    if (filePaths && filePaths.length > 0) {
      parts.push(`\n【相关文件】\n${filePaths.join('\n')}`)
    }

    parts.push(`\n---\n直接执行，返回结果。不要寒暄。`)

    return parts.join('\n')
  }

  /**
   * v8.1: 解析 Worker 回复中的 [QUESTION] 标记
   * 提取问题列表，从原文本中移除标记
   */
  private _parseQuestions(text: string): { cleanText: string; questions: string[] } {
    const questions: string[] = []
    const regex = /\[QUESTION\]([\s\S]*?)\[\/QUESTION\]/g
    let match
    let cleanText = text
    while ((match = regex.exec(text)) !== null) {
      const q = match[1].trim()
      if (q) {questions.push(q)}
    }
    if (questions.length > 0) {
      cleanText = text.replace(/\[QUESTION\][\s\S]*?\[\/QUESTION\]/g, '').trim()
    }
    return { cleanText, questions }
  }

  // =============================================
  // v8.1: 团队通知板
  // =============================================

  /** 添加团队通知 */
  addNotice(from: TeamMemberId, message: string, priority: 'low' | 'normal' | 'high' = 'normal'): void {
    const notices: NoticeEntry[] = readJson(TEAM_NOTICES_PATH, [])
    notices.push({
      id: `notice-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      from,
      message,
      priority,
      timestamp: new Date().toISOString(),
      read: false,
    })
    writeJson(TEAM_NOTICES_PATH, notices)
    console.log(`[DelegationManager] 📋 ${TEAM_MEMBERS[from]?.icon} ${from} 写了通知: ${message.slice(0, 60)}`)
  }

  /** 获取所有未读通知 */
  getUnreadNotices(): NoticeEntry[] {
    return readJson<NoticeEntry[]>(TEAM_NOTICES_PATH, []).filter(n => !n.read)
  }

  /** 获取所有通知 */
  getAllNotices(): NoticeEntry[] {
    return readJson<NoticeEntry[]>(TEAM_NOTICES_PATH, [])
  }

  /** 标记通知为已读 */
  markNoticeRead(id: string): void {
    const notices = readJson<NoticeEntry[]>(TEAM_NOTICES_PATH, [])
    const notice = notices.find(n => n.id === id)
    if (notice) {notice.read = true}
    writeJson(TEAM_NOTICES_PATH, notices)
  }

  /** 标记所有通知为已读 */
  markAllNoticesRead(): void {
    const notices = readJson<NoticeEntry[]>(TEAM_NOTICES_PATH, [])
    notices.forEach(n => n.read = true)
    writeJson(TEAM_NOTICES_PATH, notices)
  }

  // =============================================
  // v8.1: 团队共享上下文
  // =============================================

  /** 设置共享上下文 */
  setContext(key: string, value: string, updatedBy: TeamMemberId): void {
    const ctx = readJson<Record<string, TeamContextEntry>>(TEAM_CONTEXT_PATH, {})
    ctx[key] = {
      key,
      value,
      updatedBy,
      timestamp: new Date().toISOString(),
    }
    writeJson(TEAM_CONTEXT_PATH, ctx)
    console.log(`[DelegationManager] 📝 共享上下文 [${key}] 已更新 by ${updatedBy}`)
  }

  /** 获取共享上下文值 */
  getContext(key: string): TeamContextEntry | undefined {
    const ctx = readJson<Record<string, TeamContextEntry>>(TEAM_CONTEXT_PATH, {})
    return ctx[key]
  }

  /** 获取所有共享上下文 */
  getAllContext(): TeamContextEntry[] {
    return Object.values(readJson<Record<string, TeamContextEntry>>(TEAM_CONTEXT_PATH, {}))
  }

  // ═══════════════════════════════════════════════════════════
  // + Phase 3: 自动验证闭环
  // ═══════════════════════════════════════════════════════════

  /**
   * 委托完成后自动运行验证 + 修复循环
   *
   * Phase 3 增强: 情绪影响修复轮数上限和策略
   */
  private async _autoVerifyAfterDelegation(
    from: string,
    to: string,
    member: any,
    task: string,
    delegateOutput: string,
  ): Promise<{
    autoFixed: boolean
    fixLog: string
    finalContent?: string
    attempts?: string[]
  }> {
    console.log(`[DelegationManager] 🔍 v9.0 自动验证: ${member.name} → ${task.slice(0, 80)}...`)

    try {
      // 1. 检测项目根目录和特征
      const projectRoot = detectProjectRoot(process.cwd())
      const profile = detectProjectProfile(projectRoot)

      if (profile.suggestedVerifyCommands.length === 0) {
        console.log(`[DelegationManager] ⏭️ 跳过验证：无可用验证命令`)
        return { autoFixed: false, fixLog: '无可用验证命令' }
      }

      // 2. 执行首次验证
      // 🆕 Lucky: 根据 Lucky 预设动态决定最大修复轮数
      const luckyControl = getLuckyDelegationControl({
        complexity: 'medium',
        taskType: (member as any)?.type || 'coding',
        currentMode: undefined,
        currentMood: undefined,
      })

      // 🆕 Phase 3: 情绪影响修复轮数
      const mood = getCurrentMood()
      let moodAdjustedRounds = luckyControl.maxFixRounds
      if (mood === 'impatient' || mood === 'stressed') {
        moodAdjustedRounds = Math.max(1, moodAdjustedRounds - 1)
        console.log(`[DelegationManager] 💭 情绪 "${mood}" → 减少修复轮数: ${luckyControl.maxFixRounds} → ${moodAdjustedRounds}`)
      } else if (mood === 'happy' || mood === 'playful') {
        moodAdjustedRounds = Math.min(5, moodAdjustedRounds + 1)
        console.log(`[DelegationManager] 💭 情绪 "${mood}" → 增加修复轮数: ${luckyControl.maxFixRounds} → ${moodAdjustedRounds}`)
      }

      const verifyConfig = {
        commands: profile.suggestedVerifyCommands,
        maxFixRounds: moodAdjustedRounds,
        timeoutMs: 120_000,
        cwd: projectRoot,
      }

      // 3. 自动修复循环 —— 委托给 verifyLoop.autoFixLoop（唯一实现）
      //    本文件只提供钩子：情绪前缀、LuckyMode 停止条件、收敛检测、修复委托。
      //    历史上这里是整段内联拷贝，与 verifyLoop 的 autoFixLoop 形成双实现，
      //    导致修 bug 要改两处；现已收敛为单一实现。
      const workspace = getAgentWorkspaceManager()
      const targetProfile = workspace.profiles.get(to)
      const asyncManager = getAsyncTaskManager()

      // v02: 自动修复 Worker 也注入完整上下文（项目根目录+可用工具），
      //   不再只给一句"请修复"，否则它和首轮 Worker 一样两眼一抹黑。
      let fixTools: string[] = []
      try { fixTools = resolveToolset('agent', new Set(), true) } catch { /* ignore */ }

      const moodPrefix = mood === 'impatient'
        ? '【紧急】请立即修复以下问题，不要解释原因，只要给出修复代码：\n'
        : mood === 'stressed'
          ? '【简洁修复】请只修复报错指向的问题，不要做额外优化：\n'
          : ''

      let lastFixOutput = ''

      const fixResult = await autoFixLoop(
        verifyConfig,
        task,
        async (fixTask) => {
          console.log(`[DelegationManager] 🔧 修复委托 (给 ${member.name})...`)
          const fixCtx: WorkerPromptContext = {
            to, from, taskType: 'code_debug',
            task: fixTask,
            taskGoal: task,
            availableTools: fixTools,
            projectContext: { cwd: projectRoot },
          }
          const fixChildConfig = workspace.config.buildRunConfig(to as any, targetProfile, {
            systemPrompt: buildWorkerSystemPrompt(fixCtx),
            personaId: to,
          })
          const fixTaskId = asyncManager.submit(
            fixTask,
            fixChildConfig,
            { title: `AutoFix: ${to}`, tags: ['autofix', `${to}`], assignee: to }
          )
          const r = await this._waitForTaskCompletion(asyncManager, fixTaskId, 120_000)
          if (!r.result) {
            return { success: false, content: r.error || '修复任务无结果' }
          }
          lastFixOutput = r.result
          return { success: true, content: r.result }
        },
        {
          moodPrefix: () => moodPrefix,
          shouldStop: (round) => shouldStopDelegationLoop(round, verifyConfig.maxFixRounds),
          isConverged: defaultConvergenceCheck,
        },
      )

      const attempts = fixResult.attempts.map(a => a.note ? `第 ${a.round} 轮: ${a.note}` : `第 ${a.round} 轮: ${a.delegateSuccess ? '已修复但验证仍失败' : '修复任务失败'}`)

      if (fixResult.success) {
        return {
          autoFixed: true,
          fixLog: fixResult.content,
          finalContent: lastFixOutput || delegateOutput,
          attempts,
        }
      }

      // 失败：区分「提前终止」与「轮数耗尽」，都交给上层如实呈现
      const stopped = fixResult.content.startsWith('⏹')
      console.log(`[DelegationManager] ${stopped ? '⏹' : '❌'} 自动修复未通过: ${fixResult.content}`)
      return {
        autoFixed: true,
        fixLog: stopped
          ? fixResult.content
          : `❌ 自动修复失败（${verifyConfig.maxFixRounds} 轮），最终错误:\n${(fixResult.error || '').slice(0, 2000)}`,
        attempts,
      }

    } catch (err: any) {
      console.error(`[DelegationManager] ⚠️ 自动验证异常:`, err.message)
      return { autoFixed: false, fixLog: `自动验证异常: ${err.message}` }
    }
  }

  /**
   * 🆕 v9.0 + Phase 2/3: 阶段门控委托 — 复杂任务走完整五阶段流程
   *
   * Phase 2: 接收 AgentLoopConfig 控制循环行为
   * Phase 3: 情绪影响阶段数量和复杂度判断
   */
  async phaseGatedDelegate(
    request: {
      from: string
      task: string
      taskType: string
      context?: string
      loopConfig?: Partial<AgentLoopConfig>
      approvalGates?: LoopPhase[]
    },
  ): Promise<DelegationResult> {
    const startTime = Date.now()

    // 1. 复杂度分析（Phase 3: 情绪影响复杂度判断）
    const mood = getCurrentMood()
    const analysis = assessComplexity(request.task, { taskType: request.taskType })
    console.log(`[DelegationManager] 📊 复杂度分析: ${analysis.level} (${analysis.score}/100)${mood !== 'neutral' ? ` 🎭 mood=${mood}` : ''}`)

    // 🆕 Phase 3: 情绪影响 — 不耐烦时即使是复杂任务也先直派试试
    const emotionForcesSimple = mood === 'impatient' || mood === 'stressed'
    const effectiveLevel = emotionForcesSimple && analysis.level === 'complex'
      ? 'simple'
      : analysis.level

    // 🆕 Lucky: 根据 Lucky 预设决定是否拆分阶段
    const luckyControl = getLuckyDelegationControl({
      complexity: effectiveLevel,
      taskType: request.taskType,
    })

    if (effectiveLevel === 'simple' && !luckyControl.usePhaseGate) {
      console.log(`[DelegationManager] ⚡ ${emotionForcesSimple ? '情绪驱动 ' : ''}简单任务，直派 Yak`)
      return this.delegate(request.from, {
        to: 'yak',
        task: request.task,
        taskType: request.taskType as any,
        context: request.context,
        loopConfig: request.loopConfig,
        approvalGates: request.approvalGates,
      })
    }

    // 复杂任务 → 分阶段执行
    console.log(`[DelegationManager] 🏗️ 复杂任务，启动阶段门控`)
    console.log(`[DelegationManager]   触发因素: ${analysis.triggers.join(', ')}`)

    // 2. 创建项目看板
    const board = getTaskBoard()
    const project = board.createProject(
      `项目 ${request.task.slice(0, 60)}`,
      request.task,
      effectiveLevel,
    )

    // 3. 构建委托函数（透传 loopConfig）
    const delegateFn = async (to: string, task: string, taskType: string) => {
      const result = await this.delegate(request.from, {
        to: to as any,
        task,
        taskType: taskType as any,
        context: request.context,
        loopConfig: request.loopConfig,
        approvalGates: request.approvalGates,
      })
      return { success: result.success, content: result.content }
    }

    // 4. 确定阶段列表
    const phases: PhaseName[] = getPhasesFromComplexity({
      level: effectiveLevel,
      suggestedPhases: analysis.suggestedPhases,
    })

    // Phase 3: 不耐烦时减少阶段
    const effectivePhases = emotionForcesSimple && phases.length > 3
      ? phases.filter(p => p === 'execute' || p === 'verify')
      : phases

    // 5. 执行门控流程
    const phaseGate = new PhaseGate()
    const gateResult = await phaseGate.execute(effectivePhases, {
      projectId: project.id,
      task: request.task,
      delegateFn,
    })

    // 6. 构建最终输出
    const elapsed = Date.now() - startTime

    if (gateResult.success) {
      board.setFinalResult(project.id, gateResult.content)
      return {
        success: true,
        content: gateResult.content,
        toolCallsCount: 0,
        elapsedMs: elapsed,
      }
    }

    return {
      success: false,
      content: gateResult.content,
      error: gateResult.error || '阶段门控执行失败',
      toolCallsCount: 0,
      elapsedMs: elapsed,
    }
  }

  /** 清理所有 Runner */
  destroy(): void {
    this.runners.clear()
  }
};

// ═══════════════════════════════════════════════════════════
// 单例（垫片 → 委派给 AgentOrchestrator）
// ═══════════════════════════════════════════════════════════

let _instance: DelegationManager | null = null

export function getDelegationManager(): DelegationManager {
  // 优先从 orchestrator 返回
  try {
    const { getOrchestrator } = require('./core/agentOrchestrator')
    const orch = getOrchestrator()
    if (orch.delegation) {return orch.delegation}
  } catch {}
  // fallback: 本地单例
  if (!_instance) {_instance = new DelegationManager()}
  return _instance
}

export function initDelegationManager(): DelegationManager {
  _instance = new DelegationManager()
  // 注册到 orchestrator
  try {
    const { getOrchestrator } = require('./core/agentOrchestrator')
    getOrchestrator().delegation = _instance
  } catch {}
  return _instance
}
