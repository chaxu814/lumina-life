// ============================================================
// mission/runner.ts — Mission 执行引擎 (v3.5)
//
// 借鉴 QwenPaw Mission Mode:
//   Phase 1: 探索代码库 → 生成 PRD → 用户确认
//   Phase 2: 逐 story 实现 + 自动验证循环
// ============================================================

import type { MissionConfig, MissionState, PRD } from './types'
import {
  readPRD, writePRD, updateStoryStatus,
  allStoriesPassed, getStoryProgress, validatePRD, appendProgress,
} from './state'
import {
  PHASE1_SYSTEM_PROMPT, PHASE2_CONTINUATION_MESSAGE,
  MISSION_COMPLETE_MESSAGE, MISSION_MAX_ITERATIONS_MESSAGE,
} from './prompts'
import type { AgentRunConfig, AgentEvent } from '../tools/types'
import { AgentRunner } from '../agentRunner'

export interface MissionRunnerOptions {
  config: MissionConfig
  loopDir: string
  agentConfig: AgentRunConfig
  onEvent: (event: AgentEvent) => void
  /** 用户确认回调（Phase 1 完成后调用） */
  onConfirmPRD: (prd: PRD) => Promise<boolean>
  /** 内部 Agent 执行器工厂 */
  createAgent?: (systemPrompt: string) => AgentRunner
}

export class MissionRunner {
  private state: MissionState
  private onEvent: (event: AgentEvent) => void
  private onConfirmPRD: (prd: PRD) => Promise<boolean>
  private createAgent: (systemPrompt: string) => AgentRunner
  private agentConfig: AgentRunConfig

  constructor(options: MissionRunnerOptions) {
    this.onEvent = options.onEvent
    this.onConfirmPRD = options.onConfirmPRD
    this.agentConfig = options.agentConfig
    this.createAgent = options.createAgent || ((systemPrompt: string) => {
      return new AgentRunner({
        ...this.agentConfig,
        systemPrompt,
        mode: 'agent',
      })
    })

    this.state = {
      phase: 'phase1_prd',
      config: options.config,
      loopDir: options.loopDir,
      startedAt: new Date().toISOString(),
      progressFile: `${options.loopDir}/progress.txt`,
    }
  }

  /** 启动 Mission */
  async run(): Promise<string> {
    this.emit({ type: 'thinking', text: `🚀 Mission Phase 1: 探索代码库，生成 PRD...` })
    appendProgress(this.state.loopDir, 'Phase 1 开始 — PRD 生成')

    try {
      // Phase 1: PRD 生成
      const prdResult = await this.runPhase1()
      if (!prdResult) {
        return '❌ Phase 1 失败: PRD 生成超时或返回为空。'
      }

      // 解析 PRD
      const prd = this.parsePRDFromResponse(prdResult)
      if (!prd) {
        return '❌ Phase 1 失败: 无法从 LLM 响应中解析 PRD。请确保 LLM 生成了有效的 JSON。'
      }

      // 验证 PRD
      const validation = validatePRD(prd)
      if (!validation.valid) {
        return `❌ PRD 验证失败:\n${validation.errors.map(e => `  - ${e}`).join('\n')}`
      }

      // 保存并请求用户确认
      prd.createdAt = new Date().toISOString()
      writePRD(this.state.loopDir, prd)

      const progress = getStoryProgress(prd)
      this.emit({
        type: 'thinking',
        text: [
          `📋 **PRD 已生成: ${prd.title}**`,
          `摘要: ${prd.summary}`,
          `Stories: ${progress.total} 个`,
          `验证命令: ${prd.verifyCommands.join(', ') || '(无)'}`,
          ``,
          `请确认是否进入 Phase 2 实现阶段。`,
        ].join('\n'),
      })

      const confirmed = await this.onConfirmPRD(prd)
      if (!confirmed) {
        appendProgress(this.state.loopDir, '用户取消 — PRD 已保存可后续继续')
        return '⏸️ PRD 已保存。使用 `/mission continue` 继续。'
      }

      // Phase 2: 执行
      appendProgress(this.state.loopDir, 'Phase 2 开始 — Story 实现')
      this.state.phase = 'phase2_execute'

      return await this.runPhase2(prd)

    } catch (err: any) {
      this.state.phase = 'failed'
      appendProgress(this.state.loopDir, `Mission 失败: ${err.message}`)
      return `❌ Mission 执行异常: ${err.message}`
    }
  }

