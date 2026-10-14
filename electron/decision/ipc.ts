// ============================================================
// decision/ipc.ts — 决策三栏的 IPC 与斜杠命令注册函数 (v1.0)
//
// 本文件不直接改任何共享文件，只导出两个注册函数，由集成阶段统一接线：
//   · registerDecisionIpc()      —— 挂 decision:* 频道
//   · registerDecisionCommand()  —— 给出 /decide 命令的注册信息与处理器
//
// ═══════════════ 集成接线位置（精确） ═══════════════
//
// 【1】斜杠命令定义：electron/chatCommands.ts
//   在 COMMANDS 数组末尾（现最后一项是 'retry'，约 :225）追加：
//     {
//       name: 'decide',
//       aliases: ['决定', '定'],
//       description: '生活决策三栏辩论：执行者拆可行性、审查员挑风险、我给最终建议',
//       usage: '/decide <问题，如：买电动车还是油车>',
//       minArgs: 1,
//       requiresAgent: true,
//     },
//
// 【2】斜杠命令处理器：electron/ipc/commandIpc.ts
//   在 registerCommandHandlers() 内（现 router.register('lumina', ...) 约 :212 之后）追加：
//     import { buildDecisionCommandHandler } from '../decision/ipc'
//     const decide = buildDecisionCommandHandler()
//     router.register(decide.name, decide.handler)
//   （或直接调用 registerDecisionCommand() 拿到同一对象后自行 register。）
//
// 【3】IPC 注册：electron/main.ts
//   在 registerCommandHandlers() 被调用的同一区域（main.ts:151 import 之后的调用处）追加：
//     import { registerDecisionIpc } from './decision/ipc'
//     registerDecisionIpc()
//
// 【4】渲染层挂载：src/panels/ChatPanel.tsx
//   在 assistant 消息渲染处（约 :2036 `{msg.role === 'assistant' && (` 这一块）追加：
//     {msg.debateResult && <DecisionDebateCard result={msg.debateResult} />}
//   其中 debateResult 由消息流水线在收到 decision:run 返回后挂到 assistant 消息上。
//
// 【5】（可选）Lumina 综合接真 LLM：
//   registerDecisionIpc 里 runDecisionDebate 的第三个参数，
//   替换 createDefaultDecisionDeps() 的返回，补一个 luminaSynthesize 字段即可。
// ============================================================

import { ipcMain } from 'electron'
import {
  runDecisionDebate,
  createDefaultDecisionDeps,
  parseDecisionInvoke,
  type DecisionDebateResult,
} from './decisionDebate'

/**
 * 注册 decision:* IPC 频道。
 * 频道约定：decision: 前缀。
 *   decision:run     (question: string, options?: string[]) => DecisionDebateResult
 *   decision:parse   (text: string) => DecisionInvoke   （供渲染层预判断是否触发）
 */
export function registerDecisionIpc(): void {
  ipcMain.handle(
    'decision:run',
    async (_event, payload: { question?: string; options?: string[] }): Promise<DecisionDebateResult> => {
      const question = (payload?.question || '').trim()
      if (!question) {
        // 空问题不派活：三栏都空跑一遍是纯浪费预算
        return {
          question: '',
          options: payload?.options ?? [],
          columns: {
            yak: { title: '可行性与利弊', body: '', status: 'missing', raw: '' },
            recha: { title: '风险与反对', body: '', status: 'missing', raw: '' },
          },
          lumina: {
            summary: '',
            recommendation: '你还没说要决定什么。把问题补上，我再叫大家一起议。',
            status: 'template',
            source: 'template',
          },
          meta: { durationMs: 0, degradedReasons: ['empty_question'] },
        }
      }
      // 默认依赖 = 走 delegationManager.delegate('lumina', ...)，预算记账/深度闸自然生效
      return runDecisionDebate(question, payload?.options ?? [], createDefaultDecisionDeps())
    },
  )

  ipcMain.handle('decision:parse', async (_event, text: string) => {
    return parseDecisionInvoke(typeof text === 'string' ? text : '')
  })
}

/**
 * 给现有命令链路（CommandRouter）提供 /decide 的注册信息。
 * 集成方只需把 handler 注册进 router（见文件头注释【2】）。
 *
 * 返回的 CommandHandler 与 chatCommands.ts 的 CommandHandler 形状对齐：
 *   (parsed: ParsedCommand) => Promise<CommandResult>
 * 这里用结构化返回，避免 import 被本文件约束。
 */
export function registerDecisionCommand(): {
  name: string
  aliases: string[]
  description: string
  usage: string
  handler: (args: string[]) => Promise<{ success: boolean; message: string; data?: DecisionDebateResult }>
} {
  return {
    name: 'decide',
    aliases: ['决定', '定'],
    description: '生活决策三栏辩论：执行者拆可行性、审查员挑风险、Lumina 给最终建议',
    usage: '/decide <问题>',
    handler: async (args: string[]) => {
      const question = (args || []).join(' ').trim()
      if (!question) {
        return { success: false, message: '用法：/decide <你要决定的问题>' }
      }
      const result = await runDecisionDebate(question, [], createDefaultDecisionDeps())
      // message/content 给文本兜底（渲染层 command 分支读 result.content）；
      // debateResult 给渲染层挂 DecisionDebateCard；data 保留原始契约。
      const text = `${result.lumina.summary}\n\n我的建议：${result.lumina.recommendation}`
      return {
        success: true,
        message: text,
        content: text,
        data: result,
        debateResult: result,
      }
    },
  }
}

/**
 * CommandRouter.register 需要的 (parsed) => Promise<CommandResult> 形态。
 * 集成时可直接：router.register(decide.name, buildDecisionCommandHandler())
 */
export function buildDecisionCommandHandler(): (parsed: { args: string[] }) => Promise<{
  success: boolean
  message: string
  content?: string
  data?: DecisionDebateResult
  debateResult?: DecisionDebateResult
}> {
  const binding = registerDecisionCommand()
  return async (parsed: { args: string[] }) => binding.handler(parsed.args)
}
