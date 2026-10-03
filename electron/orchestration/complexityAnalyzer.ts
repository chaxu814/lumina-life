// ============================================================
// orchestration/complexityAnalyzer.ts — 任务复杂度分析 (v1.0)
//
// 在 Lumina 委托编码任务给 Yak（yak，代码工程师）之前，自动分析任务复杂度：
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

/** 强制信号不需要 weight（它不看分数，直接拍板），单独一个类型避免误用 */
interface TriggerEntry {
  pattern: RegExp
  trigger: string
}

const COMPLEXITY_SIGNALS: WeightEntry[] = [
  // ── 多文件/大规模（权重高） ──
  { pattern: /新建(系统|工程|项目|模块)/i, weight: 30, trigger: '新建大型项目/模块' },
  { pattern: /完整(实现|功能|系统)/i, weight: 25, trigger: '完整功能实现' },
  { pattern: /多(个|个文件|页面|组件|接口)/i, weight: 20, trigger: '涉及多个组件/文件' },
  // v2 修复：原来 `整体|全面|大规模|重构|重新` 是**一条**正则，
  // 「重构整个项目的架构，全面优化」里「重构」和「全面」命中的是同一条，
  // 只计一次 25 分 → 低于阈值 50 → 被误判为 simple。
  // 而这恰恰是最需要 plan→execute→review→verify 全流程的任务。
  // 修法：拆成独立条目，让每个信号各自计分（下面的「多信号叠加」再放大）。
  { pattern: /重构/i, weight: 30, trigger: '重构（高风险，改动面广）' },
  { pattern: /整体|全面|大规模/i, weight: 20, trigger: '整体性改动' },
  { pattern: /重新(设计|构建|搭建|整理)/i, weight: 20, trigger: '重新设计' },
  { pattern: /从零(开始|搭建|创建)/i, weight: 25, trigger: '从零搭建' },
  { pattern: /架构/i, weight: 25, trigger: '涉及架构决策' },

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
// 强制升级信号（v2）
//
// 为什么需要这一层：加权求和天然有「1 个中等信号打不过 1 个高信号」
// 和「多个弱信号被低估」两个缺陷。重构整个项目这种任务，单看每个词
// 都不算特别重，但组合起来是最高风险的一类。
//
// 处理方式：命中任意一个，**无论累加得分多少**，一律判为 complex。
// 这些操作一旦做错，代价远高于多走一次阶段门控的��力成本。
// ═══════════════════════════════════════════════════════════

const FORCE_COMPLEX_SIGNALS: TriggerEntry[] = [
  { pattern: /重构/i, trigger: '重构（必须走门控：plan→execute→review→verify）' },
  { pattern: /重新(设计|实现)|重做|重写|重做一遍/i, trigger: '重做/重新设计（必须走门控）' },
  { pattern: /架构(设计|调整|变更|重构|演进)/i, trigger: '架构级改动（必须走门控）' },
  { pattern: /(生产|线上|prod)\s*(环境|部署|发布|库)/i, trigger: '涉及生产环境（必须走门控）' },
  { pattern: /数据(库)?迁移/i, trigger: '数据迁移（必须走门控）' },
  { pattern: /鉴权|认证|权限系统|登录系统/i, trigger: '鉴权/权限（必须走门控）' },
  { pattern: /支付|交易|金融|结算/i, trigger: '支付/金融（必须走门控）' },
  { pattern: /(全量|批量)\s*(删除|清理|迁移|替换)/i, trigger: '批量破坏性操作（必须走门控）' },
]

// ═══════════════════════════════════════════════════════════
// 多信号叠加（v2）
//
// 根因修复：旧版是纯线性加权，「重构整个项目，全面优化」这类
// 多维度任务会因为每个信号各记一次固定分而总和偏低。
// 现在对**去重后的不同信号数**做超线性放大，让「信号多」本身成为信号。
// ═══════════════════════════════════════════════════════════

/** 命中的独立信号数 → 放大系数（覆盖 1.0 ~ 1.6） */
function compoundingFactor(distinctSignals: number): number {
  if (distinctSignals <= 1) return 1.0
  if (distinctSignals === 2) return 1.15
  if (distinctSignals === 3) return 1.35
  if (distinctSignals === 4) return 1.5
  return 1.6
}

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
  /** 命中的**独立**复杂信号（用于叠加放大，按 trigger 去重） */
  const firedSignals = new Set<string>()

  // 维度 1：关键词匹配
  for (const signal of COMPLEXITY_SIGNALS) {
    if (signal.pattern.test(task)) {
      score += signal.weight
      if (!triggers.includes(signal.trigger)) {
        triggers.push(signal.trigger)
      }
      firedSignals.add(signal.trigger)
    }
  }

  // 维度 1b：多信号叠加（v2）——「信号多」本身就是一个信号
  //   例：「重构整个项目的架构，全面优化」命中 重构(30)+整体/全面(20)+架构(25)
  //   = 75 分，再乘 1.35 = 101 → 稳稳判为 complex。
  //   旧的纯线性版本这里只有 25 分，直接漏判。
  const distinctSignals = firedSignals.size
  if (distinctSignals >= 2) {
    const factor = compoundingFactor(distinctSignals)
    if (factor > 1.0) {
      score = Math.round(score * factor)
      triggers.push(`命中 ${distinctSignals} 个独立复杂度信号（×${factor}）`)
    }
  }

  // 维度 2：简单信号 — 降低分数
  //   注意：简化类任务若同时命中了 FORCE_COMPLEX_SIGNALS（如「重构整个项目的
  //   架构，顺便改个变量」），在下面 step 3 仍会被强制升级回来。
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

  // 维度 6：强制升级（v2）——置于最后，压过前面所有减分
  //   高危操作即使描述得像个「小改」，也必须走完整门控。
  const forced = FORCE_COMPLEX_SIGNALS.find(s => s.pattern.test(task))
  if (forced) {
    score = Math.max(score, 60)
    if (!triggers.includes(forced.trigger)) {
      triggers.push(forced.trigger)
    }
  }

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
  if (level === 'simple') {return undefined}

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
