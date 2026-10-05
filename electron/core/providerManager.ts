// ============================================================
// providerManager.ts — 统一 LLM Provider 配置管理器 (QwenPaw 风格)
//
// 设计参考 QwenPaw provider_manager.py + secret_store.py：
//   ✅ 单一 JSON 文件存储所有供应商配置
//   ✅ API Key 加密存储 (AES-256-CBC)
//   ✅ Provider 定义与配置分离
//   ✅ 统一 provider_id（前后端一致）
//   ✅ 本地/云端一视同仁
//   ✅ 首次运行时自动从 .env 迁移
// ============================================================

import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import { getAgentConfig } from '../agentConfig'
import { resolveNativeKind, buildTransportPlan } from './nativeBridge'

// ═══════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════

export interface ProviderDefinition {
  /** 唯一标识（前后端统一使用此 ID） */
  id: string
  /** 显示名称 */
  name: string
  /** 是否本地模型 */
  isLocal: boolean
  /** 默认 API 地址 */
  defaultBaseUrl: string
  /** 推荐默认模型 */
  defaultModel: string
  /** 是否需要 API Key */
  requiresApiKey: boolean
  /** 原生协议：openai(默认，OpenAI 兼容) / anthropic / gemini / azure */
  protocol?: 'openai' | 'anthropic' | 'gemini' | 'azure'
}

export interface ProviderConfig {
  baseUrl: string
  apiKey: string        // 内存中为明文，磁盘上加密
  model: string
  enabled: boolean
  timeout: number
  maxContextTokens: number
}

export interface ProviderStore {
  /** 当前选中的供应商 ID */
  activeProviderId: string
  /** 供应商配置字典 (key = provider id) */
  providers: Record<string, ProviderConfig>
}

export interface ModelInfo {
  id: string
  multimodal?: boolean
  vision?: boolean
}

export interface ConnectionTestResult {
  success: boolean
  latency?: number
  error?: string
}

// ═══════════════════════════════════════════════════════════
// 内置供应商定义（唯一来源）
// ═══════════════════════════════════════════════════════════

