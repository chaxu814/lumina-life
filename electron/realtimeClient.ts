// ============================================================
// realtimeClient.ts — Realtime API 客户端 (v2.5)
//
// 借鉴 N.E.K.O.: WebSocket 连接 OpenAI Realtime API，
// 支持实时语音对话 + 打断逻辑
//
// 依赖: 兼容 OpenAI Realtime API 的服务 (如阿里云百炼)
// ============================================================

import { EventEmitter } from 'events'
import WebSocket from 'ws'

// ═══════════════════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════════════════

export interface RealtimeConfig {
  url: string
  apiKey: string
  model: string
  voice?: string
  systemPrompt?: string
  temperature?: number
}

export interface RealtimeStatus {
  connected: boolean
  model: string
  voice: string
  sessionId: string
}

export type RealtimeEventType =
  | 'connected'
  | 'disconnected'
  | 'error'
  | 'speech_started'
  | 'speech_stopped'
  | 'text_delta'
  | 'audio_delta'
  | 'interrupted'
  | 'conversation_item_created'

export interface RealtimeEvent {
  type: RealtimeEventType
  data?: any
}

// ═══════════════════════════════════════════════════════════
// 客户端
// ═══════════════════════════════════════════════════════════

export class RealtimeClient extends EventEmitter {
  private ws: WebSocket | null = null
  private config: RealtimeConfig | null = null
  private connected = false
  private sessionId = ''
  private reconnectAttempts = 0
  private maxReconnectAttempts = 5
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null

  // ── 连接管理 ─────────────────────────────────────────

  async connect(config: RealtimeConfig): Promise<RealtimeStatus> {
    this.config = config

    return new Promise((resolve, reject) => {
      try {
        const headers: Record<string, string> = {
          'Authorization': `Bearer ${config.apiKey}`,
          'OpenAI-Beta': 'realtime=v1',
        }

        this.ws = new WebSocket(`${config.url}?model=${config.model}`, { headers })

        const timeout = setTimeout(() => {
          reject(new Error('Realtime API 连接超时 (10s)'))
        }, 10000)

        this.ws.on('open', () => {
          clearTimeout(timeout)
          this.connected = true
          this.sessionId = `session_${Date.now()}`
          this.reconnectAttempts = 0

          // 发送 session.update 配置
          this.send({
            type: 'session.update',
            session: {
              modalities: ['text', 'audio'],
              instructions: config.systemPrompt || '你是 Lumina，一个 AI 桌面助手。',
              voice: config.voice || 'alloy',
              input_audio_format: 'pcm16',
              output_audio_format: 'pcm16',
              temperature: config.temperature ?? 0.8,
            },
          })

          const status: RealtimeStatus = {
            connected: true,
            model: config.model,
            voice: config.voice || 'alloy',
            sessionId: this.sessionId,
          }

          this.emit('realtime', { type: 'connected', data: status } as RealtimeEvent)
          resolve(status)
          console.log(`[RealtimeClient] 已连接到 ${config.model}`)
        })

        this.ws.on('message', (data: WebSocket.Data) => {
          try {
            const msg = JSON.parse(data.toString())
            this.handleMessage(msg)
          } catch (err) {
            console.warn('[RealtimeClient] 消息解析失败:', err)
          }
        })

        this.ws.on('error', (err) => {
          clearTimeout(timeout)
          console.error('[RealtimeClient] 连接错误:', err)
          this.emit('realtime', { type: 'error', data: err } as RealtimeEvent)
          if (!this.connected) reject(err)
        })

        this.ws.on('close', (code) => {
          this.connected = false
          this.emit('realtime', { type: 'disconnected', data: { code } } as RealtimeEvent)
          console.log(`[RealtimeClient] 连接关闭 (code: ${code})`)
          this.tryReconnect()
        })
      } catch (err) {
        reject(err)
      }
    })
  }

  disconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectAttempts = this.maxReconnectAttempts // 阻止重连
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
    this.connected = false
  }

  private tryReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts || !this.config) return

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000)
    this.reconnectAttempts++

    console.log(`[RealtimeClient] ${delay / 1000}s 后重连 (${this.reconnectAttempts}/${this.maxReconnectAttempts})`)
    this.reconnectTimer = setTimeout(() => {
      if (this.config) this.connect(this.config).catch(() => {})
    }, delay)
  }

  // ── 消息处理 ─────────────────────────────────────────

  private handleMessage(msg: any): void {
    switch (msg.type) {
      case 'response.audio.delta':
        this.emit('realtime', { type: 'audio_delta', data: msg.delta } as RealtimeEvent)
        break

      case 'response.text.delta':
        this.emit('realtime', { type: 'text_delta', data: msg.delta } as RealtimeEvent)
        break

      case 'input_audio_buffer.speech_started':
        this.emit('realtime', { type: 'speech_started' } as RealtimeEvent)
        // 打断当前 AI 输出
        this.interrupt()
        break

      case 'input_audio_buffer.speech_stopped':
        this.emit('realtime', { type: 'speech_stopped' } as RealtimeEvent)
        break

      case 'conversation.item.created':
        this.emit('realtime', { type: 'conversation_item_created', data: msg.item } as RealtimeEvent)
        break

      case 'error':
        console.error('[RealtimeClient] 服务端错误:', msg.error)
        this.emit('realtime', { type: 'error', data: msg.error } as RealtimeEvent)
        break
    }
  }

  // ── 发送 ─────────────────────────────────────────────

  /** 发送文本消息 */
  sendText(text: string): void {
    this.send({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text }],
      },
    })
    this.send({ type: 'response.create' })
  }

  /** 发送音频数据 (PCM16) */
  sendAudio(base64Audio: string): void {
    this.send({
      type: 'input_audio_buffer.append',
      audio: base64Audio,
    })
  }

  /** 提交音频缓冲区 (语音输入结束) */
  commitAudio(): void {
    this.send({ type: 'input_audio_buffer.commit' })
    this.send({ type: 'response.create' })
  }

  /** 打断 AI 输出 (用户开始说话时) */
  interrupt(): void {
    this.send({ type: 'response.cancel' })
    this.emit('realtime', { type: 'interrupted' } as RealtimeEvent)
  }

  /** 清除音频缓冲区 */
  clearAudio(): void {
    this.send({ type: 'input_audio_buffer.clear' })
  }

  private send(data: any): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('[RealtimeClient] 未连接，忽略发送')
      return
    }
    this.ws.send(JSON.stringify(data))
  }

  // ── 状态 ─────────────────────────────────────────────

  isConnected(): boolean {
    return this.connected
  }

  getSessionId(): string {
    return this.sessionId
  }
}

// ═══════════════════════════════════════════════════════════
// 单例
// ═══════════════════════════════════════════════════════════

let _realtime: RealtimeClient | null = null

export function getRealtimeClient(): RealtimeClient {
  if (!_realtime) {
    _realtime = new RealtimeClient()
  }
  return _realtime
}
