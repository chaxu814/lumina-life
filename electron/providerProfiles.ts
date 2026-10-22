// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// providerProfiles.ts — LLM Provider 能力档案 (v4.0)
//
// v4.0 慢速修复：
//   ✅ 本地模型超时默认提升至 600s（低配电脑友好）
//   ✅ 新增 slowTierTimeout：慢速模式下的兜底超时
//   ✅ 本地模型标记 isLocal=true，触发渐进超时
//
// 为每个供应商/模型建档：上下文、推理类型、推荐用途、超时策略。
//
// 解决"模型无类型感知"问题 (架构决策 #1)：
//   - 推理模型 (reasoning) → 无工具调用，长超时
//   - 快模型 (chat/coding)     → 有工具调用，短超时
//   - 本地模型 (local)        → 超长超时 + 渐进式
//   - 模型分层路由由此驱动
//
// 借鉴 QwenPaw 的 provider_manager + model_factory 思路，
// 但适配 Lumina 的 OpenAI 兼容 API 体系。
// ============================================================

// ═══════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════

export type ModelCategory = 'reasoning' | 'coding' | 'chat' | 'multimodal'

export interface ModelProfile {
  /** 匹配模型名的正则 */
  pattern: RegExp
  /** 模型类别 */
  category: ModelCategory
  /** 最大上下文 tokens */
  maxContextTokens: number
  /** 是否支持 256K 上下文 */
  supports256K: boolean
  /** 是否支持 function calling */
  supportsTools: boolean
  /** 预估首token延迟 (秒) — 用于心跳检测阈值 */
  estimatedFirstTokenSec: number
  /** 推荐用途 */
  recommendedFor: ('orchestration' | 'coding' | 'analysis' | 'chat')[]
  /** tool-calling 可靠性 0-1 */
  toolCallingReliability: number
  /** 推荐 HTTP 总超时 (秒) */
  recommendedHttpTimeout: number
  /** v4.0: 慢速模式下的兜底超时 (秒) */
  slowTierTimeout?: number
  /** v4.0: 是否本地模型 — 触发渐进超时策略 */
  isLocal?: boolean
}

export interface ProviderProfile {
  provider: string
  /** baseUrl 匹配正则 */
  urlPattern: RegExp
  models: ModelProfile[]
  /** 全局默认超时 (此供应商所有模型的基础值) */
  defaultTimeoutSec: number
}

// ═══════════════════════════════════════════════════════════
// 供应商档案
// ═══════════════════════════════════════════════════════════