const BUILT_IN_PROVIDERS: ProviderDefinition[] = [
  // ── 🏠 本地模型 ──
  { id: 'lmstudio',    name: 'LM Studio',       isLocal: true,  defaultBaseUrl: 'http://127.0.0.1:1234/v1',    defaultModel: '',               requiresApiKey: false },
  { id: 'ollama',      name: 'Ollama',           isLocal: true,  defaultBaseUrl: 'http://127.0.0.1:11434/v1',   defaultModel: 'qwen3:14b',     requiresApiKey: false },
  // ── 🎁 免费 ──
  { id: 'opencode-zen', name: 'OpenCode Zen (免费)', isLocal: false, defaultBaseUrl: 'https://opencode.ai/zen/v1', defaultModel: 'deepseek-v4-flash-free', requiresApiKey: false },
  // ── ☁️ 云端模型 ──
  { id: 'deepseek',    name: 'DeepSeek',         isLocal: false, defaultBaseUrl: 'https://api.deepseek.com/v1',  defaultModel: 'deepseek-chat',  requiresApiKey: true },
  { id: 'qwen',        name: '通义千问',         isLocal: false, defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', defaultModel: 'qwen-plus', requiresApiKey: true },
  { id: 'openai',      name: 'OpenAI',           isLocal: false, defaultBaseUrl: 'https://api.openai.com/v1',    defaultModel: 'gpt-4o',        requiresApiKey: true },
  { id: 'claude',      name: 'Anthropic Claude', isLocal: false, defaultBaseUrl: 'https://api.anthropic.com',    defaultModel: 'claude-sonnet-4-5-20250929', requiresApiKey: true, protocol: 'anthropic' },
  { id: 'gemini',      name: 'Google Gemini',    isLocal: false, defaultBaseUrl: 'https://generativelanguage.googleapis.com', defaultModel: 'gemini-2.5-flash', requiresApiKey: true, protocol: 'gemini' },
  { id: 'azure',       name: 'Azure OpenAI',     isLocal: false, defaultBaseUrl: 'https://YOUR_RESOURCE.openai.azure.com', defaultModel: 'gpt-4o', requiresApiKey: true, protocol: 'azure' },
  { id: 'zhipu',       name: '智谱 GLM',         isLocal: false, defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4', defaultModel: 'glm-4-plus', requiresApiKey: true },
  { id: 'siliconflow', name: '硅基流动',         isLocal: false, defaultBaseUrl: 'https://api.siliconflow.cn/v1', defaultModel: 'Qwen/Qwen3-235B-A22B', requiresApiKey: true },
  // ── 🔧 自定义 ──
  { id: 'custom',      name: '自定义端点',       isLocal: false, defaultBaseUrl: '',                             defaultModel: '',               requiresApiKey: false },
]

// ═══════════════════════════════════════════════════════════
// 加密工具 (AES-256-CBC)
// ═══════════════════════════════════════════════════════════

const CIPHER_KEY = crypto.scryptSync('lumina-provider-key-v1', 'provider-salt', 32)
const IV_LENGTH = 16

function encryptApiKey(text: string): string {
  if (!text) {return ''}
  try {
    const iv = crypto.randomBytes(IV_LENGTH)
    const cipher = crypto.createCipheriv('aes-256-cbc', CIPHER_KEY, iv)
    let enc = cipher.update(text, 'utf8', 'hex')
    enc += cipher.final('hex')
    return 'v1:' + iv.toString('hex') + ':' + enc
  } catch {
    return text
  }
}

function decryptApiKey(encrypted: string): string {
  if (!encrypted) {return ''}
  try {
    const parts = encrypted.split(':')
    if (parts[0] !== 'v1' || parts.length < 3) {return encrypted} // 未加密或旧格式
    const iv = Buffer.from(parts[1], 'hex')
    const data = parts.slice(2).join(':')
    const decipher = crypto.createDecipheriv('aes-256-cbc', CIPHER_KEY, iv)
    let dec = decipher.update(data, 'hex', 'utf8')
    dec += decipher.final('utf8')
    return dec
  } catch {
    return encrypted
  }
}

// ═══════════════════════════════════════════════════════════
// ProviderManager
// ═══════════════════════════════════════════════════════════

export class ProviderManager {
  private configPath: string
  private store: ProviderStore = {
    activeProviderId: '',
    providers: {},
  }
  private initialized = false

  constructor(configDir: string) {
    this.configPath = path.join(configDir, 'lumina-providers.json')
  }

  // ── QwenPaw 兼容：从 agent.json 读取 active_model ─────────

  /** 🆕 v14.0: 从 QwenPaw agent.json 加载 active_model（若有） */
  private tryLoadFromQwenPawAgent(baseDir: string): boolean {
    const agentId = process.env.LUMINA_AGENT_ID || 'lumina'
    const agentJsonPath = path.join(baseDir, 'workspaces', agentId, 'agent.json')
    if (!fs.existsSync(agentJsonPath)) {return false}

    try {
      const raw = JSON.parse(fs.readFileSync(agentJsonPath, 'utf-8'))
      const activeModel = raw.active_model
      if (!activeModel?.provider_id || !activeModel?.model) {return false}

      const qpProviderId = activeModel.provider_id
      const modelName = activeModel.model

      // QwenPaw provider_id → Lumina provider_id 映射
      const PROVIDER_MAP: Record<string, string> = {
        'opencode': 'openai',     // 兼容 QwenPaw 用的 opencode
        'deepseek': 'deepseek',
        'qwen': 'qwen',
        'openai': 'openai',
        'ollama': 'ollama',
        'lmstudio': 'lmstudio',
        'zhipu': 'zhipu',
        'siliconflow': 'siliconflow',
      }

      const luminaId = PROVIDER_MAP[qpProviderId] || qpProviderId
      const def = this.getDefinition(luminaId)

      // 如果有映射到已知 provider，自动填充配置
      if (def) {
        const existing = this.store.providers[luminaId]
        if (!existing) {
          this.store.providers[luminaId] = {
            baseUrl: def.defaultBaseUrl,
            apiKey: '',
            model: modelName || def.defaultModel,
            enabled: true,
            timeout: 600,
            maxContextTokens: 256000,
          }
        } else if (!existing.model) {
          existing.model = modelName
          existing.enabled = true
        }

        this.store.activeProviderId = luminaId
        console.log(`[ProviderManager] 🔄 QwenPaw 兼容: 同步 active_model "${modelName}" → provider "${luminaId}"`)
        return true
      }

      // 未识别的 provider_id → 作为自定义 provider
      console.log(`[ProviderManager] ⚠️ QwenPaw provider_id "${qpProviderId}" 未映射到已知供应商，保留原配置`)
      return false
    } catch {
      return false
    }
  }

  // ── 初始化 ───────────────────────────────────────────

  async initialize(): Promise<void> {
    if (this.initialized) {return}
    this.initialized = true

    // 优先从 QwenPaw agent.json 同步
    const configDir = path.dirname(this.configPath)
    const qpSynced = this.tryLoadFromQwenPawAgent(configDir)

    if (!qpSynced) {
      // 先尝试从磁盘加载自有配置
      if (fs.existsSync(this.configPath)) {
        try {
          const raw = fs.readFileSync(this.configPath, 'utf-8')
          this.store = JSON.parse(raw)
          // 🔒 不在这里解密，也不 return。
          //   旧实现在这一行之后就 return 了，导致后面的统一归一化被跳过
          //   —— 而解密恰恰是它本该做的事。
          console.log(`[ProviderManager] ✅ 已加载 ${Object.keys(this.store.providers).length} 个供应商配置`)
        } catch (err) {
          console.error('[ProviderManager] ⚠️ 配置解析失败，将重建:', err)
        }
      }

      // 首次运行：从 .env 迁移
      console.log('[ProviderManager] 🔄 首次运行，从 .env 迁移配置...')
      this._migrateFromEnv()
    }

    // ══════════════════════════════════════════════════════════
    // 🔒 不变量：this.store 里的 apiKey **永远是明文**
    // ══════════════════════════════════════════════════════════
    //
    // 🐛 真实故障（用户报「配好了却提示尚未配置 LLM」）：
    //   解密循环原先只写在 `if (!qpSynced)` 的磁盘加载分支里，
    //   而那个分支结束就 return 了。一旦走 QwenPaw 同步路径
    //   （qpSynced === true），**解密一次都没跑过**。
    //
    //   后果链：
    //     内存里存的是 v1:xxx 密文
    //     → getAllProviderConfigs() 直接把密文交给调用方（它不解密）
    //     → provider:discover-local 拿密文当 Bearer 发出去
    //     → LM Studio（开了鉴权）返回 401
    //     → found=[] → localModelReady=false → llmReady=false
    //     → 界面显示「尚未配置 LLM · 模拟回复模式」
    //
    //   而模型其实**完全正常**，对话链路走的是 getActiveConfig()
    //   → getProviderConfig()（那一处会解密），所以能真跑。
    //   于是就成了「能聊天但说没连接」这种自相矛盾的现象。
    //
    // 修法不是「在另一个分支也加解密」（那只是换个地方再犯），
    // 而是把这个不变量提到**所有加载路径之后**统一执行一次。
    this.normalizeStoreKeys()

    this._save()
  }

  /**
   * 归一化：确保内存 store 里的 apiKey 是明文。
   *
   * 对已经是明文的值是幂等的（decryptApiKey 遇到非 v1: 前缀原样返回），
   * 所以可以无条件反复调用，不必关心之前走过哪条加载路径。
   */
  private normalizeStoreKeys(): void {
    const providers = this.store?.providers
    if (!providers) {return}
    let changed = 0
    for (const id of Object.keys(providers)) {
      const cfg = providers[id]
      if (cfg?.apiKey) {
        const plain = decryptApiKey(cfg.apiKey)
        if (plain !== cfg.apiKey) {
          cfg.apiKey = plain
          changed++
        }
      }
    }
    if (changed > 0) {
      console.log(`[ProviderManager] 🔓 已解密 ${changed} 个供应商的 API Key`)
    }
  }

  // ── 查询供应商定义 ──────────────────────────────────

  getAllDefinitions(): ProviderDefinition[] {
    return [...BUILT_IN_PROVIDERS]
  }

  getCloudDefinitions(): ProviderDefinition[] {
    return BUILT_IN_PROVIDERS.filter(p => !p.isLocal && p.id !== 'custom')
  }

  getCustomDefinition(): ProviderDefinition | undefined {
    return BUILT_IN_PROVIDERS.find(p => p.id === 'custom')
  }

  getDefinition(id: string): ProviderDefinition | undefined {
    return BUILT_IN_PROVIDERS.find(p => p.id === id)
  }

  // ── 配置读写 ────────────────────────────────────────

  /** 获取某供应商的当前配置（含默认值回退） */
  getProviderConfig(id: string): ProviderConfig | null {
    const def = this.getDefinition(id)
    if (!def) {return null}

    const saved = this.store.providers[id]
    if (!saved) {return null}

    return {
      baseUrl: saved.baseUrl || def.defaultBaseUrl,
      apiKey: saved.apiKey || '',
      model: saved.model || def.defaultModel,
      enabled: saved.enabled ? true : false,
      timeout: saved.timeout || 600,
      maxContextTokens: saved.maxContextTokens || 256000,
    }
  }

  /** 获取所有供应商配置（含默认值） */
  getAllProviderConfigs(): Record<string, ProviderConfig> {
    const result: Record<string, ProviderConfig> = {}
    for (const def of BUILT_IN_PROVIDERS) {
      const saved = this.store.providers[def.id]
      result[def.id] = {
        baseUrl: saved?.baseUrl || def.defaultBaseUrl,
        // 🔒 读时解密（幂等）。
        //   这一层是纵深防御：load() 里已经统一解密过了，理论上这里拿到的一定是明文。
        //   但历史上正是因为「某条路径忘了解密」，让 provider:discover-local
        //   拿密文当 Bearer 发出去、被 LM Studio 判 401、最终误报「未配置 LLM」。
        //   调用方（尤其 IPC 边界）不应该需要知道 store 里存的是密文还是明文，
        //   所以出口再兜一次。decryptApiKey 对明文是 no-op，成本可忽略。
        apiKey: saved?.apiKey ? decryptApiKey(saved.apiKey) : '',
        model: saved?.model || def.defaultModel,
        enabled: saved?.enabled || false,
        timeout: saved?.timeout || 600,
        maxContextTokens: saved?.maxContextTokens || 256000,
      }
    }
    return result
  }

  /** 获取已启用（有有效配置）的供应商列表 */
  getAvailableProviderIds(): string[] {
    const result: string[] = []
    for (const def of BUILT_IN_PROVIDERS) {
      const cfg = this.store.providers[def.id]
      if (def.requiresApiKey) {
        // 云端：需要 baseUrl + apiKey
        if (cfg?.baseUrl && cfg?.apiKey) {result.push(def.id)}
      } else {
        // 本地：只需要 baseUrl
        if (cfg?.baseUrl || def.defaultBaseUrl) {result.push(def.id)}
      }
    }
    return result
  }

  /** 保存某供应商的配置 */
  setProviderConfig(id: string, config: Partial<ProviderConfig>): void {
    const def = this.getDefinition(id)
    if (!def) {return}

    const existing = this.store.providers[id] || {
      baseUrl: def.defaultBaseUrl,
      apiKey: '',
      model: def.defaultModel,
      enabled: false,
      timeout: 600,
      maxContextTokens: 256000,
    }

    this.store.providers[id] = { ...existing, ...config }
    this._save()
    console.log(`[ProviderManager] 💾 已保存 "${id}" 配置`)

    // 🔄 自动同步到 Team Agent（Yak / Recha / Lumina）
    try {
      const ac = getAgentConfig()
      const synced = ac.syncFromGlobalProvider()
      if (!synced) {
        console.warn(`[ProviderManager] ⚠️ 保存 "${id}" 后同步到 Team Agent 失败，请检查 lumina-providers.json 与 agent-llm-configs.json 是否在同一目录`)
      }
    } catch (err) {
      console.warn('[ProviderManager] ⚠️ 保存后同步异常:', err)
    }
  }

  /** 批量保存供应商配置 */
  setMultipleProviderConfigs(configs: Record<string, Partial<ProviderConfig>>): void {
    for (const [id, cfg] of Object.entries(configs)) {
      this.setProviderConfig(id, cfg)
    }
  }

  // ── 当前激活供应商 ─────────────────────────────────

  getActiveProviderId(): string {
    return this.store.activeProviderId
  }

  setActiveProvider(id: string): void {
    const def = this.getDefinition(id)
    if (!def) {return}

    // 确保该供应商至少有一个默认配置项
    if (!this.store.providers[id]) {
      this.store.providers[id] = {
        baseUrl: def.defaultBaseUrl,
        apiKey: '',
        model: def.defaultModel,
        enabled: true,
        timeout: 600,
        maxContextTokens: 256000,
      }
    } else {
      this.store.providers[id].enabled = true
    }

    this.store.activeProviderId = id
    this._save()
    console.log(`[ProviderManager] 🔵 激活供应商: ${id}`)

    // 🔄 激活新供应商后，同步配置到全部 Team Agent
    try {
      const ac = getAgentConfig()
      const synced = ac.syncFromGlobalProvider()
      if (synced) {
        console.log(`[ProviderManager] ✅ 激活供应商后已同步到 Team Agent`)
      } else {
        console.warn(`[ProviderManager] ⚠️ 激活供应商后同步失败，请检查 lumina-providers.json 是否存在且有效`)
      }
    } catch (err) {
      console.warn('[ProviderManager] ⚠️ 激活供应商后同步异常:', err)
    }
  }

  /** 获取当前激活供应商的完整配置（快捷方式） */
  getActiveConfig(): { definition: ProviderDefinition; config: ProviderConfig } | null {
    const id = this.store.activeProviderId
    if (!id) {return null}

    const def = this.getDefinition(id)
    const config = this.getProviderConfig(id)
    if (!def || !config) {return null}

    return { definition: def, config }
  }

  // ── 模型获取 ───────────────────────────────────────

  async fetchModels(id: string, override?: { baseUrl?: string; apiKey?: string }): Promise<{ models: ModelInfo[]; error?: string }> {
    const config = this.getProviderConfig(id)
    if (!config) {return { models: [], error: '供应商未配置' }}

    // 🔧 优先使用界面当前填写的地址/密钥（未点保存也能正确获取列表）
    const baseUrl = override?.baseUrl?.trim() || config.baseUrl
    const apiKey = override?.apiKey ?? config.apiKey

    try {
      switch (id) {
        case 'lmstudio':
          return await this._fetchLMStudioModels(baseUrl, apiKey)
        case 'ollama':
          return await this._fetchOllamaModels(baseUrl)
        default: {
          const kind = resolveNativeKind(baseUrl, this.getDefinition(id)?.protocol)
          if (kind === 'anthropic') {return await this._fetchAnthropicModels(baseUrl, apiKey)}
          if (kind === 'gemini') {return await this._fetchGeminiModels(baseUrl, apiKey)}
          if (kind === 'azure') {return this._fetchAzureModels()}
          return await this._fetchOpenAIModels(baseUrl, apiKey)
        }
      }
    } catch (err: any) {
      return { models: [], error: err.message }
    }
  }

  // ── 连接测试 ───────────────────────────────────────

  async testConnection(id: string): Promise<ConnectionTestResult> {
    const config = this.getProviderConfig(id)
    if (!config) {return { success: false, error: '供应商未配置' }}

    // 本地模型不需要 model 也能测通（只需 server 在线）
    if (!config.model && !this.getDefinition(id)?.isLocal) {
      return { success: false, error: '请先选择模型' }
    }

    const startTime = Date.now()
    try {
      // 先试轻量 GET（/models 或 /health）避免触发模型加载
      if (id === 'lmstudio' || id === 'ollama') {
        const healthUrl = id === 'ollama'
          ? config.baseUrl.replace(/\/v1\/?$/, '') + '/api/tags'
          : config.baseUrl + '/models'

        const resp = await fetch(healthUrl, {
          headers: { 'Authorization': 'Bearer ' + (config.apiKey || '') },
          signal: AbortSignal.timeout(5000),
        })
        if (resp.ok) {
          return { success: true, latency: Date.now() - startTime }
        }
        // 回退到 chat completion 测试
      }

      // 原生协议（anthropic / gemini / azure）：经 nativeBridge 出正确的端点、头与 body
      const kind = resolveNativeKind(config.baseUrl, this.getDefinition(id)?.protocol)
      if (kind !== 'openai') {
        const plan = buildTransportPlan(
          kind, config.baseUrl, config.apiKey || '', config.model || 'test',
          {
            model: config.model || 'test',
            messages: [{ role: 'user', content: 'Hi' }],
            max_tokens: 5,
            stream: false,
          },
        )
        const nativeResp = await fetch(plan.url, {
          method: 'POST',
          headers: plan.headers,
          body: JSON.stringify(plan.body),
          signal: AbortSignal.timeout(15000),
        })
        if (nativeResp.ok) {return { success: true, latency: Date.now() - startTime }}
        const nativeErr = await nativeResp.text().catch(() => '')
        return { success: false, error: `HTTP ${nativeResp.status}: ${nativeErr.slice(0, 200)}` }
      }

      // 标准 POST 测试（OpenAI 兼容）
      const resp = await fetch(config.baseUrl + '/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + (config.apiKey || ''),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: config.model || 'test',
          messages: [{ role: 'user', content: 'Hi' }],
          max_tokens: 5,
        }),
        signal: AbortSignal.timeout(15000),
      })

      const latency = Date.now() - startTime

      if (resp.ok) {
        return { success: true, latency }
      }

      // 尝试读取具体错误
      const errText = await resp.text().catch(() => '')
      // 有些 LM Studio 没加载模型时返回 400，但 server 是在线的
      if (id === 'lmstudio' && resp.status === 400) {
        return { success: true, latency, error: '服务在线，但需先加载模型' }
      }
      return { success: false, error: `HTTP ${resp.status}: ${errText.slice(0, 200)}` }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  }

  // ── 持久化 ─────────────────────────────────────────

  private _save(): void {
    try {
      const dir = path.dirname(this.configPath)
      if (!fs.existsSync(dir)) {fs.mkdirSync(dir, { recursive: true })}

      // 深拷贝并加密 API Key
      const toSave: ProviderStore = {
        activeProviderId: this.store.activeProviderId,
        providers: {},
      }
      for (const [id, cfg] of Object.entries(this.store.providers)) {
        toSave.providers[id] = {
          ...cfg,
          apiKey: cfg.apiKey ? encryptApiKey(cfg.apiKey) : '',
        }
      }

      fs.writeFileSync(this.configPath, JSON.stringify(toSave, null, 2), 'utf-8')
    } catch (err) {
      console.error('[ProviderManager] ❌ 保存失败:', err)
    }
  }

  // ── 从 .env 迁移（首次运行） ──────────────────────

  private _migrateFromEnv(): void {
    const envVars: Array<{ id: string; baseUrlVar: string; apiKeyVar: string }> = [
      { id: 'deepseek',    baseUrlVar: 'DEEPSEEK_BASE_URL',    apiKeyVar: 'DEEPSEEK_API_KEY' },
      { id: 'qwen',        baseUrlVar: 'QWEN_BASE_URL',        apiKeyVar: 'QWEN_API_KEY' },
      { id: 'openai',      baseUrlVar: 'OPENAI_BASE_URL',      apiKeyVar: 'OPENAI_API_KEY' },
      { id: 'zhipu',       baseUrlVar: 'ZHIPU_BASE_URL',       apiKeyVar: 'ZHIPU_API_KEY' },
      { id: 'siliconflow', baseUrlVar: 'SILICONFLOW_BASE_URL', apiKeyVar: 'SILICONFLOW_API_KEY' },
      { id: 'lmstudio',    baseUrlVar: 'LMSTUDIO_BASE_URL',    apiKeyVar: 'LMSTUDIO_API_KEY' },
      { id: 'ollama',      baseUrlVar: 'OLLAMA_BASE_URL',      apiKeyVar: 'OLLAMA_API_KEY' },
    ]

    const defaultKey = process.env['LUMINA_DEFAULT_API_KEY'] || ''
    let anyFound = false

    for (const ev of envVars) {
      const baseUrl = process.env[ev.baseUrlVar]
      const apiKey = process.env[ev.apiKeyVar] || defaultKey

      if (baseUrl) {
        const def = this.getDefinition(ev.id)
        this.store.providers[ev.id] = {
          baseUrl,
          apiKey: apiKey || '',
          model: def?.defaultModel || '',
          enabled: true,
          timeout: 600,
          maxContextTokens: 256000,
        }
        anyFound = true
        console.log(`[ProviderManager] 🔄 从 .env 迁移: ${ev.id}`)
      }
    }

    if (anyFound) {
      // 设置首选供应商
      const preferred = process.env['LUMINA_DEFAULT_PROVIDER'] || ''
      if (preferred && this.store.providers[preferred]) {
        this.store.activeProviderId = preferred
      } else {
        // 云端优先：deepseek > qwen > openai > zhipu > siliconflow
        const cloudOrder = ['deepseek', 'qwen', 'openai', 'zhipu', 'siliconflow']
        for (const pid of cloudOrder) {
          if (this.store.providers[pid]) {
            this.store.activeProviderId = pid
            break
          }
        }
        // 没有云端 → 选第一个本地
        if (!this.store.activeProviderId) {
          const localOrder = ['lmstudio', 'ollama']
          for (const pid of localOrder) {
            if (this.store.providers[pid]) {
              this.store.activeProviderId = pid
              break
            }
          }
        }
      }
      console.log(`[ProviderManager] 🔵 激活供应商: ${this.store.activeProviderId}`)
    } else {
      console.log('[ProviderManager] ⚠️ .env 中未检测到已配置的供应商')
    }
  }

  // ── 模型探测实现 ──────────────────────────────────

  private async _fetchLMStudioModels(baseUrl: string, apiKey: string): Promise<{ models: ModelInfo[]; error?: string }> {
    const errors: string[] = []

    // 优先 GET /models（LM Studio 会返回所有已下载的模型，无论是否已加载）
    try {
      const resp = await fetch(baseUrl + '/models', {
        headers: { 'Authorization': 'Bearer ' + (apiKey || '') },
        signal: AbortSignal.timeout(8000),
      })
      if (resp.ok) {
        const data = await resp.json()
        const raw = data.data || data
        if (Array.isArray(raw)) {
          const models = raw
            .map((m: any) => ({ id: m.id || m.model || '', multimodal: false, vision: false }))
            .filter((m: ModelInfo) => m.id)
          if (models.length > 0) {return { models }}
          // 🔧 连接正常但列表为空：不再返回伪模型条目，如实报告原因
          return { models: [], error: 'LM Studio 已连接，但模型列表为空 — 请先在 LM Studio 中下载并加载模型' }
        }
        return { models: [], error: 'LM Studio 返回了无法解析的模型列表格式' }
      }
      errors.push(`GET /models → HTTP ${resp.status}`)
    } catch (e: any) { errors.push(e.message) }

    return { models: [], error: `无法从 LM Studio 获取模型列表 (${errors.join('; ')})，请确认服务地址正确且 Server 已启动` }
  }

  private async _fetchOllamaModels(baseUrl: string): Promise<{ models: ModelInfo[]; error?: string }> {
    const ollamaBase = baseUrl.replace(/\/v1\/?$/, '')
    const errors: string[] = []

    // Ollama 原生 /api/tags
    try {
      const resp = await fetch(ollamaBase + '/api/tags', { signal: AbortSignal.timeout(10000) })
      if (resp.ok) {
        const data = await resp.json()
        const models = (data.models || [])
          .map((m: any) => ({ id: m.name || m.model || '', multimodal: false, vision: false }))
          .filter((m: ModelInfo) => m.id)
        if (models.length > 0) {return { models }}
      }
      errors.push(`/api/tags → ${resp.status}`)
    } catch (e: any) { errors.push(e.message) }

    // 回退 OpenAI 兼容
    const fallback = await this._fetchOpenAIModels(baseUrl, '')
    if (fallback.models.length > 0) {return fallback}
    errors.push(...(fallback.error ? [fallback.error] : []))

    return { models: [], error: errors.join('; ') }
  }

  private async _fetchOpenAIModels(baseUrl: string, apiKey: string): Promise<{ models: ModelInfo[]; error?: string }> {
    try {
      const resp = await fetch(baseUrl + '/models', {
        headers: { 'Authorization': 'Bearer ' + (apiKey || '') },
        signal: AbortSignal.timeout(10000),
      })
      if (resp.ok) {
        const data = await resp.json()
        const raw = data.data || data
        if (Array.isArray(raw)) {
          const models = raw
            .map((m: any) => ({ id: m.id || m.model || '', multimodal: false, vision: false }))
            .filter((m: ModelInfo) => m.id)
          return { models }
        }
      }
      return { models: [], error: `HTTP ${resp.status}` }
    } catch (err: any) {
      return { models: [], error: err.message }
    }
  }

  // ── Anthropic Claude：GET /v1/models（x-api-key） ─────────────
  private async _fetchAnthropicModels(baseUrl: string, apiKey: string): Promise<{ models: ModelInfo[]; error?: string }> {
    const base = baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')
    try {
      const resp = await fetch(base + '/v1/models', {
        headers: { 'x-api-key': apiKey || '', 'anthropic-version': '2023-06-01' },
        signal: AbortSignal.timeout(10000),
      })
      if (resp.ok) {
        const data = await resp.json()
        const raw = data.data || data
        if (Array.isArray(raw)) {
          const models = raw
            .map((m: any) => ({ id: m.id || '', multimodal: true, vision: true }))
            .filter((m: ModelInfo) => m.id)
          return { models }
        }
      }
      return { models: [], error: `HTTP ${resp.status}` }
    } catch (err: any) {
      return { models: [], error: err.message }
    }
  }

  // ── Google Gemini：GET /v1beta/models（x-goog-api-key） ────────
  private async _fetchGeminiModels(baseUrl: string, apiKey: string): Promise<{ models: ModelInfo[]; error?: string }> {
    const base = baseUrl.replace(/\/+$/, '').replace(/\/v1beta$/, '')
    try {
      const resp = await fetch(base + '/v1beta/models', {
        headers: { 'x-goog-api-key': apiKey || '' },
        signal: AbortSignal.timeout(10000),
      })
      if (resp.ok) {
        const data = await resp.json()
        const raw = Array.isArray(data.models) ? data.models : []
        const models = raw
          .filter((m: any) => (m.supportedGenerationMethods || []).includes('generateContent'))
          .map((m: any) => {
            const id = (m.name || '').replace(/^models\//, '')
            return { id, multimodal: true, vision: true }
          })
          .filter((m: ModelInfo) => m.id)
        return { models }
      }
      return { models: [], error: `HTTP ${resp.status}` }
    } catch (err: any) {
      return { models: [], error: err.message }
    }
  }

  // ── Azure OpenAI：部署名由用户自定义，无法用 key 枚举；给常用占位 ──
  private _fetchAzureModels(): { models: ModelInfo[]; error?: string } {
    return {
      models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-35-turbo', 'o3-mini']
        .map((id) => ({ id, multimodal: true, vision: id.startsWith('gpt-4o') })),
      error: 'Azure 请填写你在门户创建的「部署名(Deployment name)」，上方为常用占位',
    }
  }
}

// ═══════════════════════════════════════════════════════════
// 单例工厂
// ═══════════════════════════════════════════════════════════

let _instance: ProviderManager | null = null

export function getProviderManager(configDir?: string): ProviderManager {
  if (!_instance) {
    const dir = configDir || (
      // Electron 环境
      (() => {
        try { return require('electron').app.getPath('userData') }
        catch { return process.cwd() }
      })()
    )
    _instance = new ProviderManager(dir)
  }
  return _instance
}

// ═══════════════════════════════════════════════════════════
// IPC 处理器注册 (在 main.ts 中调用)
// ═══════════════════════════════════════════════════════════

import { ipcMain } from 'electron'

export function registerProviderIpc(): void {
  const pm = getProviderManager()

  // ── 获取所有供应商定义 ──────────────────────────
  ipcMain.handle('provider:list', () => {
    return { providers: pm.getAllDefinitions() }
  })

  // ── 获取所有供应商配置 ──────────────────────────
  ipcMain.handle('provider:get-all', () => {
    return {
      activeProviderId: pm.getActiveProviderId(),
      configs: pm.getAllProviderConfigs(),
      availableIds: pm.getAvailableProviderIds(),
    }
  })

  // ── 获取单个供应商配置 ──────────────────────────
  ipcMain.handle('provider:get-config', (_event, id: string) => {
    return { config: pm.getProviderConfig(id) }
  })

  // ── 保存供应商配置 ──────────────────────────────
  ipcMain.handle('provider:save-config', (_event, id: string, config: Partial<ProviderConfig>) => {
    try {
      pm.setProviderConfig(id, config)
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // ── 批量保存供应商配置 ──────────────────────────
  ipcMain.handle('provider:save-multiple', (_event, configs: Record<string, Partial<ProviderConfig>>) => {
    try {
      pm.setMultipleProviderConfigs(configs)
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // ── 激活供应商 ──────────────────────────────────
  ipcMain.handle('provider:set-active', (_event, id: string) => {
    try {
      pm.setActiveProvider(id)
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // ── 获取模型列表 ────────────────────────────────
  ipcMain.handle('provider:fetch-models', async (_event, id: string, override?: { baseUrl?: string; apiKey?: string }) => {
    try {
      return await pm.fetchModels(id, override)
    } catch (err: any) {
      return { models: [], error: err.message }
    }
  })

  // ── 测试连接 ────────────────────────────────────
  ipcMain.handle('provider:test-connection', async (_event, id: string) => {
    try {
      return await pm.testConnection(id)
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // ── 一键检测本地模型（Ollama / LM Studio，免 Key）──
  ipcMain.handle('provider:discover-local', async () => {
    // 引导文案在 catch 分支里也要用，所以提到 try 外面声明
    let FREE_SETUP_GUIDE: any[] = []
    try {
      const mod = await import('./localProviderDiscovery')
      const { discoverLocalProvidersDetailed } = mod
      FREE_SETUP_GUIDE = mod.FREE_SETUP_GUIDE
      // 🔧 2026-10-04：探测要带上当前供应商的 apiKey，并额外试一次当前配置的端点。
      //   1) LM Studio 开启鉴权后 /v1/models 返回 401，不带 key 探测会把
      //      「服务正常」误判成「本地没加载模型」，进而弹出「尚未配置 LLM」黄框。
      //   2) 候选表写死 127.0.0.1，LM Studio 在内网另一台机（如 192.168.1.2）时发现不了。
      let apiKey = ''
      let baseUrl = ''
      try {
        const id = pm.getActiveProviderId()
        const cfg = id ? pm.getAllProviderConfigs()[id] : undefined
        apiKey = cfg?.apiKey || ''
        baseUrl = cfg?.baseUrl || ''
      } catch { /* 拿不到就按无鉴权探测 */ }

      // 🔧 2026-10-05：探测端点不应该只依赖【激活供应商】。
      //   实测故障：用户刚在设置里配好并「保存配置」+「同步到 Team」，
      //   但激活供应商仍是旧的云端项（且 key 为空）→ 探测拿到空 key
      //   → LM Studio（开了鉴权）返回 401 → 前端判定「尚未配置 LLM」。
      //   而用户视角里「我明明填好并保存了」。
      //   修法：把 Agent 独立配置里的端点/key 也纳入探测候选。
      //   哪个能用就用哪个 —— 探测的目的是「找到一个能用的」，不是「验证某个特定来源」。
      const extraBases: string[] = []
      const extraKeys: string[] = []
      if (baseUrl) { extraBases.push(baseUrl) }
      if (apiKey && apiKey !== 'local') { extraKeys.push(apiKey) }
      try {
        // Agent 独立配置（agent-llm-configs.json）也纳入探测候选。
        // 用 getAll() 而非其他方法名 —— AgentConfigManager 的方法就叫 getAll()。
        const cfgs = getAgentConfig()?.getAll?.() || {} as Record<string, any>
        for (const id of ['lumina', 'recha', 'yak']) {
          const c: any = (cfgs as any)[id]
          if (c?.endpoint && !extraBases.includes(c.endpoint)) {
            extraBases.push(c.endpoint)
          }
          if (c?.apiKey && c.apiKey !== 'local' && !extraKeys.includes(c.apiKey)) {
            extraKeys.push(c.apiKey)
          }
        }
      } catch { /* 拿不到 Agent 配置就按已有候选探测 */ }

      // 逐个 key 试：只要有一个能通就算成功。
      // 原因：LM Studio 可能已换过 key，而各处配置不同步。
      // 第一个能用的 key 会回传给调用方，并立即写回激活供应商。
      let lastResult: any = null
      let usedKey = ''
      for (const k of (extraKeys.length ? extraKeys : [''])) {
        const r = await discoverLocalProvidersDetailed(3000, k, extraBases)
        lastResult = r
        if (r.found.length > 0) { usedKey = k; break }
        // 只有 auth 类失败才值得换 key 试；连不上/没加载模型换 key 也没用
        if (r.summary.kind !== 'auth') { break }
      }

      // 探测成功但用的是别的来源的 key → 写回激活供应商，避免下次又 401
      if (usedKey && usedKey !== apiKey) {
        const cfgId = baseUrl
          ? (pm.getAllProviderConfigs().lmstudio?.baseUrl === baseUrl ? 'lmstudio' : pm.getActiveProviderId())
          : pm.getActiveProviderId()
        if (cfgId) {
          try {
            const cur = pm.getAllProviderConfigs()[cfgId]
            if (cur) {
              pm.setProviderConfig(cfgId, { ...cur, apiKey: usedKey })
              pm.setActiveProvider(cfgId)
              console.log(`[ProviderManager] 🔑 已把探测通过的 API Key 写回供应商「${cfgId}」`)
            }
          } catch { /* 写回失败不阻断探测结果返回 */ }
        }
      }

      return { ...lastResult, guide: FREE_SETUP_GUIDE }
    } catch (err: any) {
      return {
        found: [],
        failures: [],
        summary: {
          ok: false,
          kind: 'http',
          headline: '本地模型探测出错',
          advice: `探测过程发生异常：${err?.message || err}`,
        },
        guide: FREE_SETUP_GUIDE,
        error: err?.message || String(err),
      }
    }
  })
  // ── 一键接入发现的本地模型（写配置 + 激活，无需 Key）──
  ipcMain.handle('provider:apply-local', (_event, input: { id?: string; baseUrl?: string; model?: string }) => {
    try {
      // 探测结果 id 映射到 providerManager 已知供应商
      const idMap: Record<string, string> = { ollama: 'ollama', 'lm-studio': 'lmstudio', 'local-openai': 'lmstudio' }
      const id = idMap[input?.id || ''] || (input?.baseUrl?.includes('11434') ? 'ollama' : 'lmstudio')
      const base = input?.baseUrl
        ? (input.baseUrl.endsWith('/v1') ? input.baseUrl : input.baseUrl.replace(/\/$/, '') + '/v1')
        : (id === 'ollama' ? 'http://127.0.0.1:11434/v1' : 'http://127.0.0.1:1234/v1')
      pm.setProviderConfig(id, {
        baseUrl: base,
        apiKey: 'local',
        model: input?.model || pm.getDefinition(id)?.defaultModel || '',
        enabled: true,
        timeout: 120,
        maxContextTokens: 128000,
      })
      pm.setActiveProvider(id)
      return { success: true, id, model: input?.model, baseUrl: base }
    } catch (err: any) {
      return { success: false, error: err?.message || String(err) }
    }
  })

  console.log('[ProviderManager] 📡 IPC 处理器已注册 (provider:*)')
}
