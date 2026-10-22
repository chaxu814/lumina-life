// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// orchestration/delegationPrompt.ts — Worker 委托 Prompt 构建器 (v02)
//
// 修复问题 D：之前 Worker 只收到"[lumina→yak] 前 50 字..."和一句
// "你是 yak 正在执行委托任务"，完全看不到对话历史、任务目标、
// 可用工具和项目上下文，于是回复"本轮对话目前只有这一条消息…"。
//
// 本模块把这些上下文组装成 Worker 的 system prompt + 首轮用户消息，
// 纯函数、零重依赖，便于单元测试。
// ============================================================

import { buildSelfKnowledgeBlock } from '../selfKnowledge'

/** 传给 Worker 的完整委托上下文 */
export interface WorkerPromptContext {
  /** 目标 Worker ID（'yak' | 'recha' | 自定义 agent id） */
  to: string
  /** 委托方 ID */
  from: string
  /** 任务类型 */
  taskType: string
  /** 完整任务描述（不要截断） */
  task: string
  /** 用户原始请求 / 任务目标（缺省用 task） */
  taskGoal?: string
  /** 可用工具名列表 */
  availableTools?: string[]
  /** 对话历史（已过滤 system/tool，只留 user/assistant） */
  conversationHistory?: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>
  /** 项目上下文 */
  projectContext?: {
    cwd: string
    relevantFiles?: string[]
    techStack?: string
  }
  /** 自由文本上下文（旧字段，agentRunner 传入的摘要） */
  legacyContext?: string
}

/** 角色中文名映射，给 Worker 看 */
const ROLE_LABEL: Record<string, string> = {
  user: '用户',
  assistant: fromLabel('lumina'),
  system: '系统',
}

function fromLabel(id: string): string {
  if (id === 'lumina') {return 'Lumina'}
  if (id === 'yak') {return 'Yak'}
  if (id === 'recha') {return '热茶'}
  return id
}

/** 单个角色的中文标签（含委托方映射） */
function roleLabel(role: string): string {
  return ROLE_LABEL[role] || role
}

/** 对话历史条数上限（防止 system prompt 爆炸） */
const MAX_HISTORY_MESSAGES = 12
/** 单条历史消息字数上限 */
const MAX_HISTORY_CHARS = 1200

/**
 * 把对话历史渲染成 system prompt 里的一段文本。
 * 无历史时返回空字符串。
 */
export function renderConversationHistory(
  history: Array<{ role: string; content: string }> | undefined,
): string {
  if (!history || history.length === 0) {return ''}
  const lines = history
    .slice(-MAX_HISTORY_MESSAGES)
    .map((m) => {
      const label = roleLabel(m.role)
      const text = (m.content || '').slice(0, MAX_HISTORY_CHARS).trim()
      return `【${label}】${text}`
    })
    .filter((l) => l.length > 4)
  if (lines.length === 0) {return ''}
  return lines.join('\n')
}

/**
 * 构建 Worker 的 system prompt。
 * 必须包含：任务目标 / 对话上下文 / 可用工具 / 项目根目录与文件 / 执行铁则。
 */
export function buildWorkerSystemPrompt(ctx: WorkerPromptContext): string {
  const parts: string[] = []
  const toLabel = fromLabel(ctx.to)
  const fromLabelName = fromLabel(ctx.from)

  parts.push(`你是 ${toLabel}，Lumina 团队的后台工作者，正在执行来自 ${fromLabelName} 的委托。`)
  parts.push('这是一个独立上下文子任务：你看不到与用户的完整聊天窗，所以下面已把任务背景完整交给你。')
  parts.push('不要反问"对话历史在哪"——背景就在本提示里。')
  parts.push('')

  // ── 自我认知（让 Worker 知道自己所在的项目与团队）──
  //   修复实测问题：用户问「团队有谁」「Lucky agent 是什么」时，
  //   Worker 因为 prompt 里没有任何自我描述而答不上来 / 说"没听过"。
  try {
    parts.push(buildSelfKnowledgeBlock(ctx.to, { compact: true }))
    parts.push('')
  } catch { /* 自我认知构建失败不影响委托 */ }

  // ── 任务目标 ──
  parts.push('## 🎯 任务目标')
  parts.push(`${(ctx.taskGoal || ctx.task).slice(0, 4000)}`)
  parts.push('')

  // ── 本次要执行的具体任务 ──
  parts.push('(')
  parts.push(`## 📝 具体任务`)
  parts.push(`任务类型: ${ctx.taskType}`)
  parts.push(ctx.task)
  parts.push('')

  // ── 对话上下文 ──
  const historyText = renderConversationHistory(ctx.conversationHistory)
  parts.push('## 💬 对话上下文（来龙去脉）')
  if (historyText) {
    parts.push(historyText)
  } else if (ctx.legacyContext) {
    parts.push(ctx.legacyContext.slice(0, 2000))
  } else {
    parts.push('（本轮无额外对话历史——直接完成任务即可）')
  }
  parts.push('')

  // ── 可用工具 ──
  parts.push('## 🛠 你可以使用的工具')
  if (ctx.availableTools && ctx.availableTools.length > 0) {
    parts.push(ctx.availableTools.map((t) => `- ${t}`).join('\n'))
  } else {
    parts.push('（工具列表由运行环境自动注册，你可在需要时调用读文件/写文件/执行命令等工具）')
  }
  parts.push('')

  // ── 项目上下文 ──
  parts.push('## 📂 项目上下文')
  if (ctx.projectContext?.cwd) {
    parts.push(`- 项目根目录: ${ctx.projectContext.cwd}`)
  }
  if (ctx.projectContext?.techStack) {
    parts.push(`- 技术栈: ${ctx.projectContext.techStack}`)
  }
  if (ctx.projectContext?.relevantFiles && ctx.projectContext.relevantFiles.length > 0) {
    parts.push('- 相关文件:')
    ctx.projectContext.relevantFiles.forEach((f) => parts.push(`  - ${f}`))
  }
  parts.push('')

  // ── 执行铁则（编程任务） ──
  parts.push('## ⚙️ 执行铁则')
  parts.push('① 先读文件/跑命令确认现状，不要假设')
  parts.push('② 改代码顺序固定为：file_read → file_edit → shell_exec 验证（如 tsc --noEmit / 跑测试）')
  parts.push('③ 报错就读报错、定位行号、最小改动修复；最多自我修复 3 轮')
  parts.push('④ 3 轮仍修不好就停下来，明确报告卡在哪、需要 Lumina 提供什么，不要硬凑')
  parts.push('⑤ 只改必须改的，完成后说明：改了哪些文件、验证命令结果如何')
  parts.push('⑥ 需要用户确认时用 [QUESTION]你的问题[/QUESTION] 标记')
  parts.push('')
  parts.push('直接干活，不要寒暄。')

  return parts.join('\n')
}

/**
 * 构建发给 Worker 的首轮用户消息。
 * 之前这里只传 `[from→to] 前50字`，导致 Worker 根本看不到完整任务——
 * 现在传完整任务，并复述任务目标作为锚点。
 */
export function buildWorkerFirstMessage(ctx: WorkerPromptContext): string {
  const parts: string[] = []
  parts.push(`【${fromLabel(ctx.from)} 委托 ${fromLabel(ctx.to)}】`)
  if (ctx.taskGoal && ctx.taskGoal !== ctx.task) {
    parts.push(`任务目标: ${ctx.taskGoal}`)
    parts.push('')
  }
  parts.push(ctx.task)
  return parts.join('\n')
}
