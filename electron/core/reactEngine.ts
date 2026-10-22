// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// reactEngine.ts — 独立 ReAct 循环引擎
//
// 从 agentRunner.ts 提取：管理 ReAct 循环、工具调用执行、
// 错误恢复、自动继续（auto-continue）、后处理。
// ============================================================

import type { ToolResult } from '../tools/types'
import { executeToolWithRetry, executeToolsParallel, groupParallelBatches, buildNotExecutedResult } from '../tools/registry'
import { isToolAllowedForRole, type PermissionVerdict } from '../rolePolicy'

import { getSecurityGuard, GuardSeverity } from '../securityGuard'
import { parseXmlToolCalls } from '../llm/xmlToolCall'
import { getApprovalService } from '../approvalService'
import { getPermissionStore } from '../permission/permissionStore'
import { decide as decidePermission, type PermissionDecision } from '../permission/permissionTier'
import { getHookManager } from '../hooks/hookManager'
import { getDiagnosticsStore } from '../ipc/diagnosticsIpc'

// ═══════════════════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════════════════

export interface ReactConfig {
  maxToolCalls: number
  personaId?: string
  sessionId: string
  socialMode?: boolean
  skipApproval?: boolean
  // 用于 HookContext 兼容
  model?: string
  baseUrl?: string
  apiKey?: string
  mode?: string
}

export interface ReactMessage {
  role: string
  content: string
  name?: string
  tool_calls?: Array<{
    id: string
    type: string
    function: { name: string; arguments: string }
  }>
  tool_call_id?: string
}

export interface ReactEmitCallbacks {
  onThinking?: (text: string) => void
  onThinkingStream?: (text: string, isFirst: boolean, isLast: boolean) => void
  onToolStart?: (tool: string, args: any) => void
  onToolEnd?: (tool: string, result: any) => void
  onError?: (error: string) => void
  onTokenUpdate?: (totalTokens: number, usage: any, delta: number) => void
}

export interface LLMResponse {
  text?: string
  error?: string
  aborted?: boolean
  toolCalls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
}

export type LLMCaller = (
  messages: ReactMessage[],
  tools: any[],
) => Promise<LLMResponse>

// ═══════════════════════════════════════════════════════════
// ReActEngine
// ═══════════════════════════════════════════════════════════

export interface ReactResult {
  text: string
  error?: string
  /**
   * 空回复时给出**可读的原因**（哪个工具名未注册 / 参数解析失败 / 连续空内容）。
   * 以前这个信息在链路上被完全丢弃，导致用户只能看到一句
   * 「这轮我没能给出有效回复」而无法反馈任何有用信息。
   */
  reason?: string
}

// ── v12.1-fix: XML 工具调用检测与清理 ──
// 某些 LLM 不通过标准 OpenAI function calling API，而是在文本中输出
// <tool_call><web_search>...</web_search></tool_call> 格式的 XML。
// 这些应该被剥离，不被当作最终回复展示给用户。
//
// 覆盖两种常见格式：
//   格式A: <tool_call><function=web_search><parameter=query>xxx</parameter></function></tool_call>
//   格式B: <tool_call><web_search>\nquery="xxx"\nmax_results=10\n</web_search></tool_call>
//   格式C: <tool_call>\n<web_search>\nquery="xxx"\n</web_search>\n</tool_call>

/** 检测文本是否包含 XML 格式的工具调用 */
function hasXmlToolCall(text: string): boolean {
  return (
    /<tool_call>[\s\S]*?<\/tool_call>/i.test(text) ||       // 标准闭合风格
    /<tool_call>[\s\S]*$/i.test(text) ||                    // [fix] 未闭合 <tool_call>（到文本结尾）
    /<\w+\s*\([^)]*\)/i.test(text) ||                       // [fix] 括号参数风格 <tool(...)>
    // 增加更多 LLM 输出格式兜底
    /<function_calls>[\s\S]*?<\/function_calls>/i.test(text) ||  // Groq/Mistral 风格
    /<invoke>[\s\S]*?<\/invoke>/i.test(text) ||                   // Anthropic 风格
    /```tool_code[\s\S]*?```/i.test(text)                         // 代码块包裹的工具调用
  )
}

/** 清理文本中的 XML 工具调用标记 */
function cleanXmlToolCalls(text: string): string {
  if (!text) {return text}
  const cleaned = text
    .replace(/<tool_call>[\s\S]*?<\/tool_call>\s*/gi, '')  // 移除完整 <tool_call> 块
    .replace(/<tool_call>\s*/gi, '')                       // [fix] 容错未闭合 <tool_call> 开标签（仅删标签，保留正文）
    .replace(/<\w+\s*\([^)]*\)\s*>\s*/gi, '')              // [fix] 容错 <tool(...)> 括号参数风格（含可选 >）
    .replace(/<web_search>[\s\S]*?<\/web_search>\s*/gi, '') // 移除残留 <web_search> 块
    .replace(/<function=\w+>[\s\S]*?<\/function>\s*/gi, '') // 移除 <function=xxx> 块
    .replace(/<parameter=\w+>[\s\S]*?<\/parameter>\s*/gi, '') // 移除 <parameter=xxx> 块
    .replace(/<tool_name>[\s\S]*?<\/tool_name>\s*/gi, '')   // 🔧 v13.5: 移除 <tool_name> 块
    .replace(/<tool_args>[\s\S]*?<\/tool_args>\s*/gi, '')   // 🔧 v13.5: 移除 <tool_args> 块
    .trim()

  // 🔧 P0 修复（真实故障）
  //   旧实现：「不再回退为原文」→ 整段是纯工具标记时直接返回空串。
  //   调用方 tryExecuteXmlToolCall 成功后拿到的 replyText 为空，
  //   接着走「空回复」分支 → 连续空回复 → 用户看到「暂时无法生成有效回复」。
  //   典型触发：模型想调工具但该轮没有可用工具（chat 模式 / 情绪门控收紧到 0）。
  //
  //   现在：整段被删光时返回一句诚实说明。
  //   既不吐 XML 噪音，也不让内容凭空消失——内容消失是最难排查的失败。
  if (!cleaned && text.trim()) {
    return '（我这轮只输出了工具调用标记，没能给出实际内容。你可以让我再说一次。）'
  }
  return cleaned
}

