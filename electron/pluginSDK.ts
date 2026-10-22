// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// pluginSDK.ts — 插件 SDK (v2.5)
//
// 完整的插件系统，支持社区扩展
//
// 插件类型:
//   - tool: 扩展工具（新功能）
//   - platform: 平台适配器（新 IM / 社交平台）
//   - behavior: 行为插件（自动回复、定时任务）
//   - theme: 主题插件（UI 皮肤、Live2D 模型）
//
// 插件生命周期:
//   load → init → enable → (running) → disable → unload
// ============================================================

import fs from 'fs'
import path from 'path'
import type { ToolDef, ToolResult } from './tools/types'

// ═══════════════════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════════════════

export type PluginType = 'tool' | 'platform' | 'behavior' | 'theme'

export interface PluginManifest {
  id: string
  name: string
  version: string
  type: PluginType
  description: string
  author: string
  license?: string
  homepage?: string
  dependencies?: Record<string, string>
  minLuminaVersion?: string
  icon?: string
}

export interface PluginAPI {
  /** 插件 ID */
  id: string
  /** 插件目录 */
  dir: string
  /** 日志 */
  log: (message: string) => void
  /** 注册工具 */
  registerTool: (def: ToolDef, handler: (args: Record<string, any>) => Promise<ToolResult>) => void
  /** 获取配置 */
  getConfig: <T = any>() => T
  /** 保存配置 */
  saveConfig: <T = any>(config: T) => void
  /** 事件发射 */
  emit: (event: string, data?: any) => void
  /** 事件监听 */
  on: (event: string, handler: (data: any) => void) => void
}

export interface PluginModule {
  manifest: PluginManifest
  activate: (api: PluginAPI) => Promise<void> | void
  deactivate?: () => Promise<void> | void
}

export interface PluginState {
  manifest: PluginManifest
  enabled: boolean
  loaded: boolean
  loadTime: number
  error?: string
}

// ═══════════════════════════════════════════════════════════
// 插件管理器
// ═══════════════════════════════════════════════════════════

export class PluginManager {
  private plugins = new Map<string, PluginState>()
  private modules = new Map<string, PluginModule>()
  private listeners = new Map<string, Set<(data: any) => void>>()
  private pluginDirs: string[] = []
  private toolRegisterCallback: ((def: ToolDef, handler: (args: Record<string, any>) => Promise<ToolResult>) => void) | null = null

  constructor() {
    // 默认插件目录
    this.pluginDirs = [
      path.join(process.cwd(), 'plugins'),
      path.join(process.cwd(), 'electron', 'plugins'),
    ]
  }

  /** 设置工具注册回调（与 registry 集成） */
  setToolRegisterCallback(cb: (def: ToolDef, handler: (args: Record<string, any>) => Promise<ToolResult>) => void): void {
    this.toolRegisterCallback = cb
  }

  /** 添加插件搜索目录 */
  addPluginDir(dir: string): void {
    if (!this.pluginDirs.includes(dir)) {
      this.pluginDirs.push(dir)
    }
  }

  // ── 插件发现 ─────────────────────────────────────────

  /** 扫描所有插件目录 */
  async discoverPlugins(): Promise<PluginManifest[]> {
    const manifests: PluginManifest[] = []

    for (const dir of this.pluginDirs) {
      if (!fs.existsSync(dir)) {continue}

      const entries = fs.readdirSync(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) {continue}

        const manifestPath = path.join(dir, entry.name, 'plugin.json')
        if (fs.existsSync(manifestPath)) {
          try {
            const manifest: PluginManifest = JSON.parse(
              fs.readFileSync(manifestPath, 'utf-8')
            )
            manifests.push(manifest)
          } catch (err) {
            console.warn(`[PluginSDK] 无法解析插件清单: ${manifestPath}`)
          }
        }
      }
    }

