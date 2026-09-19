// ============================================================
// intentRouter.ts — 🧭 Agent 意图路由器 (v16.0-fix)
//
// 在消息进入 Lumina 前预分类意图，自动路由到对应 Agent。
// 避免 Lumina 每次都要自己判断谁该干活。
//
// 架构：
//   User → IntentRouter.classify() → Lumina (通用/社交)
//                                  → Yak (代码任务)
//                                  → 热茶 (审查/风险评估)
//
// 可配置：
//   - autoRoute: 是否自动路由（true=直达，false=仅标记建议）
//   - minConfidence: 自动路由的最低置信度（0-1）
// ============================================================

import { getOrchestrator } from './core/agentOrchestrator'
import type { TeamMemberId } from './agentTeamTypes'

// ═══════════════════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════════════════

export interface RouteResult {
  /** 路由目标 */
  target: TeamMemberId
  /** 置信度 0-1 */
  confidence: number
  /** 路由原因 */
  reason: string
  /** 是否自动路由（false = 仅标记建议） */
  autoRouted: boolean
  /** 原始消息 */
  message: string
  /** 识别的任务类型 */
  taskType?: string
  /** 提取的关键上下文 */
  extractedContext?: string
}

export interface IntentRouterConfig {
  /** 自动路由开关 */
  autoRoute: boolean
  /** 最低置信度（低于此不下决定） */
  minConfidence: number
  /** 始终走 Lumina 的关键词（不去路由） */
  luminaKeywords: string[]
  /** 路由规则表 */
  rules: RouteRule[]
}

export interface RouteRule {
  /** 目标 Agent */
  target: TeamMemberId
  /** 触发关键词 */
  triggers: string[]
  /** 任务类型标签 */
  taskType: string
  /** 最低置信分（此规则命中后必须 ≥ 此值才路由） */
  minScore: number
  /** 规则描述 */
  description: string
}

export const DEFAULT_ROUTER_CONFIG: IntentRouterConfig = {
  autoRoute: true,
  minConfidence: 0.6,
  luminaKeywords: ['聊天', '你好', '今天', '心情', '早安', '晚安', '吃', '喝', '天气', '新闻'],
  rules: [
    {
      target: 'yak',
      triggers: ['写代码', '写个脚本', '实现', 'bug', '调试', '修复', '代码', '编程',
        '写个程序', '写个函数', '写个类', '重构', '优化代码', '写测试', '写单元测试',
        'Python', 'JavaScript', 'TypeScript', 'Go', 'Rust', 'C++', 'Java',
        'npm', 'pip', 'git', 'commit', 'push', 'pull',
        '算法', '数据结构', '命令行工具', 'CLI'],
      taskType: 'code',
      minScore: 0.5,
      description: '代码编写、调试、修复',
    },
    {
      target: 'recha',
      triggers: ['审查', '检查', '审核', 'review', '挑错', '找问题', '评估',
        '代码审查', 'code review', '安全漏洞', '性能问题', '最佳实践',
        '逻辑漏洞', '风险', '反面意见', '检查代码', 'review 一下'],
      taskType: 'review',
      minScore: 0.5,
      description: '代码审查、风险评估、逻辑检查',
    },
    {
      target: 'yak',
      triggers: ['解释代码', '这段代码什么意思', '讲一下代码', '分析代码',
        '代码逻辑', '代码流程', '这段代码怎么', '这代码干了什么'],
      taskType: 'code_explain',
      minScore: 0.4,
      description: '代码解释与分析',
    },
  ],
}

// ═══════════════════════════════════════════════════════════
// IntentRouter
// ═══════════════════════════════════════════════════════════

export class IntentRouter {
  private config: IntentRouterConfig

  constructor(config?: Partial<IntentRouterConfig>) {
    this.config = { ...DEFAULT_ROUTER_CONFIG, ...config }
  }

