// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// ipc/commandIpc.ts — 斜杠命令 IPC 处理器 (v3.5)
//
// 负责在 agentIpc 的 agent:chat 流程中拦截斜杠命令，
// 路由到 CommandRouter，返回结果给渲染进程。
// ============================================================

import { ipcMain } from 'electron'
import { getCommandRouter, CommandRouter } from '../chatCommands'
import { getHooksSummary } from '../hooks/hookManager'
import { getModelCapabilityCache } from '../modelCapabilityCache'
import type { AgentRunner } from '../agentRunner'
import { isEnabled } from '../core/featureFlags'
import { buildDecisionCommandHandler } from '../decision/ipc'

let _getActiveAgent: (() => AgentRunner | null) | null = null

/** 注册活跃 Agent 引用（由 agentIpc 调用） */
export function setActiveAgentRef(fn: () => AgentRunner | null): void {
  _getActiveAgent = fn
}

/**
 * DelegationManager 的最小接口（仅强制派活命令用到的部分）。
 * 用懒加载 require 拿实例、用本接口约束类型 —— 既避免顶层 import 的
 * 初始化顺序问题，也不引入 `any`。
 */
interface DelegationManagerLike {
  isConfigured(id: string): boolean
  delegate(from: string, req: { to: string; task: string; taskType: string }): Promise<{
    success?: boolean
    content?: string
    error?: string
  }>
}

