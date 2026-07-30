// ============================================================
// orchestration/complexityAnalyzer.ts — 任务复杂度分析 (v1.0)
//
// 在 Lumina 委托任务给 Yak 之前，自动分析任务复杂度：
//   - 'simple'  → 直派（当前流程）
//   - 'complex' → 激活分阶段门控流程
//
// 判断维度：
//   ① 文件数量 — 涉及多个文件需要改？
//   ② 任务描述长度与关键词 — "新建系统""完整实现"等
//   ③ 是否需要研究 — "研究""调研""分析"？
//   ④ 相互依赖 — "依赖""先做""需要xxx"
//   ⑤ 风险 — "数据库""支付""安全"等
// ============================================================

// ═══════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════

export type ComplexityLevel = 'simple' | 'complex'

export interface ComplexityAnalysis {
  /** 整体复杂度 */
  level: ComplexityLevel
  /** 分数 0~100，越高越复杂 */
  score: number
  /** 触发的具体维度 */
  triggers: string[]
  /** 是否建议启动阶段门控 */
  suggestPhasedExecution: boolean
  /** 建议的阶段门控路径（如有） */
  suggestedPhases?: string[]
}

// ═══════════════════════════════════════════════════════════
// 复杂度关键词特征
// ═══════════════════════════════════════════════════════════

interface WeightEntry {
  pattern: RegExp
  weight: number
  trigger: string
}

const COMPLEXITY_SIGNALS: WeightEntry[] = [
  // ── 多文件/大规模（权重高） ──
  { pattern: /新建(系统|工程|项目|模块)/i, weight: 30, trigger: '新建大型项目/模块' },
  { pattern: /完整(实现|功能|系统)/i, weight: 25, trigger: '完整功能实现' },
  { pattern: /多(个|个文件|页面|组件|接口)/i, weight: 20, trigger: '涉及多个组件/文件' },
  { pattern: /整体|全面|大规模|重构|重新/i, weight: 25, trigger: '大规模重构' },
  { pattern: /从零(开始|搭建|创建)/i, weight: 25, trigger: '从零搭建' },

  // ── 需要预研究（中等权重） ──
  { pattern: /(调研|研究|调查|分析|评估)(一下|一下)?/i, weight: 20, trigger: '需要前期研究' },
  { pattern: /最佳实践|设计模式|架构设计|技术选型/i, weight: 20, trigger: '需要架构设计' },
  { pattern: /比较|对比|区别|优缺点/i, weight: 15, trigger: '需要对比分析' },
  { pattern: /先(调研|研究|看|读|了解)/i, weight: 15, trigger: '需要前置探索' },

  // ── 相互依赖（中等权重） ──
  { pattern: /依[赖存]|先做|先完成|前提|前置/i, weight: 20, trigger: '任务间存在依赖关系' },
  { pattern: /顺序|依次|分步|分期|阶段(一|二|三)/i, weight: 15, trigger: '需要分步执行' },

  // ── 高风险（高权重） ──
  { pattern: /数据(库|迁移|安全)|支付|交易|金融|鉴权|登录/i, weight: 30, trigger: '高风险领域（数据/支付/鉴权）' },
  { pattern: /部署|上线|发布|生产(环境)?/i, weight: 25, trigger: '涉及生产环境' },
  { pattern: /权[限限制]|安全|加密|隐私|合规/i, weight: 25, trigger: '安全/合规相关' },

  // ── 代码审查必要性（中等权重） ──
  { pattern: /审[查核]|review|检查(代码|质量)|代码(规范|风格)/i, weight: 15, trigger: '需要代码审查' },
  { pattern: /测[试图]|单元测试|集成测试|覆盖率/i, weight: 10, trigger: '需要编写测试' },

  // ── 边界条件（低权重） ──
  { pattern: /第三方(API|SDK|服务|集成|对接)/i, weight: 15, trigger: '涉及第三方集成' },
  { pattern: /兼[容容]|迁移|升级|版本/i, weight: 15, trigger: '兼容性/迁移' },
]