export const PROVIDER_PROFILES: ProviderProfile[] = [
  // ── LM Studio (本地) ──────────────────────────
  {
    provider: 'lmstudio',
    urlPattern: /(localhost|127\.0\.0\.1|192\.168\.)/i,
    defaultTimeoutSec: 600,  // v4.0: 低配电脑友好
    models: [
      {
        pattern: /(^o1|^o3|^r1-|^qwq|deepseek-r1|openai-o1|openai-o3)/i,
        category: 'reasoning',
        maxContextTokens: 128_000,
        supports256K: false,
        supportsTools: false,
        estimatedFirstTokenSec: 90,
        recommendedFor: ['orchestration', 'analysis'],
        toolCallingReliability: 0.3,
        recommendedHttpTimeout: 600,
        slowTierTimeout: 1200,  // v4.0: 慢速兜底
        isLocal: true,
      },
      {
        pattern: /coder|code/i,
        category: 'coding',
        maxContextTokens: 128_000,
        supports256K: false,
        supportsTools: true,
        estimatedFirstTokenSec: 10,
        recommendedFor: ['coding'],
        toolCallingReliability: 0.85,
        recommendedHttpTimeout: 180,
        slowTierTimeout: 600,
        isLocal: true,
      },
      // Qwen 本地模型（Qwen2.5/Qwen3 支持 128K+ 上下文）
      {
        pattern: /qwen/i,
        category: 'coding',
        maxContextTokens: 256_000,
        supports256K: true,
        supportsTools: true,
        estimatedFirstTokenSec: 8,
        recommendedFor: ['coding', 'analysis', 'chat', 'orchestration'],
        toolCallingReliability: 0.88,
        recommendedHttpTimeout: 600,  // 🆕 v5.3: 300→600，本地35B模型需要更长超时
        slowTierTimeout: 900,          // 🆕 v5.3: 慢速模式兜底
        isLocal: true,                 // 🆕 v5.3: 标记本地模型，触发渐进超时
      },
      // fallback: 本地模型默认配置
      {
        pattern: /.*/,
        category: 'chat',
        maxContextTokens: 256_000,
        supports256K: true,
        supportsTools: true,
        estimatedFirstTokenSec: 15,
        recommendedFor: ['chat'],
        toolCallingReliability: 0.75,
        recommendedHttpTimeout: 600,  // 🔧 用户指定: 提升至 600s (10分钟)
        slowTierTimeout: 900,
        isLocal: true,
      },
    ],
  },

  // ── DeepSeek ──────────────────────────────────
  {
    provider: 'deepseek',
    urlPattern: /deepseek/i,
    defaultTimeoutSec: 60,
    models: [
      {
        pattern: /reasoner|r1/i,
        category: 'reasoning',
        maxContextTokens: 131_072,
        supports256K: false,
        supportsTools: false,
        estimatedFirstTokenSec: 20,
        recommendedFor: ['analysis'],
        toolCallingReliability: 0.6,
        recommendedHttpTimeout: 300,
        slowTierTimeout: 900,
        isLocal: true,
      },
      {
        pattern: /chat|v3/i,
        category: 'coding',
        maxContextTokens: 1_000_000,  // DeepSeek 官方 API 支持 1M
        supports256K: true,
        supportsTools: true,
        estimatedFirstTokenSec: 3,
        recommendedFor: ['coding', 'orchestration'],
        toolCallingReliability: 0.88,
        recommendedHttpTimeout: 120,
        slowTierTimeout: 600,
      },
      {
        pattern: /.*/,
        category: 'chat',
        maxContextTokens: 131_072,
        supports256K: false,
        supportsTools: true,
        estimatedFirstTokenSec: 5,
        recommendedFor: ['chat'],
        toolCallingReliability: 0.85,
        recommendedHttpTimeout: 120,
        slowTierTimeout: 600,
      },
    ],
  },

  // ── 通义千问 (DashScope) — 唯一 256K+ 选择 ────
  {
    provider: 'qwen-dashscope',
    urlPattern: /dashscope/i,
    defaultTimeoutSec: 60,
    models: [
      {
        pattern: /qwen-long/i,
        category: 'coding',
        maxContextTokens: 10_000_000,
        supports256K: true,
        supportsTools: true,
        estimatedFirstTokenSec: 3,
        recommendedFor: ['coding', 'orchestration', 'analysis', 'chat'],
        toolCallingReliability: 0.92,
        recommendedHttpTimeout: 120,
      },
      {
        pattern: /qwen-max/i,
        category: 'chat',
        maxContextTokens: 32_768,
        supports256K: false,
        supportsTools: true,
        estimatedFirstTokenSec: 2,
        recommendedFor: ['chat'],
        toolCallingReliability: 0.90,
        recommendedHttpTimeout: 90,
      },
      {
        pattern: /qwen-plus/i,
        category: 'coding',
        maxContextTokens: 131_072,
        supports256K: false,
        supportsTools: true,
        estimatedFirstTokenSec: 2,
        recommendedFor: ['coding'],
        toolCallingReliability: 0.90,
        recommendedHttpTimeout: 90,
      },
      {
        pattern: /.*/,
        category: 'chat',
        maxContextTokens: 131_072,
        supports256K: false,
        supportsTools: true,
        estimatedFirstTokenSec: 3,
        recommendedFor: ['chat'],
        toolCallingReliability: 0.88,
        recommendedHttpTimeout: 120,
      },
    ],
  },

  // ── OpenAI ────────────────────────────────────
  {
    provider: 'openai',
    urlPattern: /openai/i,
    defaultTimeoutSec: 60,
    models: [
      {
        // 仅匹配 OpenAI 官方推理模型 (o1/o3系列)
        pattern: /^o1|^o3/i,
        category: 'reasoning',
        maxContextTokens: 200_000,
        supports256K: false,
        supportsTools: false,
        estimatedFirstTokenSec: 12,
        recommendedFor: ['analysis'],
        toolCallingReliability: 0.7,
        recommendedHttpTimeout: 300,
      },
      {
        pattern: /gpt-4o|gpt-4\.1/i,
        category: 'coding',
        maxContextTokens: 128_000,
        supports256K: false,
        supportsTools: true,
        estimatedFirstTokenSec: 2,
        recommendedFor: ['coding', 'orchestration'],
        toolCallingReliability: 0.95,
        recommendedHttpTimeout: 90,
      },
      {
        pattern: /.*/,
        category: 'chat',
        maxContextTokens: 128_000,
        supports256K: false,
        supportsTools: true,
        estimatedFirstTokenSec: 2,
        recommendedFor: ['chat'],
        toolCallingReliability: 0.95,
        recommendedHttpTimeout: 90,
      },
    ],
  },

  // ── 智谱 GLM ──────────────────────────────────
  {
    provider: 'zhipu',
    urlPattern: /bigmodel/i,
    defaultTimeoutSec: 60,
    models: [
      {
        pattern: /glm-4/i,
        category: 'coding',
        maxContextTokens: 128_000,
        supports256K: false,
        supportsTools: true,
        estimatedFirstTokenSec: 3,
        recommendedFor: ['coding', 'chat'],
        toolCallingReliability: 0.88,
        recommendedHttpTimeout: 120,
      },
      {
        pattern: /.*/,
        category: 'chat',
        maxContextTokens: 128_000,
        supports256K: false,
        supportsTools: true,
        estimatedFirstTokenSec: 3,
        recommendedFor: ['chat'],
        toolCallingReliability: 0.85,
        recommendedHttpTimeout: 120,
      },
    ],
  },

  // ── 硅基流动 (SiliconFlow) ────────────────────
  {
    provider: 'siliconflow',
    urlPattern: /siliconflow/i,
    defaultTimeoutSec: 60,
    models: [
      {
        pattern: /deepseek.*r1|reasoner/i,
        category: 'reasoning',
        maxContextTokens: 131_072,
        supports256K: false,
        supportsTools: false,
        estimatedFirstTokenSec: 15,
        recommendedFor: ['analysis'],
        toolCallingReliability: 0.6,
        recommendedHttpTimeout: 300,
      },
      {
        pattern: /.*/,
        category: 'chat',
        maxContextTokens: 131_072,
        supports256K: false,
        supportsTools: true,
        estimatedFirstTokenSec: 3,
        recommendedFor: ['chat', 'coding'],
        toolCallingReliability: 0.85,
        recommendedHttpTimeout: 120,
      },
    ],
  },
]