export function registerCommandHandlers(): void {
  const router = getCommandRouter()

  // ═══════════════════════════════════════════════════
  // /mission — 启动自主任务
  // ═══════════════════════════════════════════════════
  router.register('mission', async (parsed) => {
    const desc = parsed.args.join(' ')
    if (!desc) {return { success: false, message: '用法: /mission <任务描述>' }}

    const agent = _getActiveAgent?.()
    if (!agent) {return { success: false, message: '请先启动 Agent' }}

    // 委托给 agentRunner 的特殊模式
    const result = await agent.run(
      `🔧 MISSION MODE 激活:\n任务: ${desc}\n请分析任务，制定计划，逐步执行。\n每个步骤完成后报告进度。\n完成后输出 "[MISSION_COMPLETE]" 标记。`
    )
    return { success: true, message: result || 'Mission 执行完毕' }
  })

  // ═══════════════════════════════════════════════════
  // /hooks — Hook 管理
  // ═══════════════════════════════════════════════════
  router.register('hooks', async (parsed) => {
    const subCmd = parsed.args[0]
    const hookId = parsed.args[1]

    if (subCmd === 'enable' && hookId) {
      const manager = require('../hooks/hookManager').getHookManager()
      const hook = manager.getRegistration(hookId)
      if (hook) {
        hook.enabled = true
        return { success: true, message: `✅ Hook "${hookId}" 已启用` }
      }
      return { success: false, message: `未找到 Hook: ${hookId}` }
    }

    if (subCmd === 'disable' && hookId) {
      const manager = require('../hooks/hookManager').getHookManager()
      const hook = manager.getRegistration(hookId)
      if (hook) {
        hook.enabled = false
        return { success: true, message: `⏸️ Hook "${hookId}" 已禁用` }
      }
      return { success: false, message: `未找到 Hook: ${hookId}` }
    }

    // 列出所有
    const summary = getHooksSummary()
    return { success: true, message: summary }
  })

  // ═══════════════════════════════════════════════════
  // /model — 模型信息
  // ═══════════════════════════════════════════════════
  router.register('model', async (_parsed) => {
    const agent = _getActiveAgent?.()
    const config = agent ? (agent as any).config : null
    const modelName = config?.model || process.env.LLM_MODEL || '未知'
    const baseUrl = config?.baseUrl || process.env.LLM_BASE_URL || '未知'

    const cache = getModelCapabilityCache()
    const cap = cache.get(modelName)

    const lines = [
      `**模型**: ${modelName}`,
      `**端点**: ${baseUrl}`,
      '',
    ]

    if (cap) {
      lines.push(`**工具支持**: ${cap.supportsTools ? '✅' : '❌'}`)
      lines.push(`**多模态**: ${cap.supportsVision ? '✅' : '❌'}`)
      lines.push(`**上下文窗口**: ${cap.maxContextTokens.toLocaleString()} tokens`)
      lines.push(`**参数规模**: ${cap.paramSize ? cap.paramSize + 'B' : '未知'}`)
      lines.push(`**推荐超时**: ${cap.recommendedTimeout}s`)
      lines.push(`**最后检测**: ${cap.lastChecked}`)
      lines.push(`**历史错误**: ${cap.errorCount} 次`)
    } else {
      lines.push('⚠️ 模型能力缓存为空，将在首次请求后自动探测。')
    }

    return { success: true, message: lines.join('\n') }
  })

  // ═══════════════════════════════════════════════════
  // /context — 上下文信息
  // ═══════════════════════════════════════════════════
  router.register('context', async (_parsed) => {
    const agent = _getActiveAgent?.()
    if (!agent) {return { success: false, message: '请先启动 Agent' }}

    const info = (agent as any).getContextInfo?.() || {
      messages: (agent as any).messages?.length || 0,
      totalTokens: (agent as any).totalTokens || 0,
      turnCount: (agent as any).turnCount || 0,
    }

    return {
      success: true,
      message: [
        `**上下文状态**`,
        `- 消息数: ${info.messages} 条`,
        `- 估算Token: ~${(info.totalTokens || 0).toLocaleString()}`,
        `- 对话轮次: ${info.turnCount} 轮`,
        `- 会话ID: ${(agent as any).sessionId || 'N/A'}`,
      ].join('\n'),
    }
  })

  // ═══════════════════════════════════════════════════
  // /retry — 重试
  // ═══════════════════════════════════════════════════
  router.register('retry', async (_parsed) => {
    const agent = _getActiveAgent?.()
    if (!agent) {return { success: false, message: '请先启动 Agent' }}

    // 用空消息触发重试机制
    const result = await agent.run('请重试上次失败的操作。')
    return { success: true, message: result || '重试完成' }
  })

  // ═══════════════════════════════════════════════════
  // /yak /recha /lumina — 🆕 确定性强制派活（逃生舱）
  //
  // 【为什么需要这三条命令】
  //   默认路由由模型裁量（routingDecider 只往 system prompt 注入一句提示），
  //   同一句话两次问可能派活不同。专业用户最在意「确定性」——这三条命令
  //   跳过路由仲裁，把**这一条消息**强制交给指定角色（一次性，不改变后续）。
  //
  // 【为什么用懒加载 require】
  //   delegationManager 的依赖链会 import agentRunner（类型），在模块顶层
  //   import 可能触发初始化顺序问题；懒加载让命令真正被调用时才解析依赖，
  //   与同文件里 /hooks 的写法一致。
  // ═══════════════════════════════════════════════════
  const forceDelegate = (target: 'yak' | 'recha') =>
    async (parsed: { args: string[] }) => {
      const task = parsed.args.join(' ').trim()
      const who = target === 'yak' ? 'Yak 💻（代码工程师）' : '热茶 🍵（审查员）'
      if (!task) {return { success: false, message: `用法: /${target} <任务描述>` }}

      let dm: DelegationManagerLike
      try {
        dm = require('../delegationManager').getDelegationManager() as DelegationManagerLike
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        return { success: false, message: `团队编排未就绪: ${msg}` }
      }

      if (!dm?.isConfigured?.(target)) {
        return {
          success: false,
          message: `⚠️ ${who} 尚未配置 LLM，无法强制派活。\n请到「设置 → Lumina Team 供应商配置」里给 TA 填上 endpoint / model / key，或改用 /lumina 自己作答。`,
        }
      }

      try {
        const res = await dm.delegate('lumina', {
          to: target,
          task,
          taskType: target === 'yak' ? 'code_write' : 'code_review',
        })
        const body = res?.content || res?.error || '（无返回内容）'
        return {
          success: !!res?.success,
          message: `🎯 已强制派给 ${who}\n\n${body}`,
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        return { success: false, message: `强制派活失败: ${msg}` }
      }
    }

  router.register('yak', forceDelegate('yak'))
  router.register('recha', forceDelegate('recha'))

  // /lumina — 强制由 Lumina 自己作答，不外派（直接把任务交给当前 Agent）
  router.register('lumina', async (parsed) => {
    const task = parsed.args.join(' ').trim()
    if (!task) {return { success: false, message: '用法: /lumina <任务描述>' }}
    const agent = _getActiveAgent?.()
    if (!agent) {return { success: false, message: '请先启动 Agent' }}
    const result = await agent.run(task)
    return { success: true, message: result || '（无返回内容）' }
  })

  // /decide — 生活决策三栏辩论（feature flag: decision.enabled，默认关）。
  // 关闭时明确提示功能未开启，不触发任何 LLM 派活；
  // 开启后结果带 debateResult 结构化数据，渲染层据此挂 DecisionDebateCard。
  router.register('decide', async (parsed: { args: string[] }) => {
    if (!isEnabled('decision.enabled')) {
      return {
        success: false,
        message: '生活决策（三栏辩论）是实验功能，当前未开启。需要在 feature flag「decision.enabled」打开后才能使用。',
      }
    }
    return await buildDecisionCommandHandler()(parsed)
  })

  // ═══════════════════════════════════════════════════
  // IPC: 命令列表查询
  // ═══════════════════════════════════════════════════
  ipcMain.handle('commands:list', async () => {
    return CommandRouter.listCommands().map(c => ({
      name: c.name,
      aliases: c.aliases,
      description: c.description,
      usage: c.usage,
    }))
  })

  ipcMain.handle('commands:help', async (_event, commandName?: string) => {
    return router.generateHelp(commandName)
  })
}