  /** Phase 1: 生成 PRD */
  private async runPhase1(): Promise<string | null> {
    const agent = this.createAgent(PHASE1_SYSTEM_PROMPT)

    const prdPath = `${this.state.loopDir}/prd.json`
    const phase1Prompt = [
      `请为以下任务生成 PRD:`,
      ``,
      `任务: ${this.state.config.taskText}`,
      `验证命令: ${this.state.config.verifyCommands || '(无)'}`,
      `最大迭代: ${this.state.config.maxIterations}`,
      ``,
      `请:`,
      `1. 浏览项目结构 (file_list)`,
      `2. 阅读关键文件 (file_read)`,
      `3. 分析代码结构 (ast_search)`,
      `4. 将生成的 PRD JSON 保存到: ${prdPath}`,
      ``,
      `生成后输出 PRD 摘要。`,
    ].join('\n')

    try {
      const result = await agent.run(phase1Prompt)

      // 检查 PRD 是否已被保存
      const savedPRD = readPRD(this.state.loopDir)
      if (savedPRD) {
        return JSON.stringify(savedPRD)
      }

      return result || null
    } catch (err: any) {
      console.error('[MissionRunner] Phase 1 异常:', err.message)
      return null
    }
  }

  /** Phase 2: 逐 story 实现 */
  private async runPhase2(prd: PRD): Promise<string> {
    const agent = this.createAgent('')
    let iteration = 0

    while (iteration < prd.maxIterations) {
      iteration++
      prd.currentIteration = iteration
      writePRD(this.state.loopDir, prd)

      const progress = getStoryProgress(prd)

      // 所有完成？
      if (allStoriesPassed(prd)) {
        this.state.phase = 'done'
        appendProgress(this.state.loopDir, `✅ Mission 完成 — ${progress.done}/${progress.total} stories`)
        this.emit({ type: 'thinking', text: MISSION_COMPLETE_MESSAGE
          .replace('{passed}', String(progress.done))
          .replace('{total}', String(progress.total))
        })
        return `✅ Mission 完成！${progress.done}/${progress.total} stories 通过。`
      }

      this.emit({
        type: 'thinking',
        text: `🔄 迭代 ${iteration}/${prd.maxIterations} — 进度: ${progress.done}/${progress.total}`,
      })

      // 构建 continuation message
      const continuation = PHASE2_CONTINUATION_MESSAGE
        .replace('{done}', String(progress.done))
        .replace('{total}', String(progress.total))
        .replace('{iteration}', String(iteration))
        .replace('{maxIterations}', String(prd.maxIterations))

      try {
        const result = await agent.run(continuation)

        if (!result) {
          appendProgress(this.state.loopDir, `迭代 ${iteration} 返回为空`)
          continue
        }

        // 重新读取 PRD（Agent 可能已更新）
        const updatedPRD = readPRD(this.state.loopDir)
        if (updatedPRD) {
          prd.stories = updatedPRD.stories
        }

        appendProgress(this.state.loopDir, `迭代 ${iteration} 完成`)

        // 运行验证命令（如果有）
        if (prd.verifyCommands?.length > 0 && iteration % 3 === 0) {
          appendProgress(this.state.loopDir, `运行验证: ${prd.verifyCommands.join(' && ')}`)
        }

      } catch (err: any) {
        appendProgress(this.state.loopDir, `迭代 ${iteration} 异常: ${err.message}`)
        if (iteration >= prd.maxIterations) {break}
      }
    }

    // 达到最大迭代
    const progress = getStoryProgress(prd)
    this.state.phase = 'failed'
    appendProgress(this.state.loopDir, `⚠️ 达到最大迭代次数 (${prd.maxIterations})`)

    return MISSION_MAX_ITERATIONS_MESSAGE
      .replace('{maxIterations}', String(prd.maxIterations))
      .replace('{passed}', String(progress.done))
      .replace('{total}', String(progress.total))
      .replace('{remaining}', String(progress.total - progress.done))
  }

  /** 从 LLM 响应中提取 PRD JSON */
  private parsePRDFromResponse(text: string): PRD | null {
    if (!text) {return null}

    // 尝试直接解析
    try {
      return JSON.parse(text) as PRD
    } catch { /* not bare JSON */ }

    // 从 markdown 代码块中提取
    const jsonMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/)
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[1].trim()) as PRD
      } catch { /* invalid JSON in code block */ }
    }

    // 查找 JSON 对象
    const objMatch = text.match(/\{[\s\S]*"stories"[\s\S]*\}/)
    if (objMatch) {
      try {
        return JSON.parse(objMatch[0]) as PRD
      } catch { /* invalid */ }
    }

    return null
  }

  private emit(event: AgentEvent): void {
    this.onEvent(event)
  }
}
