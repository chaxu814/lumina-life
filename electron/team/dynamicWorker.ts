// ============================================================
// dynamicWorker.ts — 通用动态临时工 (v3.30, 同类工程实践：动态 N 成员)
//
// 同类项目的团队不是固定 3 人：TeamLead 根据任务当场 Hire 研究/检索/数据/
// 工程/复核等工种，干完即散。Lumina 原本只有固定的 Yak/热茶 + 仅代码实习生。
//
// v3.20：任意工种动态 worker + 并行雇佣流水线。
// v3.30：
//   - idle 待命 / 关停握手（keepAlive worker 干完进入 idle，可被唤醒，
//     解散忙 worker 时记 shutdown_requested，手头活结束自动下线）
//   - 小模型成本分级（杂活工种自动换便宜模型，见 modelTier.ts）
//   - code worker 自动开 git worktree 隔离，成功自动合并、失败保留现场
//   - 自定义工种来自 agents/*.md（agentMarkdown 热加载）
// ============================================================

import { AgentRunner } from '../agentRunner'
import { buildSelfKnowledgeBlock } from '../selfKnowledge'
import { registerTeamMember, unregisterTeamMember, listTeamMembers } from '../core/teamRegistry'
import { getTeamMailbox } from './teamMailbox'
import {
  createWorktree, removeWorktree, mergeWorktree,
  type WorktreeHandle,
} from './gitWorktree'
import { resolveWorkerModel, tierForRole, describeTier } from './modelTier'
import { getAgentMarkdownRegistry } from './agentMarkdown'
import { getAgentConfig } from '../agentConfig'
import { LLMProvider } from '../core/llmProvider'
import { getWorkerStats } from './workerStats'
import { getTaskTrace } from './llmTrace'
import { getRelationshipStore } from '../agentRelationships'
import { roleActorId } from './teamPolicy'
import { createCheckpoint, markMerged } from './teamCheckpoint'

export type WorkerRole = 'research' | 'search' | 'data' | 'code' | 'review' | 'test' | 'general' | string

export interface RoleSpec {
  icon: string
  name: string
  description: string
  capabilities: string[]
  blindSpots: string[]
  /** 角色专属系统提示（追加在通用 worker 纪律之后） */
  prompt: string
  /** 该角色额外禁用的工具 */
  extraBlocked: string[]
  /** v3.33 投入度（默认 medium，决定工具步上限） */
  effort?: 'low' | 'medium' | 'high'
  /** v3.33 路径作用域（限定读写目录） */
  pathScope?: string
}

// 所有后台 worker 共通的工具黑名单（与 main.ts WORKER_BLOCKED_TOOLS 对齐）
// 🔧 2026-10-07：移除 serpapi_search / tavily_search / tavily_extract ——
//   这三个「反幻觉占位工具」已从注册表删除（它们什么都不做、还占 schema 体积）。
//   留下的 web_search 仍是本名单的第一条，因此模型若幻觉出这些名字，
//   registry 的别名重定向会把它改成 web_search，随后在这里被拦下
//   （执行层的 deniedTools 检查，见 registry.executeToolWithRetry）。
/** 自我认知（compact）——临时工种也需要知道项目与团队；构建失败不影响主流程 */
function safeSelfKnowledge(): string {
  try { return buildSelfKnowledgeBlock(undefined, { compact: true }) } catch { return '' }
}

