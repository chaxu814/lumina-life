#!/usr/bin/env node
/* ============================================================
 * scripts/verify-telegram.cjs — Telegram 渠道端到端验证
 *
 * 【为什么需要它】
 *   Lumina 有 7 个 IM 适配器，但只有 Telegram 默认开启，且此前**从未
 *   端到端真机验证**。这个脚本把「验证」变成一条命令 —— 你不需要读懂
 *   代码，只要跑它，就能确认「Bot 通不通、消息发不发得出去、Webhook 配没配」。
 *
 * 【用法】
 *   node scripts/verify-telegram.cjs <BOT_TOKEN> [CHAT_ID]
 *
 *   1) 只验 token：      node scripts/verify-telegram.cjs 123456:ABC...
 *   2) 验 token + 发消息：node scripts/verify-telegram.cjs 123456:ABC... 987654321
 *
 *   获取 CHAT_ID 的最快方式：给 Bot 发一条消息，然后访问
 *     https://api.telegram.org/bot<TOKEN>/getUpdates
 *   在返回里找 message.chat.id。
 *
 * 【退出码】0 = 全部通过；1 = 有一步失败（适合接进 CI / 脚本）
 * ============================================================ */

const https = require('https')

const token = process.argv[2]
const chatId = process.argv[3]

if (!token) {
  console.error('用法: node scripts/verify-telegram.cjs <BOT_TOKEN> [CHAT_ID]')
  console.error('提示: 在 @BotFather 创建 Bot 可拿到 BOT_TOKEN')
  process.exit(2)
}

function api(method, body) {
  return new Promise((resolve) => {
    const postData = body ? JSON.stringify(body) : null
    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${token}/${method}`,
      method: postData ? 'POST' : 'GET',
      timeout: 15000,
      headers: postData
        ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData).toString() }
        : {},
    }
    const req = https.request(options, (res) => {
      let data = ''
      res.on('data', (c) => (data += c))
      res.on('end', () => {
        try { resolve({ http: res.statusCode, json: JSON.parse(data) }) }
        catch { resolve({ http: res.statusCode, json: null, raw: data }) }
      })
    })
    req.on('error', (e) => resolve({ error: e.message }))
    req.on('timeout', () => { req.destroy(); resolve({ error: 'timeout' }) })
    if (postData) req.write(postData)
    req.end()
  })
}

const ok = (s) => `\x1b[32m✅ ${s}\x1b[0m`
const bad = (s) => `\x1b[31m❌ ${s}\x1b[0m`
const info = (s) => `\x1b[36mℹ️  ${s}\x1b[0m`

let failed = false

async function main() {
  console.log('\n=== Lumina · Telegram 渠道端到端验证 ===\n')

  // ── 步骤 1：Token 有效性 ──
  const me = await api('getMe')
  if (me.error) {
    console.log(bad(`无法连接 Telegram API：${me.error}`))
    console.log(info('检查网络/代理是否可达 api.telegram.org'))
    failed = true
    return finish()
  }
  if (me.json && me.json.ok) {
    console.log(ok(`Token 有效 · Bot: @${me.json.result.username}（${me.json.result.first_name}）`))
  } else {
    console.log(bad(`Token 无效：${JSON.stringify(me.json)}`))
    failed = true
    return finish()
  }

  // ── 步骤 2：Webhook 状态 ──
  const wh = await api('getWebhookInfo')
  if (wh.json && wh.json.ok) {
    const url = wh.json.result.url
    if (url) {
      console.log(ok(`Webhook 已配置：${url}`))
      if (wh.json.result.last_error_message) {
        console.log(bad(`最近一次投递失败：${wh.json.result.last_error_message}`))
        failed = true
      }
    } else {
      console.log(info('未配置 Webhook（若你用轮询模式可忽略；Webhook 模式请先 setWebhook）'))
    }
  }

  // ── 步骤 3：发送测试消息（可选） ──
  if (!chatId) {
    console.log(info('未提供 CHAT_ID，跳过发送测试。'))
    console.log(info('补上 CHAT_ID 可验证「消息真的发得出去」：'))
    console.log('    node scripts/verify-telegram.cjs <BOT_TOKEN> <CHAT_ID>\n')
    return finish()
  }

  const send = await api('sendMessage', {
    chat_id: chatId,
    text: '🌸 Lumina Telegram 渠道验证消息 —— 收到即代表发送链路正常。',
  })
  if (send.json && send.json.ok) {
    console.log(ok(`测试消息已发送到 chat ${chatId}（请检查手机是否收到）`))
  } else {
    console.log(bad(`发送失败：${JSON.stringify(send.json)}`))
    console.log(info('常见原因：CHAT_ID 不对 / 用户没先给 Bot 发过消息 / Bot 被拉黑'))
    failed = true
  }

  finish()
}

function finish() {
  console.log('')
  if (failed) {
    console.log(bad('验证未全部通过 —— 请按上面提示逐条排查。'))
    process.exit(1)
  }
  console.log(ok('验证通过。'))
  console.log(info('其余 6 个渠道（discord/slack/qq/dingtalk/wechat/openclaw）尚未做端到端验证，README 已如实标注。\n'))
  process.exit(0)
}

main().catch((e) => {
  console.error(bad('脚本异常：' + (e && e.message ? e.message : e)))
  process.exit(1)
})
