// ============================================================
// push/pushService.ts — 多渠道推送服务 v1.0
//
// 支持:
//   - 🚀 ServerChan (微信推送) — https://sct.ftqq.com
//   - 📮 钉钉机器人 Webhook
//   - 🔔 系统 Notification (Electron native)
//
// 推送事件:
//   - 新邮件
//   - 梦境生成
//   - 时光胶囊到期
//   - 等级提升
//   - 定时任务完成
//   - 自定义消息
// ============================================================

import { Notification } from 'electron'
import { stripMarkdown } from '../utils/stripMarkdown'

// ═══════════════════════════════════════════════════════════
// 配置
// ═══════════════════════════════════════════════════════════

export interface PushConfig {
  serverChanKey: string
  dingTalkWebhook: string
  dingTalkSecret: string
  notifyNewMail: boolean
  notifyDream: boolean
  notifyLevelUp: boolean
  notifyCapsule: boolean
  notifyTaskDone: boolean
}

export const DEFAULT_PUSH_CONFIG: PushConfig = {
  serverChanKey: '',
  dingTalkWebhook: '',
  dingTalkSecret: '',
  notifyNewMail: true,
  notifyDream: true,
  notifyLevelUp: true,
  notifyCapsule: true,
  notifyTaskDone: true,
}

// 运行时配置（从 config.json 加载）
let currentConfig: PushConfig = { ...DEFAULT_PUSH_CONFIG }

export function updatePushConfig(config: Partial<PushConfig>): void {
  currentConfig = { ...currentConfig, ...config }
}

export function getPushConfig(): PushConfig {
  return { ...currentConfig }
}

// ═══════════════════════════════════════════════════════════
// 推送发送
// ═══════════════════════════════════════════════════════════

/**
 * ServerChan 推送 (微信)
 * 文档: https://sct.ftqq.com/document
 */
async function sendServerChan(title: string, content: string): Promise<boolean> {
  if (!currentConfig.serverChanKey) {return false}
  try {
    const url = `https://sctapi.ftqq.com/${currentConfig.serverChanKey}.send`
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, content }),
    })
    const data = await resp.json()
    if (data.code === 0 || data.errno === 0) {
      console.log(`[PushService] ✅ ServerChan 推送成功: "${title}"`)
      return true
    }
    console.warn(`[PushService] ⚠️ ServerChan 返回异常:`, data)
    return false
  } catch (e) {
    console.error('[PushService] ❌ ServerChan 推送失败:', e)
    return false
  }
}

/**
 * 钉钉机器人 Webhook 推送
 * 文档: https://open.dingtalk.com/document/robots/custom-robot-access
 */
async function sendDingTalk(title: string, content: string): Promise<boolean> {
  if (!currentConfig.dingTalkWebhook) {return false}
  try {
    let url = currentConfig.dingTalkWebhook
    // 如果配置了加签密钥
    if (currentConfig.dingTalkSecret) {
      const timestamp = Date.now()
      const sign = await generateDingTalkSign(timestamp, currentConfig.dingTalkSecret)
      url += `&timestamp=${timestamp}&sign=${sign}`
    }
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        msgtype: 'markdown',
        markdown: {
          title,
          text: `## ${title}\n\n${content}\n\n---\n*Lumina Life 推送*`,
        },
      }),
    })
    const data = await resp.json()
    if (data.errcode === 0) {
      console.log(`[PushService] ✅ 钉钉推送成功: "${title}"`)
      return true
    }
    console.warn(`[PushService] ⚠️ 钉钉返回异常:`, data)
    return false
  } catch (e) {
    console.error('[PushService] ❌ 钉钉推送失败:', e)
    return false
  }
}

/**
 * 钉钉加签 (HMAC-SHA256)
 */
async function generateDingTalkSign(timestamp: number, secret: string): Promise<string> {
  const { createHmac } = await import('crypto')
  const stringToSign = `${timestamp}\n${secret}`
  const hmac = createHmac('sha256', secret)
  hmac.update(stringToSign)
  return hmac.digest('base64')
}

/**
 * 系统 Notification (Electron 原生)
 */
function sendNotification(title: string, body: string): void {
  try {
    const n = new Notification({ title: stripMarkdown(title), body: stripMarkdown(body) })
    n.show()
  } catch (e) {
    console.error('[PushService] ❌ 系统通知失败:', e)
  }
}

// ═══════════════════════════════════════════════════════════
// 统一推送接口
// ═══════════════════════════════════════════════════════════

export interface PushMessage {
  title: string
  content: string
  /** 消息分类，用于判断是否需要推送 */
  category?: 'mail' | 'dream' | 'levelup' | 'capsule' | 'task' | 'custom'
}

/**
 * 推送一条消息到所有已启用的渠道
 */
export async function pushMessage(msg: PushMessage): Promise<{
  serverChan: boolean
  dingTalk: boolean
  notification: boolean
}> {
  const results = { serverChan: false, dingTalk: false, notification: false }

  // 根据分类判断是否推送
  const category = msg.category || 'custom'
  const categoryKey = `notify${category.charAt(0).toUpperCase() + category.slice(1)}` as keyof PushConfig
  if (currentConfig[categoryKey] === false) {
    console.log(`[PushService] ⏭️ 跳过 "${category}" 类消息推送: "${msg.title}"`)
    return results
  }

  // 并行推送
  const [scResult, dtResult] = await Promise.all([
    sendServerChan(msg.title, msg.content),
    sendDingTalk(msg.title, msg.content),
  ])
  results.serverChan = scResult
  results.dingTalk = dtResult

  // 系统通知始终发送
  sendNotification(msg.title, msg.content)
  results.notification = true

  return results
}

/**
 * 快捷方式：推送新邮件通知
 */
export function pushNewMail(from: string, subject: string, preview: string): Promise<{
  serverChan: boolean; dingTalk: boolean; notification: boolean
}> {
  return pushMessage({
    title: `📧 ${from} 给你发了一封邮件`,
    content: `**${subject}**\n\n> ${preview.slice(0, 200)}`,
    category: 'mail',
  })
}

/**
 * 快捷方式：推送新梦境通知
 */
export function pushNewDream(title: string, mood: string): Promise<{
  serverChan: boolean; dingTalk: boolean; notification: boolean
}> {
  return pushMessage({
    title: `🌙 新梦境: ${title}`,
    content: `梦境情绪: ${mood}\n\nLumina 为你编织了新的梦境日记，去看看吧~`,
    category: 'dream',
  })
}

/**
 * 快捷方式：推送升级通知
 */
export function pushLevelUp(level: number, title: string): Promise<{
  serverChan: boolean; dingTalk: boolean; notification: boolean
}> {
  return pushMessage({
    title: `🎉 升级啦! Lv.${level} ${title}`,
    content: `恭喜达到 Lv.${level}「${title}」!\n继续与 Lumina 互动，解锁更多能力~`,
    category: 'levelup',
  })
}

/**
 * 快捷方式：推送时光胶囊到期通知
 */
export function pushCapsuleExpired(message: string): Promise<{
  serverChan: boolean; dingTalk: boolean; notification: boolean
}> {
  return pushMessage({
    title: `📮 时光胶囊已开启`,
    content: `你在过去埋下的时光胶囊已经到期!\n\n> ${message.slice(0, 300)}`,
    category: 'capsule',
  })
}
