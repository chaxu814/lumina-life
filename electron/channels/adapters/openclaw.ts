// ============================================================
// channels/adapters/openclaw.ts — OpenClaw 桥接渠道适配器 (v0.1)
//
// 把 OpenClaw 作为一个「渠道 / 外部执行后端」接入现有 ChannelManager：
//   send() 不再走 IM 协议，而是把任务经 A2A 发给 OpenClaw 执行。
// 连不上时 init/healthCheck 返回 false、send 返回 false，由上层回退，绝不崩溃。
// ============================================================

import type { ChannelAdapter, ChannelConfig, ChannelSendRequest, ChannelMessage } from '../types'
import { OpenClawClient } from '../openclaw/openclawClient'

export class OpenClawAdapter implements ChannelAdapter {
  readonly type = 'openclaw' as const
  readonly name = 'OpenClaw Bridge'

  private client: OpenClawClient | null = null
  private handler: ((msg: ChannelMessage) => void) | null = null

  async init(config: ChannelConfig): Promise<boolean> {
    const baseUrl = config.credentials?.baseUrl || (config.options?.baseUrl as string) || ''
    const token = config.credentials?.token || ''
    this.client = new OpenClawClient({ baseUrl, token })
    if (!this.client.isConfigured()) {
      console.warn('[OpenClaw] 未配置 baseUrl，桥接渠道不启动（不影响其它渠道）')
      return false
    }
    const ping = await this.client.ping()
    if (!ping.ok) {
      console.warn(`[OpenClaw] Gateway 不可达（${ping.error}），桥接渠道暂不启动`)
      return false
    }
    console.log('[OpenClaw] ✅ 已连接 Gateway', ping.data?.version ? `v${ping.data.version}` : '')
    return true
  }

  async send(request: ChannelSendRequest): Promise<boolean> {
    if (!this.client) return false
    const r = await this.client.sendTask({ text: request.text, targetId: request.targetId })
    if (!r.ok) {
      console.warn(`[OpenClaw] 任务委托失败（${r.error}），上层应回退本地执行`)
      return false
    }
    return true
  }

  /** OpenClaw 回推消息时可由此转发给统一消息处理（保留接口，v0.1 暂不主动拉取） */
  onMessage(handler: (msg: ChannelMessage) => void): void {
    this.handler = handler
  }

  async healthCheck(): Promise<boolean> {
    if (!this.client) return false
    const r = await this.client.ping()
    return r.ok
  }

  async destroy(): Promise<void> {
    this.client = null
    this.handler = null
  }
}
