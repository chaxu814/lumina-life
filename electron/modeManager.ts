// ============================================================
// modeManager.ts — 场景模式管理器 (v8.1)
//
//   - 自定义模式（用户自造人格）
//   - 工作流模板管理（一键切换 toolset + system prompt）
//
// 功能：
//   1. 周期性场景检测 → 自动切换模式
//   2. 手动模式覆盖（用户 > 自动）
//   3. 模式关联行为配置
//   4. 模式切换事件 → IPC 通知前端
//   5. 自定义模式 CRUD（创建/编辑/删除/列表）
//   6. 工作流模板管理（创建/激活/列表/删除）
// ============================================================

import { detectScene, detectActiveWindow, type SceneInfo, type SceneType, sceneChanged } from './sceneDetector'
import { globalEventBus, BusEvents } from './eventBus'
import { BrowserWindow } from 'electron'
import * as path from 'path'
import * as fs from 'fs'
import { app } from 'electron'
import { getUsageStats } from './usageStats'       // 📊 v3.0: 使用数据统计
// 🆕 Lucky 模式场景感知
import { getSceneAwareAdjustment, getConfig as getLuckyConfig, setConfig as setLuckyConfig } from './luckyModeIntegration'

// ═══════════════════════════════════════════════════════════
// 类型定义 — 🆕 v8.1: 自定义模式 ID 不限字面量
// ═══════════════════════════════════════════════════════════

/** 内置模式 — LuminaMode 依旧只保留四个内置模式名 */
export type LuminaMode = 'work' | 'study' | 'fun' | 'idle'
/** 任意模式 ID（含自定义） */
export type AnyMode = LuminaMode | string

export const BUILTIN_MODES: LuminaMode[] = ['work', 'study', 'fun', 'idle']

/** 自定义模式元数据 */
export interface CustomModeMeta {
  id: string
  label: string
  emoji: string
  description: string
  /** 对应 ModeConfig.agentTone */
  systemPromptExtra: string
  temperature: number
  color: string
  proactiveEnabled: boolean
  proactiveInterval: number
  newsEnabled: boolean
  createdAt: number
  updatedAt: number
}

export interface ModeConfig {
  label: string
  emoji: string
  agentTone: string
  proactiveInterval: number
  proactiveEnabled: boolean
  newsEnabled: boolean
  temperature: number
  color: string
  /** 🆕 v8.1: 是否为自定义模式 */
  isCustom?: boolean
  /** 🆕 v8.1: 自定义模式描述 */
  description?: string
}

export interface ModeState {
  /** 当前模式（含自定义） */
  current: AnyMode
  /** 上次场景检测结果 */
  lastScene: SceneInfo | null
  /** 是否为手动覆盖（True=用户手动，False=自动检测） */
  manualOverride: boolean
  /** 上次切换时间 */
  lastSwitchAt: number
  /** 检测时钟是否运行 */
  running: boolean
}

// ═══════════════════════════════════════════════════════════
// 模式配置表
// ═══════════════════════════════════════════════════════════

export const MODE_CONFIGS: Record<LuminaMode, ModeConfig> = {
  work: {
    label: '工作',
    emoji: '💼',
    agentTone: '你 Lumina 当前处于工作模式。请保持专业、高效。回复简洁明了，避免不必要的话题。仅在用户主动找你时回复，不要主动搭话。',
    proactiveInterval: 0,
    proactiveEnabled: false,
    newsEnabled: true,
    temperature: 0.5,
    color: '#4A90D9',
  },
  study: {
    label: '学习',
    emoji: '📚',
    agentTone: '你 Lumina 当前处于学习模式。用户正在学习，请提供知识辅助、深度解释、示例和延伸阅读。话风鼓励但不打扰。',
    proactiveInterval: 3600,
    proactiveEnabled: true,
    newsEnabled: true,
    temperature: 0.7,
    color: '#7B68EE',
  },
  fun: {
    label: '娱乐',
    emoji: '🎮',
    agentTone: '你 Lumina 当前处于娱乐模式。用户正在休闲，请保持轻松幽默的话风。可以主动推荐有趣的内容、开玩笑、聊八卦。气氛活泼一些！',
    proactiveInterval: 1800,
    proactiveEnabled: true,
    newsEnabled: false,
    temperature: 0.9,
    color: '#FF6B6B',
  },
  idle: {
    label: '空闲',
    emoji: '😴',
    agentTone: '你 Lumina 当前处于空闲模式。用户暂时不在。不主动发起对话，不推送通知。安静待命即可。',
    proactiveInterval: 0,
    proactiveEnabled: false,
    newsEnabled: false,
    temperature: 0.5,
    color: '#95A5A6',
  },
}

