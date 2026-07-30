// ============================================================
// channels/channelAgentBridge.ts — 📡 渠道↔Agent 消息桥接 (v14.x)
//
// 功能:
//   将 IM 渠道（钉钉/企微/QQ/Telegram/Slack）收到的消息
//   转发给 Lumina Agent 处理，处理结果通过原路返回。
//
// 架构:
//   每个渠道+用户 维护一个独立会话（AgentRunner 实例），
//   支持多轮对话上下文保持。
// ============================================================

import { AgentRunner } from '../agentRunner'
import { getAgentConfig, type AgentId } from '../agentConfig'
import { getChannelManager } from './channelManager'
import type { ChannelMessage, ChannelAdapter } from './types'

interface SessionEntry {
  runner: AgentRunner
  lastActive: number
  channelKey: string
  targetId: string
  isGroup: boolean
}

export class ChannelAgentBridge {
  /** 会话表: channelType+fromUser → SessionEntry */
  private sessions = new Map<string, SessionEntry>()
  /** 闲置超时（15 分钟无消息自动销毁） */
  private idleTimeoutMs = 15 * 60 * 1000
  /** 清理定时器 */
  private cleanupTimer: ReturnType<typeof setInterval> | null = null

  constructor() {
    // 每分钟检查一次过期会话
    this.cleanupTimer = setInterval(() => this.cleanup(), 60_000)
  }

  /**
   * 处理一条渠道消息
   *  1. 查找/创建对应会话
   *  2. 通过 AgentRunner 处理消息
   *  3. 将回复发回原渠道
   */
  async handleMessage(msg: ChannelMessage): Promise<void> {
    const sessionKey = this.buildSessionKey(msg)

    // 查找或创建会话
    let session = this.sessions.get(sessionKey)
    if (!session) {
      // 新建 AgentRunner
      const runner = this.createRunner(msg)
      if (!runner) {
        console.warn(`[ChannelBridge] 无法为 ${msg.channel}/${msg.fromUser} 创建 AgentRunner（LLM 未配置）`)
        return
      }
      session = {
        runner,
        lastActive: Date.now(),
        channelKey: msg.channel, // 使用 channel type 作为 key
        targetId: msg.groupId || msg.fromUser,
        isGroup: !!msg.groupId,
      }
      this.sessions.set(sessionKey, session)
      console.log(`[ChannelBridge] 🆕 新会话: ${sessionKey}`)
    }

    // 更新活跃时间
    session.lastActive = Date.now()

    // 找对应的 channel adapter 发消息
    const channelAdapter = this.findAdapter(msg.channel)
    if (!channelAdapter) {
      console.warn(`[ChannelBridge] 找不到渠道适配器: ${msg.channel}`)
      return
    }

    try {
      // 构造带渠道前缀的消息，让 Agent 知道来源
      const prefixed = this.buildAgentMessage(msg)

      // 🆕 发送"收到"提示（可选，长耗时任务时有用）
      // 暂不发送，等完整回复

      // 调用 Agent
      const reply = await session.runner.sendMessage(prefixed)

      // 将回复发回渠道
      if (reply && reply.trim()) {
        await channelAdapter.send({
          targetId: session.targetId,
          isGroup: session.isGroup,
          text: reply.trim(),
        })
        console.log(`[ChannelBridge] ✅ 回复已发送: ${reply.slice(0, 60)}...`)
      }
    } catch (err: any) {
      console.error(`[ChannelBridge] ❌ 处理消息失败:`, err.message)
      try {
        await channelAdapter.send({
          targetId: session.targetId,
          isGroup: session.isGroup,
          text: `抱歉，处理消息时出错了：${err.message}`,
        })
      } catch {}
    }
  }

  /** 销毁所有会话 */
  destroy(): void {
    for (const [, session] of this.sessions) {
      try { session.runner.abort() } catch {}
    }
    this.sessions.clear()
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
    }
    console.log('[ChannelBridge] 已销毁所有会话')
  }

  // ── 内部方法 ──────────────────────────────────────

  /** 构建会话 key */
  private buildSessionKey(msg: ChannelMessage): string {
    // 群聊: channelType + groupId
    // 私聊: channelType + fromUser
    const uid = msg.groupId || msg.fromUser
    return `${msg.channel}:${uid}`
  }

  /** 查找对应的渠道适配器实例 */
  private findAdapter(channelType: string): ChannelAdapter | undefined {
    const manager = getChannelManager()
    const statuses = manager.getStatus()
    for (const st of statuses) {
      if (st.type === channelType && st.online) {
        // 通过 adapters map 取实例
        const adapters = (manager as any).adapters as Map<string, ChannelAdapter>
        return adapters.get(st.key)
      }
    }
    return undefined
  }

  /** 创建 AgentRunner（复用 Lumina 的 LLM 配置） */
  private createRunner(msg: ChannelMessage): AgentRunner | null {
    const agentConfig = getAgentConfig()

    // 找配置好的 LLM（优先 Lumina，降级到任意可用）
    let llmConfig: { endpoint: string; model: string; apiKey: string } | null = null
    if (agentConfig.isConfigured('lumina')) {
      const c = agentConfig.get('lumina')
      llmConfig = { endpoint: c.endpoint, model: c.model, apiKey: c.apiKey || '' }
    } else {
      // 降级：找第一个配置了的 Agent
      for (const id of ['yak', 'recha'] as AgentId[]) {
        if (agentConfig.isConfigured(id)) {
          const c = agentConfig.get(id)
          llmConfig = { endpoint: c.endpoint, model: c.model, apiKey: c.apiKey || '' }
          break
        }
      }
    }

    if (!llmConfig) return null

    const runner = new AgentRunner({
      mode: 'agent',
      personaId: 'lumina',
      baseUrl: llmConfig.endpoint,
      model: llmConfig.model,
      apiKey: llmConfig.apiKey,
      skipApproval: true,
    })

    return runner
  }

  /** 构造发给 Agent 的消息（带渠道上下文） */
  private buildAgentMessage(msg: ChannelMessage): string {
    const sourceLabel: Record<string, string> = {
      dingtalk: '钉钉',
      wechat: '企业微信',
      qq: 'QQ',
      slack: 'Slack',
      telegram: 'Telegram',
    }
    const platform = sourceLabel[msg.channel] || msg.channel
    const userLabel = msg.fromUserName || msg.fromUser
    const context = msg.groupId
      ? `[📡 来自 ${platform} 群聊（${msg.groupName || ''}）的用户 ${userLabel}]`
      : `[📡 来自 ${platform} 的用户 ${userLabel}]`

    return `${context}\n${msg.text}`
  }

  /** 清理过期会话 */
  private cleanup(): void {
    const now = Date.now()
    for (const [key, session] of this.sessions) {
      if (now - session.lastActive > this.idleTimeoutMs) {
        try { session.runner.abort() } catch {}
        this.sessions.delete(key)
        console.log(`[ChannelBridge] 🧹 过期会话已清理: ${key}`)
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════
// 全局单例
// ═══════════════════════════════════════════════════════════

let _bridge: ChannelAgentBridge | null = null

export function getChannelAgentBridge(): ChannelAgentBridge {
  if (!_bridge) _bridge = new ChannelAgentBridge()
  return _bridge
}

export function initChannelAgentBridge(): ChannelAgentBridge {
  _bridge = new ChannelAgentBridge()
  return _bridge
}