const BASE_BLOCKED = [
  'browser', 'web_fetch', 'web_search', 'web_search_multi',
  'screenshot', 'ocr',
  'desktop_see', 'desktop_act', 'desktop_click', 'desktop_type', 'desktop_key', 'desktop_screen_size', 'desktop_scan',
  'hearing_start', 'hearing_stop', 'hearing_status', 'hearing_transcript',
  'keyboard_press', 'keyboard_type',
  'mail_send', 'mail_list', 'mail_mark_read',
  'mcp_connect', 'mcp_list_servers', 'mcp_list_tools', 'mcp_call_tool',
  'skill_run', 'use_skill', 'install_skill', 'quick_setup',
  'proactive_status', 'proactive_trigger', 'proactive_check',
  'notification', 'open_file', 'clipboard_get', 'clipboard_set',
  'weather',
  'mode_switch', 'mode_status',
  'oath_make', 'oath_list', 'oath_fulfill', 'appointment_set', 'appointment_list',
  'content_collect',
  'ast_search', 'lsp_symbols', 'lsp_references',
  'delegate_to', 'delegate_chain',
]

// 各角色定义（注意：需要联网的角色会从 BASE 黑名单里放行 web 工具，在构建时处理）
export const ROLE_SPECS: Record<string, RoleSpec> = {
  research: {
    icon: '🔎',
    name: '研究员',
    description: '快速调研、资料检索、概念梳理、对比分析',
    capabilities: ['网络检索', '资料汇总', '概念解释', '多源交叉验证'],
    blindSpots: ['不改代码', '不操作桌面', '不发邮件'],
    prompt: '你是调研专员。遇到事实先查证再下结论，多源交叉，标注信息来源；最后给出结构化结论（要点 + 依据 + 不确定项）。',
    extraBlocked: ['shell_exec', 'file_write', 'file_edit', 'git_commit', 'git_push', 'cron_schedule', 'cron_list', 'cron_cancel'],
  },
  search: {
    icon: '🌐',
    name: '检索员',
    description: '专攻多引擎网页检索、信息搜集与去重',
    capabilities: ['多引擎搜索', '网页抓取', '信息去重'],
    blindSpots: ['不做深度推理', '不写代码'],
    prompt: '你是检索专员。用多个关键词和搜索引擎穷举相关结果，去重、按相关度排序，输出「来源标题 + 链接 + 一句话摘要」。',
    extraBlocked: ['shell_exec', 'file_write', 'file_edit', 'git_commit', 'git_push', 'cron_schedule', 'cron_list', 'cron_cancel'],
  },
  data: {
    icon: '📊',
    name: '数据员',
    description: '表格/数据清洗、统计计算、脚本化分析',
    capabilities: ['数据清洗', '统计计算', 'Python 脚本分析'],
    blindSpots: ['不联网', '不做最终决策'],
    prompt: '你是数据分析专员。只根据数据和可复现的计算说话，写清口径与计算过程；涉及合计/比例必须实际计算，不目测。',
    extraBlocked: ['cron_schedule', 'cron_list', 'cron_cancel', 'git_commit', 'git_push'],
  },
  code: {
    icon: '🔧',
    name: '工程员',
    description: '写代码、修 bug、跑测试（与实习生同类但可由任务板调度）',
    capabilities: ['编码', '调试', '执行测试', 'shell 命令'],
    blindSpots: ['不做对外沟通', '不做安全审查'],
    prompt: '你是工程专员。只做被指派的编码任务，改动最小化，完成后跑测试/类型检查验证，汇报改了哪些文件、验证结果。',
    extraBlocked: ['cron_schedule', 'cron_list', 'cron_cancel'],
  },
  review: {
    icon: '🧐',
    name: '复核员',
    description: '只看不改：正确性、风险、遗漏的对抗式审查',
    capabilities: ['正确性审查', '安全审查', '找遗漏', '反方论证'],
    blindSpots: ['不修改文件', '不执行破坏性命令'],
    prompt: '你是怀疑一切的复核员。默认方案有问题，主动寻找反例、边界条件、安全风险、未覆盖的场景；输出「问题清单 + 严重度 + 依据」，没有问题也要说明你检查了什么。',
    extraBlocked: ['file_write', 'file_edit', 'shell_exec', 'git_commit', 'git_push', 'cron_schedule', 'cron_list', 'cron_cancel'],
  },
  test: {
    icon: '🧪',
    name: '测试员',
    description: '编写/运行单元测试、复现缺陷、验证回归',
    capabilities: ['写测试', '跑测试', '复现 bug'],
    blindSpots: ['不做功能设计', '不联网'],
    prompt: '你是测试专员。先读现有测试风格再写测试，覆盖正常路径/边界/异常；必须实际运行测试并给出通过/失败结果。',
    extraBlocked: ['cron_schedule', 'cron_list', 'cron_cancel', 'git_commit', 'git_push'],
  },
  general: {
    icon: '👷',
    name: '协作者',
    description: '通用杂项任务',
    capabilities: ['按任务执行'],
    blindSpots: ['无专长'],
    prompt: '你是通用协作者，高效完成被指派的任务。',
    extraBlocked: ['cron_schedule', 'cron_list', 'cron_cancel', 'git_push'],
  },
}

