// ============================================================
// agentRunConfigBuilder.ts — 从 AgentProfile 构建 AgentRunConfig (P3-1)
//
// 将 agent.json 的配置转换为 AgentRunner 需要的 AgentRunConfig
// ============================================================

import type { AgentRunConfig } from './tools/types'
import type { AgentProfile, AgentToolConfig } from './agentProfileManager'

// ═══════════════════════════════════════════════════════════
// 构建函数
// ═══════════════════════════════════════════════════════════

export function buildAgentRunConfig(
  profile: AgentProfile,
  overrides?: Partial<AgentRunConfig>
): AgentRunConfig {
  const llm = profile.llm
  const tools = profile.tools
  
  // 基础配置
  const config: AgentRunConfig = {
    mode: profile.role === 'boss' ? 'chat' : 'agent',
    model: llm.model,
    baseUrl: llm.endpoint,
    apiKey: llm.apiKey || '',
    temperature: llm.temperature ?? 0.7,
    maxTokens: llm.maxContextTokens || 256000,
    timeout: (llm.timeout || 600) * 1000, // 转换为毫秒
    
    // 工具配置
    disabledTools: tools.blacklist,
    skipApproval: tools.approvalLevel === 'none',
    
    // 子 Agent 标记
    isChildAgent: profile.role === 'worker',
    
    // 社交模式
    socialMode: profile.role === 'worker',
    
    // 默认 systemPrompt
    systemPrompt: '', // 将由 AgentRunner 根据 persona 加载
    
    // 合并覆盖
    ...overrides,
  }
  
  return config
}

/** 从 AgentProfile 提取工具白名单 */
export function getAgentToolWhitelist(profile: AgentProfile): string[] {
  return profile.tools.whitelist
}

/** 从 AgentProfile 提取工具黑名单 */
export function getAgentToolBlacklist(profile: AgentProfile): string[] {
  return profile.tools.blacklist
}

/** 检查工具是否被允许 */
export function isToolAllowed(toolName: string, profile: AgentProfile): boolean {
  const { whitelist, blacklist } = profile.tools
  
  // 黑名单优先
  if (blacklist.includes(toolName)) return false
  
  // 如果白名单为空，则允许所有（除黑名单外）
  if (whitelist.length === 0) return true
  
  // 白名单模式
  return whitelist.includes(toolName)
}

/** 获取审批级别 */
export function getApprovalLevel(profile: AgentProfile): 'auto' | 'none' | 'strict' {
  return profile.tools.approvalLevel
}
