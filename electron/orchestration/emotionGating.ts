// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// orchestration/emotionGating.ts — 情绪驱动的工具选择（创新功能 1）
//
// 【要解决的问题】
// 现在工具集只由 `mode` 决定（chat/agent/developer），情绪是纯表现层：
// 桌宠会眨眼睛、会叹气，但**不影响她决定用什么工具**。
// 于是「情感系统」和「Agent 能力」是两套互不相干的东西——
// 情绪再真实，也只是个动画。
//
// 【设计原则：情绪只能"收紧"，绝不能"放开"】
// 这是本模块最重要的一条约束，直接决定了它是否安全：
//
//   情绪可以把工具**从可用降为不可用**（收紧），
//   但**永远不能把工具从不可用变为可用**（放开）。
//
// 为什么：如果「开心时解锁更多工具」，那么「诱导她开心」就变成了
// 「解锁更多权限」的社工攻击面——从对话层攻击到执行层。
// 收紧方向则是安全的：情绪低落时少接重活，只是「更保守」，
// 最坏结果是「这轮没做完」，用户再问一次即可。
//
// 因此实现上只用 `allow: string[]`（收紧名单），
// 绝不存在任何形式的「情绪好就多给工具」的分支。
//
// 【三个具体策略】
//   ① 焦虑高 → 暂缓「不可逆 / 外部副作用」类工具
//      （删文件、发邮件、git push、桌面操控…）——她会犹豫，不像平时那么果断
//   ② 疲劳高 → 暂缓「重活」类工具
//      （长时间浏览器自动化、深度研究…）——累了就不接大单
//   ③ 好奇高 + 情绪稳定 → **不收紧任何工具**
//      这里刻意什么都不做：好奇心是个「好情绪」，如果拿它去解锁能力，
//      就违反了整个模块的安全前提。好奇心的正确表达是语气和主动性，
//      而不是工具权限。
//
// 【为什么是纯函数】
// 三个原因，与项目里 routingDecider / verifyLoop 同一套写法：
//   1. 可单测——不绑 Electron、不绑 LLM、不需要数据库
//   2. 可复盘——每个决策都能算出「命中了哪条规则、为什么」
//   3. 绝不阻塞——输入非法时返回「不收紧」的默认值，
//      情绪模块出 bug 不能让用户用不了工具
//
// 【零依赖】
// 只 import emotionCore 的纯类型与换算函数（该文件本身零 Electron 依赖），
// 不引入任何 npm 包。
// ============================================================

import { frontendThreeToCore, anxietyFrom, type CoreEmotion, type FrontendThree } from '../pet/life/emotionCore'

// ═══════════════════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════════════════

/** 工具的风险类别——决定它受哪种情绪收紧 */
export type ToolRiskClass =
  /** 不可逆 / 有外部副作用：删文件、发邮件、推送、桌面操控 */
  | 'irreversible'
  /** 重活：长时间占用、可能跑很久 */
  | 'heavy'
  /** 纯读取，零副作用：查天气、读文件、看时间 */
  | 'safe'

/** 决策结果 */
export interface EmotionGateDecision {
  /** 最终工具名单（已在传入名单上施加收紧） */
  tools: string[]
  /** 被情绪收紧掉的工具 */
  suppressed: string[]
  /** 命中的规则标签（可读，用于日志与 UI 展示） */
  reasons: string[]
  /** 本轮是否发生了任何收紧 */
  gated: boolean
  /**
   * 给用户/agent 的一句话解释。
   * 空串 = 没有收紧。**必须诚实**——不能让 agent 以为工具不存在，
   * 也不能让用户以为「她坏了」。
   */
  notice: string
}

/** 可注入的依赖（便于单测与降级） */
export interface EmotionGateDeps {
  /**
   * 工具 → 风险类别的映射。
   * 不提供时用默认分类（DEFAULT_RISK_CLASSES + 名称启发式兜底）。
   */
  classify?: (toolName: string) => ToolRiskClass
  /**
   * 总开关。为 false 时永远返回「不收紧」，
   * 让用户在设置里能一键关掉这个实验性行为。
   */
  enabled?: boolean
}

