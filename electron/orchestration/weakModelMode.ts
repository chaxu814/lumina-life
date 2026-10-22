// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// orchestration/weakModelMode.ts — 弱模型（小参数量）自动降级
//
// 【要解决的问题】
// 1.9B / 3B 这类本地小模型跑 Lumina 的多 Agent 团队编排（delegate_to /
// delegate_chain / 32 条工具沙箱 / 多步推理）会频繁"只思考不回答"或
// 调工具后不收尾 —— 症状就是用户看到「本轮未产出可用内容」。
//
// 这不是 Lumina 的 bug，是**当前小模型的能力下限**：它既协调不动团队，
// 也容易在长工具链里跑飞。硬逼它在小模型上跑完整编排，体验只会更差。
//
// 【做法：不逼它，自动降级】
// 模型能力画像（core/modelCapabilities）已经按参数量分了档（nano<1.5B /
// small<7B / medium<20B …），但旧代码只拿档位去压 token 预算，
// **从没降过编排复杂度** —— 于是 nano 档仍被要求跑完整团队。
//
// 本模块把"是否弱模型"收敛成一个判断 + 一份安全工具白名单 + 一段提示词，
// 由 agentRunner 在两条路径上自动应用（无需任何用户配置）：
//   ① getToolsForMode() —— 弱模型只暴露白名单工具，团队/写/执行类全砍；
//   ② initSystemPrompt() —— 追加"轻量模式"指令，让模型直接简洁回答、不委派。
//
// 设计原则与项目一致：**全自动、零配置、失败开放**。白名单若被上游过滤
// 全干掉，至少退回 memory_search，保证模型还能"回忆"。
// ============================================================

import type { ModelTier } from '../core/modelCapabilities'

/** 弱模型档位：只有 nano / small 需要降级。其余走完整编排。 */
export function isLiteTier(tier: ModelTier | undefined | null): boolean {
  return tier === 'nano' || tier === 'small'
}

/**
 * 弱模型安全工具白名单。
 *
 * 只保留「陪伴 + 检索 + 只读」三类低风险、单轮即可完成的工具，
 * 砍掉一切需要协调或具破坏性的工具：
 *   - 团队协作：delegate_to / delegate_chain / hire_worker /
 *     adversarial_review / phase_gate_delegate
 *   - 写/改：file_write / file_edit / git_commit
 *   - 执行：shell_exec / computer_use / 浏览器自动化
 *
 * 小模型既协调不动团队，也极易在长工具链里跑飞，所以干脆不暴露。
 * 工具名均来自 electron/tools/impl/ 下已确认存在的导出。
 */
export const LITE_TOOL_WHITELIST: ReadonlySet<string> = new Set([
  'memory_search', // 回忆：陪伴体验的核心
  'web_search', // 查资料：单轮可完成
  'file_read', // 只读文件：低风险、偶尔有用
])

/**
 * 轻量模式提示词（注入 system prompt）。
 * 明确告诉小模型：直接答、别委派、别跑复杂工具链。
 */
export const LITE_SYSTEM_NOTE = `## 🪶 轻量模式（当前模型参数量较小）
你正在一个参数量较小的模型上运行。为了保持回答稳定，请遵循：
- **直接、简洁**地回答，优先用你已有的知识，不要硬凑长推理；
- **不要**调用 delegate_to / delegate_chain / hire_worker / adversarial_review /
  phase_gate_delegate 等团队协作工具（这些工具本轮不可用）；
- 避免复杂的多步工具链；如确需查资料可用 web_search，如需回忆可用 memory_search；
- 如果遇到需要大量写代码 / 跑命令的任务，如实告诉用户"这个我在这个小模型上可能做不好，
  建议换更大的模型"，而不是强行尝试后给出残缺结果。`