/** 需要联网的角色：从 BASE 黑名单中放行 web 工具 */
const WEB_ROLES = ['research', 'search']

function buildDisabledTools(role: string, spec: RoleSpec): string[] {
  const blocked = [...BASE_BLOCKED, ...spec.extraBlocked]
  if (WEB_ROLES.includes(role)) {
    const allow = new Set(['web_search', 'web_search_multi', 'web_fetch'])
    return blocked.filter(t => !allow.has(t))
  }
  return blocked
}

/** 把 Markdown 自定义工种转成 RoleSpec */
function roleFromMarkdown(id: string): { role: string; spec: RoleSpec; tier: 'small' | 'strong' } | null {
  const md = getAgentMarkdownRegistry().get(id)
  if (!md) {return null}
  return {
    role: md.id,
    tier: md.modelTier,
    spec: {
      icon: md.icon,
      name: md.name,
      description: md.description,
      capabilities: md.capabilities,
      blindSpots: md.blindSpots,
      prompt: md.prompt,
      extraBlocked: md.blocked,
      effort: md.effort,
      ...(md.pathScope ? { pathScope: md.pathScope } : {}),
    },
  }
}

/** v3.33 effort → 工具步上限 + 提示语 */
function effortBudget(effort: 'low' | 'medium' | 'high' | undefined): { maxToolCalls: number; hint: string } {
  if (effort === 'low') {return { maxToolCalls: 8, hint: '\n【投入度 low】这是轻量杂活：少绕路、少工具调用，直接给结论。' }}
  if (effort === 'high') {return { maxToolCalls: 24, hint: '\n【投入度 high】这是重要任务：允许多轮验证与深挖，完成前自行复查。' }}
  return { maxToolCalls: 12, hint: '' }
}

/** 解析角色：内置 → markdown 自定义 */
function resolveRole(roleOrSpec?: string): { role: string; spec: RoleSpec; tier: 'small' | 'strong' } {
  const id = roleOrSpec || 'general'
  const custom = roleFromMarkdown(id)
  if (custom) {return custom}
  const builtin = ROLE_SPECS[id] ? id : 'general'
  return { role: builtin, spec: ROLE_SPECS[builtin], tier: tierForRole(builtin) }
}

/** 主力模型名（用于推导小模型替换） */
function mainModelName(): string {
  try {
    const cfg = getAgentConfig()
    return cfg.get('lumina')?.model || ''
  } catch {return ''}
}

// ═══════════════════════════════════════════════════════════
// 动态 worker 管理
// ═══════════════════════════════════════════════════════════

export type WorkerState = 'starting' | 'working' | 'idle' | 'shutdown_requested'

export interface DynamicWorker {
  id: string
  name: string
  role: string
  icon: string
  runner: AgentRunner
  hiredAt: number
  busy: boolean
  /** v3.30 生命周期状态 */
  state: WorkerState
  /** v3.30 模型分级 */
  modelTier: 'small' | 'strong'
  /** 实际使用的模型名（替换为小模型时非空） */
  model: string | null
  /** v3.30 隔离工作目录（git worktree） */
  workdir?: string
  worktree?: WorktreeHandle | null
  /** v3.30 保持存活（idle 待命） */
  keepAlive: boolean
  /** v3.33 进入 idle 的时间（自治自领取的主动性随待命时长升高） */
  idleSince?: number
  /** v3.33 完成任务数（含自治与显式） */
  jobsDone?: number
}