  /** 更新配置 */
  updateConfig(patch: Partial<IntentRouterConfig>): void {
    Object.assign(this.config, patch)
  }

  /** 获取配置 */
  getConfig(): IntentRouterConfig {
    return { ...this.config }
  }

  /** 分类消息 → 返回路由结果 */
  classify(message: string): RouteResult {
    const lower = message.toLowerCase().trim()

    // 1. 检查是否走 lumina 关键词（不路由）
    for (const kw of this.config.luminaKeywords) {
      if (lower.includes(kw)) {
        return {
          target: 'lumina',
          confidence: 0.9,
          reason: `匹配 Lumina 关键词: ${kw}`,
          autoRouted: false,
          message,
        }
      }
    }

    // 2. 遍历规则评分
    const scores: Array<{ target: TeamMemberId; score: number; reason: string; taskType: string }> = []

    for (const rule of this.config.rules) {
      let matchCount = 0
      for (const trigger of rule.triggers) {
        if (lower.includes(trigger.toLowerCase())) {
          matchCount++
        }
      }

      if (matchCount > 0) {
        const score = Math.min(1, matchCount / Math.max(3, rule.triggers.length) * 2)
        if (score >= rule.minScore) {
          scores.push({
            target: rule.target,
            score,
            reason: `匹配 ${matchCount} 个 "${rule.description}" 触发词`,
            taskType: rule.taskType,
          })
        }
      }
    }

    // 3. 取最高分
    scores.sort((a, b) => b.score - a.score)

    if (scores.length > 0 && scores[0].score >= this.config.minConfidence) {
      const best = scores[0]
      return {
        target: best.target,
        confidence: best.score,
        reason: best.reason,
        autoRouted: this.config.autoRoute && best.score >= this.config.minConfidence,
        message,
        taskType: best.taskType,
        extractedContext: this._extractContext(message, best.taskType),
      }
    }

    // 4. 默认走 Lumina
    return {
      target: 'lumina',
      confidence: 0.5,
      reason: '未匹配到特定路由规则',
      autoRouted: false,
      message,
    }
  }

  /** 获取路由规则列表（给 UI 展示） */
  getRules(): RouteRule[] {
    return this.config.rules
  }

  // ── 内部 ──────────────────────────────────────────

  private _extractContext(msg: string, taskType: string): string {
    // 从消息中提取代码片段、文件路径等
    const contextParts: string[] = []

    // 提取文件路径（包含 \ 或 /）
    const filePaths = msg.match(/[a-zA-Z]:\\(?:[^\\\s]+\\)*[^\\\s]*|(?:\/[^\s\/]+\/)+\/?[^\s]*/g)
    if (filePaths && filePaths.length > 0) {
      contextParts.push(`文件路径: ${filePaths.join(', ')}`)
    }

    // 提取代码块（``` 之间）
    const codeBlocks = msg.match(/```[\s\S]*?```/g)
    if (codeBlocks && codeBlocks.length > 0) {
      contextParts.push(`包含 ${codeBlocks.length} 个代码块`)
    }

    // 提取编程语言名
    const languages = ['python', 'javascript', 'typescript', 'go', 'rust', 'java', 'c++', 'c#', 'ruby', 'php']
    const foundLangs = languages.filter(l => msg.toLowerCase().includes(l))
    if (foundLangs.length > 0) {
      contextParts.push(`语言: ${foundLangs.join(', ')}`)
    }

    return contextParts.length > 0 ? contextParts.join('; ') : ''
  }
}

// ═══════════════════════════════════════════════════════════
// 全局单例
// ═══════════════════════════════════════════════════════════

let _router: IntentRouter | null = null

export function getIntentRouter(): IntentRouter {
  if (!_router) {_router = new IntentRouter()}
  return _router
}

export function initIntentRouter(config?: Partial<IntentRouterConfig>): IntentRouter {
  _router = new IntentRouter(config)
  return _router
}
