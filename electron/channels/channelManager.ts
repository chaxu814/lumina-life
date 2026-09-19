// ============================================================
// channels/channelManager.ts — 📡 渠道管理器 (Phase C)
//
// 统一管理所有渠道适配器的生命周期。
// 提供注册、初始化、消息路由、健康检查等功能。
// ============================================================

import * as path from 'path'
import * as fs from 'fs'
import type {
  ChannelType, ChannelConfig, ChannelMessage, ChannelSendRequest,
  ChannelAdapter, ChannelManagerConfig,
} from './types'

type MessageHandler = (msg: ChannelMessage) => Promise<string | void>

export class ChannelManager {
  private adapters: Map<string, ChannelAdapter> = new Map()
  private configs: Map<string, ChannelConfig> = new Map()
  private configDir: string
  private messageHandler?: MessageHandler
  private initialized = false

  constructor(config?: Partial<ChannelManagerConfig>) {
    this.configDir = config?.configDir || path.join(
      process.env.LUMINA_CONFIG_DIR || path.join(require('os').homedir(), '.lumina'),
      'channels',
    )
    this.messageHandler = config?.onMessage
  }

  // ── 生命周期 ───────────────────────────────────────

  /** 初始化：读取配置并启动已启用的渠道 */
  async init(handler?: MessageHandler): Promise<void> {
    if (this.initialized) {return}
    if (handler) {this.messageHandler = handler}

    // 确保配置目录存在
    fs.mkdirSync(this.configDir, { recursive: true })

    // 读取渠道配置
    await this.loadConfigs()

    // 启动已启用的渠道（单个渠道失败不影响其它渠道）
    for (const [key, cfg] of this.configs) {
      if (cfg.enabled) {
        try {
          await this.startAdapter(key, cfg)
        } catch (err) {
          console.warn(`[ChannelManager] 渠道 ${key} 启动失败（已隔离，不影响其它渠道）:`, err)
        }
      }
    }

    this.initialized = true
    console.log(`[ChannelManager] 📡 已初始化，管理 ${this.adapters.size} 个活跃渠道`)
  }

  /** 注册一个渠道适配器 */
  registerAdapter(key: string, adapter: ChannelAdapter): void {
    this.adapters.set(key, adapter)
  }

  /** 启动指定渠道 */
  async startChannel(key: string): Promise<boolean> {
    const cfg = this.configs.get(key)
    if (!cfg) {
      console.error(`[ChannelManager] 未找到渠道配置: ${key}`)
      return false
    }
    return this.startAdapter(key, cfg)
  }

  /** 停止指定渠道 */
  async stopChannel(key: string): Promise<void> {
    const adapter = this.adapters.get(key)
    if (adapter) {
      await adapter.destroy()
      this.adapters.delete(key)
    }
  }

  /** 发送消息到指定渠道 */
  async send(channelKey: string, request: ChannelSendRequest): Promise<boolean> {
    const adapter = this.adapters.get(channelKey)
    if (!adapter) {
      console.error(`[ChannelManager] 渠道不在线: ${channelKey}`)
      return false
    }
    return adapter.send(request)
  }

  /** 向所有活跃渠道广播 */
  async broadcast(to: string, text: string): Promise<void> {
    const tasks: Promise<boolean>[] = []
    for (const [key, adapter] of this.adapters) {
      tasks.push(adapter.send({ targetId: to, isGroup: false, text }).catch(() => false))
    }
    await Promise.allSettled(tasks)
  }

  /** 获取渠道状态 */
  getStatus(): Array<{ key: string; type: ChannelType; name: string; online: boolean }> {
    const result: Array<{ key: string; type: ChannelType; name: string; online: boolean }> = []
    for (const [key, cfg] of this.configs) {
      const adapter = this.adapters.get(key)
      result.push({
        key,
        type: cfg.type,
        name: cfg.name,
        online: !!adapter,
      })
    }
    return result
  }

  /** 销毁所有渠道 */
  async destroy(): Promise<void> {
    for (const [key, adapter] of this.adapters) {
      await adapter.destroy().catch(() => {})
    }
    this.adapters.clear()
    this.initialized = false
    console.log('[ChannelManager] 📡 所有渠道已停止')
  }

  /** 获取渠道配置列表 */
  getConfigs(): ChannelConfig[] {
    return Array.from(this.configs.values())
  }

  /** 更新渠道配置 */
  async updateConfig(key: string, config: ChannelConfig): Promise<void> {
    this.configs.set(key, config)
    await this.saveConfigs()
    // 如果渠道正在运行，重启
    if (this.adapters.has(key)) {
      await this.stopChannel(key)
    }
    if (config.enabled) {
      await this.startChannel(key)
    }
  }

  // ── 内部方法 ──────────────────────────────────────

