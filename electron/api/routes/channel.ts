// ============================================================
// api/routes/channel.ts — 📡 渠道 Webhook API 路由 (Phase C)
//
// 为各渠道提供 Webhook 接收端点。
// 由 ChannelManager 分发到对应的适配器实例。
// ============================================================

import { getChannelManager } from '../../channels/channelManager'
import { DingTalkAdapter } from '../../channels/adapters/dingtalk'
import { SlackAdapter } from '../../channels/adapters/slack'

/** POST /api/channel/dingtalk — 钉钉消息回调 */
export async function handleDingTalkWebhook(
  req: any,
  res: any,
): Promise<void> {
  const manager = getChannelManager()
  const body = req._body || {}

  // 实际查找适配器实例并转发消息
  const adapters = (manager as any).adapters as Map<string, any>
  for (const [, adapter] of adapters) {
    if (adapter.type === 'dingtalk' && typeof adapter.handleIncoming === 'function') {
      await adapter.handleIncoming(body)
      break
    }
  }

  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ ok: true }))
}

/** POST /api/channel/slack — Slack Events API 回调 */
export async function handleSlackWebhook(
  req: any,
  res: any,
): Promise<void> {
  const body = req._body || {}
  const signature = req.headers?.['x-slack-signature'] || ''
  const timestamp = req.headers?.['x-slack-request-timestamp'] || ''
  const rawBody = req._rawBody || ''

  // 查找 Slack 适配器
  const manager = getChannelManager()
  const adapters = (manager as any).adapters as Map<string, any>
  let slackAdapter: SlackAdapter | null = null
  for (const [, adapter] of adapters) {
    if (adapter instanceof SlackAdapter) {
      slackAdapter = adapter
      break
    }
  }

  if (!slackAdapter) {
    res.writeHead(503, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Slack 渠道不在线' }))
    return
  }

  // 验证签名
  if (!slackAdapter.verifySignature(signature, timestamp, rawBody)) {
    res.writeHead(401, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: '签名验证失败' }))
    return
  }

  const result = await slackAdapter.handleEvent(body)
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(result))
}

/** POST /api/channel/telegram — Telegram Webhook 回调 */
export async function handleTelegramWebhook(
  _req: any,
  res: any,
): Promise<void> {
  const body = _req._body || {}
  const manager = getChannelManager()
  const statuses = manager.getStatus()
  const tgStatus = statuses.find(s => s.type === 'telegram')

  if (!tgStatus || !tgStatus.online) {
    // Telegram 要求即使无处理也要返回 200
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('OK')
    return
  }

  // 查找 Telegram 适配器
  const adapters = (manager as any).adapters as Map<string, any>
  for (const [, adapter] of adapters) {
    if (adapter.type === 'telegram') {
      const result = adapter.handleWebhook(body)
      res.writeHead(result.status, { 'Content-Type': 'text/plain' })
      res.end(result.body)
      return
    }
  }

  res.writeHead(200, { 'Content-Type': 'text/plain' })
  res.end('OK')
}

/** GET /api/channel/telegram — Telegram Webhook 验证 */
export async function handleTelegramWebhookGet(
  _req: any,
  res: any,
): Promise<void> {
  // Telegram 用 GET 做 Webhook 验证，直接返回 OK
  res.writeHead(200, { 'Content-Type': 'text/plain' })
  res.end('OK')
}

/** 🆕 v16.0-fix: POST /api/channel/wechat — 企业微信消息回调 */
export async function handleWeChatWebhook(
  req: any,
  res: any,
): Promise<void> {
  const body = req._body || {}
  const query = req._query || {}

  // 查找 WeChat 适配器
  const manager = getChannelManager()
  const adapters = (manager as any).adapters as Map<string, any>
  let wechatAdapter: any = null
  for (const [, adapter] of adapters) {
    if (adapter.type === 'wechat' && typeof adapter.handleIncoming === 'function') {
      wechatAdapter = adapter
      break
    }
  }

  if (!wechatAdapter) {
    // 企业微信要求即使不可用也返回成功（否则会重复推送）
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('ok')
    return
  }

  const result = await wechatAdapter.handleIncoming(query, body)
  res.writeHead(200, { 'Content-Type': 'text/plain' })
  res.end(result || 'ok')
}

/** GET /api/channel/wechat — 企业微信 URL 验证 */
export async function handleWeChatWebhookGet(
  req: any,
  res: any,
): Promise<void> {
  const query = req._query || {}

  // 查找 WeChat 适配器做签名验证
  const manager = getChannelManager()
  const adapters = (manager as any).adapters as Map<string, any>
  for (const [, adapter] of adapters) {
    if (adapter.type === 'wechat' && typeof adapter.handleIncoming === 'function') {
      const result = await adapter.handleIncoming(query, {})
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end(result || '')
      return
    }
  }

  res.writeHead(200, { 'Content-Type': 'text/plain' })
  res.end('')
}

/** 🆕 v14.x: POST /api/channel/qq — QQ 机器人消息回调 */
export async function handleQQWebhook(
  req: any,
  res: any,
): Promise<void> {
  const body = req._body || {}
  const headers = req.headers || {}

  // 查找 QQ 适配器
  const manager = getChannelManager()
  const adapters = (manager as any).adapters as Map<string, any>
  for (const [, adapter] of adapters) {
    if (adapter.type === 'qq' && typeof adapter.handleIncoming === 'function') {
      const result = await adapter.handleIncoming(body, headers)
      res.writeHead(result.status, { 'Content-Type': 'text/plain' })
      res.end(result.body)
      return
    }
  }

  // QQ 要求即使没有处理也要返回 200
  res.writeHead(200, { 'Content-Type': 'text/plain' })
  res.end('ok')
}

/** GET /api/channels — 获取所有渠道状态 */
export async function handleChannelStatusRoute(
  _req: any,
  res: any,
): Promise<void> {
  const manager = getChannelManager()
  const statuses = manager.getStatus()

  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify({
    success: true,
    channels: statuses,
    configs: manager.getConfigs(),
  }, null, 2))
}