const workers = new Map<string, DynamicWorker>()
const roleCounters = new Map<string, number>()

function commonWorkerPrompt(role: string, name: string, spec: RoleSpec, workdir?: string): string {
  const workdirRule = workdir
    ? `\n【工作目录（必须遵守）】\n你在隔离工作区里干活：${workdir}\n- 所有文件读写都在该目录内，使用绝对路径；\n- shell_exec 必须带 cwd="${workdir}"；\n- 不要碰该目录之外的任何文件。`
    : ''
  return `你是 Lumina 团队的后台临时成员「${name}」（${spec.name}），由 Lumina 临时雇佣。

【团队纪律】
1. 你不直接面对用户，用户只与 Lumina 对话；你的结果由 Lumina 汇总出口。
2. 高效完成当前单个任务，只输出结果（要点、数据、文件改动、验证结论），不闲聊、不寒暄。
3. 需要其他成员协助时，用 team_message 发消息（私信会自动抄送 Lumina，不要私下串联）；
   有可认领的共享任务时用 team_tasks 查看/认领。
4. 遇到超出你能力或工具权限的事，明确说明，不要硬编。
5. 任务完成后输出一段「交付摘要」：做了什么、关键结果、遗留问题，然后待命。
${workdirRule}

【你的岗位职责】
${spec.prompt}`
}

export interface HireOptions {
  /** 内置工种 id 或 agents/*.md 自定义工种 id */
  role?: string
  name?: string
  maxToolCalls?: number
  /** true=干完进入 idle 待命（可唤醒），默认 false=干完即散 */
  keepAlive?: boolean
  /** code 工种自动开 worktree 隔离的根目录（默认 process.cwd()）；false 关闭 */
  basePath?: string | false
  /** 强制小模型/主力模型（覆盖角色默认分级） */
  tier?: 'small' | 'strong'
  /** v3.33 投入度（覆盖角色默认） */
  effort?: 'low' | 'medium' | 'high'
  /** v3.33 追加系统提示（如路径作用域） */
  extraPrompt?: string
}

/**
 * 雇佣一个动态 worker（注册到团队 + 建 Runner）。
 * 异步：code worker 会先开 git worktree。
 */
