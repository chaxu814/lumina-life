// ============================================================
// agentProfileManager.ts — Agent 独立配置管理器 (P3-1)
//
// 每个 Agent 拥有独立的 agent.json，包含：
//   - LLM 配置（provider, model, endpoint, apiKey, temperature）
//   - 工具白名单/黑名单
//   - 审批级别
//   - 社交配置（TTS 语音、情绪状态）
//   - 路径配置（chats, jobs, memory, dialog）
// ============================================================

import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'
import { getAgentConfig, AgentId, AgentLlmConfig } from './agentConfig'

// ═══════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════

export interface AgentToolConfig {
  whitelist: string[]
  blacklist: string[]
  approvalLevel: 'auto' | 'none' | 'strict'
}

export interface AgentSocialConfig {
  ttsVoice: string
  mood: number
  energy: number
  affinity: number
}

export interface AgentPathsConfig {
  chats: string
  jobs: string
  memory: string
  dialog: string
}

export interface AgentLlmConfigExtended {
  provider: string
  model: string
  endpoint: string
  apiKey?: string
  maxContextTokens?: number
  timeout?: number
  temperature?: number
  topP?: number
}

export interface AgentProfile {
  id: string
  name: string
  role: 'boss' | 'worker'
  enabled: boolean
  llm: AgentLlmConfigExtended
  tools: AgentToolConfig
  social: AgentSocialConfig
  paths: AgentPathsConfig
}

// ═══════════════════════════════════════════════════════════
// AgentProfileManager
// �═══════════════════════════════════════════════════════════

export class AgentProfileManager {
  private _profiles: Map<string, AgentProfile> = new Map()
  private _baseDir: string

  constructor(baseDir?: string) {
    this._baseDir = baseDir || path.join(app.getPath('userData'), 'agents')
  }

  /** 加载所有 Agent 配置 */
  loadAll(): Record<string, AgentProfile> {
    this._profiles.clear()
    
    const agentIds = ['lumina', 'yak', 'recha'] as const
    
    for (const id of agentIds) {
      try {
        const profile = this.load(id)
        this._profiles.set(id, profile)
      } catch (e) {
        console.warn(`[AgentProfile] 加载 ${id} 配置失败:`, e)
      }
    }
    
    return this._getAll()
  }

  /** 加载单个 Agent 配置 */
  load(agentId: string): AgentProfile {
    const agentDir = path.join(this._baseDir, agentId)
    const agentJsonPath = path.join(agentDir, 'agent.json')
    
    // 如果 agent.json 不存在，从 agentConfig 生成默认配置
    if (!fs.existsSync(agentJsonPath)) {
      const profile = this._createDefaultProfile(agentId)
      this.save(agentId, profile)
      return profile
    }
    
    try {
      const raw = fs.readFileSync(agentJsonPath, 'utf-8')
      const profile = JSON.parse(raw) as AgentProfile
      
      // 合并从 agentConfig 加载的 LLM 配置
      const agentConfig = getAgentConfig()
      const llmConfig = agentConfig.get(agentId as AgentId)
      
      if (llmConfig && llmConfig.enabled) {
        profile.llm = {
          ...profile.llm,
          provider: llmConfig.provider || profile.llm.provider,
          model: llmConfig.model || profile.llm.model,
          endpoint: llmConfig.endpoint || profile.llm.endpoint,
          apiKey: llmConfig.apiKey || profile.llm.apiKey,
          maxContextTokens: llmConfig.maxContextTokens || profile.llm.maxContextTokens,
          timeout: llmConfig.timeout || profile.llm.timeout,
        }
      }
      
      return profile
    } catch (e) {
      console.warn(`[AgentProfile] 加载 ${agentId} agent.json 失败:`, e)
      return this._createDefaultProfile(agentId)
    }
  }

  /** 保存 Agent 配置 */
  save(agentId: string, profile: Partial<AgentProfile>): void {
    const agentDir = path.join(this._baseDir, agentId)
    if (!fs.existsSync(agentDir)) {
      fs.mkdirSync(agentDir, { recursive: true })
    }
    
    const agentJsonPath = path.join(agentDir, 'agent.json')
    const existing = this._profiles.get(agentId)
    const merged = { ...existing, ...profile } as AgentProfile
    
    fs.writeFileSync(agentJsonPath, JSON.stringify(merged, null, 2), 'utf-8')
    this._profiles.set(agentId, merged)
  }

  /** 获取单个 Agent 配置 */
  get(agentId: string): AgentProfile | undefined {
    if (!this._profiles.has(agentId)) {
      this._profiles.set(agentId, this.load(agentId))
    }
    return this._profiles.get(agentId)
  }

  /** 获取所有 Agent 配置 */
  getAll(): Record<string, AgentProfile> {
    return this._getAll()
  }

  /** 获取 Agent 工作目录 */
  getAgentDir(agentId: string): string {
    return path.join(this._baseDir, agentId)
  }