// ═══════════════════════════════════════════════════════════
// 模式管理器
// ═══════════════════════════════════════════════════════════

class ModeManager {
  private state: ModeState = {
    current: 'work',
    lastScene: null,
    manualOverride: false,
    lastSwitchAt: Date.now(),
    running: false,
  }

  /** 🆕 v3.0: 用户自定义配置覆盖（松耦合：仅覆盖 MODE_CONFIGS 的字段） */
  private userConfigOverrides: Record<string, Partial<ModeConfig>> = {}
  /** 🆕 v3.0: 持久化路径 */
  private get persistPath(): string {
    try {
      return path.join(app.getPath('userData'), 'mode-config.json')
    } catch {
      return path.join(process.cwd(), 'mode-config.json')
    }
  }

  /** 🆕 v3.0: 手动模式最大持续时长 (30分钟) — 超时自动恢复自动检测 */
  private readonly MANUAL_OVERRIDE_TIMEOUT_MS = 30 * 60 * 1000
  /** 🆕 v3.0: 健康检查周期 (5分钟) */
  private readonly HEALTH_CHECK_INTERVAL_MS = 5 * 60 * 1000
  /** 🆕 v3.0: 连续检测失败阈值 — 触发熔断 */
  private readonly DETECT_FAIL_THRESHOLD = 5
  /** 🆕 v3.0: 当前连续检测失败次数 */
  private detectFailCount = 0
  /** 🆕 v3.0: 是否处于熔断状态 */
  private circuitBroken = false
  private healthTimer: ReturnType<typeof setInterval> | null = null

  private detectTimer: ReturnType<typeof setInterval> | null = null
  private mainWindowRef: BrowserWindow | null = null
  private listeners: Array<() => void> = []

  /** 场景检测间隔 (秒) — 🆕 v3.0: 30s→60s，使用缓存后降低频率 */
  private readonly DETECT_INTERVAL = 60
  /** 🆕 v3.0: 空闲模式检测间隔加倍（省电） */
  private readonly IDLE_DETECT_INTERVAL = 120

  /** 注册主窗口引用（用于 IPC 推送） */
  setMainWindow(win: BrowserWindow): void {
    this.mainWindowRef = win
  }

  /** 🆕 v8.1: 自定义模式存储 */
  private customModes: Record<string, CustomModeMeta> = {}

  /** 🆕 v8.1: 获取模式配置（支持自定义模式） */
  getModeConfig(mode?: AnyMode): ModeConfig {
    const m = mode || this.state.current
    // 自定义模式
    if (this.customModes[m]) {
      const cm = this.customModes[m]
      return {
        label: cm.label,
        emoji: cm.emoji,
        agentTone: cm.systemPromptExtra,
        proactiveInterval: cm.proactiveInterval,
        proactiveEnabled: cm.proactiveEnabled,
        newsEnabled: cm.newsEnabled,
        temperature: cm.temperature,
        color: cm.color,
        isCustom: true,
        description: cm.description,
      }
    }
    // 内置模式
    const base = MODE_CONFIGS[m as LuminaMode]
    if (!base) return MODE_CONFIGS.work // fallback
    const overrides = this.userConfigOverrides[m as LuminaMode]
    return overrides ? { ...base, ...overrides } : base
  }

  /** 🆕 v8.1: 更新模式配置（内置→覆盖，自定义→更新元数据） */
  updateModeConfig(mode: AnyMode, overrides: Partial<ModeConfig>): void {
    if (this.customModes[mode]) {
      const cm = this.customModes[mode]
      this.customModes[mode] = {
        ...cm,
        label: overrides.label ?? cm.label,
        emoji: overrides.emoji ?? cm.emoji,
        systemPromptExtra: overrides.agentTone ?? cm.systemPromptExtra,
        description: overrides.description ?? cm.description,
        temperature: overrides.temperature ?? cm.temperature,
        color: overrides.color ?? cm.color,
        proactiveEnabled: overrides.proactiveEnabled ?? cm.proactiveEnabled,
        proactiveInterval: overrides.proactiveInterval ?? cm.proactiveInterval,
        newsEnabled: overrides.newsEnabled ?? cm.newsEnabled,
        updatedAt: Date.now(),
      }
      this.persistCustomModes()
      console.log(`[ModeManager] ⚙️ 更新自定义模式: ${mode}`, overrides)
      return
    }
    // 内置模式
    this.userConfigOverrides[mode] = {
      ...(this.userConfigOverrides[mode] || {}),
      ...overrides,
    }
    this.persistConfig()
    console.log(`[ModeManager] ⚙️ 更新内置模式: ${mode}`, overrides)
  }

