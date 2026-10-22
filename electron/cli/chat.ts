// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// cli/chat.ts — CLI 聊天命令
// ============================================================

import type { AgentRunConfig } from '../tools/types'
import type { AgentId } from '../agentConfig'

export async function handleChat(args: string[]): Promise<{ ok: boolean; data?: any; error?: string }> {
  if (args.length === 0 || args[0] === '--help') {
    return {
      ok: true,
      data: `用法: lumina chat "<消息>" [--mode agent|chat|developer] [--agent lumina|recha|yak]

示例:
  lumina chat "今天天气怎么样"
  lumina chat "帮我写个 Python 脚本" --mode developer
  lumina chat "你好呀" --agent lumina --mode chat`,
    }
  }

  // 解析参数
  const parsed = parseArgs(args)
  const positional = Array.isArray(parsed._) ? parsed._ : []
  const message = positional.join(' ') || args[0]

  if (!message) {
    return { ok: false, error: '请提供消息内容' }
  }

  const mode = (parsed.mode as string) || 'agent'
  const agentId = (parsed.agent as string) || 'lumina'

  try {
    const { getAgentConfig } = await import('../agentConfig')
    const config = getAgentConfig()
    const agentCfg = config.get(agentId as AgentId)

    if (!agentCfg || !agentCfg.enabled) {
      return { ok: false, error: `Agent "${agentId}" 未配置，请在 GUI 中设置` }
    }

    const runConfig: AgentRunConfig = {
      mode: mode as AgentRunConfig['mode'],
      model: agentCfg.model,
      baseUrl: agentCfg.endpoint,
      apiKey: agentCfg.apiKey || '',
      // 🐛 2026-10-10 修复：maxContextTokens 是**上下文窗口**，不是输出上限
      contextWindow: agentCfg.maxContextTokens || 0,
      personaId: agentId,
    }

    // 使用 AgentRunner 执行对话
    const { AgentRunner } = await import('../agentRunner')
    const runner = new AgentRunner(runConfig)

    // 注册事件回调以在控制台显示实时状态
    runner.setEventCallback((event) => {
      if (event.type === 'thinking' && event.text) {
        process.stdout.write(`\r🤔 ${event.text}`)
      } else if (event.type === 'tool_start') {
        process.stdout.write(`\r🔧 执行工具: ${event.tool}...`)
      } else if (event.type === 'error') {
        process.stdout.write(`\r❌ 错误: ${event.error}\n`)
      }
    })

    // 执行对话
    const result = await runner.run(message)
    return { ok: true, data: result }

  } catch (err: any) {
    return { ok: false, error: `对话执行失败: ${err.message}` }
  }
}

/** 简易参数解析: --key value --flag */
function parseArgs(args: string[]): Record<string, string | string[] | boolean> {
  const result: Record<string, any> = { _: [] as string[] }
  let i = 0
  while (i < args.length) {
    const arg = args[i]
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
        result[key] = args[i + 1]
        i += 2
      } else {
        result[key] = true
        i += 1
      }
    } else {
      result._.push(arg)
      i += 1
    }
  }
  return result
}