  /** 获取 Agent 记忆目录 */
  getMemoryDir(agentId: string): string {
    const profile = this.get(agentId)
    return path.join(this.getAgentDir(agentId), profile?.paths?.memory || 'memory')
  }

  /** 获取 Agent 对话目录 */
  getChatsPath(agentId: string): string {
    const profile = this.get(agentId)
    return path.join(this.getAgentDir(agentId), profile?.paths?.chats || 'chats.json')
  }

  /** 获取 Agent 任务目录 */
  getJobsPath(agentId: string): string {
    const profile = this.get(agentId)
    return path.join(this.getAgentDir(agentId), profile?.paths?.jobs || 'jobs.json')
  }

  /** 获取 Agent dialog 目录 */
  getDialogDir(agentId: string): string {
    const profile = this.get(agentId)
    return path.join(this.getAgentDir(agentId), profile?.paths?.dialog || 'dialog')
  }

  // ── 私有方法 ─────────────────────────────────────────

  private _getAll(): Record<string, AgentProfile> {
    const result: Record<string, AgentProfile> = {}
    for (const [id, profile] of this._profiles) {
      result[id] = profile
    }
    return result
  }

  private _createDefaultProfile(agentId: string): AgentProfile {
    const agentConfig = getAgentConfig()
    const llmConfig = agentConfig.get(agentId as AgentId)
    
    const defaults: Record<string, Partial<AgentProfile>> = {
      lumina: {
        id: 'lumina',
        name: 'Lumina',
        role: 'boss',
        enabled: true,
        llm: {
          provider: llmConfig.provider || 'siliconflow',
          model: llmConfig.model || 'Qwen/Qwen3-235B-A22B',
          endpoint: llmConfig.endpoint || 'https://api.siliconflow.cn/v1',
          apiKey: llmConfig.apiKey || '',
          maxContextTokens: llmConfig.maxContextTokens || 256000,
          timeout: llmConfig.timeout || 600,
          temperature: 0.7,
          topP: 0.9,
        },
        tools: {
          whitelist: [],
          blacklist: [],
          approvalLevel: 'auto',
        },
        social: {
          ttsVoice: 'zh-CN-XiaoxiaoNeural',
          mood: 0.3,
          energy: 0.7,
          affinity: 0.5,
        },
        paths: {
          chats: 'chats.json',
          jobs: 'jobs.json',
          memory: 'memory',
          dialog: 'dialog',
        },
      },
      yak: {
        id: 'yak',
        name: 'Yak',
        role: 'worker',
        enabled: true,
        llm: {
          provider: llmConfig.provider || 'deepseek',
          model: llmConfig.model || 'deepseek-v3',
          endpoint: llmConfig.endpoint || 'https://api.deepseek.com/v1',
          apiKey: llmConfig.apiKey || '',
          maxContextTokens: llmConfig.maxContextTokens || 256000,
          timeout: llmConfig.timeout || 600,
          temperature: 0.3,
          topP: 0.9,
        },
        tools: {
          whitelist: ['write_code', 'debug', 'explain_code'],
          blacklist: [],
          approvalLevel: 'none',
        },
        social: {
          ttsVoice: 'zh-CN-YunjianNeural',
          mood: 0.5,
          energy: 0.8,
          affinity: 0.6,
        },
        paths: {
          chats: 'chats.json',
          jobs: 'jobs.json',
          memory: 'memory',
          dialog: 'dialog',
        },
      },
      recha: {
        id: 'recha',
        name: '热茶',
        role: 'worker',
        enabled: true,
        llm: {
          provider: llmConfig.provider || 'zhipu',
          model: llmConfig.model || 'glm-4-flash',
          endpoint: llmConfig.endpoint || 'https://open.bigmodel.cn/api/paas/v4',
          apiKey: llmConfig.apiKey || '',
          maxContextTokens: llmConfig.maxContextTokens || 256000,
          timeout: llmConfig.timeout || 600,
          temperature: 0.2,
          topP: 0.9,
        },
        tools: {
          whitelist: ['review_code', 'find_bug', 'risk_assessment'],
          blacklist: [],
          approvalLevel: 'none',
        },
        social: {
          ttsVoice: 'zh-CN-YunxiNeural',
          mood: 0.4,
          energy: 0.6,
          affinity: 0.7,
        },
        paths: {
          chats: 'chats.json',
          jobs: 'jobs.json',
          memory: 'memory',
          dialog: 'dialog',
        },
      },
    }
    
    return (defaults[agentId] || defaults.lumina) as AgentProfile
  }
}

// ═══════════════════════════════════════════════════════════
// 单例
// ═══════════════════════════════════════════════════════════

let _instance: AgentProfileManager | null = null

export function getAgentProfileManager(): AgentProfileManager {
  if (!_instance) {
    _instance = new AgentProfileManager()
    _instance.loadAll()
  }
  return _instance
}

export function initAgentProfileManager(baseDir?: string): AgentProfileManager {
  _instance = new AgentProfileManager(baseDir)
  _instance.loadAll()
  return _instance
}