/** 角色硬闸门：被拒时返回一个「未执行」失败结果；放行返回 null */
function checkRoleGate(personaId: string | undefined, toolName: string): ToolResult | null {
  const verdict: PermissionVerdict = isToolAllowedForRole(personaId, toolName)
  if (verdict.allowed) {return null}
  console.warn(`[ReActEngine] ⛔ 角色硬闸门拦截: role=${personaId || 'lumina'} tool=${toolName} -> ${verdict.reason}`)
  return buildNotExecutedResult(
    `该角色无权使用此工具（${personaId || 'lumina'} / ${toolName}）`,
    verdict.reason,
  )
}

/** 尝试解析和执行 XML 工具调用，返回是否成功处理 */
async function tryExecuteXmlToolCall(
  text: string,
  messages: ReactMessage[],
  emit?: ReactEmitCallbacks,
  personaId?: string,
): Promise<boolean> {
  // 格式B/C: <tool_call>\n<web_search>\nquery="xxx"\nmax_results=10\n</web_search>\n</tool_call>
  let match = text.match(/<tool_call>[\s\S]*?<(\w+)>([\s\S]*?)<\/\1>[\s\S]*?<\/tool_call>/i)
  // [fix] 括号参数风格兜底：<web_search(query="...", engine="...")>（兼容未闭合）
  if (!match) {
    const paren = text.match(/<tool_call>[\s\S]*?<(\w+)\s*\(([^)]*)\)/i) || text.match(/<(\w+)\s*\(([^)]*)\)/i)
    if (paren) {match = paren as any}
  }
  // 增加 JSON 参数格式兜底：<tool_call><tool_name>xxx</tool_name><tool_args>JSON</tool_args></tool_call>
  if (!match) {
    const jsonMatch = text.match(/<tool_call>\s*<tool_name>(\w+)<\/tool_name>\s*<tool_args>(.*?)<\/tool_args>\s*<\/tool_call>/is)
    if (jsonMatch) {
      const fnName = jsonMatch[1]
      const rawArgs = jsonMatch[2].trim()
      let args: Record<string, any> = {}
      try { args = JSON.parse(rawArgs) } catch { /* 非 JSON，跳过 */ }
      if (Object.keys(args).length > 0) {
        console.log(`[ReActEngine] 🔄 检测到 JSON 参数工具调用: ${fnName}(${rawArgs})，尝试执行...`)
        try {
          const gate = checkRoleGate(personaId, fnName)
          if (gate) {
            emit?.onToolStart?.(fnName, args)
            emit?.onToolEnd?.(fnName, gate)
            messages.push({ role: 'system', content: `【${fnName} 结果】\n错误: ${gate.error}` })
            return true
          }
          emit?.onToolStart?.(fnName, args)
          const result = await executeToolWithRetry(fnName, args).catch((e) => ({
            callId: '', ok: false, content: '', error: e.message,
          }))
          emit?.onToolEnd?.(fnName, result)
          const resultContent = result.ok
            ? (result.content?.slice(0, 3000) || '（无返回内容）')
            : `错误: ${result.error}`
          messages.push({ role: 'system', content: `【${fnName} 结果】\n${resultContent}` })
          console.log(`[ReActEngine] ✅ JSON 工具 ${fnName} 执行完成 (${resultContent.length} 字符)`)
          return true
        } catch (err: any) {
          console.warn(`[ReActEngine] ⚠️ JSON 工具 ${fnName} 执行失败:`, err.message)
          return false
        }
      }
    }
  }
  // fix: 支持截图中出现的 <tool_call><tool_calls>[{"name":"web_search",...}]</tool_calls></tool_call>
  if (!match) {
    const nestedJsonMatch = text.match(/<tool_call>\s*<tool_calls>\s*([\s\S]*?)\s*<\/tool_calls>\s*<\/tool_call>/is)
    if (nestedJsonMatch) {
      const rawJson = nestedJsonMatch[1].trim()
      let calls: any[] = []
      try {
        const parsed = JSON.parse(rawJson)
        calls = Array.isArray(parsed) ? parsed : [parsed]
      } catch {
        // 尝试匹配单个大括号对象
        const singleObj = rawJson.match(/\{[\s\S]*\}/)
        if (singleObj) {
          try {
            calls = [JSON.parse(singleObj[0])]
          } catch { /* ignore */ }
        }
      }
      if (calls.length > 0) {
        const call = calls[0]
        const fnName = call?.name || call?.function?.name
        const args = call?.arguments || call?.function?.arguments || call?.parameters || {}
        if (fnName && typeof fnName === 'string') {
          console.log(`[ReActEngine] 🔄 检测到嵌套 JSON 工具调用: ${fnName}(${JSON.stringify(args)})，尝试执行...`)
          try {
            const gate = checkRoleGate(personaId, fnName)
            if (gate) {
              emit?.onToolStart?.(fnName, args)
              emit?.onToolEnd?.(fnName, gate)
              messages.push({ role: 'system', content: `【${fnName} 结果】\n错误: ${gate.error}` })
              return true
            }
            emit?.onToolStart?.(fnName, args)
            const result = await executeToolWithRetry(fnName, args).catch((e) => ({
              callId: '', ok: false, content: '', error: e.message,
            }))
            emit?.onToolEnd?.(fnName, result)
            const resultContent = result.ok
              ? (result.content?.slice(0, 3000) || '（无返回内容）')
              : `错误: ${result.error}`
            messages.push({ role: 'system', content: `【${fnName} 结果】\n${resultContent}` })
            console.log(`[ReActEngine] ✅ 嵌套 JSON 工具 ${fnName} 执行完成 (${resultContent.length} 字符)`)
            return true
          } catch (err: any) {
            console.warn(`[ReActEngine] ⚠️ 嵌套 JSON 工具 ${fnName} 执行失败:`, err.message)
            return false
          }
        }
      }
    }
  }
  if (!match) {return false}

  const toolName = match[1]     // e.g. "web_search"
  const paramsBlock = match[2]  // e.g. 'query="本周五 A 股"\nmax_results=10'

  // 解析 key="value" 或 key=value 格式的参数
  const args: Record<string, any> = {}
  const paramRegex = /(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/g
  let pm: RegExpExecArray | null
  while ((pm = paramRegex.exec(paramsBlock)) !== null) {
    args[pm[1]] = pm[2] ?? pm[3] ?? pm[4] ?? ''
  }
  // 处理 search_depth → 不传给 webSearch
  delete args.search_depth

  if (Object.keys(args).length === 0) {return false}

  console.log(`[ReActEngine] 🔄 检测到 XML 工具调用: ${toolName}(${JSON.stringify(args)})，尝试执行...`)

  try {
    const gate = checkRoleGate(personaId, toolName)
    if (gate) {
      emit?.onToolStart?.(toolName, args)
      emit?.onToolEnd?.(toolName, gate)
      messages.push({
        role: 'system',
        content: `【${toolName} 结果】\n错误: ${gate.error}`,
      })
      return true
    }
    emit?.onToolStart?.(toolName, args)
    const result = await executeToolWithRetry(toolName, args).catch((e) => ({
      callId: '',
      ok: false,
      content: '',
      error: e.message,
    }))
    emit?.onToolEnd?.(toolName, result)

    // 把工具结果作为 system message 注入
    const resultContent = result.ok
      ? (result.content?.slice(0, 3000) || '（无返回内容）')
      : `错误: ${result.error}`
    messages.push({
      role: 'system',
      content: `【${toolName} 结果】\n${resultContent}`,
    })
    console.log(`[ReActEngine] ✅ XML 工具 ${toolName} 执行完成 (${resultContent.length} 字符)`)
    return true
  } catch (err: any) {
    console.warn(`[ReActEngine] ⚠️ XML 工具 ${toolName} 执行失败:`, err.message)
    return false
  }
}