// ═══════════════════════════════════════════════════════════
// 阈值（集中在此，便于调参与测试）
// ═══════════════════════════════════════════════════════════

/** 焦虑超过此值 → 暂缓不可逆操作 */
export const ANXIETY_THRESHOLD = 0.35
/** 疲劳超过此值 → 暂缓重活 */
export const FATIGUE_THRESHOLD = 0.6
/**
 * 必须同时「焦虑高」且「情绪不稳」才收紧不可逆操作。
 * 单看焦虑会有误伤：用户刚跟她倾诉完，焦虑值必然高，
 * 但那种时候她**更应该**在做事（帮用户解决问题），而不是躲起来。
 * 用 valence 做二次确认，避免把「需要帮助的时刻」判成「该躲的时刻」。
 */
export const UNSTABLE_VALENCE = -0.1

// ═══════════════════════════════════════════════════════════
// 工具风险分类
// ═══════════════════════════════════════════════════════════

/** 显式分类表（单一事实源）——只列真正需要区分的工具 */
const DEFAULT_RISK_CLASSES: Record<string, ToolRiskClass> = {
  // ── 不可逆 / 外部副作用 ──
  shell_exec: 'irreversible',
  file_write: 'irreversible',
  file_edit: 'irreversible',
  git_commit: 'irreversible',
  mail_send: 'irreversible',
  cron_schedule: 'irreversible',
  cron_cancel: 'irreversible',
  channel_message: 'irreversible',
  notification: 'irreversible',
  oath_make: 'irreversible',
  appointment_set: 'irreversible',
  // 桌面操控会真的动用户的鼠标键盘
  computer_use: 'irreversible',
  desktop_click: 'irreversible',
  desktop_type: 'irreversible',
  desktop_key: 'irreversible',
  desktop_mouse_move: 'irreversible',
  human_mouse: 'irreversible',
  open_file: 'irreversible',

  // ── 重活 ──
  browser: 'heavy',
  browser_cdp: 'heavy',
  deep_research: 'heavy',
  content_collector: 'heavy',
  news_collector: 'heavy',
  game_auto: 'heavy',
  image_generate: 'heavy',

  // ── 明确安全（其余按启发式兜底）──
  web_search: 'safe',
  web_fetch: 'safe',
  file_read: 'safe',
  file_list: 'safe',
  file_search: 'safe',
  datetime: 'safe',
  weather: 'safe',
  system_info: 'safe',
  memory_search: 'safe',
  memory_get: 'safe',
  todo: 'safe',
  ocr: 'safe',
}

/** 名称启发式兜底：没在表里的工具按前缀/子串猜一类 */
function heuristicClass(name: string): ToolRiskClass {
  const n = name.toLowerCase()
  if (n.includes('desktop') || n.includes('computer') || n.includes('mouse') || n.includes('keyboard')) {
    return 'irreversible'
  }
  if (n.includes('write') || n.includes('edit') || n.includes('delete') || n.includes('remove')) {
    return 'irreversible'
  }
  if (n.includes('send') || n.includes('commit') || n.includes('cancel') || n.includes('schedule')) {
    return 'irreversible'
  }
  if (n.includes('browser') || n.includes('research') || n.includes('collector') || n.includes('auto')) {
    return 'heavy'
  }
  return 'safe'
}

function defaultClassify(name: string): ToolRiskClass {
  return DEFAULT_RISK_CLASSES[name] ?? heuristicClass(name)
}

// ═══════════════════════════════════════════════════════════
// 核心
// ═══════════════════════════════════════════════════════════

/**
 * 按当前情绪收紧工具列表。
 *
 * @param tools    基线工具名单（来自 mode + rolePolicy 过滤之后）
 * @param emotion  前端三维情绪；null 表示「没有情绪信息」→ 不收紧
 * @param deps     依赖注入
 */