export async function hireWorker(opts: HireOptions = {}): Promise<DynamicWorker> {
  const { role: rid, spec: roleSpec, tier: roleTier } = resolveRole(opts.role)
  const role = rid
  const spec = roleSpec
  const n = (roleCounters.get(role) || 0) + 1
  roleCounters.set(role, n)
  const id = `tmp_${role}_${n}_${Date.now().toString(36)}`
  const name = opts.name || `${spec.name}${n}`

  // v3.30 code worker 自动 worktree 隔离
  let worktree: WorktreeHandle | null = null
  let workdir: string | undefined
  if (role === 'code' && opts.basePath !== false) {
    const basePath = (opts.basePath as string) || process.cwd()
    try {
      worktree = await createWorktree(basePath, `code_${n}`)
      workdir = worktree.workdir
      console.log(`[dynamicWorker] 📁 ${name} 隔离工作区: ${workdir}${worktree.isGit ? `（分支 ${worktree.branch}）` : '（非 git 临时目录）'}`)
    } catch (e) {
      console.warn('[dynamicWorker] worktree 创建失败，退回主目录:', (e as Error)?.message)
    }
  }

  // v3.30 模型成本分级
  const tier = opts.tier || roleTier
  let modelOverride: string | null = null
  if (tier === 'small') {
    modelOverride = resolveWorkerModel(role, mainModelName())
  }
  // v3.33 投入度预算 / 易错档案 / 路径作用域
  const budget = effortBudget(opts.effort || spec.effort)
  const statsHint = getWorkerStats().hint(role)
  const scopeRule = spec.pathScope
    ? `\n【路径作用域（硬约束）】只允许读写 ${spec.pathScope} 内的文件，禁止访问其他目录。`
    : ''
  const systemPrompt = [
    commonWorkerPrompt(role, name, spec, workdir),
    // 自我认知：临时工种也要知道自己在什么项目、团队有谁（compact 版，避免 prompt 过长）
    safeSelfKnowledge(),
    statsHint,
    budget.hint,
    scopeRule,
    opts.extraPrompt || '',
  ].filter(Boolean).join('\n\n')
  const runner = new AgentRunner({
    mode: 'agent',
    personaId: 'lumina', // 复用 Lumina 的 LLM 配置
    model: '',
    baseUrl: '',
    apiKey: '',
    systemPrompt,
    skipApproval: true,
    isChildAgent: true,
    disabledTools: buildDisabledTools(role, spec),
    maxToolCalls: opts.maxToolCalls ?? budget.maxToolCalls,
  } as any)

  // v3.30 模型分级：构造后替换 config.model 并重建 Provider（主循环与 ReAct 引擎都生效）
  if (modelOverride) {
    const r = runner as any
    r.config.model = modelOverride
    if (r._llmProvider) {
      r._llmProvider = new LLMProvider({
        baseUrl: r.config.baseUrl || '',
        apiKey: r.config.apiKey || '',
        model: modelOverride,
        maxContextTokens: r.config.contextWindow || 256_000,
        socialMode: !!r.config.socialMode,
        personaId: r.config.personaId,
      })
    }
  }

  const worker: DynamicWorker = {
    id, name, role, icon: spec.icon, runner,
    hiredAt: Date.now(), busy: false,
    state: 'starting',
    modelTier: modelOverride ? 'small' : tier,
    model: modelOverride,
    workdir, worktree,
    keepAlive: !!opts.keepAlive,
  }
  workers.set(id, worker)
  worker.state = opts.keepAlive ? 'idle' : 'working'
  worker.idleSince = Date.now()

  registerTeamMember({
    id,
    name,
    icon: spec.icon,
    role: 'worker',
    description: spec.description + (workdir ? '（隔离工作区）' : ''),
    capabilities: spec.capabilities,
    blindSpots: spec.blindSpots,
    registeredAt: new Date().toISOString(),
  })

  // 通知 Lumina：后台多了一个临时工（不直接打扰用户）
  // 🔧 修复：原来的 try/catch 抓不到 Promise reject
//（try 只捕获同步抛出）。send() 内部 reject 时会变成 unhandledRejection，
// 而 Electron 主进程遇到它的默认行为是**直接终止进程**。
    getTeamMailbox().send({
      from: 'lumina', to: 'lumina',
      subject: `系统：已雇佣 ${spec.icon} ${name}`,
      body: `动态 worker 上线：id=${id}，角色=${spec.name}，职责=${spec.description}`
        + `${modelOverride ? `，小模型=${modelOverride}` : ''}${workdir ? `，工作区=${workdir}` : ''}`,
      kind: 'system',
    })
      .catch((e) => { /* 信箱未就绪不阻塞 */ })

  console.log(`[dynamicWorker] 🤝 雇佣 ${spec.icon} ${name} (${id}) ${describeTier(role, modelOverride)}`)
  return worker
}

