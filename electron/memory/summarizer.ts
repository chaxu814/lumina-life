// ============================================================
// summarizer.ts — 结构化上下文压缩 (v2.7 重写)
//
// 借鉴 QwenPaw LightContextManager + compactor_prompts.py:
//   旧: ≤150字简单摘要，丢失关键细节
//   新: 结构化压缩保留 Goal/Progress/Decisions/Critical Context
//
// 压缩触发:
//   1. 达到 token 阈值 (默认 60k) — 自动压缩
//   2. 用户发送 /compact 命令 — 手动压缩
//   3. 每轮对话结束 — 增量压缩 (可选)
// ============================================================

import { getMemoryStore } from './memoryStore'
import { TokenEstimator } from '../tokenEstimator'

const SUMMARY_EVERY_N_TURNS = 10

// ═══════════════════════════════════════════════════════════
// 结构化压缩提示词 (借鉴 QwenPaw compactor_prompts.py)
// ═══════════════════════════════════════════════════════════

const COMPACTOR_SYSTEM_PROMPT = `你是上下文压缩助手。你的角色是创建对话的结构化摘要，
这些摘要可以在未来会话中用于恢复上下文。专注于保留关键信息，同时减少 token 数量。`

const COMPACTOR_USER_PROMPT = `# 任务
根据上面的对话创建一个结构化摘要。

# 规则：
- 保持每个部分简洁
- 保留确切的文件路径、函数名称和错误消息
- 不丢失任何技术细节

# 输出格式：

## 目标
[用户试图完成什么？如果会话涵盖不同任务，可以有多个项目。]

## 约束和偏好
- [用户提到的任何约束、偏好或要求]
- [或 "(无)" 如果没有]

## 进度
### 已完成
- [x] [已完成的任务/更改]

### 进行中
- [ ] [当前进行的工作]

### 阻塞
- [阻碍进展的问题，如果有]

## 关键决策
- **[决策]**：[简要理由]

## 下一步
1. [接下来应该发生什么的有序列表]

## 关键上下文
- [继续工作所需的任何数据、示例或参考文献]
- [或 "(无)" 如果不适用]

输出上述格式的结构化摘要。`

// ═══════════════════════════════════════════════════════════
// 增量更新提示词 (会话中途压缩)
// ═══════════════════════════════════════════════════════════

const INCREMENTAL_COMPACTOR_PROMPT = `# 任务
基于现有上下文摘要和最新对话，更新结构化摘要。

# 现有摘要
{existingSummary}

# 最新对话
{recentMessages}

# 规则
- 更新「进度」部分反映最新状态
- 在「关键决策」中添加新的重要决策
- 更新「下一步」以反映当前优先级
- 保持「目标」和「约束」不变，除非发生根本变化
- 如果新对话与旧目标无关，添加为新的目标条目

输出更新后的完整结构化摘要（同格式）。`

// ═══════════════════════════════════════════════════════════
// 压缩结果类型
// ═══════════════════════════════════════════════════════════

export interface CompactedContext {
  goal: string[]
  constraints: string[]
  progress: {
    done: string[]
    inProgress: string[]
    blocked: string[]
  }
  keyDecisions: Array<{ decision: string; rationale: string }>
  nextSteps: string[]
  criticalContext: string[]
  compactedAt: number
  messageCount: number
  estimatedTokensSaved: number
}

// ═══════════════════════════════════════════════════════════
// ConversationSummarizer (重构版)
// ═══════════════════════════════════════════════════════════

export class ConversationSummarizer {
  private buffer: Array<{ role: string; content: string }> = []
  private compacted: CompactedContext | null = null
  private sessionId: string
  private estimator: TokenEstimator

  constructor(
    sessionId: string,
    options?: { compressionThreshold?: number },
  ) {
    this.sessionId = sessionId
    this.estimator = new TokenEstimator({ threshold: options?.compressionThreshold })
  }

  getBufferLength(): number {
    return this.buffer.length
  }

  getEstimatedTokens(): number {
    return this.estimator.getTotal()
  }

  getCompactedContext(): CompactedContext | null {
    return this.compacted
  }

  /** 检查是否需要压缩 */
  needsCompaction(): boolean {
    return this.estimator.needsCompaction()
  }

  compactionUrgency(): number {
    return this.estimator.compactionUrgency()
  }

  /**
   * 添加消息到缓冲区
   */
  addMessage(role: string, content: string): void {
    this.buffer.push({ role, content })
    this.estimator.add(this.estimator.estimate(content))

    // 保留最近 50 条在缓冲区
    if (this.buffer.length > 50) {
      const removed = this.buffer.splice(0, this.buffer.length - 50)
      // 粗略从 token 估算中减去
      for (const m of removed) {
        this.estimator.add(-this.estimator.estimate(m.content))
      }
    }
  }

  /**
   * 生成即将发送给 LLM 的压缩用对话文本
   */
  getSummaryText(): string {
    return this.buffer
      .map(m => `${m.role === 'user' ? '用户' : '助手'}: ${m.content.slice(0, 300)}`)
      .join('\n')
  }