// ═══════════════════════════════════════════════════════════
// 模型匹配与查询
// ═══════════════════════════════════════════════════════════

export interface MatchedProfile {
  provider: ProviderProfile
  model: ModelProfile
}

/**
 * 根据 baseUrl + modelName 匹配对应的档案
 * 优先级: 精确模型名匹配 > 泛化匹配 > fallback
 */
export function matchProfile(baseUrl: string, modelName: string): MatchedProfile | null {
  const provider = PROVIDER_PROFILES.find(p => p.urlPattern.test(baseUrl))
  if (!provider) {
    // 未知供应商 → 使用保守默认值
    return {
      provider: {
        provider: 'unknown',
        urlPattern: /.*/,
        defaultTimeoutSec: 300,
        models: [],
      },
      model: {
        pattern: /.*/,
        category: 'chat',
        maxContextTokens: 256_000,
        supports256K: true,
        supportsTools: true,
        estimatedFirstTokenSec: 15,
        recommendedFor: ['chat'],
        toolCallingReliability: 0.7,
        recommendedHttpTimeout: 300,
      },
    }
  }

  // 按顺序匹配（第一个命中即为结果）
  for (const model of provider.models) {
    if (model.pattern.test(modelName)) {
      return { provider, model }
    }
  }

  // fallback: 供应商最后一个模型（通配 .*）
  const lastModel = provider.models[provider.models.length - 1]
  return { provider, model: lastModel }
}

/**
 * 判断模型是否为推理模型（有隐式思考期）
 */
export function isReasoningModel(baseUrl: string, modelName: string): boolean {
  const matched = matchProfile(baseUrl, modelName)
  return matched?.model.category === 'reasoning'
}

/**
 * v4.0: 获取推荐 HTTP 超时 (秒)
 * 如果全局慢速模式已激活，返回慢速兜底超时。
 */
export function getRecommendedTimeout(baseUrl: string, modelName: string): number {
  const matched = matchProfile(baseUrl, modelName)
  const baseTimeout = matched?.model.recommendedHttpTimeout || 300

  // v4.0: 检查全局慢速模式
  try {
    const { isSlowModeActive, getSlowModeTimeout } = require('./llmRetry')
    if (isSlowModeActive()) {
      const slowMs = getSlowModeTimeout()
      const modelSlowTier = matched?.model.slowTierTimeout || baseTimeout * 5
      return Math.max(Math.floor(slowMs / 1000), modelSlowTier)
    }
  } catch {}

  return baseTimeout
}

/**
 * 获取模型最大上下文 tokens
 */
export function getModelMaxContext(baseUrl: string, modelName: string): number {
  const matched = matchProfile(baseUrl, modelName)
  if (!matched) {return 256_000}
  return matched.model.maxContextTokens
}

/**
 * 判断模型是否适合做 tool-calling
 */
export function canUseTools(baseUrl: string, modelName: string): boolean {
  const matched = matchProfile(baseUrl, modelName)
  if (!matched) {return true}
  return matched.model.supportsTools
}