  /** 🆕 v8.1: 获取某模式的完整配置 */
  getEffectiveConfig(mode: AnyMode): ModeConfig {
    return this.getModeConfig(mode)
  }

  /** 🆕 v8.1: 获取所有模式的完整配置（内置 + 自定义） */
  getAllConfigs(): Record<string, ModeConfig> {
    const result: Record<string, ModeConfig> = {}
    for (const mode of BUILTIN_MODES) {
      result[mode] = this.getModeConfig(mode)
    }
    for (const id of Object.keys(this.customModes)) {
      result[id] = this.getModeConfig(id)
    }
    return result
  }

  /** 🆕 v8.1: 创建自定义模式 */
  addCustomMode(meta: Omit<CustomModeMeta, 'createdAt' | 'updatedAt'> & { id: string }): CustomModeMeta {
    const now = Date.now()
    const full: CustomModeMeta = {
      ...meta,
      createdAt: now,
      updatedAt: now,
    }
    this.customModes[full.id] = full
    this.persistCustomModes()
    console.log(`[ModeManager] 🎨 创建自定义模式: ${full.id} (${full.label})`)
    return full
  }

  /** 🆕 v8.1: 删除自定义模式 */
  removeCustomMode(id: string): boolean {
    if (!this.customModes[id]) return false
    delete this.customModes[id]
    // 如果当前正在使用该模式，切回 work
    if (this.state.current === id) {
      this.setMode('work')
    }
    this.persistCustomModes()
    console.log(`[ModeManager] 🗑️ 删除自定义模式: ${id}`)
    return true
  }