// ═══════════════════════════════════════════════════════════
// 简单信号（降级复杂度）
// ═══════════════════════════════════════════════════════════

const SIMPLICITY_SIGNALS: RegExp[] = [
  /修[复改](一个|个小|一下|个b)ug/i,
  /改(一个|几个)?(变量|参数|配置|文字|文案|字符串)/i,
  /删(一个|一行|一段)?(代码|文件|注释)/i,
  /重命(名|称)/i,
  /加(一个|一行|一条)?(注释|日志|debug)/i,
  /格式化|排版|对齐|换行/i,
  /查(看|询|一下|个)/i, // 只读操作
]

// ═══════════════════════════════════════════════════════════
// 分析函数
// ═══════════════════════════════════════════════════════════

/**
 * 分析任务复杂度
 *
 * @param task - 任务描述
 * @param options - 可选：文件数量、任务类型等额外信息
 * @returns ComplexityAnalysis
 */
export function assessComplexity(
  task: string,
  options?: {
    fileCount?: number
    taskType?: string
  },
): ComplexityAnalysis {
  let score = 0
  const triggers: string[] = []

  // 维度 1：关键词匹配
  for (const signal of COMPLEXITY_SIGNALS) {
    if (signal.pattern.test(task)) {
      score += signal.weight
      if (!triggers.includes(signal.trigger)) {
        triggers.push(signal.trigger)
      }
    }
  }

  // 维度 2：简单信号 — 降低分数
  for (const pattern of SIMPLICITY_SIGNALS) {
    if (pattern.test(task)) {
      score -= 20 // 简单任务直接降低复杂度
      triggers.push('任务描述偏简单')
      break
    }
  }

  // 维度 3：文件数量
  if (options?.fileCount !== undefined) {
    if (options.fileCount >= 5) {
      score += 20
      triggers.push(`涉及 ${options.fileCount} 个文件`)
    } else if (options.fileCount >= 3) {
      score += 10
      triggers.push(`涉及 ${options.fileCount} 个文件`)
    }
  }

  // 维度 4：任务类型
  if (options?.taskType) {
    if (['code_refactor', 'code_debug'].includes(options.taskType)) {
      score += 10
      triggers.push(`任务类型为 ${options.taskType}`)
    }
  }

  // 维度 5：任务长度（长任务更复杂）
  if (task.length > 500) {
    score += 10
    triggers.push('任务描述较长')
  }

  // 归一化
  score = Math.max(0, Math.min(100, score))

  const level: ComplexityLevel = score >= 50 ? 'complex' : 'simple'

  // 建议阶段
  const suggestedPhases = buildSuggestedPhases(level, triggers, task)

  return {
    level,
    score,
    triggers,
    suggestPhasedExecution: level === 'complex',
    suggestedPhases,
  }
}

/**
 * 根据复杂度分析结果，建议执行阶段
 */
function buildSuggestedPhases(
  level: ComplexityLevel,
  triggers: string[],
  task: string,
): string[] | undefined {
  if (level === 'simple') return undefined

  const phases: string[] = []

  // 如果需要研究 → 先加 research
  if (triggers.some(t => t.includes('研究') || t.includes('调研') || t.includes('探索'))) {
    phases.push('research')
  }

  // 再加 execute
  phases.push('execute')

  // 如果需要依赖关系 → 加 plan
  if (triggers.some(t => t.includes('依赖') || t.includes('分步'))) {
    phases.unshift('plan') // plan 放在 execute 前
  }

  // 高风险 → 加 review
  if (triggers.some(t => t.includes('风险') || t.includes('安全') || t.includes('生产'))) {
    phases.push('review')
  }

  // 如果有 research/plan → 再加一次 verify
  if (phases.length > 1) {
    phases.push('verify')
  }

  return [...new Set(phases)] // 去重
}
