// ============================================================
// api/routes/chat.ts — POST /api/chat
// ============================================================

import type { IncomingMessage, ServerResponse } from 'http'

export async function handleChatRoute(
  _req: IncomingMessage,
  res: ServerResponse,
  _match: RegExpExecArray,
  body: any,
): Promise<void> {
  const message = body?.message
  if (!message) {
    writeJson(res, 400, { error: '缺少 message 字段' })
    return
  }

  const mode = body?.mode || 'agent'
  const agentId = body?.agent_id || 'lumina'

  try {
    // 动态导入以避免循环依赖
    const { getAgentConfig } = await import('../../agentConfig')
    const { AgentRunner } = await import('../../agentRunner')

    const config = getAgentConfig()
    const agentCfg = config.get(agentId)

    if (!agentCfg || !agentCfg.enabled) {
      writeJson(res, 400, { error: `Agent "${agentId}" 未配置` })
      return
    }

    const runner = new AgentRunner({
      mode: mode as 'chat' | 'agent' | 'developer',
      model: agentCfg.model,
      baseUrl: agentCfg.endpoint,
      apiKey: agentCfg.apiKey || '',
      maxTokens: agentCfg.maxContextTokens,
      personaId: agentId,
    })

    const result = await runner.run(message)

    writeJson(res, 200, {
      ok: true,
      content: result || '',
      agent_id: agentId,
      mode,
    })
  } catch (err: any) {
    writeJson(res, 500, { error: `对话执行失败: ${err.message}` })
  }
}

function writeJson(res: ServerResponse, status: number, data: any): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(data, null, 2))
}
