// ============================================================
// hooks/memoryCompaction.ts — LLM 驱动上下文压缩 Hook (v3.5)
//
// 借鉴 QwenPaw LightContextManager + Compactor:
//   用 LLM 生成结构化摘要（目标/约束/进展/决策/下一步/关键上下文）
//   而非简单截断或规则摘要
// ============================================================

import type { HookRegistration, BeforeReasoningInput, OnCompactionInput, HookContext, AgentMessage } from './types'
import { TokenEstimator } from '../tokenEstimator'

/** 将 AgentMessage content 安全转为字符串 */
function toText(content: AgentMessage['content']): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map(part => part.text || '').join('')
  }
  return ''
}

// v4.0: Per-Agent 独立压缩阈值（借鉴 QwenPaw 独立上下文管理）
//   - 每个 Agent 有独立的压缩阈值，互不影响
//   - Lumina(85K): 主交互 Agent，需要最大上下文空间
//   - Recha(60K): 编程 Agent，代码多但迭代快
//   - Yak(75K):   分析 Agent，需要较多数据上下文
//   - 社交聊天轨道独立低阈值(3K)，不与 Agent 主上下文混淆

const COMPACTION_THRESHOLD_CHAT_TRACK = 3000   // 社交闲聊轨道 — 超过就收

const COMPACTION_THRESHOLD_TOKENS = 24000   // 旧全局阈值（向后兼容）

/** v4.0: Per-Agent 压缩阈值映射 */
const PER_AGENT_THRESHOLDS: Record<string, number> = {
  lumina: 85_000,  // 主交互，最大空间
  recha:  60_000,  // 编程任务，迭代快
  yak:    75_000,  // 分析任务，需要数据上下文
}

/** 根据 Agent ID 获取其压缩阈值，未注册的用默认值 */
export function getCompactionThreshold(agentId?: string): number {
  if (agentId && PER_AGENT_THRESHOLDS[agentId]) {
    return PER_AGENT_THRESHOLDS[agentId]
  }
  return COMPACTION_THRESHOLD_TOKENS
}

/** 社交聊天轨道专用低阈值 */
export function getChatTrackCompactionThreshold(): number {
  return COMPACTION_THRESHOLD_CHAT_TRACK
}
const COMPACTION_TARGET_TOKENS = 8000        // 压缩目标
const MAX_SUMMARY_LENGTH = 3000              // 摘要最大字符数

/** LLM 驱动的上下文压缩 */
async function compactWithLLM(
  ctx: HookContext,
  messages: AgentMessage[],
): Promise<string | null> {
  // 构建压缩请求
  const conversation = messages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => `[${m.role}]: ${toText(m.content).slice(0, 500)}`)
    .join('\n\n')

  const compactPrompt = `你是一个对话压缩助手。将以下对话压缩为结构化摘要，保留关键信息：

## 输出格式
### 目标
[用户试图完成什么]

### 约束与偏好
- [用户的约束、偏好]

### 进展
- [已完成的任务]

### 关键决策
- **[决策]**: [理由]

### 下一步
1. [应该做什么]

### 关键上下文
- [重要的数据、文件路径、错误信息]

---
对话内容：
${conversation.slice(0, 8000)}
---
请生成压缩摘要（中文，${MAX_SUMMARY_LENGTH} 字以内）:`

  try {
    // 使用配置的 LLM 做压缩（或降级到规则摘要）
    const res = await fetch(`${ctx.config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ctx.config.apiKey}`,
      },
      body: JSON.stringify({
        model: ctx.config.model,
        messages: [{ role: 'user', content: compactPrompt }],
        max_tokens: 1024,
        temperature: 0.3,
      }),
      signal: AbortSignal.timeout(120_000),
    })

    if (!res.ok) throw new Error(`压缩请求失败: ${res.status}`)

    const data = await res.json()
    const summary = data.choices?.[0]?.message?.content?.trim()
    if (summary && summary.length > 50) return summary.slice(0, MAX_SUMMARY_LENGTH)
    return null
  } catch (err: any) {
    console.warn('[MemoryCompaction] LLM 压缩失败，使用规则摘要:', err.message)
    return null
  }
}

/** 规则摘要（降级方案） */
function ruleBasedCompact(
  messages: AgentMessage[],
): string {
  const userMsgs = messages.filter(m => m.role === 'user')
  const assistantMsgs = messages.filter(m => m.role === 'assistant')

  const goal = toText(userMsgs[0]?.content).slice(0, 200) || '(未识别)'
  const lastAction = toText(assistantMsgs[assistantMsgs.length - 1]?.content).slice(0, 300) || '(无)'

  return [
    `### 目标\n${goal}`,
    `### 约束与偏好\n- (从对话中提取)`,
    `### 进展\n- 已进行 ${messages.length} 轮对话`,
    `### 关键决策\n- 最后操作: ${lastAction}`,
    `### 下一步\n1. 继续当前任务`,
    `### 关键上下文\n- (请查看历史文件)`,
  ].join('\n\n')
}

export function createMemoryCompactionHook(workingDir: string): HookRegistration {
  let lastCompactionTokens = 0
  const estimator = new TokenEstimator()

  return {
    id: 'core.memory_compaction',
    name: 'LLM 上下文压缩',
    description: '当上下文超过阈值时，用 LLM 生成结构化摘要压缩',
    priority: 'high',
    enabled: true,

    async beforeReasoning(input: BeforeReasoningInput) {
      // v4.0: Per-Agent 独立压缩阈值
      const agentId = (input.ctx as any)?.agentId || (input.ctx as any)?.personaId
      const threshold = getCompactionThreshold(agentId)
      
      // 估算当前总 token
      const totalTokens = estimator.estimateMessages(
        input.messages.map(m => ({ content: m.content, role: m.role }))
      )

      if (totalTokens < threshold) return

      console.log(`[MemoryCompaction] ⚠️ Agent[${agentId || 'default'}] 上下文 ${TokenEstimator.format(totalTokens)} tokens 超过阈值 ${TokenEstimator.format(threshold)}，触发压缩...`)

      // 保留 system + 最近 4 条消息
      const systemMsg = input.messages.find(m => m.role === 'system')
      const recentMsgs = input.messages.filter(m => m.role !== 'system').slice(-6)
      const toCompact = input.messages.filter(m => m.role !== 'system').slice(0, -6)

      if (toCompact.length === 0) return

      // LLM 驱动压缩
      const hookCtx: HookContext = {
        ...input.ctx,
        extra: { workingDir },
      }
      let summary = await compactWithLLM(hookCtx, toCompact)

      // 降级到规则摘要
      if (!summary) {
        summary = ruleBasedCompact(toCompact)
      }

      // 替换消息数组
      const compactBlock = {
        role: 'system' as const,
        content: `\n\n---\n## 📋 对话压缩摘要\n${summary}\n---\n`,
      }

      input.messages = [
        ...(systemMsg ? [systemMsg] : []),
        compactBlock,
        ...recentMsgs,
      ]

      const newTokens = estimator.estimateMessages(
        input.messages.map(m => ({ content: m.content, role: m.role }))
      )

      console.log(`[MemoryCompaction] ✅ 压缩完成: ${TokenEstimator.format(totalTokens)} → ${TokenEstimator.format(newTokens)} tokens`)

      // 触发 onCompaction Hook
      const compactionInput: OnCompactionInput = {
        ctx: hookCtx,
        beforeTokens: totalTokens,
        afterTokens: newTokens,
        summary,
      }
      const { getHookManager } = require('./hookManager')
      getHookManager().runOnCompaction(compactionInput).catch(() => {})
    },
  }
}