  getFullText(): string {
    return this.buffer.map(m => `${m.role}: ${m.content}`).join('\n')
  }

  /**
   * 获取压缩提示词 (初始压缩)
   */
  getCompactorPrompt(): { system: string; user: string } {
    const conversationText = this.getSummaryText()
    return {
      system: COMPACTOR_SYSTEM_PROMPT,
      user: COMPACTOR_USER_PROMPT + `\n\n## 对话内容\n${conversationText}`,
    }
  }

  /**
   * 获取增量压缩提示词
   */
  getIncrementalCompactorPrompt(existingSummary: string, recentCount: number): { system: string; user: string } {
    const recent = this.buffer.slice(-recentCount).map(m =>
      `${m.role === 'user' ? '用户' : '助手'}: ${m.content.slice(0, 300)}`
    ).join('\n')

    const prompt = INCREMENTAL_COMPACTOR_PROMPT
      .replace('{existingSummary}', existingSummary)
      .replace('{recentMessages}', recent)

    return { system: COMPACTOR_SYSTEM_PROMPT, user: prompt }
  }

  /**
   * 保存压缩结果
   */
  saveCompaction(compacted: CompactedContext): void {
    const beforeTokens = this.estimator.getTotal()
    this.compacted = compacted
    // 压缩后，清空旧缓冲区，保留最近 5 条
    this.buffer = this.buffer.slice(-5)
    this.estimator.reset()
    // 重新计算
    for (const m of this.buffer) {
      this.estimator.add(this.estimator.estimate(m.content))
    }
    const afterTokens = this.estimator.getTotal()
    compacted.estimatedTokensSaved = beforeTokens - afterTokens
  }

  /**
   * 将压缩上下文生成为可注入 System Prompt 的文本
   */
  formatCompactedForSystemPrompt(): string {
    if (!this.compacted) {return ''}

    const c = this.compacted
    const parts: string[] = ['# 之前对话的摘要\n以下是你与用户之前对话的结构化摘要：']

    if (c.goal.length > 0) {
      parts.push('\n## 目标')
      parts.push(...c.goal.map(g => `- ${g}`))
    }

    if (c.constraints.length > 0) {
      parts.push('\n## 约束和偏好')
      parts.push(...c.constraints.map(cn => `- ${cn}`))
    }

    const allDone = c.progress.done
    const allProgress = c.progress.inProgress
    const allBlocked = c.progress.blocked
    if (allDone.length + allProgress.length + allBlocked.length > 0) {
      parts.push('\n## 进度')
      if (allDone.length) {
        parts.push('### 已完成')
        parts.push(...allDone.map(d => `- [x] ${d}`))
      }
      if (allProgress.length) {
        parts.push('### 进行中')
        parts.push(...allProgress.map(p => `- [ ] ${p}`))
      }
      if (allBlocked.length) {
        parts.push('### 阻塞')
        parts.push(...allBlocked.map(b => `- ⚠️ ${b}`))
      }
    }

    if (c.keyDecisions.length > 0) {
      parts.push('\n## 关键决策')
      parts.push(...c.keyDecisions.map(d => `- **${d.decision}**：${d.rationale}`))
    }

    if (c.nextSteps.length > 0) {
      parts.push('\n## 下一步')
      parts.push(...c.nextSteps.map((s, i) => `${i + 1}. ${s}`))
    }

    if (c.criticalContext.length > 0) {
      parts.push('\n## 关键上下文')
      parts.push(...c.criticalContext.map(ctx => `- ${ctx}`))
    }

    return parts.join('\n')
  }

  // ═══════════════════════════════════════════════════════
  // 兼容旧接口
  // ═══════════════════════════════════════════════════════

  /** @deprecated 使用结构化压缩替代 */
  async summarize(summaryText: string): Promise<void> {
    try {
      getMemoryStore().addConversationSummary(summaryText)
      getMemoryStore().cleanup(50)
    } catch { /* ignore */ }
    this.buffer = this.buffer.slice(-5)
  }

  /** @deprecated 使用 getCompactorPrompt 替代 */
  getSummarizePrompt(): { system: string; user: string } {
    const OLD_SUMMARY_PROMPT = `你是记忆整理助手。请用≤150字总结以下对话片段的关键信息：\n- 用户说了什么重要信息（偏好、习惯、任务）\n- 完成了什么操作\n- 有哪些值得记住的教训\n只输出摘要文本，不要加前缀。`
    return { system: OLD_SUMMARY_PROMPT, user: `请总结以下对话：\n${this.getSummaryText()}` }
  }
}

// ═══════════════════════════════════════════════════════════
// 旧版三层精炼 Prompt (保留兼容)
// ═══════════════════════════════════════════════════════════

const REFINE_SYSTEM_PROMPT = `你是长期记忆整理助手。维护用户的结构化记忆档案，分为两个部分：

1. **USER（用户画像）**：用户身份、偏好、习惯、沟通风格
2. **MEMORY（环境配置）**：系统环境、工具特性、项目约定、经验教训

根据提供的对话摘要，输出 JSON（仅 JSON，不要其他文本）：

{
  "user": {
    "preferences": ["偏好1", "偏好2"],
    "habits": ["习惯1"],
    "communicationStyle": "casual/formal/direct",
    "personality": "性格描述"
  },
  "memory": {
    "lessons": ["教训1"],
    "systemInfo": ["系统信息"],
    "projectConventions": ["项目约定"],
    "toolExperience": ["工具经验"]
  }
}`

