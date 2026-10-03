// ============================================================
// tools/impl/askDecision.ts — 「向用户征询决策」工具 (v1.0)
//
// 给 agent 的一个提问出口。命中后渲染进程会弹出结构化决策卡片
// （N 个选项 + 自由输入），用户的选择作为 tool result 回传给 agent。
//
// 【什么时候该用这个工具】
// 判据：**不同选择会导致显著不同的结果，且用户意图无法从上下文推断**。
//   ✓ 数据库选型 / 要不要做破坏性操作 / 用哪个方案 / 是否继续某方向
//   ✗ 工具怎么调、先读哪个文件 —— 这类自己定就行，问了反而烦人
//
// 【与审批的区别】
// 审批（approvalService）问的是「我可以做 X 吗」，不答就拦下。
// 本工具问的是「你想走哪条路」，不答就走默认，**不阻塞**。
//
// 【最重要的约束：不能滥用】
// 一个每句话都问的 agent 是灾难。因此：
//   1. 同一轮 ReAct 循环内的提问次数受限（见 decisionService 的 maxPending）
//   2. 没有 UI 界面时直接返回默认，agent 照常干活
//   3. 超时按默认选项继续，绝不无限等待
// ============================================================

import type { ToolDef, ToolResult } from '../types'
import { askDecision } from '../../decisionService'
import { getCurrentPersona } from '../agentRunContext'

export const askDecisionDef: ToolDef = {
  name: 'ask_decision',
  description:
    '向用户征询决策并等待回答。当任务出现「走哪条路」的分叉点、且不同选择会导致显著不同的结果时使用。' +
    '会弹出一张卡片，用户可以点选项，也可以直接输入自己的答案。' +
    '不要滥用：工具怎么调、先读哪个文件这类执行细节自己决定，不要问。' +
    '用户可能不回答（超时/关窗/没看），此时会按推荐项继续，所以必须保证「不回答也能推进」。',
  category: 'collaboration',
  toolsets: ['agent', 'developer', 'team'],
  parameters: {
    type: 'object',
    properties: {
      question: {
        type: 'string',
        description: '要问用户什么。一句话说清分叉点，不要写成开放题。',
      },
      context: {
        type: 'string',
        description: '可选：为什么需要你拍板（背景、已做的调研、你的倾向）。',
      },
      options: {
        type: 'array',
        description: '给用户的可选项，建议 2-5 个。最多 8 个。',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: '选项标识，可省略，省略时由 label 派生' },
            label: { type: 'string', description: '选项主文案，尽量短（20 字内）' },
            description: { type: 'string', description: '选项说明，说清代价/适用场景' },
            recommended: { type: 'boolean', description: '是否推荐。最多只能有一个' },
          },
          required: ['label'],
        },
      },
      multiSelect: {
        type: 'boolean',
        description: '是否允许多选。默认 false。',
      },
      allowCustomAnswer: {
        type: 'boolean',
        description: '是否允许用户不选、直接输入自己的答案。默认 true。',
      },
      customPlaceholder: {
        type: 'string',
        description: '自定义输入框的占位提示，可选。',
      },
      timeoutMs: {
        type: 'number',
        description: '等待超时毫秒。默认 300000（5 分钟）。超时按推荐项继续。',
      },
    },
    required: ['question', 'options'],
  },
}

export async function askDecisionTool(args: Record<string, any>): Promise<ToolResult> {
  const start = Date.now()
  const callId = args.__callId || ''

  // 拿到「是谁在问」——子智能体派生时也能正确标注
  let askedBy: 'lumina' | 'yak' | 'recha' = 'lumina'
  try {
    const p = getCurrentPersona()
    if (p === 'yak' || p === 'recha') {askedBy = p}
  } catch { /* ignore */ }

  let result
  try {
    result = await askDecision({
      askedBy,
      sessionId: args.__sessionId,
      question: String(args.question ?? ''),
      context: args.context,
      options: Array.isArray(args.options) ? args.options : [],
      multiSelect: args.multiSelect === true,
      allowCustomAnswer: args.allowCustomAnswer !== false,
      customPlaceholder: args.customPlaceholder,
      timeoutMs: args.timeoutMs,
    })
  } catch (err: any) {
    // 这一层是最后一道保险：决策系统本身出错，也绝不能把 agent 带崩
    return {
      callId,
      ok: true, // 仍然算成功：agent 拿到了「没问到」这个信息，可以自己决定
      content: `向用户征询决策时出错（${err?.message || String(err)}）。请自行决定并继续，不要重试。`,
      durationMs: Date.now() - start,
    }
  }

  const lines: string[] = [result.summary]

  // 把结构化结果也带上，方便模型在多轮里回溯
  if (result.answer && !result.answer.cancelled) {
    if (result.answer.selectedIds.length) {
      lines.push(`（选项 id：${result.answer.selectedIds.join(', ')}）`)
    }
    if (result.answer.customText) {
      lines.push(`（用户原话：${result.answer.customText}）`)
    }
  }
  if (result.status === 'timeout') {
    lines.push('注意：用户没有实际回答，以上是默认选择。如果你认为默认值不合适，请说明并给出你的建议。')
  }
  if (result.status === 'cancelled') {
    lines.push('不要执行原方案。先向用户说明情况，并询问替代方向。')
  }

  return {
    callId,
    ok: true,
    content: lines.join('\n'),
    durationMs: Date.now() - start,
  }
}