  private async startAdapter(key: string, cfg: ChannelConfig): Promise<boolean> {
    // 找对应的适配器实现（构造阶段失败不影响其它渠道）
    let adapter: ChannelAdapter | undefined
    try {
      switch (cfg.type) {
        case 'dingtalk':
          adapter = await this.createDingTalkAdapter(cfg)
          break
        case 'wechat':
          adapter = await this.createWeChatAdapter(cfg)
          break
        case 'qq':
          adapter = await this.createQQAdapter(cfg)
          break
        case 'slack':
          adapter = await this.createSlackAdapter(cfg)
          break
        case 'telegram':
          adapter = await this.createTelegramAdapter(cfg)
          break
        case 'discord':
          adapter = await this.createDiscordAdapter(cfg)
          break
        case 'openclaw':
          adapter = await this.createOpenClawAdapter(cfg)
          break
        default:
          console.warn(`[ChannelManager] 不支持的渠道类型: ${cfg.type}`)
          return false
      }
    } catch (err) {
      console.warn(`[ChannelManager] 渠道 ${key} 适配器构造失败（已隔离）:`, err)
      return false
    }

    if (!adapter) {return false}

    // 设置消息回调
    adapter.onMessage(async (msg: ChannelMessage) => {
      if (this.messageHandler) {
        try {
          await this.messageHandler(msg)
        } catch (err) {
          console.error(`[ChannelManager] 消息处理异常:`, err)
        }
      }
    })

    // init 失败 / 抛异常都要安全降级：该渠道保持离线，不注册、不影响其它渠道
    try {
      const ok = await adapter.init(cfg)
      if (!ok) {
        console.warn(`[ChannelManager] 渠道 ${key} (${cfg.type}) 初始化返回 false，保持离线`)
        await adapter.destroy().catch(() => {})
        return false
      }
    } catch (err) {
      console.warn(`[ChannelManager] 渠道 ${key} (${cfg.type}) 初始化异常（已隔离）:`, err)
      await adapter.destroy().catch(() => {})
      return false
    }

    this.adapters.set(key, adapter)
    console.log(`[ChannelManager] ✅ 渠道已启动: ${key} (${cfg.type})`)
    return true
  }

  private async createDingTalkAdapter(_cfg: ChannelConfig): Promise<ChannelAdapter | undefined> {
    try {
      const { DingTalkAdapter } = await import('./adapters/dingtalk')
      return new DingTalkAdapter()
    } catch {
      console.warn('[ChannelManager] DingTalk 适配器未找到，请创建 adapters/dingtalk.ts')
      return undefined
    }
  }

  private async createWeChatAdapter(_cfg: ChannelConfig): Promise<ChannelAdapter | undefined> {
    try {
      const { WeChatAdapter } = await import('./adapters/wechat')
      return new WeChatAdapter()
    } catch {
      console.warn('[ChannelManager] WeChat 适配器未找到')
      return undefined
    }
  }

  private async createQQAdapter(_cfg: ChannelConfig): Promise<ChannelAdapter | undefined> {
    try {
      const { QQAdapter } = await import('./adapters/qq')
      return new QQAdapter()
    } catch {
      console.warn('[ChannelManager] QQ 适配器未找到')
      return undefined
    }
  }

  private async createSlackAdapter(_cfg: ChannelConfig): Promise<ChannelAdapter | undefined> {
    try {
      const { SlackAdapter } = await import('./adapters/slack')
      return new SlackAdapter()
    } catch {
      console.warn('[ChannelManager] Slack 适配器未找到')
      return undefined
    }
  }

  private async createTelegramAdapter(_cfg: ChannelConfig): Promise<ChannelAdapter | undefined> {
    try {
      const { TelegramAdapter } = await import('./adapters/telegram')
      return new TelegramAdapter()
    } catch {
      console.warn('[ChannelManager] Telegram 适配器未找到')
      return undefined
    }
  }

  private async createDiscordAdapter(_cfg: ChannelConfig): Promise<ChannelAdapter | undefined> {
    try {
      const { DiscordAdapter } = await import('./adapters/discord')
      return new DiscordAdapter()
    } catch {
      console.warn('[ChannelManager] Discord 适配器未找到')
      return undefined
    }
  }

  private async createOpenClawAdapter(_cfg: ChannelConfig): Promise<ChannelAdapter | undefined> {
    try {
      const { OpenClawAdapter } = await import('./adapters/openclaw')
      // 仅构造；连通性探活由 startAdapter 统一在 init() 中完成（失败则安全保持离线）
      return new OpenClawAdapter()
    } catch (err) {
      console.warn('[ChannelManager] OpenClaw 适配器构造失败（不影响其它渠道）:', err)
      return undefined
    }
  }

  private async loadConfigs(): Promise<void> {
    const configFile = path.join(this.configDir, 'channels.json')
    if (!fs.existsSync(configFile)) {
      // 创建默认配置
      const defaults: Record<string, ChannelConfig> = {}
      this.configs = new Map(Object.entries(defaults))
      this.saveConfigs()
      return
    }
    try {
      const raw = fs.readFileSync(configFile, 'utf-8')
      const data = JSON.parse(raw)
      this.configs = new Map(Object.entries(data))
    } catch (err) {
      console.error(`[ChannelManager] 配置加载失败:`, err)
      this.configs = new Map()
    }
  }

  private async saveConfigs(): Promise<void> {
    const configFile = path.join(this.configDir, 'channels.json')
    const obj: Record<string, ChannelConfig> = {}
    for (const [key, val] of this.configs) {
      obj[key] = val
    }
    fs.writeFileSync(configFile, JSON.stringify(obj, null, 2), 'utf-8')
  }
}

// ═══════════════════════════════════════════════════════════
// 全局单例
// ═══════════════════════════════════════════════════════════

let _manager: ChannelManager | null = null

export function getChannelManager(): ChannelManager {
  if (!_manager) {_manager = new ChannelManager()}
  return _manager
}

export function initChannelManager(config?: Partial<ChannelManagerConfig>): ChannelManager {
  _manager = new ChannelManager(config)
  return _manager
}
