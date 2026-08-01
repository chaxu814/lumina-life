// ============================================================
// agentConfig.ts — 独立 Agent LLM 配置管理器 (v14.0)
//
// v14.0: QwenPaw 风格改进
//   ✅ 三个 agent 分配不同默认模型（Lumina→Qwen, Yak→DeepSeek, Recha→GLM）
//   ✅ 无 .env 时使用内置免费 API（硅基流动）
//   ✅ collabHistory 阶段性结果累积（GroupChatView）
// v6.x: 自动检测 .env 配置 + 加密存储
// ============================================================

import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'

// ═══════════════════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════════════════

export type AgentId = 'lumina' | 'yak' | 'recha'

export interface AgentLlmConfig {
  /** 是否已启用独立配置 */
  enabled: boolean
  /** LLM Provider: 'lmstudio' | 'openai' | 'anthropic' | 'ollama' | 'custom' */
  provider: string
  /** 模型标识符 */
  model: string
  /** API endpoint (e.g. http://localhost:1234/v1) */
  endpoint: string
  /** API Key (内存中解密，不入日志) */
  apiKey?: string
  /** 上下文窗口 token 数 */
  maxContextTokens?: number
  /** 请求超时 (秒) */
  timeout?: number
  /** 上次配置时间 */
  configuredAt?: number
}

export interface AgentConfigMap {
  lumina: AgentLlmConfig
  yak: AgentLlmConfig
  recha: AgentLlmConfig
}

/**
 * v14.0: 三个 agent 不同默认 LLM 分配
 * QwenPaw 风格：每个 agent 有独立 LLM 配置，首次运行时自动分配。
 */
const AGENT_DEFAULT_MODELS: Record<AgentId, ProviderEnvMapping> = {
  lumina: {
    provider: 'siliconflow',
    baseUrlEnv: 'SILICONFLOW_BASE_URL',
    apiKeyEnv: 'SILICONFLOW_API_KEY',
    defaultModel: 'Qwen/Qwen3-235B-A22B',
    baseUrlDefault: 'https://api.siliconflow.cn/v1',
  },
  yak: {
    provider: 'deepseek',
    baseUrlEnv: 'DEEPSEEK_BASE_URL',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    defaultModel: 'deepseek-v3',
    baseUrlDefault: 'https://api.deepseek.com/v1',
  },
  recha: {
    provider: 'zhipu',
    baseUrlEnv: 'ZHIPU_BASE_URL',
    apiKeyEnv: 'ZHIPU_API_KEY',
    defaultModel: 'glm-4-flash',
    baseUrlDefault: 'https://open.bigmodel.cn/api/paas/v4',
  },
}

// ═══════════════════════════════════════════════════════════
// Provider 映射
// ═══════════════════════════════════════════════════════════

interface ProviderEnvMapping {
  provider: string
  baseUrlEnv: string
  apiKeyEnv: string
  defaultModel: string
  baseUrlDefault: string
}