export class ReActEngine {
  private config: ReactConfig
  private callLLM: LLMCaller
  private emit?: ReactEmitCallbacks
  private abortController: AbortController | null = null

  /** 跟踪本轮是否已用过工具 */
  private toolsUsedThisRun = false
  /** 自动继续计数 */
  private autoContinueCount = 0
  /** 最近一次失败的诊断原因（跨 run 保留，便于上层取用） */
  public lastFailureReason = ''

  constructor(config: ReactConfig, callLLM: LLMCaller, emit?: ReactEmitCallbacks) {
    this.config = config
    this.callLLM = callLLM
    this.emit = emit
  }

  /** 更新回调 */
  updateEmit(emit: ReactEmitCallbacks): void {
    this.emit = emit
  }

  /** 注入中止控制器 */
  setAbortController(ac: AbortController): void {
    this.abortController = ac
  }

  /** 重置本轮状态 */
  resetRunState(): void {
    this.autoContinueCount = 0
    this.toolsUsedThisRun = false
  }

  // ═══════════════════════════════════════════════════════
  // 主循环
  // ═══════════════════════════════════════════════════════

  /**
   * 执行完整 ReAct 循环
   * @param messages  消息数组（会被修改）
   * @param tools     可用工具列表（OpenAI format）
   * @param totalTokens 外部累积的 token 计数器（会被更新）
   * @returns 最终回复文本
   */
  async run(
    messages: ReactMessage[],
    tools: any[],
    totalTokens: { value: number },
  ): Promise<ReactResult> {
    // 默认上限：30 轮（与 agentRunner 对齐）。
    // 早期版本默认 1_000_000 是真空洞：任何绕过 agentRunner 直连的调用方
    // 会拿到无上限循环，把"防 ReAct 死循环"承诺落空。agentRunner.ts:616
    // 固定传 30 仍保持优先；这里只兜住直连路径。
    const maxRounds = this.config.maxToolCalls ?? 30
    let finalText = ''
    let consecutiveEmptyCount = 0
    let shortReplyCount = 0      // 🆕 v11.0-fix: 短回复独立计数，不污染空回复计数器
    let slowThinkingRetries = 0
    let notFinalRetries = 0
    let slowSummarizeInjected = false
    /** 本轮会话里最后一次「XML 工具调用解析失败」的原因，供兜底文案自证清白 */
    let lastXmlDiagnostic = ''

    for (let round = 0; round < maxRounds; round++) {
      if (this.abortController?.signal.aborted) {break}

      this.emit?.onThinking?.(`思考中... (第 ${round + 1} 轮)`)

      try {
        const response = await this.callLLM(messages, tools)

        // 🆕 fix: 推理模型诊断日志
        console.log(`[ReActEngine] LLM响应: text=${(response.text||'').length}字, error=${response.error||'无'}, toolCalls=${response.toolCalls?.length||0}`)

        // token 用量更新
        const tokenUsage = this.estimateTokenUsage(response, messages)
        if (tokenUsage.total_tokens > 0) {
          totalTokens.value += tokenUsage.total_tokens
          this.emit?.onTokenUpdate?.(totalTokens.value, tokenUsage, tokenUsage.total_tokens)
        }

        // ── 错误处理 ──
        if (response.error) {
          if (response.aborted) {
            this.emit?.onError?.('用户中止')
            break
          }

          this.emit?.onError?.(response.error)

          const isTimeoutError =
            response.error.includes('超时') ||
            response.error.includes('AbortError') ||
            response.error.includes('ETIMEDOUT')

          if (isTimeoutError && messages.length > 1) {
            const isSlowThinking = response.error.includes('🐢')

            if (isSlowThinking && slowThinkingRetries < 2) {
              slowThinkingRetries++
              const slowMsg = '请继续你的回答，不要重复之前的内容。'
              messages.push({ role: 'user', content: slowMsg })
              this.emit?.onThinking?.('🔄 LLM 思考较慢，已注入"请继续"...')
              continue
            }

            if (notFinalRetries < 1 && finalText.length > 10) {
              notFinalRetries++
              messages.push({
                role: 'user',
                content:
                  '你的回复中包含了"这是最终回答"或"最终结论"等标记，请直接回复，不要使用标记。',
              })
              continue
            }

            if (finalText.length > 5) {
              this.emit?.onThinking?.('⚠️ 超时但已有部分回复，继续使用...')
              break
            }

            if (!slowSummarizeInjected) {
              slowSummarizeInjected = true
              messages.push({
                role: 'user',
                content:
                  '之前的对话太长，请简洁总结当前已知信息并继续。',
              })
              this.emit?.onThinking?.('🔄 压缩上下文后重试...')
              continue
            }

            this.emit?.onError?.('LLM 超时，请稍后重试')
            finalText = '抱歉，LLM 响应超时了。请稍后重试或换一个问题。'
            break
          }

          // 非超时错误
          const errMsg = response.error
          const shortErrMatch = errMsg.match(/LLM 返回 \d+:\s*(.+)/)
          let shortErr = ''
          if (shortErrMatch) {
            shortErr = shortErrMatch[1].slice(0, 150)
          } else {
            shortErr = errMsg.replace(/\{[^}]*\}/g, '').replace(/\s+/g, ' ').trim().slice(0, 150)
          }
          finalText = `抱歉，出了点问题: ${shortErr}。请稍后再试。`
          break
        }

        // ── 工具调用 ──
        if (response.toolCalls && response.toolCalls.length > 0) {
          this.toolsUsedThisRun = true
          this.autoContinueCount = 0

          const assistantMsg: ReactMessage = {
            role: 'assistant',
            content: response.text || '',
            tool_calls: response.toolCalls,
          }
          messages.push(assistantMsg)

          // 处理工具调用
          await this.executeToolCalls(response.toolCalls, messages)

          // Auto-continue: 完成工具后自动继续
          continue
        }

        // ── 纯文本回复 ──
        let replyText = (response.text || '').trim()

        // 检测 XML 工具调用标记
        //   某些 LLM 不通过 OpenAI function calling API，
        //   而是在文本中输出 <tool_call><web_search>...</web_search></tool_call>。
        //   检测到后：
        //     1. 尝试解析并执行工具
        //     2. 清理文本中的 XML 标记
        //     3. 如果工具执行成功，进入下一轮（带结果继续）
        //     4. 如果工具执行失败，只保留清理后的文本
        if (replyText && hasXmlToolCall(replyText)) {
          this.emit?.onThinking?.('🔄 检测到 XML 工具调用标记，尝试执行...')

          // 🩺 先用「唯一事实源」探一次，拿到解析诊断。
          //   tryExecuteXmlToolCall 是手写的老解析器，失败时只返回 false，
          //   不告诉你为什么。parseXmlToolCalls 会说明是哪个工具名没注册。
          //   不传白名单（宽容模式）—— 这里只用于诊断，执行路径另有白名单校验。
          const probe = parseXmlToolCalls(replyText)
          if (probe.hadToolCallIntent && probe.calls.length === 0 && !lastXmlDiagnostic) {
            lastXmlDiagnostic = probe.diagnostic || '工具调用格式无法识别'
          }

          const executed = await tryExecuteXmlToolCall(replyText, messages, this.emit, this.config.personaId)

          // 🐛 P0 修复：先把模型写的「人话」留底，再决定下一步。
          //
          // 旧实现在这里无条件 continue，而 finalText 只在下面的普通分支里赋值。
          // 于是出现这条链路：
          //   模型最后一轮只输出工具标签 + 几乎没有正文
          //   → executed=true → continue → finalText 从头到尾是 ''
          //   → 循环耗尽 → agentRunner 的兜底文案接管
          //   → 用户看到「这轮我没能给出有效回复（模型返回了无法识别的内容）」
          //
          // 而实际上模型**确实给了内容**（哪怕只有一句“我先查一下”），
          // 只是在清理工具标签时跟着被扔了。把清理后的正文写进 finalText，
          // 至少让用户看到「它想干什么”，而不是一句完全无法排查的道歉。
          const prose = cleanXmlToolCalls(replyText)

          if (executed) {
            if (prose) {
              finalText = prose
              messages.push({ role: 'assistant', content: prose })
            }
            // fix: XML 工具执行成功后，强制注入“请根据结果直接回答”指令
            messages.push({
              role: 'system',
              content: '工具已执行并返回结果。请直接根据结果回答用户，不要再说"我去查"或输出新的 XML 工具标签。',
            })
            continue
          }
          // 执行失败 → 至少清理标记
          replyText = prose
          if (!replyText) {continue} // 清空后跳到空回复处理
        }

        if (replyText) {
          finalText = replyText
          messages.push({ role: 'assistant', content: replyText })

          // v2.11: 连续空回复检测
          // 使用 shortReplyCount 独立计数，不污染空回复计数器
          if (replyText.length < 5) {
            shortReplyCount++
          } else {
            shortReplyCount = 0
          }

          // QwenPaw 风格 auto-continue
          // 使用 shortReplyCount（短回复独立计数），
          //   不再与 consecutiveEmptyCount 混用，避免短回复加速触发错误消息
          //
          // 新增意图句式检测 — 模型说"我来帮你查一下""让我先查一下"
          //   但未调工具时，识别为未完成，自动继续。
          //
          // isIntentOnly 时注入"请直接回答"消息，
          //   而非空转循环。空转时 LLM 看到相同上下文，只会继续重复意图句式。
          const intentAction = /^(我来|让我|我先|我去|让我来|我帮你|我给大家|我给你|我这就|马上|这就去|现在我来|现在让我)/
          const intentVerb = /查[一一下]?|看[一一看]?|搜索|检查|确认|问问|核实|分析|查查|看看|搜一搜/
          const hasResult = /\b(结果|结论|答案|资料|信息|数据|如下|找到|发现|查到|搜索到|获取到|根据|显示)\b/.test(replyText)
          const isIntentOnly = intentAction.test(replyText.trim()) && intentVerb.test(replyText) && !hasResult

          // 检查上下文中是否已有搜索结果
          //   v12.1-fix2: 现在由 preExecuteSearch 注入为 tool role 消息（模拟 tool_call + tool_result），
          //   不再是 system 消息。检测 tool role + 内容包含 '搜索结果' 或 '实时搜索'。
          //   同时检测 tool 角色或 system 角色中是否包含搜索结果标记词
          const hasSearchResult = messages.some(m =>
            (m.role === 'tool' || m.role === 'system' || m.role === 'assistant') &&
            (m.content?.includes('实时搜索') || m.content?.includes('搜索结果') || m.content?.includes('【实时搜索结果】'))
          )

          const needsContinue =
            this.toolsUsedThisRun ||
            (isIntentOnly && !hasSearchResult) ||  // v14.0-fix: 只有"意图句式 + 无搜索结果"才触发，避免误触
            replyText.includes('接下来我将') ||
            replyText.includes('让我继续') ||
            replyText.endsWith('...') ||
            replyText.endsWith('：') ||
            // v14.0-fix: 社交模式下不过度解读短回复（群聊中短回复是正常的）
            (!this.config?.socialMode && shortReplyCount > 0 && shortReplyCount < 3)

          if (needsContinue && this.autoContinueCount < 3) {
            this.autoContinueCount++
            // ── v12.1-fix: 给 LLM 明确的继续指令 ──
            //   之前只 continue 空转，LLM 看到相同上下文会继续输出意图句式。
            //   现在根据不同情况注入具体指令：
            if (isIntentOnly && hasSearchResult) {
              // 搜索结果已在上下文但 LLM 还在说"我来查"→ 直接要求归纳
              const hint = '搜索结果已经提供了。请直接根据搜索结果归纳回答用户问题，不要再说"我去查"，也不要输出 &lt;tool_call&gt; 等 XML 标记。'
              messages.push({ role: 'user', content: hint })
              this.emit?.onThinking?.(`🔄 检测到意图句式+已有搜索结果，已注入"直接归纳" (${this.autoContinueCount}/3)`)
            } else if (isIntentOnly) {
              // 没有搜索结果但 LLM 说"我去查"→ 引导输出 XML 工具调用
              const hint = '请直接输出 <web_search(query="你的搜索词")> 这样的 XML 标签来执行搜索，系统会自动搜索并返回结果给你。不要只是口头上说"我去查"，要实际输出 XML 工具调用标签。'
              messages.push({ role: 'user', content: hint })
              this.emit?.onThinking?.(`🔄 检测到意图句式，已注入"请直接回答" (${this.autoContinueCount}/3)`)
            } else {
              // 原有的自动继续（工具已调用、短回复等）— 提示继续
              const hint = this.autoContinueCount <= 1
                ? '请继续你的回答，给出实质内容。'
                : '请继续你的回答，不要重复之前的内容，给出最终答案。'
              if (this.config?.socialMode) {
                // 🆕 群聊模式：续话提示以 system 角色注入，避免被其他 agent 误读为"用户发言"（续话污染）
                messages.push({ role: 'system', content: '[内部续话指令·非用户发言] ' + hint })
              } else {
                messages.push({ role: 'user', content: hint })
              }
              this.emit?.onThinking?.(`🔄 自动继续 (${this.autoContinueCount}/3)`)
            }
            continue
          }

          break
        } else {
          // 空回复
          consecutiveEmptyCount++
          // 加详细日志，帮助诊断空回复原因
          // 每次空回复都打印，包括 response 完整结构
          console.warn(`[ReActEngine] ⚠️ 第${round+1}轮空回复（连续${consecutiveEmptyCount}次）` +
            ` text长度=${(response.text||'').length}` +
            ` toolCalls=${JSON.stringify(response.toolCalls?.map(t=>t.function.name))}` +
            ` error=${response.error||'无'}` +
            ` response.keys=${Object.keys(response).join(',')}` +
            ` persona=${this.config.personaId||'default'}` +
            ` socialMode=${this.config.socialMode}`)

          // ── v12.0 长期修复：空回复分级处理 ──
          //   不再简单地在 3 次后放弃，而是逐步升级干预策略
          if (consecutiveEmptyCount >= 1 && consecutiveEmptyCount < 3) {
            // 第 1-2 次空回复：注入简短提示让模型继续
            const hint = '请继续你的回复，给出内容。'
            if (this.config?.socialMode) {
              // 🆕 群聊模式：续话提示以 system 角色注入，避免被其他 agent 误读为"用户发言"（续话污染）
              messages.push({ role: 'system', content: '[内部续话指令·非用户发言] ' + hint })
            } else {
              messages.push({ role: 'user', content: hint })
            }
            this.emit?.onThinking?.(`🔄 空回复，注入提示...`)
            continue
          }

          if (consecutiveEmptyCount === 3) {
            // 第 3 次空回复：去除系统提示中的工具定义，可能是工具定义混淆了模型
            console.warn(`[ReActEngine] 🔧 第3次空回复，尝试去除工具定义后重试`)
            const sysIdx = messages.findIndex(m => m.role === 'system')
            if (sysIdx >= 0) {
              // 在系统消息末尾附加强调
              messages[sysIdx] = {
                ...messages[sysIdx],
                content: (messages[sysIdx].content || '') +
                  '\n\n【重要】请直接用自然语言给出你的回答，不要输出工具调用或系统指令相关内容。',
              }
            } else {
              messages.push({
                role: 'system',
                content: '请用自然语言给出你的回答，不要输出工具调用。',
              })
            }
            continue
          }

          if (consecutiveEmptyCount === 4) {
            // 第 4 次空回复：简化上下文，去除工具消息，只保留最近3轮对话
            console.warn(`[ReActEngine] 🔧 第4次空回复，简化上下文后重试`)
            const systemMsgs = messages.filter(m => m.role === 'system')
            const recentMsgs = messages
              .filter(m => m.role !== 'system')
              .slice(-6)  // 只保留最近 3 轮 (user+assistant)
            messages = [
              ...systemMsgs,
              ...recentMsgs,
              { role: 'user', content: '请用自然语言回复。' },
            ]
            continue
          }

          // 第 5+ 次空回复：模型可能确实有问题，返回空让上层（agentRunner）做完整恢复
          console.error(`[ReActEngine] ❌ 连续 ${consecutiveEmptyCount} 次空回复，放弃。` +
            ` persona=${this.config.personaId || 'default'}` +
            ` socialMode=${this.config.socialMode}` +
            ` messages总数=${messages.length}` +
            ` xml诊断=${lastXmlDiagnostic || '无'}` +
            ` 最后user消息="${(messages.filter(m=>m.role==='user').pop()?.content||'').slice(0,80)}"`)

          // 🩺 把「为什么空」带上去，而不是只丢一个空串。
          //   上层（agentRunner）的兜底文案会原样展示这段 reason ——
          //   用户下次截图反馈时就能直接看出是工具名不认识、参数解析不了、
          //   还是模型压根没吐正文，再也不用翻 DevTools。
          finalText = ''
          this.lastFailureReason = lastXmlDiagnostic
            || (this.config.model ? `模型 ${this.config.model} 连续 ${consecutiveEmptyCount} 次返回空内容` : `连续 ${consecutiveEmptyCount} 次返回空内容`)
          break
        }
      } catch (err: any) {
        console.error('[ReActEngine] 循环异常:', err)
        this.emit?.onError?.(err.message || String(err))
        finalText = `抱歉，处理时出了点问题。请稍后重试。`
        break
      }
    }

