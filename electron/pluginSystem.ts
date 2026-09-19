// ============================================================
// pluginSystem.ts — 插件系统
//
// Phase 3: 插件 SDK + 生命周期管理
// 借鉴 N.E.K.O. 的插件生态系统设计
//
// 插件接口：
//   - onInit(): 初始化时调用
//   - onMessage(msg): 收到用户消息时调用
//   - onResponse(resp): AI 回复时调用
//   - onShutdown(): 关闭时调用
//   - tools[]: 插件注册的工具
// ============================================================

export interface PluginTool {
  name: string
  description: string
  params: Record<string, { type: string; description: string; required?: boolean }>
  execute: (args: Record<string, any>) => Promise<{ ok: boolean; content: string }>
}

export interface LuminaPlugin {
  /** 插件唯一标识 */
  id: string
  /** 插件名称 */
  name: string
  /** 版本号 */
  version: string
  /** 描述 */
  description: string
  /** 作者 */
  author?: string

  /** 初始化 */
  onInit?: () => Promise<void>
  /** 收到用户消息 */
  onMessage?: (text: string) => Promise<string | null>
  /** AI 回复时 */
  onResponse?: (text: string) => Promise<string | null>
  /** 关闭 */
  onShutdown?: () => Promise<void>
  /** 注册的工具 */
  tools?: PluginTool[]
  /** 🆕 v8.1: 面板注册 — 插件自带 UI 面板 */
  panels?: Array<{
    id: string
    name: string
    icon: string
    description: string
    renderType: 'iframe' | 'content' | 'component'
    content: string
    placement: ('sidebar' | 'settings' | 'floating')[]
    preferredSize: 'small' | 'medium' | 'large' | 'fullscreen'
  }>
}

// ============================================================
// 插件管理器
// ============================================================

class PluginManager {
  private plugins: Map<string, LuminaPlugin> = new Map()
  private activePlugins: Set<string> = new Set()

  /** 注册插件 */
  async register(plugin: LuminaPlugin): Promise<void> {
    if (this.plugins.has(plugin.id)) {
      console.warn(`[Plugin] 插件 ${plugin.id} 已注册，跳过`)
      return
    }

    this.plugins.set(plugin.id, plugin)
    this.activePlugins.add(plugin.id)

    if (plugin.onInit) {
      try {
        await plugin.onInit()
      } catch (err) {
        console.error(`[Plugin] ${plugin.id} 初始化失败:`, err)
        this.activePlugins.delete(plugin.id)
        return
      }
    }

    console.log(`[Plugin] ${plugin.name} v${plugin.version} 已激活`)

    // 自动注册插件面板
    if (plugin.panels) {
      const { getPanelRegistry } = require('./panelRegistry')
      for (const panelDef of plugin.panels) {
        getPanelRegistry().register({
          id: `plugin_${plugin.id}_${panelDef.id}`,
          name: panelDef.name,
          icon: panelDef.icon,
          description: panelDef.description,
          source: 'plugin',
          renderType: panelDef.renderType,
          content: panelDef.content,
          placement: panelDef.placement,
          preferredSize: panelDef.preferredSize,
          tags: [plugin.name, 'plugin'],
          ownerId: plugin.id,
        })
      }
    }
  }

  /** 获取所有已激活的插件 */
  getActive(): LuminaPlugin[] {
    return Array.from(this.activePlugins)
      .map((id) => this.plugins.get(id)!)
      .filter(Boolean)
  }

  /** 获取所有插件的工具 */
  getAllTools(): PluginTool[] {
    return this.getActive().flatMap((p) => p.tools || [])
  }

  /** 钩子：用户消息 */
  async onMessage(text: string): Promise<string | null> {
    for (const plugin of this.getActive()) {
      if (plugin.onMessage) {
        try {
          const result = await plugin.onMessage(text)
          if (result) {return result}
        } catch (err) {
          console.error(`[Plugin] ${plugin.id} onMessage 错误:`, err)
        }
      }
    }
    return null
  }

  /** 钩子：AI 回复 */
  async onResponse(text: string): Promise<string | null> {
    for (const plugin of this.getActive()) {
      if (plugin.onResponse) {
        try {
          const result = await plugin.onResponse(text)
          if (result) {return result}
        } catch (err) {
          console.error(`[Plugin] ${plugin.id} onResponse 错误:`, err)
        }
      }
    }
    return null
  }

  /** 关闭所有插件 */
  async shutdown(): Promise<void> {
    for (const plugin of this.getActive()) {
      if (plugin.onShutdown) {
        try { await plugin.onShutdown() } catch {}
      }
    }
    this.activePlugins.clear()
    console.log('[Plugin] 所有插件已关闭')
  }
}

// ============================================================
// 单例
// ============================================================

export const pluginManager = new PluginManager()