  /** 🆕 v8.1: 列出所有自定义模式 */
  listCustomModes(): CustomModeMeta[] {
    return Object.values(this.customModes).sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** 🆕 v8.1: 获取某自定义模式 */
  getCustomMode(id: string): CustomModeMeta | undefined {
    return this.customModes[id]
  }

  /** 🆕 v8.1: 判断是否为自定义模式 */
  isCustomMode(mode: AnyMode): boolean {
    return !!this.customModes[mode]
  }

  /** 🆕 v8.1: 持久化自定义模式 */
  private persistCustomModes(): void {
    try {
      const dir = path.dirname(this.persistPath)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      const dataPath = path.join(dir, 'custom-modes.json')
      fs.writeFileSync(dataPath, JSON.stringify(Object.values(this.customModes), null, 2), 'utf-8')
    } catch (e: any) {
      console.warn('[ModeManager] 自定义模式持久化失败:', e.message)
    }
  }

  /** 🆕 v8.1: 加载自定义模式 */
  loadCustomModes(): void {
    try {
      const dataPath = path.join(path.dirname(this.persistPath), 'custom-modes.json')
      if (fs.existsSync(dataPath)) {
        const list: CustomModeMeta[] = JSON.parse(fs.readFileSync(dataPath, 'utf-8'))
        for (const cm of list) {
          this.customModes[cm.id] = cm
        }
        console.log(`[ModeManager] ✅ 加载 ${list.length} 个自定义模式`)
      }
    } catch (e: any) {
      console.warn('[ModeManager] 自定义模式加载失败:', e.message)
    }
  }

  /** 🆕 v3.0: 持久化用户配置到磁盘 */
  private persistConfig(): void {
    try {
      const dir = path.dirname(this.persistPath)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(this.persistPath, JSON.stringify({
        userConfigOverrides: this.userConfigOverrides,
        lastManualMode: this.state.manualOverride && !this.isCustomMode(this.state.current) ? this.state.current : undefined,
      }, null, 2), 'utf-8')
    } catch (e: any) {
      console.warn('[ModeManager] 配置持久化失败:', e.message)
    }
  }

  /** 🆕 v3.0: 从磁盘加载持久化配置 */
  loadPersistedConfig(): void {
    try {
      if (fs.existsSync(this.persistPath)) {
        const data = JSON.parse(fs.readFileSync(this.persistPath, 'utf-8'))
        if (data.userConfigOverrides) {
          this.userConfigOverrides = data.userConfigOverrides
        }
        // 恢复上次手动模式
        if (data.lastManualMode) {
          this.state.current = data.lastManualMode as LuminaMode
          this.state.manualOverride = true
          this.state.lastSwitchAt = Date.now()
          console.log(`[ModeManager] 🔄 恢复上次手动模式: ${data.lastManualMode}`)
        }
        console.log('[ModeManager] ✅ 已加载持久化配置')
      }
    } catch (e: any) {
      console.warn('[ModeManager] 配置加载失败:', e.message)
    }
  }

  /** 🆕 v8.1: 获取完整状态（含自定义模式 + allConfigs） */
  getState(): ModeState & { config: ModeConfig; scene: SceneInfo | null; allConfigs?: Record<string, ModeConfig>; customModes?: CustomModeMeta[] } {
    return {
      ...this.state,
      config: this.getModeConfig(),
      scene: this.state.lastScene,
      allConfigs: this.getAllConfigs(),
      customModes: this.listCustomModes(),
    }
  }

  /** 🆕 v8.1: 手动切换模式（支持自定义模式名） */
  setMode(mode: AnyMode): void {
    if (mode === this.state.current && this.state.manualOverride) return

    // 校验：必须存在
    const config = this.getModeConfig(mode)
    if (!config) {
      console.warn(`[ModeManager] ⚠️ 模式不存在: ${mode}`)
      return
    }

    const oldMode = this.state.current
    this.state.current = mode
    this.state.manualOverride = true
    this.state.lastSwitchAt = Date.now()

    console.log(`[ModeManager] 🔄 手动切换: ${oldMode} → ${mode}`)
    getUsageStats().recordModeSwitch(oldMode as string, mode as string, 'manual')
    this.emitModeChange(oldMode)
  }

  /** 解除手动覆盖（恢复自动检测） */
  releaseOverride(): void {
    if (!this.state.manualOverride) return
    this.state.manualOverride = false
    console.log('[ModeManager] 🔓 解除手动覆盖，恢复自动检测')
  }

  /** 是否处于手动覆盖 */
  isManualOverride(): boolean {
    return this.state.manualOverride
  }

  // ── 场景检测循环 ──

  /**
   * 一次检测循环 — 🆕 v3.0: 加入熔断保护 + 异常计数
   */
  private async detectLoop(): Promise<void> {
    // 熔断检查
    if (this.circuitBroken) {
      return
    }

    try {
      const scene = await detectScene()
      // 检测成功 → 重置失败计数
      this.detectFailCount = 0

      const changed = sceneChanged(this.state.lastScene, scene)

      if (changed) {
        this.state.lastScene = scene
        console.log(`[ModeManager] 🔍 场景: ${scene.scene} (${scene.confidence}%) — ${scene.reason}`)

        // 非手动覆盖时才自动切换
        if (!this.state.manualOverride) {
          const oldMode = this.state.current
          this.state.current = scene.scene
          this.state.lastSwitchAt = Date.now()
          // 📊 记录使用数据
          getUsageStats().recordModeSwitch(oldMode, scene.scene, 'auto')
          this.emitModeChange(oldMode)
        } else {
          // 手动覆盖时仅推送场景信息（不切换）
          this.emitSceneUpdate()
        }
      }
    } catch (err: any) {
      this.detectFailCount++
      console.warn(`[ModeManager] 检测异常 (${this.detectFailCount}/${this.DETECT_FAIL_THRESHOLD}):`, err.message)

      // 达到阈值 → 熔断
      if (this.detectFailCount >= this.DETECT_FAIL_THRESHOLD) {
        this.circuitBroken = true
        console.warn('[ModeManager] 🔴 连续检测失败，触发熔断（5分钟后自动恢复）')
      }
    }
  }

  /** 启动场景检测 — 🆕 v3.0: 空闲模式用更长间隔省电 */
  start(): void {
    if (this.state.running) return
    this.state.running = true

    const interval = this.state.current === 'idle' ? this.IDLE_DETECT_INTERVAL : this.DETECT_INTERVAL
    console.log(`[ModeManager] 🚀 启动场景检测 (间隔 ${interval}s)`)

    // 首次立即执行
    this.detectLoop()

    this.detectTimer = setInterval(() => {
      this.detectLoop()
    }, interval * 1000)

    // 每次检测后根据模式动态调整下一次间隔
    this._adjustIntervalOnModeChange()

    // 启动健康检查
    this.healthTimer = setInterval(() => {
      this.healthCheck()
    }, this.HEALTH_CHECK_INTERVAL_MS)
  }

  /** 🆕 v3.0: 健康检查 — 自动修复常见异常状态 */
  private healthCheck(): void {
    // 1. 手动模式超时恢复
    if (this.state.manualOverride) {
      const elapsed = Date.now() - this.state.lastSwitchAt
      if (elapsed > this.MANUAL_OVERRIDE_TIMEOUT_MS) {
        console.log(`[ModeManager] 🩺 手动模式超时 (${Math.round(elapsed/60000)}分钟)，自动恢复自动检测`)
        this.releaseOverride()
      }
    }

    // 2. 熔断自动恢复
    if (this.circuitBroken) {
      console.log('[ModeManager] 🩺 熔断已解除，恢复检测')
      this.circuitBroken = false
      this.detectFailCount = 0
    }

    // 3. 检查检测定时器是否还在运行
    if (this.state.running && !this.detectTimer) {
      console.warn('[ModeManager] 🩺 检测定时器丢失，自动恢复')
      this.start()
    }

    // 4. 持久化最新的手动模式状态
    this.persistConfig()
  }

  /** 🆕 v3.0: 根据模式动态调整检测间隔 */
  private _adjustIntervalOnModeChange(): void {
    const newInterval = this.state.current === 'idle' ? this.IDLE_DETECT_INTERVAL : this.DETECT_INTERVAL
    const currentInterval = ((this.detectTimer as any)?._interval || this.DETECT_INTERVAL) / 1000
    if (Math.abs(currentInterval - newInterval) > 10) {
      console.log(`[ModeManager] 🔄 动态调整检测间隔: ${currentInterval}s → ${newInterval}s (${this.state.current})`)
      if (this.detectTimer) {
        clearInterval(this.detectTimer)
      }
      this.detectTimer = setInterval(() => {
        this.detectLoop()
      }, newInterval * 1000)
    }
  }

  /** 停止检测 */
  stop(): void {
    this.state.running = false
    if (this.detectTimer) {
      clearInterval(this.detectTimer)
      this.detectTimer = null
    }
    if (this.healthTimer) {
      clearInterval(this.healthTimer)
      this.healthTimer = null
    }
    console.log('[ModeManager] ⏹ 场景检测已停止')
  }

  // ── 事件推送 ──

  /**
   * 推送模式变化到前端
   */
  private emitModeChange(oldMode: AnyMode): void {
    const modeConfig = this.getModeConfig()

    // 🆕 场景感知调整在前，推送给前端时带上 Lucky 调整信息
    let luckyAdjustment: string | null = null
    try {
      const luckyConfig = getLuckyConfig()
      if (luckyConfig.preset !== 'off') {
        const adjustment = getSceneAwareAdjustment(this.state.current, oldMode)
        if (adjustment.action !== 'none' && adjustment.suggestedConfigOverrides) {
          const newConfig = { ...luckyConfig, ...adjustment.suggestedConfigOverrides }
          setLuckyConfig(newConfig)
          luckyAdjustment = adjustment.description
          console.log(`[LuckyMode] 🌐 场景感知: ${adjustment.description}`)
        }
      }
    } catch (e) {
      // Lucky 模式未初始化时静默
    }

    // 通过 eventBus 推送给前端
    try {
      if (this.mainWindowRef && !this.mainWindowRef.isDestroyed()) {
        this.mainWindowRef.webContents.send('mode:changed', {
          mode: this.state.current,
          config: modeConfig,
          manualOverride: this.state.manualOverride,
          scene: this.state.lastScene,
          oldMode,
          luckyAdjustment,   // 🆕 场景感知 toast 信息
        })
      }
    } catch { /* 窗口已销毁 */ }

    // 同时通过 eventBus 广播
    globalEventBus.emit('mode:changed', {
      mode: this.state.current,
      oldMode,
      config: modeConfig,
      manualOverride: this.state.manualOverride,
      luckyAdjustment,
    })

    console.log(`[ModeManager] 📢 已推送模式变更: ${oldMode} → ${this.state.current}`)

    // 模式切换后动态调整检测间隔
    this._adjustIntervalOnModeChange()
  }

  /**
   * 推送场景更新（不切换模式时）
   */
  private emitSceneUpdate(): void {
    try {
      if (this.mainWindowRef && !this.mainWindowRef.isDestroyed()) {
        this.mainWindowRef.webContents.send('mode:scene-update', {
          scene: this.state.lastScene,
          currentMode: this.state.current,
          manualOverride: this.state.manualOverride,
        })
      }
    } catch { /* 窗口已销毁 */ }
  }

  /** 销毁 */
  destroy(): void {
    this.stop()
    this.listeners.forEach(fn => fn())
    this.listeners = []
  }
}

// ── 单例 ──

let instance: ModeManager | null = null

export function getModeManager(): ModeManager {
  if (!instance) {
    instance = new ModeManager()
  }
  return instance
}

export function initModeManager(mainWindow?: BrowserWindow): ModeManager {
  const mgr = getModeManager()
  // 加载持久化配置（恢复上次手动模式）
  mgr.loadPersistedConfig()
  // 加载自定义模式
  mgr.loadCustomModes()
  if (mainWindow) mgr.setMainWindow(mainWindow)
  mgr.start()
  return mgr
}
