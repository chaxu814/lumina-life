// ============================================================
// modelTier.ts — v3.30 小模型成本分级（同类工程实践）
//
// 杂活（检索/调研/数据/通用）用便宜快模型，关键活（编码/复核/测试）
// 仍用主力模型。模型名映射规则（纯函数，可单测）：
//   1. 环境变量 LUMINA_SMALL_MODEL 显式指定（最高优先）
//   2. 按主力模型家族做已知轻量型号替换（OpenAI / DeepSeek / 智谱 / 通义）
//   3. 认不出来的本地/自部署模型 → 返回 null（不替换，避免瞎指）
// ============================================================

import type { WorkerRole } from './dynamicWorker'

export type ModelTier = 'strong' | 'small'

/** 杂活工种：用小模型；关键工种保持主力 */
const SMALL_ROLES: WorkerRole[] = ['research', 'search', 'data', 'general']

export function tierForRole(role: WorkerRole | string): ModelTier {
  return SMALL_ROLES.includes(role as WorkerRole) ? 'small' : 'strong'
}

/**
 * 给出某角色应使用的模型：
 * @returns 小模型名（应替换）；null 表示继续用主力模型
 */
export function resolveWorkerModel(
  role: WorkerRole | string,
  mainModel: string,
  envSmall?: string,
): string | null {
  if (tierForRole(role) !== 'small') {return null}
  const forced = envSmall || process.env.LUMINA_SMALL_MODEL
  if (forced && forced.trim()) {return forced.trim()}

  const m = (mainModel || '').toLowerCase().trim()
  if (!m) {return null}

  // OpenAI
  if (/gpt-4o/.test(m) || /gpt-4\.1/.test(m)) {
    // 已经是轻量型号就别再降
    if (/mini|nano/.test(m)) {return null}
    return m.includes('gpt-4o-mini') ? null : 'gpt-4o-mini'
  }
  if (/gpt-4(\b|-)/.test(m)) {return 'gpt-4o-mini'}
  // DeepSeek：deepseek-chat（V3）本身已是便宜档，reasoner 降到 chat
  if (/deepseek/.test(m)) {
    if (m.includes('deepseek-chat')) {return null}
    if (/r1|reasoner/.test(m)) {return 'deepseek-chat'}
    return null
  }
  // 智谱 GLM
  if (/glm-4|glm4/.test(m)) {
    if (/flash|air/.test(m)) {return null}
    return 'glm-4-flash'
  }
  // 通义千问
  if (/qwen/.test(m)) {
    if (/7b|14b|qwen-turbo|qwen2\.5-7b/.test(m)) {return null}
    return 'qwen-turbo'
  }
  // 本地 / 自部署模型（Ollama、vLLM、IP 直连）：不猜型号，保持主力
  return null
}

/**
 * 把模型替换决策汇总成一句日志/UI 描述。
 */
export function describeTier(role: WorkerRole | string, model: string | null): string {
  if (tierForRole(role) !== 'small') {return '主力模型（关键工种）'}
  return model ? `小模型 ${model}（杂活降本）` : '主力模型（未配置小模型替换）'
}
