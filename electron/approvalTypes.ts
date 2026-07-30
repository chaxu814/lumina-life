// ============================================================
// approvalTypes.ts — 审批流共享类型 (v8.0)
//
// 借鉴 QwenPaw ToolExecutionLevel + ToolGuard 设计
// ============================================================

import type { ApprovalLocale } from './i18n/approval'

// ═══════════════════════════════════════════════════════════
// 执行级别 (Execution Level)
// ═══════════════════════════════════════════════════════════

export enum ToolExecutionLevel {
  STRICT = 'strict',
  /** 所有工具调用都需审批（最高安全性） */
  SMART = 'smart',
  /** 低风险自动放行，中风险以上需审批（推荐） */
  AUTO = 'auto',
  /** 仅高危工具需审批（向下兼容，默认） */
  OFF = 'off',
  /** 完全禁用工具审查（仅开发环境） */
}

export const EXECUTION_LEVEL_ORDER: ToolExecutionLevel[] = [
  ToolExecutionLevel.OFF,
  ToolExecutionLevel.AUTO,
  ToolExecutionLevel.SMART,
  ToolExecutionLevel.STRICT,
]

export function parseExecutionLevel(value: string | null | undefined): ToolExecutionLevel {
  if (!value) return ToolExecutionLevel.AUTO
  const v = value.toLowerCase().trim()
  for (const level of Object.values(ToolExecutionLevel)) {
    if (v === level) return level
  }
  return ToolExecutionLevel.AUTO
}

/** 级别的安全强度（用于比较） */
export function executionLevelScore(level: ToolExecutionLevel): number {
  switch (level) {
    case ToolExecutionLevel.OFF: return 0
    case ToolExecutionLevel.AUTO: return 1
    case ToolExecutionLevel.SMART: return 2
    case ToolExecutionLevel.STRICT: return 3
  }
}

/** 该级别下某风险级别是否需要审批 */
export function requiresApproval(
  level: ToolExecutionLevel,
  riskLevel: ApprovalRiskLevel,
): boolean {
  switch (level) {
    case ToolExecutionLevel.OFF:
      return false
    case ToolExecutionLevel.AUTO:
      return riskLevel === 'high' || riskLevel === 'critical'
    case ToolExecutionLevel.SMART:
      return riskLevel === 'medium' || riskLevel === 'high' || riskLevel === 'critical'
    case ToolExecutionLevel.STRICT:
      return true
  }
}

// ═══════════════════════════════════════════════════════════
// 审批风险级别
// ═══════════════════════════════════════════════════════════

export type ApprovalRiskLevel = 'low' | 'medium' | 'high' | 'critical'

// ═══════════════════════════════════════════════════════════
// 审批决策
// ═══════════════════════════════════════════════════════════

export enum ApprovalDecision {
  APPROVED = 'approved',
  DENIED = 'denied',
  TIMEOUT = 'timeout',
  CANCELLED = 'cancelled',
}

// ═══════════════════════════════════════════════════════════
// 审批请求
// ═══════════════════════════════════════════════════════════

export interface ApprovalRequest {
  id: string
  sessionId: string
  agentId: string
  toolName: string
  toolArgs: Record<string, any>
  /** 人类可读的操作描述 */
  description: string
  /** 风险等级 */
  riskLevel: ApprovalRiskLevel
  /** 威胁分类 */
  threatCategories: string[]
  /** 安全发现详情 */
  securityFindings: string[]
  /** 创建时间戳 */
  createdAt: number
  /** 超时时间 (ms) */
  timeoutMs: number
  /** 已过等待时间（心跳用） */
  elapsedMs: number
  /** 审批状态 */
  status: 'pending' | 'approved' | 'denied' | 'timeout' | 'cancelled'
  /** 决议时间 */
  resolvedAt?: number
  /** 审批者备注 */
  approverNote?: string
}

// ═══════════════════════════════════════════════════════════
// 审批配置
// ═══════════════════════════════════════════════════════════

export interface ApprovalConfig {
  enabled: boolean
  /** 执行级别 */
  executionLevel: ToolExecutionLevel
  /** 默认超时 (ms) */
  defaultTimeoutMs: number
  /** 心跳间隔 (ms) */
  heartbeatIntervalMs: number
  /** 最大并发审批数 */
  maxPending: number
  /** 是否自动拒绝超时 */
  autoDenyOnTimeout: boolean
  /** 语言 */
  locale: ApprovalLocale
}

export const DEFAULT_APPROVAL_CONFIG: ApprovalConfig = {
  enabled: true,
  executionLevel: ToolExecutionLevel.AUTO,
  defaultTimeoutMs: 300_000,  // 5 分钟
  heartbeatIntervalMs: 15_000, // 15 秒
  maxPending: 10,
  autoDenyOnTimeout: true,
  locale: 'zh',
}

// ═══════════════════════════════════════════════════════════
// 审批事件
// ═══════════════════════════════════════════════════════════

export interface HeartbeatEvent {
  requestId: string
  elapsed: number
  remaining: number
  riskLevel: ApprovalRiskLevel
  toolName: string
  status: 'pending'
}
