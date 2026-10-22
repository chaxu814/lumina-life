// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// cuSafety.ts — Computer Use 安全策略（零依赖纯函数，可单测）
//
// v6.2（F1）：底层规则库迁移到 ./sandboxRules.ts —— 7 级严重度 × 8 类威胁。
// 本文件保留旧 API（destructiveReason / isDestructive）做兼容：
//   任一调用方升级到 severity >= HIGH 即视为「高危/不可逆」，与旧行为一致。
//
// 新代码请直接使用 evaluateCommand 拿到结构化命中（级别/类别/处置）。
// ============================================================

import { evaluateCommand, Severity } from './sandboxRules'

/**
 * 命中明确不可逆 / 越权的系统命令时返回人类可读原因，否则返回 null。
 * 任何权限姿态（auto/ask/strict）下，命中都硬拦截。
 */
export function destructiveReason(text: string | undefined | null): string | null {
  const ev = evaluateCommand(text)
  if (ev.severity < Severity.HIGH) {return null}
  // 取最高 severity 的命中作为主因展示
  const worst = ev.hits.reduce((a, b) => (b.severity > a.severity ? b : a), ev.hits[0])
  const label = worst?.description || '高危命令'
  return `检测到高危/不可逆操作（${label}），已硬拦截`
}

/** 便捷布尔判定 */
export function isDestructive(text: string | undefined | null): boolean {
  return destructiveReason(text) !== null
}

// 重新导出新规则库 API，方便调用方一站式从这里引用
export {
  evaluateCommand,
  Severity,
  ThreatCategory,
  severityLabel,
  severityColor,
  categoryLabel,
  ruleStats,
} from './sandboxRules'
export type {
  SandboxRule,
  RuleHit,
  CommandEvaluation,
} from './sandboxRules'