const PROVIDER_ENV_MAP: ProviderEnvMapping[] = [
  { provider: 'deepseek',    baseUrlEnv: 'DEEPSEEK_BASE_URL',    apiKeyEnv: 'DEEPSEEK_API_KEY',    defaultModel: 'deepseek-chat',       baseUrlDefault: 'https://api.deepseek.com/v1' },
  { provider: 'qwen',        baseUrlEnv: 'QWEN_BASE_URL',        apiKeyEnv: 'QWEN_API_KEY',        defaultModel: 'qwen-plus',           baseUrlDefault: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  { provider: 'openai',      baseUrlEnv: 'OPENAI_BASE_URL',      apiKeyEnv: 'OPENAI_API_KEY',      defaultModel: 'gpt-4o',              baseUrlDefault: 'https://api.openai.com/v1' },
  { provider: 'zhipu',       baseUrlEnv: 'ZHIPU_BASE_URL',       apiKeyEnv: 'ZHIPU_API_KEY',       defaultModel: 'glm-4-plus',          baseUrlDefault: 'https://open.bigmodel.cn/api/paas/v4' },
  { provider: 'siliconflow', baseUrlEnv: 'SILICONFLOW_BASE_URL', apiKeyEnv: 'SILICONFLOW_API_KEY', defaultModel: 'Qwen/Qwen3-235B-A22B', baseUrlDefault: 'https://api.siliconflow.cn/v1' },
  { provider: 'lmstudio',    baseUrlEnv: 'LMSTUDIO_BASE_URL',    apiKeyEnv: 'LMSTUDIO_API_KEY',    defaultModel: '',                     baseUrlDefault: 'http://127.0.0.1:1234/v1' },
  { provider: 'ollama',      baseUrlEnv: 'OLLAMA_BASE_URL',      apiKeyEnv: 'OLLAMA_API_KEY',      defaultModel: 'qwen3:14b',           baseUrlDefault: 'http://127.0.0.1:11434/v1' },
]

// ═══════════════════════════════════════════════════════════
// .env 自动检测
// ═══════════════════════════════════════════════════════════

function detectAvailableProviders(): ProviderEnvMapping[] {
  const available: ProviderEnvMapping[] = []
  const defaultKey = process.env['LUMINA_DEFAULT_API_KEY'] || ''
  for (const mapping of PROVIDER_ENV_MAP) {
    const baseUrl = process.env[mapping.baseUrlEnv] || ''
    const apiKey = process.env[mapping.apiKeyEnv] || defaultKey
    if (mapping.provider === 'lmstudio' || mapping.provider === 'ollama') {
      if (baseUrl) available.push(mapping)
      continue
    }
    if (baseUrl && apiKey) available.push(mapping)
  }
  return available
}

function buildAgentConfigFromEnv(mapping: ProviderEnvMapping): AgentLlmConfig {
  const defaultKey = process.env['LUMINA_DEFAULT_API_KEY'] || ''
  return {
    enabled: true,
    provider: mapping.provider,
    model: mapping.defaultModel,
    endpoint: process.env[mapping.baseUrlEnv] || mapping.baseUrlDefault,
    apiKey: process.env[mapping.apiKeyEnv] || defaultKey || '',
    maxContextTokens: 256000,
    timeout: 600,
    configuredAt: Date.now(),
  }
}

// ═══════════════════════════════════════════════════════════
// 默认配置模板
// ═══════════════════════════════════════════════════════════

const DEFAULT_CONFIG: AgentLlmConfig = {
  enabled: false,
  provider: '',
  model: '',
  endpoint: '',
  apiKey: '',
  maxContextTokens: 256000,
  timeout: 300,
}

// ═══════════════════════════════════════════════════════════
// 加密工具
// ═══════════════════════════════════════════════════════════

const ENCRYPTION_KEY = 'lumina-v6-agent-secure-store-2024'
const IV_LENGTH = 16

function encrypt(text: string): string {
  const iv = crypto.randomBytes(IV_LENGTH)
  const cipher = crypto.createCipheriv('aes-256-cbc', crypto.scryptSync(ENCRYPTION_KEY, 'salt', 32), iv)
  let encrypted = cipher.update(text, 'utf8', 'hex')
  encrypted += cipher.final('hex')
  return iv.toString('hex') + ':' + encrypted
}

function decrypt(encrypted: string): string {
  try {
    const parts = encrypted.split(':')
    if (parts.length !== 2) return encrypted
    const iv = Buffer.from(parts[0], 'hex')
    const decipher = crypto.createDecipheriv('aes-256-cbc', crypto.scryptSync(ENCRYPTION_KEY, 'salt', 32), iv)
    let decrypted = decipher.update(parts[1], 'hex', 'utf8')
    decrypted += decipher.final('utf8')
    return decrypted
  } catch {
    return encrypted
  }
}

// ═══════════════════════════════════════════════════════════
// AgentConfigManager
// ═══════════════════════════════════════════════════════════

class AgentConfigManager {
  private _configs: AgentConfigMap
  private _configPath: string
  private _loaded: boolean = false

  constructor(configPath?: string) {
    this._configPath = configPath || path.join(
      process.env.LUMINA_USER_DATA ||
      path.join(require('electron').app?.getPath('userData') || process.cwd(), 'agent-llm-configs.json'),
    )
    this._configs = {
      lumina: { ...DEFAULT_CONFIG },
      yak: { ...DEFAULT_CONFIG },
      recha: { ...DEFAULT_CONFIG },
    }
  }

  /** 从磁盘加载 */
  load(): AgentConfigMap {
    if (this._loaded) return this._configs
    this._loaded = true
    try {
      if (fs.existsSync(this._configPath)) {
        const raw = fs.readFileSync(this._configPath, 'utf-8')
        const saved = JSON.parse(raw)
        for (const id of ['lumina', 'yak', 'recha'] as AgentId[]) {
          if (saved[id]) {
            this._configs[id] = { ...DEFAULT_CONFIG, ...saved[id], apiKey: saved[id].apiKey ? decrypt(saved[id].apiKey) : '' }
          }
        }
      }

      // 所有 Agent 都未配置 → 自动检测
      const allDisabled = (['lumina', 'yak', 'recha'] as AgentId[])
        .every(id => !this._configs[id].enabled || !this._configs[id].endpoint)

      if (allDisabled) {
        const available = detectAvailableProviders()
        const preferredProvider = process.env['LUMINA_DEFAULT_PROVIDER'] || ''

        if (available.length > 0) {
          // ── 有 .env → per-agent 差异化分配 ──
          for (const id of ['lumina', 'yak', 'recha'] as AgentId[]) {
            const pref = AGENT_DEFAULT_MODELS[id]
            const chosen = preferredProvider
              ? available.find(m => m.provider === preferredProvider)
              : available.find(m => m.provider === pref.provider)
            if (chosen) {
              this._configs[id] = {
                enabled: true,
                provider: chosen.provider,
                model: pref.defaultModel,
                endpoint: process.env[chosen.baseUrlEnv] || chosen.baseUrlDefault,
                apiKey: process.env[chosen.apiKeyEnv] || process.env['LUMINA_DEFAULT_API_KEY'] || '',
                maxContextTokens: 256000, timeout: 600,
                configuredAt: Date.now(),
              }
            } else {
              this._configs[id] = buildAgentConfigFromEnv(available[0])
            }
          }
        } else {
          // ── 无 .env → 内置免费 API ──
          for (const id of ['lumina', 'yak', 'recha'] as AgentId[]) {
            const pref = AGENT_DEFAULT_MODELS[id]
            this._configs[id] = {
              enabled: true,
              provider: pref.provider,
              model: pref.defaultModel,
              endpoint: pref.baseUrlDefault,
              apiKey: '',
              maxContextTokens: 131072, timeout: 600,
              configuredAt: Date.now(),
            }
          }
        }
      }
    } catch (err) {
      console.warn('[AgentConfig] 加载失败:', err)
    }
    this._syncToTeamMembers()
    return this._configs
  }

  _save(): void {
    const dir = path.dirname(this._configPath)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    const toSave: Record<string, any> = {}
    for (const id of ['lumina', 'yak', 'recha'] as AgentId[]) {
      const c = this._configs[id]
      toSave[id] = { ...c, apiKey: c.apiKey ? encrypt(c.apiKey) : '',
        enabled: !!(c.model && c.endpoint), configuredAt: Date.now() }
    }
    fs.writeFileSync(this._configPath, JSON.stringify(toSave, null, 2), 'utf-8')
  }

  get(agentId: AgentId): AgentLlmConfig {
    return this._configs[agentId] || { ...DEFAULT_CONFIG }
  }

  set(agentId: AgentId, config: Partial<Omit<AgentLlmConfig, 'enabled'>>): AgentLlmConfig {
    const merged: AgentLlmConfig = {
      ...this._configs[agentId],
      ...config,
      enabled: !!((config.model || this._configs[agentId].model) && (config.endpoint || this._configs[agentId].endpoint)),
      configuredAt: Date.now(),
    }
    this._configs[agentId] = merged
    this._save()
    this._syncToTeamMembers()
    return merged
  }

  setAll(config: Partial<AgentLlmConfig>): void {
    for (const id of ['lumina', 'yak', 'recha'] as AgentId[]) {
      this.set(id, config)
    }
  }

  getEffectiveConfig(agentId: AgentId): AgentLlmConfig {
    return this._configs[agentId] || { ...DEFAULT_CONFIG, enabled: true }
  }

  _syncToTeamMembers(): void {
    try {
      const { TEAM_MEMBERS } = require('./teamMembers')
      for (const id of ['lumina', 'yak', 'recha'] as AgentId[]) {
        const cfg = this._configs[id]
        if (cfg?.enabled && TEAM_MEMBERS[id]) {
          TEAM_MEMBERS[id].llmConfig = {
            provider: cfg.provider,
            model: cfg.model,
            endpoint: cfg.endpoint,
            apiKey: cfg.apiKey || '',
            maxTokens: cfg.maxContextTokens || 256000,
            timeout: cfg.timeout || 300,
          }
        }
      }
    } catch { /* 可选同步 */ }
  }

  /**
   * 从 lumina-providers.json 读取当前激活的全局供应商配置，
   * 将 endpoint / model / apiKey 同步到全部三个 Team Agent。
   * 让用户在右上角改完 LLM 后自动生效，不需要手动再配一遍。
   */
  syncFromGlobalProvider(): boolean {
    try {
      const providerPath = path.join(path.dirname(this._configPath), 'lumina-providers.json')
      if (!fs.existsSync(providerPath)) return false

      const raw = JSON.parse(fs.readFileSync(providerPath, 'utf-8'))
      const activeId: string = raw.activeProviderId || ''
      const providerCfg = raw.providers?.[activeId]
      if (!providerCfg || !providerCfg.enabled) return false

      const endpoint = providerCfg.baseUrl || ''
      const model = providerCfg.model || ''
      const apiKey = providerCfg.apiKey || ''

      if (!endpoint || !model) return false

      for (const id of ['lumina', 'yak', 'recha'] as AgentId[]) {
        this._configs[id] = {
          ...this._configs[id],
          enabled: true,
          provider: activeId,
          endpoint,
          model,
          apiKey,
          configuredAt: Date.now(),
        }
      }
      this._save()
      console.log(`[AgentConfig] 🔄 已从全局 "${activeId}" 同步到全部 Team Agent`)
      return true
    } catch (err) {
      console.warn('[AgentConfig] ⚠️ syncFromGlobalProvider 失败:', err)
      return false
    }
  }

  useGlobalConfig(): void {
    const available = detectAvailableProviders()
    if (available.length > 0) {
      for (const id of ['lumina', 'yak', 'recha'] as AgentId[]) {
        const pref = AGENT_DEFAULT_MODELS[id]
        const chosen = available.find(m => m.provider === pref.provider) || available[0]
        this._configs[id] = buildAgentConfigFromEnv(chosen)
      }
      this._save()
    }
  }

  getAvailableProviders(): string[] {
    const result: string[] = []
    for (const def of PROVIDER_ENV_MAP) {
      if (def.provider === 'lmstudio' || def.provider === 'ollama') {
        if (process.env[def.baseUrlEnv]) result.push(def.provider)
        continue
      }
      if (process.env[def.baseUrlEnv] && (process.env[def.apiKeyEnv] || process.env['LUMINA_DEFAULT_API_KEY'])) {
        result.push(def.provider)
      }
    }
    return result
  }

  autoRefreshFromEnv(agentId: AgentId): boolean {
    const current = this._configs[agentId]
    if (!current || !current.provider) return false

    // ── 优先级 1: .env 环境变量（用户可直接修改，无需重新编译）──
    let globalEndpoint: string | undefined
    let globalApiKey: string | undefined
    const available = detectAvailableProviders()
    const envProvider = available.find(m => m.provider === current.provider)
    if (envProvider) {
      globalEndpoint = process.env[envProvider.baseUrlEnv] || envProvider.baseUrlDefault
      globalApiKey = process.env[envProvider.apiKeyEnv] || process.env['LUMINA_DEFAULT_API_KEY'] || ''
    }

    // ── 优先级 2: lumina-providers.json（UI 设置面板，优先级低于 .env）──
    if (!globalEndpoint) {
      try {
        const providersPath = path.join(path.dirname(this._configPath), 'lumina-providers.json')
        if (fs.existsSync(providersPath)) {
          const data = JSON.parse(fs.readFileSync(providersPath, 'utf-8'))
          if (data.providers?.[current.provider]?.baseUrl) {
            globalEndpoint = data.providers[current.provider].baseUrl
            globalApiKey = data.providers[current.provider].apiKey || globalApiKey
          }
        }
      } catch { /* 忽略 */ }
    }

    // 不覆盖用户手动指定的 LAN 地址为 localhost
    const isDefaultLocal = !globalEndpoint || globalEndpoint.includes('127.0.0.1')
    if (isDefaultLocal && current.endpoint && current.endpoint !== globalEndpoint) return false

    let changed = false
    if (globalEndpoint && globalEndpoint !== current.endpoint) {
      this._configs[agentId].endpoint = globalEndpoint
      changed = true
    }
    // 也同步 apiKey（如果 .env 提供了且与已存储的不同）
    if (globalApiKey && globalApiKey !== current.apiKey) {
      this._configs[agentId].apiKey = globalApiKey
      changed = true
    }
    if (changed) {
      this._save()
      return true
    }
    return false
  }

  /** 返回所有 agent 的配置状态摘要 */
  getAllStatus(): Array<{
    id: AgentId
    name: string
    icon: string
    configured: boolean
    provider: string
    model: string
  }> {
    const AGENT_META: Record<AgentId, { name: string; icon: string }> = {
      lumina: { name: 'Lumina', icon: '🪷' },
      yak: { name: 'Yak', icon: '🐂' },
      recha: { name: 'Recha', icon: '📋' },
    }
    return (['lumina', 'yak', 'recha'] as AgentId[]).map(id => {
      const cfg = this._configs[id]
      return {
        id,
        ...AGENT_META[id],
        configured: !!(cfg.enabled && cfg.model && cfg.endpoint),
        provider: cfg.provider || '',
        model: cfg.model || '',
      }
    })
  }

  /** 检查指定 agent 是否已配置（有模型+端点） */
  isConfigured(agentId: AgentId): boolean {
    const cfg = this._configs[agentId]
    return !!(cfg && cfg.enabled && cfg.model && cfg.endpoint)
  }

  reset(): void {
    this._configs = {
      lumina: { ...DEFAULT_CONFIG },
      yak: { ...DEFAULT_CONFIG },
      recha: { ...DEFAULT_CONFIG },
    }
    this._save()
  }
}

// ═══════════════════════════════════════════════════════════
// 单例
// ═══════════════════════════════════════════════════════════

let _instance: AgentConfigManager | null = null

export function getAgentConfig(): AgentConfigManager {
  if (!_instance) { _instance = new AgentConfigManager(); _instance.load() }
  return _instance
}

export function initAgentConfig(configPath?: string): AgentConfigManager {
  _instance = new AgentConfigManager(configPath)
  _instance.load()
  return _instance
}