    return manifests
  }

  // ── 插件加载 ─────────────────────────────────────────

  /** 加载并激活插件 */
  async loadPlugin(pluginDir: string): Promise<boolean> {
    const manifestPath = path.join(pluginDir, 'plugin.json')
    if (!fs.existsSync(manifestPath)) {
      console.error(`[PluginSDK] 未找到 plugin.json: ${pluginDir}`)
      return false
    }

    const manifest: PluginManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))

    // 版本检查
    if (manifest.minLuminaVersion) {
      // 简化版本比较
      const luminaVersion = '1.0.0'
      if (this.compareVersions(luminaVersion, manifest.minLuminaVersion) < 0) {
        console.error(`[PluginSDK] ${manifest.id}: 需要 Lumina >= ${manifest.minLuminaVersion}`)
        return false
      }
    }

    try {
      // 动态加载插件模块
      const indexPath = path.join(pluginDir, 'index.js')

      let module: PluginModule

      if (fs.existsSync(indexPath)) {
        // JavaScript 插件
        module = require(indexPath)
      } else {
        // 尝试 TypeScript (编译后)
        const compiledPath = path.join(pluginDir, 'dist', 'index.js')
        if (fs.existsSync(compiledPath)) {
          module = require(compiledPath)
        } else {
          throw new Error(`未找到插件入口文件: index.js 或 dist/index.js`)
        }
      }

      if (!module.manifest || !module.activate) {
        throw new Error('插件模块缺少 manifest 或 activate 导出')
      }

      // 创建插件 API
      const api = this.createPluginAPI(manifest.id, pluginDir)

      // 激活插件
      await module.activate(api)

      this.plugins.set(manifest.id, {
        manifest,
        enabled: true,
        loaded: true,
        loadTime: Date.now(),
      })
      this.modules.set(manifest.id, module)

      console.log(`[PluginSDK] ✅ 已加载插件: ${manifest.name} v${manifest.version}`)
      return true
    } catch (err: any) {
      console.error(`[PluginSDK] ❌ 加载插件失败: ${manifest.id}`, err.message)
      this.plugins.set(manifest.id, {
        manifest,
        enabled: false,
        loaded: false,
        loadTime: Date.now(),
        error: err.message,
      })
      return false
    }
  }

  /** 卸载插件 */
  async unloadPlugin(pluginId: string): Promise<boolean> {
    const module = this.modules.get(pluginId)
    if (!module?.deactivate) {
      this.cleanup(pluginId)
      return true
    }

    try {
      await module.deactivate()
      this.cleanup(pluginId)
      return true
    } catch (err: any) {
      console.error(`[PluginSDK] 卸载插件失败: ${pluginId}`, err.message)
      return false
    }
  }

  private cleanup(pluginId: string): void {
    this.plugins.delete(pluginId)
    this.modules.delete(pluginId)
    console.log(`[PluginSDK] 已卸载插件: ${pluginId}`)
  }

  // ── 插件 API 工厂 ─────────────────────────────────────

  private createPluginAPI(pluginId: string, pluginDir: string): PluginAPI {
    return {
      id: pluginId,
      dir: pluginDir,
      log: (message) => console.log(`[Plugin:${pluginId}] ${message}`),
      registerTool: (def, handler) => {
        if (this.toolRegisterCallback) {
          this.toolRegisterCallback(def, handler)
        }
      },
      getConfig: <T>() => {
        try {
          const configPath = path.join(pluginDir, 'config.json')
          return fs.existsSync(configPath)
            ? JSON.parse(fs.readFileSync(configPath, 'utf-8'))
            : {}
        } catch { return {} as T }
      },
      saveConfig: <T>(config: T) => {
        const configPath = path.join(pluginDir, 'config.json')
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')
      },
      emit: (event, data) => {
        const handlers = this.listeners.get(event)
        if (handlers) {
          for (const handler of handlers) {
            try { handler(data) } catch (err) {
              console.error(`[PluginSDK] 事件处理器错误: ${event}`, err)
            }
          }
        }
      },
      on: (event, handler) => {
        if (!this.listeners.has(event)) {
          this.listeners.set(event, new Set())
        }
        this.listeners.get(event)!.add(handler)
      },
    }
  }

  // ── 查询 ─────────────────────────────────────────────

  getPlugins(): PluginState[] {
    return Array.from(this.plugins.values())
  }

  getPlugin(id: string): PluginState | undefined {
    return this.plugins.get(id)
  }

  isEnabled(id: string): boolean {
    return this.plugins.get(id)?.enabled ?? false
  }

  // ── 生成插件模板 ─────────────────────────────────────

  generatePluginTemplate(
    name: string,
    type: PluginType,
    targetDir: string
  ): string {
    const pluginDir = path.join(targetDir, name.toLowerCase().replace(/\s+/g, '-'))
    fs.mkdirSync(pluginDir, { recursive: true })

    // plugin.json
    const manifest: PluginManifest = {
      id: name.toLowerCase().replace(/\s+/g, '-'),
      name,
      version: '1.0.0',
      type,
      description: `${name} 插件`,
      author: 'Your Name',
      license: 'MIT',
      minLuminaVersion: '1.0.0',
    }
    fs.writeFileSync(
      path.join(pluginDir, 'plugin.json'),
      JSON.stringify(manifest, null, 2),
      'utf-8'
    )

    // index.js
    const indexContent = `// ${name} - Lumina Plugin
module.exports = {
  manifest: require('./plugin.json'),

  async activate(api) {
    api.log('插件已激活!')

    // 示例：注册一个工具
    api.registerTool({
      name: '${manifest.id}_hello',
      description: '${name} 示例工具',
      params: {
        name: { type: 'string', description: '你的名字', required: true }
      },
      toolsets: ['agent'],
    }, async (args) => {
      return {
        callId: '',
        ok: true,
        content: \`你好 \${args.name}，来自 ${name} 插件！\`,
      }
    })
  },

  async deactivate() {
    console.log('${name} 插件已停用')
  },
}
`
    fs.writeFileSync(path.join(pluginDir, 'index.js'), indexContent, 'utf-8')

    // config.json
    fs.writeFileSync(path.join(pluginDir, 'config.json'), '{}', 'utf-8')

    return pluginDir
  }

  // ── 辅助 ─────────────────────────────────────────────

  private compareVersions(a: string, b: string): number {
    const partsA = a.split('.').map(Number)
    const partsB = b.split('.').map(Number)
    for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
      const na = partsA[i] || 0
      const nb = partsB[i] || 0
      if (na !== nb) {return na - nb}
    }
    return 0
  }

  /** 关联主窗口 (供 main.ts 初始化时调用) */
  attachWindow(_win: any): void {
    // 保存窗口引用，供插件使用
    (this as any)._mainWindow = _win
  }
}

// ═══════════════════════════════════════════════════════════
// 单例
// ═══════════════════════════════════════════════════════════

let _pluginManager: PluginManager | null = null

export function getPluginManager(): PluginManager {
  if (!_pluginManager) {
    _pluginManager = new PluginManager()
  }
  return _pluginManager
}
