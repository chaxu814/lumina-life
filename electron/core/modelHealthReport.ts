// ============================================================
// modelHealthReport.ts — 模型体检报告（2026-10-05）
//
// 【为什么做这个】
// 深度评测发现：Lumina 在本地模型兼容上已经有一套相当完整的机制 ——
//   · modelServerFacts  遍历各厂商字段路径读服务端真相
//   · modelCapabilities  按参数量档位推导能力画像
//   · modelCompat        六类错误自动降级 + XML 工具兼容层
//   · modelCapabilityCache  运行时实测回写能力缓存
// 但这些信息【全是给机器看的】，散在日志和内部状态里，用户一个都看不到。
//
// 于是产生了两个现实问题：
//   1. 用户遇到「模型变傻了 / 工具不灵 / 很卡」时无从判断原因
//   2. 这些已经领先的工程能力【没有被表达出来】—— 本可以成为差异化卖点
//
// 所以本模块把已有信息聚合成一份人能读的诊断。
// ⚠️ 本模块【不新增任何探测逻辑】，只做聚合与翻译 —— 避免引入新的 IO 和延迟。
//
// 【产品定位】
// 行业普遍在卷功能。这是把「已经领先的工程能力」变成可见产品力的一步：
// 不是告诉用户「我们有降级机制」，而是直接告诉他
// 「你这个 9B 模型的 chat template 不支持原生工具调用，已切 XML 模式，
//   工具选择准确率会下降，建议换 Qwen3-8B」。
// ============================================================

import { resolveCapabilities, type ResolvedCapabilities, type CapabilitySource } from './modelCapabilities'
import { recallServerFacts, familiesImplyVision } from './modelServerFacts'
import { getModelCapabilityCache } from '../modelCapabilityCache'
import { isLocalEndpoint } from './modelCompat'

// ═══════════════════════════════════════════════════════════
// 报告结构
// ═══════════════════════════════════════════════════════════

/** 体检结论等级 */
export type HealthLevel = 'ok' | 'notice' | 'warn' | 'blocker'

/** 单条体检项 */
export interface HealthCheck {
  id: string
  /** 体检项名（面向用户） */
  label: string
  level: HealthLevel
  /** 面向用户的结论，一句话说清「是什么 / 意味着什么」 */
  summary: string
  /** 可操作建议（level 非 ok 时必填） */
  advice?: string
  /** 该项的数据来源，用于「这个结论从哪来」的可信度展示 */
  source: string
}

export interface ModelHealthReport {
  modelName: string
  baseUrl: string
  /** 是否本地端点（本地与服务端的建议不同） */
  isLocal: boolean
  /** 综合结论 */
  level: HealthLevel
  /** 一句话总结 */
  headline: string
  /** 能力画像快照 */
  capabilities: {
    contextWindow: number
    outputBudget: number
    supportsTools: boolean
    supportsVision: boolean
    isReasoning: boolean
    tier: string
    paramSizeB: number | null
  }
  /** 用户填写的上下文窗口（用于对比提示） */
  userConfiguredContext: number | null
  /** 体检项列表，按严重程度排序 */
  checks: HealthCheck[]
  /** 面向用户的行动建议（去重后的优先级列表） */
  actions: string[]
  generatedAt: string
}

// ═══════════════════════════════════════════════════════════
// 等级与排序
// ═══════════════════════════════════════════════════════════

const LEVEL_ORDER: Record<HealthLevel, number> = { blocker: 0, warn: 1, notice: 2, ok: 3 }

const LEVEL_LABEL: Record<HealthLevel, string> = {
  ok: '正常',
  notice: '提示',
  warn: '注意',
  blocker: '阻断',
}

export function levelLabel(level: HealthLevel): string {
  return LEVEL_LABEL[level]
}

// ═══════════════════════════════════════════════════════════
// 来源标签（让用户知道这个结论有多可信）
// ═══════════════════════════════════════════════════════════

function sourceLabel(s: CapabilitySource): string {
  switch (s) {
    case 'server': return '服务端报告（权威）'
    case 'explicit': return '你手动设置的'
    case 'runtime': return '运行时实测（收到过错误反馈）'
    case 'family': return '按模型名家族判断'
    case 'size': return '按模型名里的参数量档位推测'
    default: return String(s)
  }
}

/** 上下文窗口的来源是否属于「靠猜的」——决定要不要提醒用户校准 */
function contextIsGuessy(s: CapabilitySource): boolean {
  return s === 'size' || s === 'family'
}

// ═══════════════════════════════════════════════════════════
// 主入口
// ═══════════════════════════════════════════════════════════

export interface HealthReportInput {
  modelName: string
  baseUrl: string
  /** 用户在设置里填的上下文窗口；0 / undefined = 自动检测 */
  userContextWindow?: number | null
}