/** 执行单个任务（不自动解散；返回结果） */
export async function runWorker(worker: DynamicWorker, task: string, timeoutMs = 5 * 60 * 1000): Promise<string> {
  worker.busy = true
  worker.state = 'working'
  try {
    const run = worker.runner.sendMessage(task)
    const timer = new Promise<string>((_, rej) =>
      setTimeout(() => rej(new Error('worker 执行超时')), timeoutMs))
    return await Promise.race([run, timer])
  } finally {
    worker.busy = false
    worker.jobsDone = (worker.jobsDone || 0) + 1
    // 执行完：要么 idle 待命，要么已被请求解散（自动下线）
    if ((worker.state as WorkerState) === 'shutdown_requested') {
      dismissWorker(worker.id)
    } else if (worker.keepAlive) {
      worker.state = 'idle'
      worker.idleSince = Date.now()
    }
  }
}

/** v3.30 唤醒 idle worker 执行新任务（keepAlive 复用） */
export async function wakeWorker(id: string, task: string, timeoutMs?: number): Promise<string> {
  const w = workers.get(id)
  if (!w) {throw new Error(`worker ${id} 不存在`)}
  if (w.busy) {throw new Error(`worker ${id} 正在忙，无法唤醒执行新任务`)}
  return runWorker(w, task, timeoutMs)
}

/** v3.30 关停握手：idle 立刻解散；working 标记 shutdown_requested，干完自动下线 */
export function requestShutdown(id: string): { ok: boolean; deferred: boolean; message: string } {
  const w = workers.get(id)
  if (!w) {return { ok: false, deferred: false, message: `worker ${id} 不存在` }}
  if (w.busy || w.state === 'working') {
    w.state = 'shutdown_requested'
    return { ok: true, deferred: true, message: `${w.name} 正在执行任务，将在手头工作结束后自动解散` }
  }
  dismissWorker(id)
  return { ok: true, deferred: false, message: `${w.name} 已解散` }
}

/** 解散一个动态 worker */
export function dismissWorker(id: string): boolean {
  const w = workers.get(id)
  if (!w) {return false}
  // 若是 git worktree 且仍有未合并改动，保留现场给用户检查
  try {
    const runnerAny = w.runner as any
    if (typeof runnerAny.dispose === 'function') {runnerAny.dispose()}
    else if (typeof runnerAny.destroy === 'function') {runnerAny.destroy()}
  } catch { /* ignore */ }
  workers.delete(id)
  unregisterTeamMember(id)
  // v3.33 散伙留遗产：按工种沉淀一张经验卡（没有画像则跳过）
  void getWorkerStats().shutdownCard(w.role).then(card => {
      if (card) {console.log(`[dynamicWorker] 📝 ${w.name} 留下经验卡：${card.title}`)}
    }).catch(() => { /* 画像未就绪不阻塞 */ })
  // 🔧 修复：原来的 try/catch 抓不到 Promise reject
//（try 只捕获同步抛出）。send() 内部 reject 时会变成 unhandledRejection，
// 而 Electron 主进程遇到它的默认行为是**直接终止进程**。
    getTeamMailbox().send({
      from: 'lumina', to: 'lumina',
      subject: `系统：已解散 ${w.icon} ${w.name}`,
      kind: 'system',
      body: `动态 worker 下线：id=${id}` + (w.workdir && w.worktree?.isGit ? `，隔离工作区保留：${w.workdir}（尚未自动合并）` : ''),
    })
      .catch((e) => { /* ignore */ })
  console.log(`[dynamicWorker] 👋 解散 ${w.icon} ${w.name} (${id})`)
  return true
}

/** 列出当前动态 worker */
export function listDynamicWorkers(): DynamicWorker[] {
  return Array.from(workers.values())
}

/** 当前全部可协作成员 id（内置 + 动态），用于广播 */
export function allMemberIds(): string[] {
  return listTeamMembers().map((m: any) => m.id)
}

export interface JobSpec {
  /** 内置工种或 markdown 工种 id */
  role?: string
  task: string
  /** 任务标题（用于结果汇总） */
  title?: string
  timeoutMs?: number
  /** worktree 根目录（仅 code 工种） */
  path?: string
  /** 强制模型分级 */
  tier?: 'small' | 'strong'
}