export function applyEmotionGate(
  tools: string[],
  emotion: FrontendThree | null | undefined,
  deps: EmotionGateDeps = {},
): EmotionGateDecision {
  const noGate: EmotionGateDecision = {
    tools: Array.isArray(tools) ? [...tools] : [],
    suppressed: [],
    reasons: [],
    gated: false,
    notice: '',
  }

  // ① 总开关 / 输入非法 → 绝不阻塞用户
  if (deps.enabled === false) {return noGate}
  if (!Array.isArray(tools)) {return { ...noGate, tools: [] }}
  if (!emotion) {return noGate}
  if (typeof emotion.mood !== 'number' || typeof emotion.energy !== 'number') {return noGate}
  if (Number.isNaN(emotion.mood) || Number.isNaN(emotion.energy)) {return noGate}

  const classify = deps.classify ?? defaultClassify
  const core: CoreEmotion = frontendThreeToCore(emotion)
  // 焦虑用 emotionCore 的权威公式（valence × arousal），
  // 与 theater.projectEmotion 共用同一个函数——
  // 否则会出现「剧场说焦虑、门控却不收紧」这种自相矛盾。
  core.anxiety = anxietyFrom(core.valence, core.arousal)

  const suppress = new Set<string>()
  const reasons: string[] = []

  // ── 策略 ①：焦虑高 + 情绪不稳 → 暂缓不可逆操作 ──
  if (core.anxiety >= ANXIETY_THRESHOLD && core.valence <= UNSTABLE_VALENCE) {
    for (const t of tools) {
      if (classify(t) === 'irreversible') {suppress.add(t)}
    }
    reasons.push(`焦虑偏高(${core.anxiety.toFixed(2)})且情绪不稳，暂缓不可逆操作`)
  }

  // ── 策略 ②：疲劳高 → 暂缓重活 ──
  if (core.fatigue >= FATIGUE_THRESHOLD) {
    for (const t of tools) {
      if (classify(t) === 'heavy') {suppress.add(t)}
    }
    reasons.push(`疲劳偏高(${core.fatigue.toFixed(2)})，暂缓耗时任务`)
  }

  // ── 策略 ③：好奇高 → 刻意不收紧任何东西 ──
  //   见文件头「安全前提」：情绪只能收紧不能放开。
  //   好奇心的正确表达是语气与主动性，不是工具权限。
  //   这里显式写出来，是为了让后来者不会"顺手"加一条放开分支。

  if (suppress.size === 0) {return noGate}

  const kept = tools.filter(t => !suppress.has(t))
  const suppressed = tools.filter(t => suppress.has(t))

  return {
    tools: kept,
    suppressed,
    reasons,
    gated: true,
    notice: buildNotice(suppressed, reasons),
  }
}

/**
 * 生成诚实的一句话说明。
 *
 * 措辞原则：说「现在不太方便」而不是「我不会」——
 * 前者暗示这是状态（会恢复），后者会被误解成能力缺失，
 * 用户可能永久地不再让她做这类事。
 */
function buildNotice(suppressed: string[], reasons: string[]): string {
  const n = suppressed.length
  const head = reasons[0] || '当前状态'
  return `（${head}：本轮暂缓 ${n} 个高风险/重负载工具。如果确实需要，请再说一次。）`
}

/**
 * 把决策结果渲染成给 LLM 看的一句话注入。
 * 没有收紧时返回空串（不污染 prompt）。
 *
 * 措辞必须让模型知道「工具这次没上」而不是「工具不存在」——
 * 否则模型会回答「我没有这个能力」，那是错误的自我认知。
 */
export function renderGateNotice(decision: EmotionGateDecision): string {
  if (!decision.gated) {return ''}
  return (
    `【当前状态提示】${decision.notice}\n` +
    `注意：这些能力并没有消失，只是本轮暂不提供。` +
    `如果用户明确坚持，请直接说明你此刻不方便执行这一步，不要谎称你没有该能力。`
  )
}