export function buildModelHealthReport(input: HealthReportInput): ModelHealthReport {
  const { modelName, baseUrl } = input
  const isLocal = isLocalEndpoint(baseUrl)
  const checks: HealthCheck[] = []

  // ── 1. 组装能力画像（复用既有 resolveCapabilities，不重复探测）──
  const serverFacts = recallServerFacts(modelName)
  const caps: ResolvedCapabilities = resolveCapabilities({
    modelName,
    explicitContextWindow: input.userContextWindow || null,
    server: (serverFacts as any) ?? undefined,
  })

  // 运行时实测缓存（由 400 降级 / 401 重试等路径回写）
  const runtime = getModelCapabilityCache().get(modelName)

  // ══ 体检项 1：上下文窗口的取值来源 ══
  // 这是评测中发现的最高频问题：用户填的值比模型实际能吃的大得多，
  // 导致每轮全量 prefill，首 token 极慢。所以放第一位。
  const ctxSource = caps.source.contextWindow
  const userCtx = input.userContextWindow && input.userContextWindow > 0
    ? input.userContextWindow : null

  if (userCtx != null && ctxSource === 'server' && userCtx > caps.contextWindow) {
    // P0-3 修复后 agentRunner 会取 min；这里明确告诉用户发生了什么。
    // 这是评测中命中的最高频问题，所以给它一个独立的、说得最清楚的结论。
    checks.push({
      id: 'context',
      label: '上下文窗口',
      level: 'notice',
      summary: `你填的是 ${userCtx.toLocaleString()}，但服务端报告模型实际只能吃 ${caps.contextWindow.toLocaleString()}，已按服务端为准。`,
      advice: '这是正常保护：窗口填得比模型实际能吃的大很多时，每轮都要重新预填充全部历史，'
        + '首字响应会从秒级变成分钟级。建议直接把该字段改为 0（自动检测）。',
      source: sourceLabel(ctxSource),
    })
  } else if (ctxSource === 'family') {
    checks.push({
      id: 'context',
      label: '上下文窗口',
      level: 'notice',
      summary: `未能从服务端读到实际值，按模型名推测为 ${caps.contextWindow.toLocaleString()} tokens。`,
      advice: '若首字响应明显偏慢，请在推理服务里确认实际 n_ctx 并在设置里填准确值，'
        + '或直接填 0 让服务端报告说了算。',
      source: sourceLabel(ctxSource),
    })
  } else if (contextIsGuessy(ctxSource)) {
    checks.push({
      id: 'context',
      label: '上下文窗口',
      level: 'notice',
      summary: `按模型名推测为 ${caps.contextWindow.toLocaleString()} tokens（服务端未报告实际值）。`,
      advice: '若首字响应明显偏慢，请在推理服务里确认实际 n_ctx 并在设置里填准确值。',
      source: sourceLabel(ctxSource),
    })
  } else {
    checks.push({
      id: 'context',
      label: '上下文窗口',
      level: 'ok',
      summary: `${caps.contextWindow.toLocaleString()} tokens`,
      source: sourceLabel(ctxSource),
    })
  }

  // ══ 体检项 2：工具调用能力 ══
  // 这是「模型变傻了」的第一大原因：不支持原生 function calling 时会降级成 XML 模式。
  const toolsRuntimeKnown = runtime?.supportsTools === false
  if (toolsRuntimeKnown) {
    checks.push({
      id: 'tools',
      label: '工具调用',
      level: 'notice',
      summary: '已实测确认：该模型不支持原生函数调用，已自动切换为 XML 工具调用兼容模式。',
      advice: '功能不缺失，但工具选择准确率会低于支持原生协议的模型。'
        + '若在意准确率，可换用带工具模板的指令模型（Qwen2.5 / Qwen3 / GLM-4 / Llama 3.1 等）。',
      source: '运行时实测（收到过 400 后降级）',
    })
  } else if (!caps.supportsTools) {
    // ⚠️ 服务端报告 supportsTools=false 时，caps.source.tools 仍是 'family'/'size'
    //   （能力画像不会因为服务端否定了工具就改写来源），所以这里直接用
    //   serverFacts 决定依据文案 —— 否则会出现「文案说按模型名判断、
    //   依据却写服务端报告（权威）」这种自相矛盾。
    const toolsSource = serverFacts?.supportsTools === false
      ? '服务端报告（权威）'
      : sourceLabel(caps.source.tools)
    checks.push({
      id: 'tools',
      label: '工具调用',
      level: 'notice',
      summary: serverFacts?.supportsTools === false
        ? '服务端明确报告该模型不支持原生函数调用。'
        : '按模型名判断，该模型可能不支持原生函数调用。',
      advice: '首次调用工具时若报错，会自动切换为 XML 兼容模式（功能保留，准确率略降）。',
      source: toolsSource,
    })
  } else {
    checks.push({
      id: 'tools',
      label: '工具调用',
      level: 'ok',
      summary: '支持原生函数调用',
      source: sourceLabel(caps.source.tools),
    })
  }

  // ══ 体检项 3：视觉能力 ══
  const familiesVision = serverFacts?.families?.length
    ? familiesImplyVision(serverFacts.families) : null
  const hasVision = serverFacts?.supportsVision ?? familiesVision ?? caps.supportsVision
  if (!hasVision) {
    const visionSource = serverFacts?.supportsVision !== null && serverFacts?.supportsVision !== undefined
      ? '服务端报告（权威）'
      : sourceLabel(caps.source.vision)
    checks.push({
      id: 'vision',
      label: '图片理解',
      level: caps.tier === 'nano' || caps.tier === 'small' ? 'notice' : 'ok',
      summary: '不支持图片输入',
      advice: caps.tier === 'nano' || caps.tier === 'small'
        ? '屏幕视觉 / Computer Use 需要一个单独的视觉模型。请在设置里为视觉任务单独配置（如 Qwen2.5-VL、GPT-4o、GLM-4V）。'
        : undefined,
      source: visionSource,
    })
  } else {
    checks.push({
      id: 'vision',
      label: '图片理解',
      level: 'ok',
      summary: '支持图片输入',
      source: sourceLabel(caps.source.vision),
    })
  }

  // ══ 体检项 4：输出预算 ══
  checks.push({
    id: 'output',
    label: '单次输出上限',
    level: 'ok',
    summary: `${caps.outputBudget.toLocaleString()} tokens（已自动限制在上下文窗口的一半以内）`,
    source: sourceLabel(caps.source.outputBudget),
  })

  // ══ 体检项 5：本地端点的额外提醒 ══
  if (isLocal) {
    checks.push({
      id: 'local',
      label: '本地推理',
      level: 'notice',
      summary: '本地端点并发能力有限：同一时刻只能处理一个请求。',
      advice: '已内置调度：对话进行时自动暂停记忆精炼等后台任务。'
        + '若仍感觉卡顿，多半是上下文窗口远大于模型实际 n_ctx —— 见上方「上下文窗口」一项。',
      source: '端点地址判定',
    })
  }

  // ══ 体检项 6：模型健康（运行时连续失败）══
  if (runtime && typeof (runtime as any).consecutiveFailures === 'number'
    && (runtime as any).consecutiveFailures >= 3) {
    checks.push({
      id: 'stability',
      label: '连接稳定性',
      level: 'warn',
      summary: `最近连续 ${(runtime as any).consecutiveFailures} 次请求失败。`,
      advice: '可运行 `lumina doctor` 获取完整诊断；常见原因是服务未启动 / 模型未加载 / 端口不通。',
      source: '运行时实测',
    })
  }

  // ── 排序：严重的在前 ──
  checks.sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level])

  // ── 综合结论：取最严重的一项 ──
  const level = checks.reduce<HealthLevel>(
    (worst, c) => (LEVEL_ORDER[c.level] < LEVEL_ORDER[worst] ? c.level : worst),
    'ok',
  )

  // ── 一句话总结 ──
  const blockers = checks.filter(c => c.level === 'blocker').length
  const warns = checks.filter(c => c.level === 'warn').length
  const notices = checks.filter(c => c.level === 'notice').length

  const headline = blockers > 0
    ? `发现 ${blockers} 个阻断问题，该模型当前无法正常使用。`
    : warns > 0
      ? `${modelName} 基本可用，但有 ${warns} 项需要注意。`
      : notices > 0
        ? `${modelName} 可正常使用，有 ${notices} 项优化建议。`
        : `${modelName} 状态良好，各项能力均正常。`

  // ── 行动建议（按严重程度去重）──
  const actions = checks
    .filter(c => c.advice)
    .sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level])
    .map(c => `【${LEVEL_LABEL[c.level]}】${c.label}：${c.advice}`)

  return {
    modelName,
    baseUrl,
    isLocal,
    level,
    headline,
    capabilities: {
      contextWindow: caps.contextWindow,
      outputBudget: caps.outputBudget,
      supportsTools: caps.supportsTools,
      supportsVision: caps.supportsVision,
      isReasoning: caps.isReasoning,
      tier: caps.tier,
      paramSizeB: caps.paramSizeB,
    },
    userConfiguredContext: userCtx,
    checks,
    actions,
    generatedAt: new Date().toISOString(),
  }
}

/** 转成纯文本，供 CLI / 复制到剪贴板 / 日志使用 */
export function formatHealthReportText(r: ModelHealthReport): string {
  const lines: string[] = []
  lines.push(`模型体检报告 · ${r.modelName}`)
  lines.push(`端点：${r.baseUrl}${r.isLocal ? '（本地）' : ''}`)
  lines.push(`结论：${r.headline}`)
  lines.push('')
  for (const c of r.checks) {
    lines.push(`[${LEVEL_LABEL[c.level]}] ${c.label}：${c.summary}`)
    if (c.advice) { lines.push(`        → ${c.advice}`) }
    lines.push(`        （依据：${c.source}）`)
  }
  if (r.actions.length > 0) {
    lines.push('')
    lines.push('建议：')
    for (const a of r.actions) { lines.push(`  · ${a}`) }
  }
  return lines.join('\n')
}