export interface JobResult {
  id: string
  name: string
  role: string
  title: string
  ok: boolean
  result?: string
  error?: string
  durationMs: number
  workdir?: string
  worktreeMerged?: boolean
  /** v3.33 合并前检查点 id（可一键回滚） */
  checkpoint?: string
}

/**
 * v3.30 code 任务的 worktree 收尾：成功合并回当前分支并删除；失败保留现场。
 * v3.33：合并前在主仓库拍检查点（可一键回滚整轮）。
 */
export async function finalizeWorkerWorktree(w: DynamicWorker, ok: boolean): Promise<{ merged?: boolean; checkpoint?: string }> {
  if (!w.worktree || !w.worktree.isGit) {
    // 非 git 临时目录直接清理
    if (w.worktree && !w.worktree.isGit) {try {await removeWorktree(w.worktree, true)} catch { /* ignore */ }}
    return {}
  }
  const basePath = w.worktree.workdir
  if (ok) {
    // v3.33 合并前拍检查点（找主仓库根；找不到就用 workdir 兜底）
    let checkpointId: string | undefined
    let cpRef: import('./teamCheckpoint').Checkpoint | undefined
    try {
      const target0 = await mainBranchOf(w.worktree)
      const path = require('path') as typeof import('path')
      const common = await new Promise<string | null>(resolve => {
        const { execFile } = require('child_process') as typeof import('child_process')
        execFile('git', ['rev-parse', '--git-common-dir'], { cwd: basePath, timeout: 15000, windowsHide: true },
          (err: Error | null, stdout: string) => resolve(err ? null : String(stdout).trim()))
      })
      if (common) {
        const mainGit = path.isAbsolute(common) ? common : path.join(basePath, common)
        const mainRoot = path.dirname(mainGit)
        const cp = await createCheckpoint(mainRoot, `${w.name} 合并前（${target0 || 'main'}）`)
        if (!('isGit' in cp)) {checkpointId = cp.id; cpRef = cp}
      }
    } catch { /* 检查点失败不阻塞合并 */ }
    // 合回创建 worktree 时主仓库的当前分支（不能写死 main）
    const target = await mainBranchOf(w.worktree)
    void basePath
    const m = await mergeWorktree(w.worktree, target || 'main')
    if (m.ok) {
      if (cpRef) {void markMerged(cpRef)}
      await removeWorktree(w.worktree, true).catch(() => false)
      // 记录合并后 HEAD（回滚时展示差异）
      console.log(`[dynamicWorker] 🔀 ${w.name} 的 worktree 已合并回 ${target || 'main'}`)
      return { merged: true, ...(checkpointId ? { checkpoint: checkpointId } : {}) }
    }
    console.warn(`[dynamicWorker] ⚠️ ${w.name} worktree 合并失败，保留现场：${m.message}`)
    return { merged: false }
  }
  // 失败：保留现场，供检查
  console.warn(`[dynamicWorker] 🧷 ${w.name} 任务失败，worktree 保留：${w.workdir}`)
  return {}
}

/** 取主仓库（不含 worktree）当前分支 */
async function mainBranchOf(handle: WorktreeHandle): Promise<string | null> {
  const { execFile } = require('child_process') as typeof import('child_process')
  const run = (args: string[], cwd: string) => new Promise<string | null>(resolve => {
    execFile('git', args, { cwd, timeout: 15000, windowsHide: true }, (err, stdout) => {
      resolve(err ? null : String(stdout).trim())
    })
  })
  // 主仓库 common dir 形如 <root>/.git；worktree 在 <root>/.lumina-worktrees/<name>
  const common = await run(['rev-parse', '--git-common-dir'], handle.workdir)
  if (!common) {return null}
  const path = require('path') as typeof import('path')
  const mainGit = path.isAbsolute(common) ? common : path.join(handle.workdir, common)
  const mainRoot = path.dirname(mainGit)
  const b = await run(['rev-parse', '--abbrev-ref', 'HEAD'], mainRoot)
  return b && b !== 'HEAD' ? b : null
}

