// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// panelRegistry.ts — 面板插件注册中心 (v8.1)
//
// 技能/插件自带 UI 面板
//   - 任何插件或技能都可以注册一个面板
//   - 面板可以是远程 URL（iframe 加载）或本地内容
//   - 面板自动出现在设置/侧边栏
// ============================================================

import * as path from 'path'
import * as fs from 'fs'
import { app } from 'electron'
import { globalEventBus } from './eventBus'

// ═══════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════

export type PanelRenderType = 'iframe' | 'content' | 'component'

export interface PanelRegistration {
  /** 面板唯一 ID */
  id: string
  /** 显示名称 */
  name: string
  /** 图标 emoji */
  icon: string
  /** 简短描述 */
  description: string
  /** 来源：'plugin' | 'skill' | 'user' */
  source: 'plugin' | 'skill' | 'user'
  /** 渲染方式 */
  renderType: PanelRenderType
  /**
   * renderType 对应值:
   *   'iframe'    → iframe 加载的 URL
   *   'content'   → 直接渲染的 HTML 内容字符串
   *   'component' → 保留给未来动态导入的组件路径
   */
  content: string
  /** 面板放置位置（可多选） */
  placement: ('sidebar' | 'settings' | 'floating')[]
  /** 面板尺寸推荐：'small' | 'medium' | 'large' | 'fullscreen' */
  preferredSize: 'small' | 'medium' | 'large' | 'fullscreen'
  /** 所属插件/技能 ID */
  ownerId?: string
  /** 标签 */
  tags: string[]
  /** 创建时间 */
  createdAt: number
  /** 更新时间 */
  updatedAt: number
  /** 是否启用 */
  enabled: boolean
}

export interface PanelEventPayload {
  panelId: string
  action: 'opened' | 'closed' | 'enabled' | 'disabled'
  timestamp: string
}

// ═══════════════════════════════════════════════════════════
// 面板注册中心
// ═══════════════════════════════════════════════════════════

class PanelRegistry {
  private _panels: Map<string, PanelRegistration> = new Map()
  private _userDisabled: Set<string> = new Set()

  private get dataDir(): string {
    try {
      return path.join(app.getPath('userData'), 'panels')
    } catch {
      return path.join(process.cwd(), 'panels')
    }
  }

  private get configPath(): string {
    return path.join(this.dataDir, 'panel-config.json')
  }

  // ── 单例 ──

  private static _instance: PanelRegistry
  static getInstance(): PanelRegistry {
    if (!this._instance) {this._instance = new PanelRegistry()}
    return this._instance
  }

  // ── 持久化 ──

  load(): void {
    try {
      if (!fs.existsSync(this.dataDir)) {fs.mkdirSync(this.dataDir, { recursive: true })}
      if (fs.existsSync(this.configPath)) {
        const data = JSON.parse(fs.readFileSync(this.configPath, 'utf-8'))
        if (data.userDisabled) {this._userDisabled = new Set(data.userDisabled)}
        if (data.panels) {
          for (const p of data.panels) {
            if (p.source !== 'plugin') {
              this._panels.set(p.id, p)
            }
          }
        }
        console.log(`[PanelRegistry] ✅ 已加载 ${this._panels.size} 个面板`)
      }
    } catch (e: any) {
      console.warn('[PanelRegistry] 加载失败:', e.message)
    }
  }

  private save(): void {
    try {
      if (!fs.existsSync(this.dataDir)) {fs.mkdirSync(this.dataDir, { recursive: true })}
      const userPanels = Array.from(this._panels.values()).filter(p => p.source !== 'plugin')
      fs.writeFileSync(this.configPath, JSON.stringify({
        panels: userPanels,
        userDisabled: Array.from(this._userDisabled),
      }, null, 2), 'utf-8')
    } catch (e: any) {
      console.warn('[PanelRegistry] 持久化失败:', e.message)
    }
  }

  // ── 注册 ──

  register(reg: Omit<PanelRegistration, 'createdAt' | 'updatedAt' | 'enabled'> & { id: string }): PanelRegistration {
    const existing = this._panels.get(reg.id)
    if (existing) {
      // 更新已有面板
      const updated: PanelRegistration = {
        ...existing,
        ...reg,
        updatedAt: Date.now(),
      }
      this._panels.set(reg.id, updated)
      return updated
    }

    const now = Date.now()
    const panel: PanelRegistration = {
      ...reg,
      createdAt: now,
      updatedAt: now,
      enabled: !this._userDisabled.has(reg.id),
    }
    this._panels.set(panel.id, panel)

    globalEventBus.emit('panel:registered' as any, {
      panelId: panel.id,
      action: 'enabled' as const,
      timestamp: new Date().toISOString(),
    })

    console.log(`[PanelRegistry] 📦 面板已注册: ${panel.icon} ${panel.name} (${panel.id})`)
    this.save()
    return panel
  }

  /** 取消注册 */
  unregister(id: string): boolean {
    if (!this._panels.has(id)) {return false}
    this._panels.delete(id)
    this._userDisabled.delete(id)
    globalEventBus.emit('panel:unregistered' as any, {
      panelId: id,
      action: 'closed' as const,
      timestamp: new Date().toISOString(),
    })
    this.save()
    return true
  }

  /** 启用/禁用面板 */
  setEnabled(id: string, enabled: boolean): boolean {
    const panel = this._panels.get(id)
    if (!panel) {return false}
    panel.enabled = enabled
    if (enabled) {this._userDisabled.delete(id)}
    else {this._userDisabled.add(id)}
    this.save()
    return true
  }

  // ── 查询 ──

  /** 获取所有已启用的面板 */
  getEnabledPanels(placement?: 'sidebar' | 'settings' | 'floating'): PanelRegistration[] {
    const list = Array.from(this._panels.values())
      .filter(p => p.enabled)
    if (placement) {return list.filter(p => p.placement.includes(placement))}
    return list.sort((a, b) => a.name.localeCompare(b.name))
  }

  /** 获取所有面板（含禁用） */
  getAllPanels(): PanelRegistration[] {
    return Array.from(this._panels.values())
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  /** 按来源获取 */
  getPanelsBySource(source: 'plugin' | 'skill' | 'user'): PanelRegistration[] {
    return this.getEnabledPanels().filter(p => p.source === source)
  }

  /** 获取单个面板 */
  getPanel(id: string): PanelRegistration | undefined {
    return this._panels.get(id)
  }
}

// ═══════════════════════════════════════════════════════════
// 快捷函数
// ═══════════════════════════════════════════════════════════

export function getPanelRegistry(): PanelRegistry {
  return PanelRegistry.getInstance()
}

export function registerPanel(reg: Omit<PanelRegistration, 'createdAt' | 'updatedAt' | 'enabled'> & { id: string }): PanelRegistration {
  return PanelRegistry.getInstance().register(reg)
}

export function unregisterPanel(id: string): boolean {
  return PanelRegistry.getInstance().unregister(id)
}

export function listPanels(placement?: 'sidebar' | 'settings' | 'floating'): PanelRegistration[] {
  return PanelRegistry.getInstance().getEnabledPanels(placement)
}

export function getPanel(id: string): PanelRegistration | undefined {
  return PanelRegistry.getInstance().getPanel(id)
}

/** 🆕 v8.1: 初始化面板注册中心 */
export function initPanelRegistry(): PanelRegistry {
  const reg = PanelRegistry.getInstance()
  reg.load()
  return reg
}
