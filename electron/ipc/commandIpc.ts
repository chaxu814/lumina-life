// ============================================================
// ipc/commandIpc.ts — 斜杠命令 IPC 处理器 (v3.5)
//
// 负责在 agentIpc 的 agent:chat 流程中拦截斜杠命令，
// 路由到 CommandRouter，返回结果给渲染进程。
// ============================================================

import { ipcMain, BrowserWindow } from 'electron'
import { getCommandRouter, CommandRouter } from '../chatCommands'
import { getHooksSummary } from '../hooks/hookManager'
import { getModelCapabilityCache } from '../modelCapabilityCache'
import type { AgentRunner } from '../agentRunner'

let _getActiveAgent: (() => AgentRunner | null) | null = null

/** 注册活跃 Agent 引用（由 agentIpc 调用） */
export function setActiveAgentRef(fn: () => AgentRunner | null): void {
  _getActiveAgent = fn
}

export function registerCommandHandlers(): void {
  const router = getCommandRouter()

  // ═══════════════════════════════════════════════════
  // /mission — 启动自主任务
  // ═══════════════════════════════════════════════════
  router.register('mission', async (parsed) => {
    const desc = parsed.args.join(' ')
    if (!desc) return { success: false, message: '用法: /mission <任务描述>' }

    const agent = _getActiveAgent?.()
    if (!agent) return { success: false, message: '请先启动 Agent' }

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
    if (!agent) return { success: false, message: '请先启动 Agent' }

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
    if (!agent) return { success: false, message: '请先启动 Agent' }

    // 用空消息触发重试机制
    const result = await agent.run('请重试上次失败的操作。')
    return { success: true, message: result || '重试完成' }
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