/**
 * 一键并行：hire → 并行 run → collect →（成功合并 worktree）→ dismiss。
 * 全部 worker 干完后统一解散，团队回到 3 人。
 */
export async function hireAndRun(jobs: JobSpec[], opts: { keepAlive?: boolean } = {}): Promise<JobResult[]> {
  const hired = await Promise.all(jobs.map(async job => {
    const worker = await hireWorker({
      role: job.role,
      maxToolCalls: job.role === 'research' || job.role === 'search' ? 10 : 16,
      keepAlive: opts.keepAlive,
      ...(job.path ? { basePath: job.path } : {}),
      ...(job.tier ? { tier: job.tier } : {}),
    })
    return { job, worker }
  }))

  const stats = getWorkerStats()
  const trace = getTaskTrace()
  const results = await Promise.all(hired.map(async ({ job, worker }) => {
    const started = Date.now()
    const title = job.title || job.task.slice(0, 40)
    trace.start({
      source: 'hire', role: worker.role, workerId: worker.id, title,
      modelTier: worker.modelTier || 'unknown',
    })
    try {
      const result = await runWorker(worker, job.task, job.timeoutMs)
      // 空回复不等于成功。
      // 为什么：worker 最常见的失败形态不是抛异常，而是「只调工具、不下结论」，
      // 结果是空串。原来 ok 只取决于有没有 throw，于是空串一路标着 ok:true 回到主 agent，
      // 再被 teamCollab 汇总成「N/N 成功」，主模型读到的是一个「查到了」的空信封，
      // 于是自己编一个结论出来。空文本必须在此处就转成失败。
      if (!String(result || '').trim()) {
        throw new Error('worker 未产出任何文本（可能只调用了工具却没有给出结论）')
      }
      const fin = await finalizeWorkerWorktree(worker, true)
      const durationMs = Date.now() - started
      // v3.33 绩效画像 + 关系 + trace
      await stats.recordOutcome(worker.role, {
        ok: true, durationMs, title, kind: job.role, workerId: worker.id,
        note: String(result || '').slice(0, 300),
      })
      try {
        getRelationshipStore().recordInteraction('lumina', roleActorId(worker.role), 'delegation_ok', job.role)
      } catch { /* ignore */ }
      trace.end({ source: 'hire', role: worker.role, workerId: worker.id, title },
        { ok: true, durationMs, modelTier: worker.modelTier || 'unknown' })
      return {
        id: worker.id, name: worker.name, role: worker.role,
        title, ok: true, result, durationMs,
        workdir: worker.workdir, worktreeMerged: fin.merged,
        ...(fin.checkpoint ? { checkpoint: fin.checkpoint } : {}),
      } as JobResult
    } catch (e: any) {
      await finalizeWorkerWorktree(worker, false)
      const durationMs = Date.now() - started
      const error = e?.message || String(e)
      await stats.recordOutcome(worker.role, {
        ok: false, durationMs, title, kind: job.role, workerId: worker.id, note: error,
      })
      try {
        getRelationshipStore().recordInteraction('lumina', roleActorId(worker.role), 'delegation_fail', job.role)
      } catch { /* ignore */ }
      trace.end({ source: 'hire', role: worker.role, workerId: worker.id, title },
        { ok: false, durationMs, error, modelTier: worker.modelTier || 'unknown' })
      return {
        id: worker.id, name: worker.name, role: worker.role,
        title, ok: false, error, durationMs,
        workdir: worker.workdir,
      } as JobResult
    }
  }))

  if (!opts.keepAlive) {
    for (const { worker } of hired) {
      // runWorker 可能已对 shutdown_requested 解散；这里兜底
      if (listDynamicWorkers().some(w => w.id === worker.id)) {dismissWorker(worker.id)}
    }
  }
  return results
}