    return { text: finalText, reason: this.lastFailureReason }
  }

  // ═══════════════════════════════════════════════════════
  // 🔒 权限档位裁决
  // ═══════════════════════════════════════════════════════

  /**
   * 三档权限的唯一执行点。单发与并行两条路径都走这里 —— 只要有一处漏掉，
   * 「仅可查看」就能被多工具并行绕过。
   *
   * 返回 null = 放行；否则返回一段给 LLM 看的中文说明（让它知道为什么被拒，
   * 而不是默默失败 —— 模型需要这个信息才能换条路走）。
   */
  private checkPermission(
    toolName: string,
    args: Record<string, unknown>,
  ): { decision: PermissionDecision; message: string; approvalId?: string } | null {
    const store = getPermissionStore()
    const st = store.get()

    // 安全兜底：档位数据被写坏时，绝不能默默退到「完全权限」
    const decision = decidePermission({
      tier: st.tier,
      workspaceRoot: store.effectiveWorkspaceRoot(),
      trustedDirs: store.effectiveTrustedDirs(),
      args,
      command: typeof args.command === 'string' ? args.command : undefined,
      toolName,
      agentId: this.config.personaId,
    })

    if (decision.action === 'allow') {return null}

    if (decision.action === 'deny') {
      return { decision, message: `🔒 权限拦截（${decision.category}）: ${decision.reason}` }
    }

    // ask：走既有审批流，行为与安全审查保持一致（/approve <id>）
    if (this.config.skipApproval) {
      // CLI / headless 场景没有人类审批者：默认放行中风险，
      // 高风险仍然拒 —— 不能因为「没人点确认」就等于「全放行」
      if (decision.risk === 'high') {
        return { decision, message: `🔒 无人审批环境，已拒绝高风险操作: ${decision.reason}` }
      }
      return null
    }
    const req = getApprovalService().requestApproval({
      sessionId: this.config.sessionId,
      agentId: this.config.personaId || 'default',
      toolName,
      toolArgs: args as Record<string, never>,
      description: `${toolName}: ${JSON.stringify(args).slice(0, 100)}`,
      riskLevel: decision.risk as 'medium' | 'high' | 'critical',
      threatCategories: [decision.category],
      securityFindings: [decision.reason],
    })
    if (req) {
      return {
        decision,
        approvalId: req.id,
        message:
          `🔐 权限档位要求确认（${decision.reason}）\n` +
          `请回复 /approve ${req.id} 批准，或 /deny ${req.id} 拒绝。\n` +
          `不想每次确认？到发送栏右侧的权限选择器切成「完全权限」。`,
      }
    }
    return null
  }

  // ═══════════════════════════════════════════════════════
  // 工具执行
  // ═══════════════════════════════════════════════════════

  /**
   * 同回合工具调用去重键：工具名 + 规范化后的参数。
   * 规范化规则：丢弃空字符串 / null / undefined / 空数组（如 calendar_list
   * 的 `query:""` 与缺省视为同一调用），键内字段按字典序排序，保证
   * `{days:2}` 与 `{days:2,query:""}` 归为同一键。用于在单次 LLM 响应内
   * 拦截"参数几乎一致"的重复工具调用，省 token、省时间。
   */
  private toolDedupKey(name: string, args: Record<string, any>): string {
    const cleaned: Record<string, any> = {}
    for (const [k, v] of Object.entries(args || {})) {
      if (v === '' || v === null || v === undefined) { continue }
      if (Array.isArray(v) && v.length === 0) { continue }
      cleaned[k] = v
    }
    const sorted = Object.keys(cleaned).sort().reduce((o, k) => { o[k] = cleaned[k]; return o }, {} as Record<string, any>)
    return `${name}::${JSON.stringify(sorted)}`
  }

  private async executeToolCalls(
    toolCalls: LLMResponse['toolCalls'],
    messages: ReactMessage[],
  ): Promise<void> {
    if (!toolCalls) {return}

    // 🔁 同回合去重：记录本 LLM 响应内已执行的「工具名+参数」，重复调用跳过
    const seenThisTurn = new Set<string>()

    if (toolCalls.length === 1) {
      const tc = toolCalls[0]
      const fn = tc.function
      let args: Record<string, any> = {}
      try { args = JSON.parse(fn.arguments) } catch {}

      // 安全检查
      const guardResult = getSecurityGuard().checkToolCall(tc)
      if (!guardResult.allowed) {
        messages.push({
          role: 'tool',
          content: `⛔ 安全审查阻止: ${guardResult.summary}`,
          tool_call_id: tc.id,
        })
        return
      }

      if (guardResult.requiresApproval && !this.config.skipApproval) {
        const approvalReq = getApprovalService().requestApproval({
          sessionId: this.config.sessionId,
          agentId: this.config.personaId || 'default',
          toolName: fn.name,
          toolArgs: args,
          description: `${fn.name}: ${JSON.stringify(args).slice(0, 100)}`,
          riskLevel:
            guardResult.severity === GuardSeverity.CRITICAL
              ? 'critical'
              : guardResult.severity === GuardSeverity.HIGH
                ? 'high'
                : 'medium',
          threatCategories: guardResult.findings.map((f: any) => f.category),
          securityFindings: guardResult.findings.map((f: any) => f.title),
        })

        if (approvalReq) {
          messages.push({
            role: 'tool',
            content: `🔐 需要审批才能执行 "${fn.name}"。审批ID: \`${approvalReq.id}\`\n请回复 /approve ${approvalReq.id} 批准，或 /deny ${approvalReq.id} 拒绝。\n\n风险: ${guardResult.summary}`,
            tool_call_id: tc.id,
          })
          return
        }
      }

      // 🔒 权限档位（安全审查之后、角色闸门之前）
      const perm = this.checkPermission(fn.name, args)
      if (perm) {
        this.emit?.onToolStart?.(fn.name, args)
        this.emit?.onToolEnd?.(fn.name, { ok: false, content: '', error: perm.message })
        messages.push({ role: 'tool', content: perm.message, tool_call_id: tc.id })
        return
      }

      // 角色硬闸门（执行层）：无权工具不调用 registry，直接回 ok:false 失败信号
      const gate = checkRoleGate(this.config.personaId, fn.name)
      if (gate) {
        this.emit?.onToolStart?.(fn.name, args)
        this.emit?.onToolEnd?.(fn.name, gate)
        messages.push({
          role: 'tool',
          content: gate.ok ? (gate.content || '') : `工具错误: ${gate.error || '无权调用'}`,
          tool_call_id: tc.id,
        })
        return
      }

      this.emit?.onToolStart?.(fn.name, args)

      const hookCtx: any = {
        config: {
          personaId: this.config.personaId,
          mode: this.config.mode || 'agent',
          model: this.config.model || '',
          baseUrl: this.config.baseUrl || '',
          apiKey: this.config.apiKey || '',
        },
        sessionId: this.config.sessionId,
        turnCount: 0,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
      }

      // Hook: beforeToolCall
      getHookManager()
        .runBeforeToolCall({
          ctx: hookCtx,
          toolName: fn.name,
          toolArgs: args,
        })
        .catch(() => {})

      const result = await executeToolWithRetry(fn.name, args).catch((e) => ({
        callId: tc.id,
        ok: false,
        content: '',
        error: e.message,
        durationMs: 0,
      }))

      // 诊断埋点
      getDiagnosticsStore().addToolCall({
        timestamp: new Date().toISOString(),
        toolName: fn.name,
        args: JSON.stringify(args).slice(0, 200),
        result: result.ok ? result.content.slice(0, 200) : '',
        ok: result.ok,
        error: result.ok ? undefined : result.error,
        durationMs: result.durationMs || 0,
      })

      // Hook: afterToolCall
      getHookManager()
        .runAfterToolCall({
          ctx: hookCtx,
          toolName: fn.name,
          toolArgs: args,
          result: result.ok ? result.content : '',
          error: result.ok ? undefined : result.error,
          durationMs: result.durationMs || 0,
        })
        .catch(() => {})

      this.emit?.onToolEnd?.(fn.name, result)
      messages.push({
        role: 'tool',
        content: result.ok ? result.content : `工具错误: ${result.error || '未知错误'}`,
        tool_call_id: tc.id,
      })
    } else {
      // 多工具并行
      const allowedCalls: typeof toolCalls = []
      for (const tc of toolCalls) {
        const guardResult = getSecurityGuard().checkToolCall(tc)
        if (!guardResult.allowed) {
          messages.push({
            role: 'tool',
            content: `⛔ 安全审查阻止 ${tc.function.name}: ${guardResult.summary}`,
            tool_call_id: tc.id,
          })
          continue
        }
        if (guardResult.requiresApproval && !this.config.skipApproval) {
          messages.push({
            role: 'tool',
            content: `🔐 ${tc.function.name} 需要审批: ${guardResult.summary}`,
            tool_call_id: tc.id,
          })
          continue
        }
        // 🔒 权限档位（并行路径同样必须走，单发路径的绕过不算数）
        let pArgs: Record<string, unknown> = {}
        try { pArgs = JSON.parse(tc.function.arguments || '{}') } catch { pArgs = {} }
        const perm = this.checkPermission(tc.function.name, pArgs)
        if (perm) {
          this.emit?.onToolStart?.(tc.function.name, pArgs)
          this.emit?.onToolEnd?.(tc.function.name, { ok: false, content: '', error: perm.message })
          messages.push({ role: 'tool', content: perm.message, tool_call_id: tc.id })
          continue
        }
        // 角色硬闸门（并行路径）：无权工具直接回 ok:false，不进执行批次
        const gate = checkRoleGate(this.config.personaId, tc.function.name)
        if (gate) {
          messages.push({
            role: 'tool',
            content: gate.ok ? (gate.content || '') : `工具错误: ${gate.error || '无权调用'}`,
            tool_call_id: tc.id,
          })
          continue
        }
        // 🔁 同回合去重：同一响应内参数一致的重复调用只执行一次
        const dupKey = this.toolDedupKey(tc.function.name, pArgs)
        if (seenThisTurn.has(dupKey)) {
          messages.push({
            role: 'tool',
            content: `♻️ 本回合已执行过相同的 ${tc.function.name} 调用（参数一致），跳过重复执行以省时省 token。`,
            tool_call_id: tc.id,
          })
          continue
        }
        seenThisTurn.add(dupKey)
        allowedCalls.push(tc)
      }
      if (allowedCalls.length === 0) {return}

      const batches = groupParallelBatches(allowedCalls)
      for (const batch of batches) {
        const batchResults = await executeToolsParallel(batch)
        for (const item of batchResults) {
          this.emit?.onToolStart?.(item.call.function.name, JSON.parse(item.call.function.arguments || '{}'))
          this.emit?.onToolEnd?.(item.call.function.name, item.result)
          messages.push({
            role: 'tool',
            content: item.result.ok ? item.result.content : `工具错误: ${item.result.error || '未知错误'}`,
            tool_call_id: item.call.id,
          })
        }
      }
    }
  }

  // ═══════════════════════════════════════════════════════
  // Token 估算
  // ═══════════════════════════════════════════════════════

  private estimateTokenUsage(
    response: LLMResponse,
    messages: ReactMessage[],
  ): { prompt_tokens: number; completion_tokens: number; total_tokens: number } {
    if (response.usage?.total_tokens && response.usage.total_tokens > 0) {
      return response.usage
    }
    const completionText = response.text || ''
    const completionTokens = Math.max(1, Math.ceil(completionText.length / 3.5))
    const promptText = messages.map((m) => (m.content || '') + (m.name || '')).join(' ')
    const promptTokens = Math.max(1, Math.ceil(promptText.length / 3.5))
    return {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    }
  }

  /** 获取本轮是否用过工具 */
  get toolsUsed(): boolean {
    return this.toolsUsedThisRun
  }
}