const FACTS_EXTRACTION_PROMPT = `你是信息提取助手。从对话中提取客观事实，输出 JSON（仅 JSON）：

{
  "facts": [
    { "category": "user|environment|event|preference|habit", "content": "事实描述", "confidence": 0.0-1.0, "source": "user_said|observed|inferred" }
  ]
}

规则：
- user: 关于用户本身的信息（姓名、工作、年龄等）
- environment: 环境信息（操作系统、软件、项目等）
- event: 发生的事件（"今天做了X"、"明天要Y"）
- preference: 用户偏好（"我喜欢/不喜欢..."）
- habit: 用户习惯（"我经常..."）
- confidence: 1.0=明确陈述，0.7=合理推断
- 最多提取 5 条事实`

const REFLECTION_PROMPT = `你是自我反思助手。基于对话，反思助手的表现和需要改进之处，输出 JSON（仅 JSON）：

{
  "reflections": [
    { "topic": "反思主题", "insight": "具体洞察", "action": "行动建议" }
  ]
}

反思方向: 沟通方式是否合适？工具选择是否最优？回答是否简洁清晰？用户是否有不满或困惑？
最多生成 3 条反思。`

const PERSONA_UPDATE_PROMPT = `你是人格评估助手。根据与用户的对话，评估 AI 助手的人格特质变化，输出 JSON（仅 JSON）：

{
  "traits": ["特质1", "特质2", "特质3"],
  "traitChange": "人格变化描述 (≤30字)",
  "bigFive": { "openness": 0.0-1.0, "conscientiousness": 0.0-1.0, "extraversion": 0.0-1.0, "agreeableness": 0.0-1.0, "playfulness": 0.0-1.0 }
}

traits 可选值: 活泼、温暖、毒舌、傲娇、冷静、细心、幽默、严肃、温柔、理性
只输出 JSON。`

// ═══════════════════════════════════════════════════════════
// GlobalMemoryRefiner (保留兼容)
// ═══════════════════════════════════════════════════════════

export class GlobalMemoryRefiner {
  getRefinePrompt(summaries: string[]): { system: string; user: string } {
    return {
      system: REFINE_SYSTEM_PROMPT,
      user: `基于以下对话摘要，更新记忆档案：\n\n${summaries.map((s, i) => `[${i + 1}] ${s}`).join('\n\n')}`,
    }
  }

  applyRefinement(result: {
    user?: { preferences?: string[]; habits?: string[]; communicationStyle?: string; personality?: string }
    memory?: { lessons?: string[]; systemInfo?: string[]; projectConventions?: string[]; toolExperience?: string[] }
  }): void {
    try {
      if (result.user) {getMemoryStore().saveUserProfile(result.user)}
      if (result.memory) {getMemoryStore().saveMemoryConfig(result.memory)}
    } catch { /* ignore */ }
  }

  getFactsExtractionPrompt(): { system: string; user: string } {
    return { system: FACTS_EXTRACTION_PROMPT, user: '' }
  }

  getReflectionPrompt(): { system: string; user: string } {
    return { system: REFLECTION_PROMPT, user: '' }
  }

  getPersonaUpdatePrompt(): { system: string; user: string } {
    return { system: PERSONA_UPDATE_PROMPT, user: '' }
  }

  applyFactsExtraction(facts: Array<{
    category: string; content: string; confidence: number; source: string
  }>): void {
    try {
      const store = getMemoryStore()
      for (const f of facts) {
        if (f.confidence > 0.5) {
          store.addFact({
            category: f.category as any, content: f.content,
            confidence: f.confidence, source: f.source,
          })
        }
      }
    } catch { /* ignore */ }
  }

  applyReflections(reflections: Array<{
    topic: string; insight: string; action: string
  }>): void {
    try {
      const store = getMemoryStore()
      for (const r of reflections) {
        store.addReflection({ topic: r.topic, insight: r.insight, action: r.action })
      }
    } catch { /* ignore */ }
  }

  applyPersonaUpdate(persona: {
    traits?: string[]; traitChange?: string
    bigFive?: { openness: number; conscientiousness: number; extraversion: number; agreeableness: number; playfulness: number }
  }): void {
    try {
      if (persona.bigFive) {getMemoryStore().savePersonaTraits(persona.bigFive)}
      if (persona.traits) {getMemoryStore().addPersonaTraits(persona.traits)}
      if (persona.traitChange) {getMemoryStore().addEvolutionLog(persona.traitChange)}
    } catch { /* ignore */ }
  }
}

// 导出旧常量以保持兼容
export {
  REFINE_SYSTEM_PROMPT,
  FACTS_EXTRACTION_PROMPT,
  REFLECTION_PROMPT,
  PERSONA_UPDATE_PROMPT,
}
