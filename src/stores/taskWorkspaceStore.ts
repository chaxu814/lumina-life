// ============================================================
// stores/taskWorkspaceStore.ts — Agent 团队任务工作区面板状态
//
// 参考豆包桌面端右侧任务面板：对话在左、任务工作区在右。
// 本 store 管理：面板开合、任务标签页、时间线事件、产物标签页。
//
// 设计原则：
// - 状态全部从真实 store（agentRuntimeStore / loopStore）派生或桥接，
//   不写死假进度；无实时数据时显示"待机中"。
// - 纯函数（事件映射、语言检测、参数摘要）单独导出，便于单元测试。
// ============================================================

import { create } from 'zustand'

// ─── 类型定义 ─────────────────────────────────────────────

export type TaskStatus = 'running' | 'done' | 'error' | 'idle'

export type TimelineEventType =
  | 'thinking'
  | 'tool_start'
  | 'tool_end'
  | 'tool_error'
  | 'text'
  | 'system'
  | 'artifact'

export interface TaskWorkspaceTask {
  id: string
  title: string
  createdAt: number
  /** 所属 Agent：'lumina' | 'recha' | 'yak' | 'loop:<loopId>' */
  agentId: string
  status: TaskStatus
  /** 🆕 v02: 执行该任务的 Agent（委托任务的 assignee） */
  assignee?: string
  /** 🆕 v02: 最近更新时间 */
  updatedAt?: number
  /** 🆕 v02: 进度文案（来自主进程 task:progress） */
  progressText?: string
  /** 子任务列表（存在时该任务渲染为父级分组卡片） */
  subtasks?: SubtaskItem[]
  /** 父任务 ID（无子任务的任务不设此字段；层级最多两层） */
  parentId?: string
}

/** 子任务项 */
export interface SubtaskItem {
  id: string
  title: string
  status: TaskStatus
  /** 负责人：'lumina' | 'recha' | 'yak' | 'loop:<loopId>' */
  agentId?: string
  createdAt: number
  completedAt?: number
}

/**
 * 🆕 v03: 子智能体运行态（「对话摘要」侧边栏「子智能体」层）。
 *
 * 与 SubtaskItem 的区别：SubtaskItem 是挂在父任务卡片下的两层结构数据；
 * 这里是一份扁平、实时的并行子智能体列表——后端 InternPool（任意 owner
 * 派生）hire/assign/done/error/fire 时经桥接灌入，用于渲染
 * 「彩色圆点 + 子任务标题」的纵向并行列表。
 */
export interface SubagentItem {
  /** 子智能体 ID（后端 intern_<owner>_<name>） */
  id: string
  /** 子任务标题（assigned 之后才有） */
  title: string
  status: TaskStatus
  /** 派生 owner：'lumina' | 'yak' | 'recha' */
  owner: string
  createdAt: number
  completedAt?: number
  /** 完成结果摘要（展开可见） */
  result?: string
  /** 失败错误（展开可见） */
  error?: string
  /** 子智能体展示名（eg. 实习生小陈） */
  internName?: string
  /** 🆕 归属会话 ID；缺失表示尚未被任何会话派活。
   *  前端据此过滤，避免切会话时把别的会话的实习生卡片也显示出来。 */
  sessionId?: string
}

/** 🆕 v03: 面板主视图：对话摘要（默认）/ 详情（旧时间线·工具·产物） */
export type PanelView = 'summary' | 'detail'

export interface TimelineEvent {
  id: string
  taskId: string
  agentId: string
  type: TimelineEventType
  text: string
  status: TaskStatus
  timestamp: number
  tool?: string
  args?: unknown
  result?: unknown
  /** 所属会话 ID（用于时间线按会话隔离；无此字段的旧事件兼容显示） */
  conversationId?: string
  /** 所属父任务 ID（用于时间线分组；无此字段归入"其他"） */
  parentId?: string
}

export interface ArtifactItem {
  id: string
  taskId: string
  filename: string
  language: string
  content: string
  filePath?: string
  createdAt: number
  /** 图片 base64 data URL（图片/PDF 等二进制产物不存 content） */
  dataUrl?: string
  /** PDF 运行时生成的 blob URL（不持久化，组件卸载时 revoke） */
  blobUrl?: string
  /** 已检测的产物类型（未设则渲染时检测） */
  kind?: ArtifactKind
  /** 文件大小（字节） */
  size?: number
  /** 修改时间（ms） */
  mtime?: number
}

// ─── 纯函数：Agent 状态文案（从工具追踪 + 思考推断） ──────

/** 工具追踪条目形状（与 agentRuntimeStore.toolTraces 对齐） */
export interface ToolTraceShape {
  name: string
  status: 'running' | 'done' | 'error'
}

/**
 * 从工具追踪列表推断当前活动 Agent 的状态文案。
 * 优先级：running 工具 > error 工具 > 思考中 > 已完成 > 待机。
 */
export function deriveStatusText(
  lastThinking: string,
  toolTraces: ToolTraceShape[],
): { text: string; status: TaskStatus } {
  const running = toolTraces.find((t) => t.status === 'running')
  if (running) {
    return { text: `执行工具 ${running.name}`, status: 'running' }
  }
  const errored = toolTraces.find((t) => t.status === 'error')
  if (errored) {
    return { text: `工具 ${errored.name} 失败`, status: 'error' }
  }
  if (lastThinking && lastThinking.trim()) {
    return { text: '正在思考…', status: 'running' }
  }
  if (toolTraces.length > 0) {
    return { text: '工具执行完成', status: 'done' }
  }
  return { text: '待机中', status: 'idle' }
}

// ─── 纯函数：面板 wrapper className（动画用） ──────────────

/**
 * 计算面板 wrapper 的 className。
 * - panelOpen 控制 open/closed
 * - isResizing 控制 tw-resizing（拖拽时禁用过渡，避免动画延迟）
 */
export function getPanelWrapperClass(
  panelOpen: boolean,
  isResizing: boolean,
): string {
  const base = 'tw-panel-wrapper'
  const state = panelOpen ? 'open' : 'closed'
  const resize = isResizing ? ' tw-resizing' : ''
  return `${base} ${state}${resize}`
}

// ─── 纯函数：文件名 → 语言标签 ─────────────────────────────

/** 根据文件扩展名推断展示用语言标签 */
export function detectLanguage(filename: string): string {
  const ext = (filename.split('.').pop() || '').toLowerCase()
  const map: Record<string, string> = {
    ts: 'TypeScript', tsx: 'TypeScript', js: 'JavaScript', jsx: 'JavaScript',
    py: 'Python', md: 'Markdown', markdown: 'Markdown',
    json: 'JSON', html: 'HTML', css: 'CSS', scss: 'SCSS', less: 'Less',
    java: 'Java', c: 'C', h: 'C', cpp: 'C++', cc: 'C++', hpp: 'C++',
    cs: 'C#', go: 'Go', rs: 'Rust', rb: 'Ruby', php: 'PHP',
    sql: 'SQL', sh: 'Shell', bash: 'Shell', zsh: 'Shell',
    yml: 'YAML', yaml: 'YAML', toml: 'TOML', xml: 'XML',
    txt: 'Plain Text', log: 'Log', vue: 'Vue', svelte: 'Svelte',
  }
  return map[ext] || 'Plain Text'
}

// ─── 纯函数：工具参数摘要 ─────────────────────────────────

/** 把任意参数对象序列化为可展示的短摘要，超长截断 */
export function summarizeArgs(args: unknown, max = 60): string {
  if (args == null) {return ''}
  let str: string
  try {
    str = typeof args === 'string' ? args : JSON.stringify(args)
  } catch {
    str = String(args)
  }
  str = str.replace(/\s+/g, ' ').trim()
  if (str.length <= max) {return str}
  return str.slice(0, max) + '…'
}

// ─── 纯函数：Agent 运行时事件 → 时间线事件 ───────────────

/** 桥接用的事件形状（与 agentRuntimeStore.AgentEvent 结构对齐，避免直接耦合） */
export interface BridgeAgentEvent {
  type: string
  text?: string
  tool?: string
  args?: unknown
  result?: unknown
  timestamp?: number
}

/**
 * 把 agentRuntimeStore 的单个事件映射为时间线事件。
 * 无法识别的类型返回 null（调用方应忽略）。
 */
export function mapAgentEventToTimeline(
  ev: BridgeAgentEvent,
  taskId: string,
  agentId: string,
): TimelineEvent | null {
  const ts = ev.timestamp || Date.now()
  const base = {
    id: `tl-${ts}-${Math.random().toString(36).slice(2, 8)}`,
    taskId,
    agentId,
    timestamp: ts,
  }
  switch (ev.type) {
    case 'thinking':
    case 'thinking_stream':
      return {
        ...base, type: 'thinking', status: 'running',
        text: ev.text ? ev.text.slice(0, 200) : '正在思考…',
      }
    case 'tool_start':
      return {
        ...base, type: 'tool_start', status: 'running',
        tool: ev.tool,
        args: ev.args,
        text: `开始执行工具 ${ev.tool || 'unknown'}`,
      }
    case 'tool_end':
      return {
        ...base, type: 'tool_end', status: 'done',
        tool: ev.tool,
        result: ev.result,
        text: `工具 ${ev.tool || 'unknown'} 执行完成`,
      }
    case 'tool_error':
      return {
        ...base, type: 'tool_error', status: 'error',
        tool: ev.tool,
        result: ev.result,
        text: `工具 ${ev.tool || 'unknown'} 执行失败`,
      }
    case 'text':
    case 'text_stream':
      return {
        ...base, type: 'text', status: 'done',
        text: (ev.text || '').slice(0, 300) || '收到消息',
      }
    default:
      return null
  }
}

// ─── 纯函数：Loop 任务 → 工作区任务 ─────────────────────

export interface LoopTaskShape {
  id: string
  goal: string
  status?: string
  runCount?: number
}

/** 把 loopStore 的任务列表映射为工作区任务卡片 */
export function mapLoopTaskToWorkspace(loop: LoopTaskShape): TaskWorkspaceTask {
  const status: TaskStatus =
    loop.status === 'running' || loop.status === 'active' ? 'running'
    : loop.status === 'error' ? 'error'
    : loop.status === 'paused' || loop.status === 'stopped' ? 'idle'
    : 'idle'
  return {
    id: `loop:${loop.id}`,
    title: loop.goal || '未命名 Loop',
    createdAt: Date.now(),
    agentId: `loop:${loop.id}`,
    status,
  }
}

/** 🆕 v02: 后台 AsyncTask 状态 → 工作区 TaskStatus */
export function mapAsyncStatus(s: string): TaskStatus {
  if (s === 'running') {return 'running'}
  if (s === 'done') {return 'done'}
  if (s === 'error') {return 'error'}
  return 'idle' // queued / cancelled / paused
}

/** 🆕 v02: 后台 AsyncTask → 工作区任务对象（纯函数，便于测试） */
export function mapAsyncTaskToWorkspace(t: {
  id: string; title: string; status: string; assignee?: string;
  createdAt?: number; progress?: string;
}): TaskWorkspaceTask {
  return {
    id: `remote:${t.id}`,
    title: t.title || '后台任务',
    createdAt: t.createdAt || Date.now(),
    updatedAt: Date.now(),
    agentId: t.assignee || 'remote',
    assignee: t.assignee,
    status: mapAsyncStatus(t.status),
    progressText: t.progress,
  }
}

// ─── 已隐藏 Loop 任务的持久化（localStorage） ─────────────
// 背景：Loop 任务通过 createElectronLoopPersistence() 持久化到磁盘，
// 历史会话中创建的数学题任务（已暂停）会一直回流到面板。
// 这里只记录"用户主动隐藏"的 Loop 原始 ID，不真正删除 Loop 引擎数据，
// 用户清空 localStorage 或调用 restore 即可找回。

const DISMISS_KEY = 'lumina_tw_dismissed_loops'

/** 从 localStorage 读取已隐藏的 Loop ID 列表；不可用时降级为空数组 */
function loadDismissedLoops(): string[] {
  try {
    if (typeof localStorage === 'undefined') {return []}
    const raw = localStorage.getItem(DISMISS_KEY)
    if (!raw) {return []}
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) {return []}
    return parsed.filter((x): x is string => typeof x === 'string')
  } catch {
    return []
  }
}

/** 把已隐藏的 Loop ID 列表写回 localStorage；不可用时静默忽略 */
function saveDismissedLoops(ids: string[]): void {
  try {
    if (typeof localStorage === 'undefined') {return}
    localStorage.setItem(DISMISS_KEY, JSON.stringify(ids))
  } catch {
    /* localStorage 不可用（隐私模式/Node 测试环境）时降级为内存态 */
  }
}

// ─── 纯函数：子任务层级分组与进度聚合 ─────────────────────

/** 无 parentId 的事件归入此分组键 */
export const UNGROUPED_GROUP = '__ungrouped__'

/** 把时间线事件按 parentId 分组，无 parentId 的归入 '__ungrouped__' */
export function groupTimelineByParent(
  events: TimelineEvent[],
): Record<string, TimelineEvent[]> {
  const groups: Record<string, TimelineEvent[]> = {}
  for (const ev of events) {
    const key = ev.parentId || UNGROUPED_GROUP
    if (!groups[key]) {groups[key] = []}
    groups[key].push(ev)
  }
  return groups
}

/** 聚合子任务进度：返回总数与各状态计数及百分比 */
export function aggregateSubtaskProgress(
  subtasks: SubtaskItem[],
): { total: number; done: number; running: number; error: number; idle: number; percent: number } {
  let done = 0, running = 0, error = 0, idle = 0
  for (const s of subtasks) {
    if (s.status === 'done') {done++}
    else if (s.status === 'running') {running++}
    else if (s.status === 'error') {error++}
    else {idle++}
  }
  const total = subtasks.length
  const percent = total > 0 ? Math.round(((done + error) / total) * 100) : 0
  return { total, done, running, error, idle, percent }
}

/** 从子任务状态推导父任务整体状态：有error→error，有running→running，全done→done，否则idle */
export function deriveGroupStatus(subtasks: SubtaskItem[]): TaskStatus {
  if (subtasks.length === 0) {return 'idle'}
  const { done, running, error } = aggregateSubtaskProgress(subtasks)
  if (error > 0) {return 'error'}
  if (running > 0) {return 'running'}
  if (done === subtasks.length) {return 'done'}
  return 'idle'
}

/**
 * 纯函数：判断某个父任务是否应自动展开。
 * 规则：
 * 1. 仅 running 父任务自动展开；
 * 2. 用户手动折叠过（在 collapsedGroupIds 中）→ 不展开（尊重用户）；
 * 3. 同一时刻最多自动展开一个活跃父任务：
 *    若已有别的活跃父任务被自动展开（hasActiveExpanded=true），本任务不自动展开。
 */
export function shouldAutoExpand(
  task: TaskWorkspaceTask,
  collapsedGroupIds: string[],
  hasActiveExpanded: boolean,
): boolean {
  if (task.status !== 'running') {return false}
  if (collapsedGroupIds.includes(task.id)) {return false}
  if (hasActiveExpanded) {return false}
  return true
}

/** 格式化耗时：ms → "12.3s" / "2m 5s" / "1h 2m" */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) {return '0s'}
  if (ms < 1000) {return `${Math.round(ms)}ms`}
  const totalSec = ms / 1000
  if (totalSec < 60) {return `${Math.round(totalSec * 10) / 10}s`}
  const totalMin = totalSec / 60
  if (totalMin < 60) {
    const m = Math.floor(totalMin)
    const s = Math.round(totalSec - m * 60)
    return s > 0 ? `${m}m ${s}s` : `${m}m`
  }
  const totalHour = totalMin / 60
  const h = Math.floor(totalHour)
  const m = Math.round(totalMin - h * 60)
  return `${h}h ${m}m`
}

// ─── 纯函数：产物类型检测 ───────────────────────────────────

export type ArtifactKind =
  | 'code' | 'markdown' | 'image' | 'pdf' | 'json' | 'csv' | 'text' | 'binary'

/** 各类型体积阈值（字节），用于渲染保护 */
export const ARTIFACT_SIZE_LIMITS: Record<ArtifactKind, number> = {
  code: 100 * 1024,
  markdown: 500 * 1024,
  image: 10 * 1024 * 1024,
  pdf: 25 * 1024 * 1024,
  json: 500 * 1024,
  csv: 5 * 1024 * 1024,
  text: 500 * 1024,
  binary: Infinity,
}

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'])
const CODE_EXTS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'java', 'c', 'h', 'cpp', 'cc', 'hpp',
  'cs', 'go', 'rs', 'rb', 'php', 'swift', 'kt', 'sql', 'sh', 'bash', 'zsh', 'vue', 'svelte',
  'css', 'scss', 'less', 'html', 'xml', 'yaml', 'yml', 'toml', 'ini', 'conf',
])
const TEXT_EXTS = new Set(['txt', 'log', 'md', 'markdown'])

/** 根据文件名+内容前几个字节判定产物类型 */
export function detectArtifactKind(filename: string, content?: string): ArtifactKind {
  const ext = (filename.split('.').pop() || '').toLowerCase()
  if (ext === 'pdf') {return 'pdf'}
  if (IMAGE_EXTS.has(ext)) {return 'image'}
  if (ext === 'json') {return 'json'}
  if (ext === 'csv' || ext === 'tsv') {return 'csv'}
  if (ext === 'md' || ext === 'markdown') {return 'markdown'}
  if (CODE_EXTS.has(ext)) {return 'code'}
  if (TEXT_EXTS.has(ext)) {return 'text'}
  // 无扩展名或未知：用内容嗅探
  const head = (content || '').slice(0, 256).trim()
  if (head.startsWith('{') || head.startsWith('[')) {
    try { JSON.parse(head); return 'json' } catch { /* 非合法 JSON，回退 text */ }
  }
  if (head.includes(',') && head.includes('\n')) {return 'csv'}
  if (head.length > 0) {return 'text'}
  return 'binary'
}

/** 判定是否为文本类（可安全以字符串处理） */
export function isTextArtifact(kind: ArtifactKind): boolean {
  return kind === 'code' || kind === 'markdown' || kind === 'json'
    || kind === 'csv' || kind === 'text'
}

// ─── 🆕 v03: 「对话摘要」六层聚合纯函数 ──────────────────────
// 全部从真实 store 状态（artifacts / subagents / board / toolCalls）派生，
// 不写死任何假数据。每层无数据时由渲染层显示「暂无内容」。

/** 产物 → 侧边栏图标 key（md / html / code / image / pdf / json / file） */
export function artifactIconKey(kind: ArtifactKind, filename: string): string {
  const ext = (filename.split('.').pop() || '').toLowerCase()
  if (ext === 'md' || ext === 'markdown') {return 'md'}
  if (ext === 'html' || ext === 'htm') {return 'html'}
  if (ext === 'json') {return 'json'}
  if (ext === 'csv' || ext === 'tsv') {return 'csv'}
  if (kind === 'image') {return 'image'}
  if (kind === 'pdf') {return 'pdf'}
  if (kind === 'code') {return 'code'}
  return 'file'
}

/**
 * 「对话产物」层：文档类产物（md/html/code/json/csv/text），按创建时间倒序。
 * 图片/PDF 等二进制资源归到「对话资源」层，不混在这里。
 */
export function deriveConversationArtifacts(artifacts: ArtifactItem[]): ArtifactItem[] {
  return artifacts
    .filter((a) => {
      const kind = a.kind ?? detectArtifactKind(a.filename, a.content)
      return kind === 'markdown' || kind === 'code' || kind === 'json'
        || kind === 'csv' || kind === 'text'
    })
    .slice()
    .sort((a, b) => b.createdAt - a.createdAt)
}

/** 「对话资源」层：图片/PDF 等资源（缩略图/文件名），按创建时间倒序 */
export function deriveConversationResources(artifacts: ArtifactItem[]): ArtifactItem[] {
  return artifacts
    .filter((a) => {
      const kind = a.kind ?? detectArtifactKind(a.filename, a.content)
      return kind === 'image' || kind === 'pdf'
    })
    .slice()
    .sort((a, b) => b.createdAt - a.createdAt)
}

/** 「最近文件」层：带磁盘路径的产物，按 mtime/createdAt 倒序，最多 limit 条 */
export function deriveRecentFiles(artifacts: ArtifactItem[], limit = 8): ArtifactItem[] {
  return artifacts
    .filter((a) => !!a.filePath)
    .slice()
    .sort((a, b) => (b.mtime ?? b.createdAt) - (a.mtime ?? a.createdAt))
    .slice(0, limit)
}

/** 「任务规划」层：进度看板条目（无看板时为空，显示「暂无内容」） */
export function deriveTaskPlan(board: TaskBoard | null): BoardItem[] {
  return board?.items ?? []
}

/** 「技能」层：本次对话用过的工具（按调用先后去重） */
export function deriveUsedSkills(calls: ToolCallRecord[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const c of calls) {
    if (!c.name || seen.has(c.name)) {continue}
    seen.add(c.name)
    out.push(c.name)
  }
  return out
}

/**
 * 「子智能体」层：合并运行态子智能体列表 + 父任务卡片里的 subtasks，
 * 去重后按创建时间正序（先派的在上），过滤掉 idle（还没领到活的）。
 */
export function deriveSubagentList(
  runtime: SubagentItem[],
  tasks: TaskWorkspaceTask[],
): SubagentItem[] {
  const map = new Map<string, SubagentItem>()
  for (const s of runtime) {
    map.set(s.id, s)
  }
  // 兼容旧数据模型：父任务卡片里的 subtasks 也进「子智能体」层
  for (const t of tasks) {
    for (const sub of t.subtasks ?? []) {
      if (map.has(sub.id)) {continue}
      map.set(sub.id, {
        id: sub.id,
        title: sub.title,
        status: sub.status,
        owner: sub.agentId ?? t.agentId,
        createdAt: sub.createdAt,
        completedAt: sub.completedAt,
      })
    }
  }
  return Array.from(map.values())
    .filter((s) => s.status !== 'idle')
    .sort((a, b) => a.createdAt - b.createdAt)
}

// ─── 持久化 helper（分组折叠 / 区块折叠 / 宽度 / 最近产物） ──

const COLLAPSED_GROUPS_KEY = 'lumina_tw_collapsed_groups'
const COLLAPSED_SECTIONS_KEY = 'lumina_tw_collapsed_sections'
const PANEL_WIDTH_KEY = 'lumina_tw_panel_width'
const LAST_ARTIFACT_KEY = 'lumina_tw_last_artifact'
/** 🆕 v03: 主视图（对话摘要/详情）持久化 key */
const PANEL_VIEW_KEY = 'lumina_tw_panel_view'
/** 进度看板（图1）持久化 key */
const BOARD_KEY = 'lumina_tw_board'

function loadJson<T>(key: string, fallback: T): T {
  try {
    if (typeof localStorage === 'undefined') {return fallback}
    const raw = localStorage.getItem(key)
    if (!raw) {return fallback}
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

/** 读取字符串数组型持久化，非数组或元素非字符串时回退默认值 */
function loadStringArray(key: string, fallback: string[] = []): string[] {
  try {
    if (typeof localStorage === 'undefined') {return fallback}
    const raw = localStorage.getItem(key)
    if (!raw) {return fallback}
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) {return fallback}
    return parsed.filter((x): x is string => typeof x === 'string')
  } catch {
    return fallback
  }
}

/** 读取面板宽度，NaN/越界/非数一律回退默认 360 */
function loadPanelWidth(): number {
  const w = loadJson<number>(PANEL_WIDTH_KEY, 360)
  return typeof w === 'number' && Number.isFinite(w) && w >= 280 && w <= 500 ? w : 360
}

/** 读取主视图偏好，非法值回退默认 'summary'（对话摘要为新主视图） */
function loadPanelView(): PanelView {
  const v = loadJson<string>(PANEL_VIEW_KEY, 'summary')
  return v === 'detail' ? 'detail' : 'summary'
}

function saveJson(key: string, value: unknown): void {
  try {
    if (typeof localStorage === 'undefined') {return}
    localStorage.setItem(key, JSON.stringify(value))
  } catch { /* 隐私模式/Node 测试环境降级 */ }
}

// ─── 类型：进度看板（图1 那种"进度 / 交付物"任务板） ────────

export type BoardItemStatus = 'done' | 'active' | 'pending'

/** 看板条目附带的交付物（结果） */
export interface BoardDeliverable {
  /** 产物类型：artifact=工作区产物, file=磁盘文件, url=链接, text=文本结果 */
  kind: 'artifact' | 'file' | 'url' | 'text'
  /** 展示名 */
  label: string
  /** file/url/text 类型的实际目标；artifact 类型指向 ArtifactItem.id */
  ref?: string
}

export interface BoardItem {
  id: string
  /** 条目文案 */
  text: string
  status: BoardItemStatus
  /** 完成时间（毫秒） */
  completedAt?: number
  /** 交付物：该条目产出的结果 */
  deliverable?: BoardDeliverable
}

export interface TaskBoard {
  title: string
  items: BoardItem[]
  updatedAt: number
}

/** 看板进度：已完成 / 总数 */
export function boardProgress(board: TaskBoard | null): { done: number; total: number; percent: number } {
  const items = board?.items ?? []
  const total = items.length
  const done = items.filter((i) => i.status === 'done').length
  return { done, total, percent: total === 0 ? 0 : Math.round((done / total) * 100) }
}

/** 从任意数组推导看板状态：显式 status 优先，否则 done/active/pending 按位置猜 */
export function normalizeBoardItems(raw: any[]): BoardItem[] {
  return raw.map((r, idx) => {
    const text = String(r?.text ?? r?.title ?? r?.task ?? '').trim()
    let status: BoardItemStatus
    if (r?.status === 'done' || r?.status === 'completed' || r?.done === true) {
      status = 'done'
    } else if (r?.status === 'active' || r?.status === 'in_progress' || r?.status === 'running') {
      status = 'active'
    } else if (r?.status === 'pending' || r?.status === 'todo') {
      status = 'pending'
    } else {
      status = 'pending'
    }
    return {
      id: String(r?.id ?? `bi-${idx}-${Math.random().toString(36).slice(2, 6)}`),
      text,
      status,
      completedAt: r?.completedAt ?? (status === 'done' ? Date.now() : undefined),
      deliverable: r?.deliverable ? {
        kind: r.deliverable.kind ?? 'text',
        label: String(r.deliverable.label ?? r.deliverable.ref ?? '交付物'),
        ref: r.deliverable.ref,
      } : undefined,
    }
  }).filter((i) => i.text.length > 0)
}

// ─── 类型：工具调用记录（持久，随会话保留） ────────────────

/**
 * 一次工具调用的完整记录。
 *
 * 为什么不直接读 agentRuntimeStore.toolTraces：
 *   ChatPanel 在每轮对话结束时会调 `resetAgentRuntime()`，把
 *   agentEvents / toolTraces 一次性清空。任务工作区如果依赖它，
 *   就会在"Agent 刚干完活"的那一刻清空成"暂无工具调用"——
 *   正是工作区一直不跟聊天联动的原因。
 *   所以这里维护一份独立、合并过 start/end、带耗时的持久记录。
 */
export interface ToolCallRecord {
  /** 唯一 ID：一次调用一个，不是按工具名去重 */
  id: string
  name: string
  /** 执行方：'lumina' | 'recha' | 'yak' | 'worker' */
  agentId: string
  /** 所属会话 */
  conversationId?: string
  status: 'running' | 'done' | 'error'
  args?: unknown
  result?: unknown
  error?: string
  startedAt: number
  endedAt?: number
  durationMs?: number
}

/** 找到某个工具当前仍在跑的那条记录（同名并发时取最近一条） */
export function findRunningToolCall(
  calls: ToolCallRecord[],
  name: string,
  conversationId?: string | null,
): ToolCallRecord | undefined {
  for (let i = calls.length - 1; i >= 0; i--) {
    const c = calls[i]
    if (c.name === name && c.status === 'running' && (c.conversationId ?? null) === (conversationId ?? null)) {
      return c
    }
  }
  return undefined
}

/** 会话内已结束的调用是否需要丢弃（会话容量保护，避免无限增长） */
export function pruneToolCalls(calls: ToolCallRecord[], keep = 300): ToolCallRecord[] {
  if (calls.length <= keep) {return calls}
  // 优先丢弃最旧的已结束记录，运行中的永远保留
  const running = calls.filter((c) => c.status === 'running')
  const finished = calls.filter((c) => c.status !== 'running')
  const keepFinished = finished.slice(-Math.max(0, keep - running.length))
  return [...keepFinished, ...running].sort((a, b) => a.startedAt - b.startedAt)
}

/** 「刚刚完成」的时间窗口：这段时间内卡片仍显示最近干过什么，不立刻弹回待机 */
export const RECENT_ACTIVITY_MS = 8000

/**
 * 从持久工具调用记录派生 Agent 状态文案。
 *
 * 与 deriveStatusText 的区别：后者读的是 agentRuntimeStore 的瞬时 toolTraces，
 * 每轮对话结束就被 resetAgentRuntime() 清空，工作区会瞬间全部退回"待机中"；
 * 这里读带时间戳的持久记录，刚干完活的几秒内仍如实显示"做了什么"。
 */
export function deriveAgentStatusFromCalls(
  calls: ToolCallRecord[],
  lastThinking: string,
  now = Date.now(),
): { text: string; status: TaskStatus } {
  // 运行中的工具永远优先
  const running = calls.find((c) => c.status === 'running')
  if (running) {
    return { text: `执行工具 ${running.name}`, status: 'running' }
  }
  if (lastThinking && lastThinking.trim()) {
    return { text: '正在思考…', status: 'running' }
  }
  if (calls.length > 0) {
    const last = calls[calls.length - 1]
    const age = now - (last.endedAt || last.startedAt)
    if (last.status === 'error') {
      return { text: `工具 ${last.name} 失败`, status: 'error' }
    }
    if (age <= RECENT_ACTIVITY_MS) {
      return { text: `完成 ${last.name}`, status: 'done' }
    }
    return { text: '待机中', status: 'idle' }
  }
  return { text: '待机中', status: 'idle' }
}

export type SectionKey = 'agents' | 'tools' | 'timeline' | 'artifacts' | 'board'

// 模块级记录最近一次同步进来的原始 Loop 列表，

let lastSyncedLoops: LoopTaskShape[] = []

// ─── Zustand Store ────────────────────────────────────────

interface TaskWorkspaceState {
  /** 面板是否展开 */
  panelOpen: boolean
  /** 面板宽度（可拖拽调整，持久化到 localStorage） */
  panelWidth: number
  setPanelWidth: (w: number) => void
  togglePanel: () => void
  setPanelOpen: (open: boolean) => void

  /** 当前激活的任务标签页 */
  activeTaskId: string | null
  tasks: TaskWorkspaceTask[]
  createTask: (title: string, agentId?: string) => string
  closeTask: (id: string) => void
  switchTask: (id: string) => void

  /** 时间线事件（按时间倒序渲染，内部按时间正序追加） */
  timeline: TimelineEvent[]
  addTimelineEvent: (ev: TimelineEvent) => void
  clearTimeline: (taskId?: string) => void

  /** 🆕 持久工具调用记录（不随 resetAgentRuntime 清空） */
  toolCalls: ToolCallRecord[]
  recordToolStart: (name: string, agentId?: string, conversationId?: string | null, args?: unknown) => string
  recordToolEnd: (name: string, ok: boolean, agentId?: string, conversationId?: string | null, result?: unknown) => void
  clearToolCalls: (conversationId?: string) => void

  /** 🆕 进度看板（图1）：任务板 + 交付物 */
  board: TaskBoard | null
  setBoard: (board: { title?: string; items: any[] } | null) => void
  updateBoardItem: (id: string, patch: Partial<Omit<BoardItem, 'id'>>) => void
  clearBoard: () => void

  /** 产物标签页 */
  artifacts: ArtifactItem[]
  activeArtifactId: string | null
  addArtifact: (a: ArtifactItem) => void
  closeArtifact: (id: string) => void
  setActiveArtifact: (id: string | null) => void

  /** 同步 Loop 任务（由组件在 effect 中调用） */
  syncLoopTasks: (loops: LoopTaskShape[]) => void

  /** 🆕 v02: 摄入后台 AsyncTask（创建或更新），返回工作区任务 id */
  upsertRemoteTask: (remote: {
    id: string; title: string; status: string; assignee?: string;
    createdAt?: number; progress?: string;
  }) => string
  /** 🆕 v02: 更新后台任务状态/进度 */
  setRemoteTaskStatus: (remoteId: string, status: string, progress?: string) => void

  /** 已隐藏的 Loop 任务原始 ID（持久化到 localStorage） */
  dismissedLoopIds: string[]
  /** 隐藏单个 Loop 任务（写入 dismissedLoopIds + 持久化） */
  dismissLoopTask: (loopId: string) => void
  /** 恢复单个 Loop 任务（从 dismissedLoopIds 移除） */
  restoreLoopTask: (loopId: string) => void
  /** 清空所有非 running 的 Loop 任务（隐藏），返回清除数量 */
  clearFinishedLoopTasks: () => number

  /** 删除单条时间线事件 */
  removeTimelineEvent: (eventId: string) => void

  /** 当前关联的会话 ID（用于时间线/工具反馈按会话隔离） */
  activeConversationId: string | null
  setActiveConversation: (convId: string | null) => void

  /** 折叠的子任务分组 ID 集合（持久化 localStorage） */
  collapsedGroupIds: string[]
  toggleGroupCollapse: (groupId: string) => void

  /** 子任务操作 */
  addSubtask: (parentId: string, subtask: SubtaskItem) => void
  updateSubtaskStatus: (parentId: string, subtaskId: string, status: TaskStatus) => void
  removeSubtask: (parentId: string, subtaskId: string) => void

  /** 各区块折叠状态（持久化 localStorage） */
  collapsedSections: Record<SectionKey, boolean>
  toggleSection: (section: SectionKey) => void

  /** 🆕 v03: 面板主视图（对话摘要 / 详情），持久化 localStorage */
  panelView: PanelView
  setPanelView: (view: PanelView) => void

  /** 🆕 v03: 运行态并行子智能体列表（「子智能体」层实时数据） */
  subagents: SubagentItem[]
  upsertSubagent: (item: SubagentItem) => void
  removeSubagent: (id: string) => void
  clearSubagents: () => void
}

let taskSeq = 0
function genId(prefix: string): string {
  taskSeq += 1
  return `${prefix}-${Date.now()}-${taskSeq}-${Math.random().toString(36).slice(2, 6)}`
}

export const useTaskWorkspace = create<TaskWorkspaceState>()((set, get) => {
  // 面板宽度持久化：初始化时从 localStorage 读取，越界/NaN 则回退默认
  const initialWidth = loadPanelWidth()
  // 最近一次打开的产物 ID 持久化
  const savedArtifactId = loadJson<string | null>(LAST_ARTIFACT_KEY, null)
  // 主视图偏好持久化（默认对话摘要）
  const initialPanelView = loadPanelView()

  return {
  panelOpen: false,
  panelWidth: initialWidth,
  setPanelWidth: (w) => {
    const clamped = Math.min(500, Math.max(280, Math.round(w)))
    saveJson(PANEL_WIDTH_KEY, clamped)
    set({ panelWidth: clamped })
  },
  togglePanel: () => set((s) => ({ panelOpen: !s.panelOpen })),
  setPanelOpen: (open) => set({ panelOpen: open }),

  activeTaskId: null,
  tasks: [],
  createTask: (title, agentId = 'lumina') => {
    const id = genId('task')
    const task: TaskWorkspaceTask = {
      id, title, createdAt: Date.now(), agentId, status: 'running',
    }
    set((s) => ({ tasks: [...s.tasks, task], activeTaskId: id }))
    return id
  },
  closeTask: (id) => set((s) => {
    const tasks = s.tasks.filter((t) => t.id !== id)
    const activeTaskId =
      s.activeTaskId === id ? (tasks[tasks.length - 1]?.id ?? null) : s.activeTaskId
    return { tasks, activeTaskId }
  }),
  switchTask: (id) => set({ activeTaskId: id }),

  timeline: [],
  addTimelineEvent: (ev) => set((s) => ({ timeline: [...s.timeline, ev] })),
  clearTimeline: (taskId) => set((s) => ({
    timeline: taskId ? s.timeline.filter((e) => e.taskId !== taskId) : [],
  })),

  toolCalls: [],
  recordToolStart: (name, agentId = 'lumina', conversationId = null, args) => {
    const id = genId('tc')
    set((s) => ({
      toolCalls: pruneToolCalls([
        ...s.toolCalls,
        {
          id,
          name,
          agentId,
          conversationId: conversationId ?? undefined,
          status: 'running' as const,
          args,
          startedAt: Date.now(),
        },
      ]),
    }))
    return id
  },
  recordToolEnd: (name, ok, agentId = 'lumina', conversationId = null, result) => {
    set((s) => {
      const running = findRunningToolCall(s.toolCalls, name, conversationId)
      if (!running) {
        // 没配对到 start（事件乱序/被丢弃）：补一条已结束的记录，别让调用凭空消失
        return {
          toolCalls: pruneToolCalls([
            ...s.toolCalls,
            {
              id: genId('tc'),
              name,
              agentId,
              conversationId: conversationId ?? undefined,
              status: ok ? ('done' as const) : ('error' as const),
              result,
              startedAt: Date.now(),
              endedAt: Date.now(),
              durationMs: 0,
            },
          ]),
        }
      }
      const endedAt = Date.now()
      const toolCalls = [...s.toolCalls]
      const idx = toolCalls.findIndex((c) => c.id === running.id)
      toolCalls[idx] = {
        ...running,
        status: ok ? 'done' : 'error',
        result,
        endedAt,
        durationMs: endedAt - running.startedAt,
      }
      return { toolCalls: pruneToolCalls(toolCalls) }
    })
  },
  clearToolCalls: (conversationId) => set((s) => ({
    toolCalls: conversationId
      ? s.toolCalls.filter((c) => (c.conversationId ?? null) !== conversationId)
      : [],
  })),

  // ── 进度看板 ──
  board: loadJson<TaskBoard | null>(BOARD_KEY, null),
  setBoard: (b) => {
    if (!b || !Array.isArray(b.items) || b.items.length === 0) {
      saveJson(BOARD_KEY, null)
      set({ board: null })
      return
    }
    const board: TaskBoard = {
      title: b.title?.trim() || '进度',
      items: normalizeBoardItems(b.items),
      updatedAt: Date.now(),
    }
    saveJson(BOARD_KEY, board)
    set({ board })
  },
  updateBoardItem: (id, patch) => set((s) => {
    if (!s.board) {return s}
    const items = s.board.items.map((i) => {
      if (i.id !== id) {return i}
      const next = { ...i, ...patch }
      if (patch.status === 'done' && !next.completedAt) {next.completedAt = Date.now()}
      if (patch.status && patch.status !== 'done') {next.completedAt = undefined}
      return next
    })
    const board = { ...s.board, items, updatedAt: Date.now() }
    saveJson(BOARD_KEY, board)
    return { board }
  }),
  clearBoard: () => {
    saveJson(BOARD_KEY, null)
    set({ board: null })
  },

  artifacts: [],
  activeArtifactId: typeof savedArtifactId === 'string' ? savedArtifactId : null,
  addArtifact: (a) => set((s) => {
    // 同名产物去重：已存在则替换并激活
    const existingIdx = s.artifacts.findIndex((x) => x.filename === a.filename && x.taskId === a.taskId)
    if (existingIdx >= 0) {
      const artifacts = [...s.artifacts]
      artifacts[existingIdx] = a
      saveJson(LAST_ARTIFACT_KEY, a.id)
      return { artifacts, activeArtifactId: a.id }
    }
    saveJson(LAST_ARTIFACT_KEY, a.id)
    return { artifacts: [...s.artifacts, a], activeArtifactId: a.id }
  }),
  closeArtifact: (id) => set((s) => {
    const artifacts = s.artifacts.filter((a) => a.id !== id)
    const activeArtifactId =
      s.activeArtifactId === id ? (artifacts[artifacts.length - 1]?.id ?? null) : s.activeArtifactId
    saveJson(LAST_ARTIFACT_KEY, activeArtifactId)
    return { artifacts, activeArtifactId }
  }),
  setActiveArtifact: (id) => {
    saveJson(LAST_ARTIFACT_KEY, id)
    set({ activeArtifactId: id })
  },

  // 初始化时从 localStorage 读取已隐藏的 Loop ID（Node 测试环境自动降级为空）
  dismissedLoopIds: loadDismissedLoops(),
  dismissLoopTask: (loopId) => set((s) => {
    if (s.dismissedLoopIds.includes(loopId)) {return s}
    const next = [...s.dismissedLoopIds, loopId]
    saveDismissedLoops(next)
    // 同时从工作区 tasks 里移除对应卡片
    const tasks = s.tasks.filter((t) => t.agentId !== `loop:${loopId}`)
    return { dismissedLoopIds: next, tasks }
  }),
  restoreLoopTask: (loopId) => set((s) => {
    if (!s.dismissedLoopIds.includes(loopId)) {return s}
    const next = s.dismissedLoopIds.filter((id) => id !== loopId)
    saveDismissedLoops(next)
    return { dismissedLoopIds: next }
  }),
  clearFinishedLoopTasks: () => {
    const s = get()
    // 只隐藏非 running 的 Loop（已完成/暂停/待命/配置中/审阅中），running 保留
    const toDismiss = lastSyncedLoops
      .filter((l) => l.status !== 'running')
      .map((l) => l.id)
      .filter((id) => !s.dismissedLoopIds.includes(id))
    if (toDismiss.length === 0) {return 0}
    const next = [...s.dismissedLoopIds, ...toDismiss]
    saveDismissedLoops(next)
    // 从工作区 tasks 移除对应 Loop 卡片
    const tasks = s.tasks.filter(
      (t) => !(t.agentId.startsWith('loop:') && toDismiss.includes(t.agentId.slice(5))),
    )
    set({ dismissedLoopIds: next, tasks })
    return toDismiss.length
  },

  removeTimelineEvent: (eventId) => set((s) => ({
    timeline: s.timeline.filter((e) => e.id !== eventId),
  })),

  activeConversationId: null,
  setActiveConversation: (convId) => set({ activeConversationId: convId }),

  syncLoopTasks: (loops) => {
    // 记录原始列表，供 clearFinishedLoopTasks 计算
    lastSyncedLoops = loops
    set((s) => {
      // 移除旧的 loop 任务，再合并新的（保留用户自建任务）
      // 同时过滤掉已被用户主动隐藏的 Loop 任务，防止被 effect 重新拉回
      const visibleLoops = loops.filter((l) => !s.dismissedLoopIds.includes(l.id))
      const userTasks = s.tasks.filter((t) => !t.agentId.startsWith('loop:'))
      const loopTasks = visibleLoops.map(mapLoopTaskToWorkspace)
      return { tasks: [...userTasks, ...loopTasks] }
    })
  },

  upsertRemoteTask: (remote) => {
    const mapped = mapAsyncTaskToWorkspace(remote)
    const assignedId = mapped.id
    set((s) => {
      const idx = s.tasks.findIndex((t) => t.id === mapped.id)
      if (idx >= 0) {
        const tasks = [...s.tasks]
        tasks[idx] = { ...tasks[idx], ...mapped, updatedAt: Date.now() }
        return { tasks }
      }
      return { tasks: [...s.tasks, mapped] }
    })
    return assignedId
  },

  setRemoteTaskStatus: (remoteId, status, progress) => {
    const wid = `remote:${remoteId}`
    set((s) => ({
      tasks: s.tasks.map((t) =>
        t.id === wid
          ? { ...t, status: mapAsyncStatus(status), progressText: progress ?? t.progressText, updatedAt: Date.now() }
          : t,
      ),
    }))
  },

  // ── 子任务层级分组 ──
  collapsedGroupIds: loadStringArray(COLLAPSED_GROUPS_KEY, []),
  toggleGroupCollapse: (groupId) => set((s) => {
    const next = s.collapsedGroupIds.includes(groupId)
      ? s.collapsedGroupIds.filter((id) => id !== groupId)
      : [...s.collapsedGroupIds, groupId]
    saveJson(COLLAPSED_GROUPS_KEY, next)
    return { collapsedGroupIds: next }
  }),

  addSubtask: (parentId, subtask) => set((s) => ({
    tasks: s.tasks.map((t) => {
      if (t.id !== parentId) {return t}
      const subtasks = t.subtasks ? [...t.subtasks, subtask] : [subtask]
      // 父任务状态随子任务聚合
      return { ...t, subtasks, status: deriveGroupStatus(subtasks) }
    }),
  })),
  updateSubtaskStatus: (parentId, subtaskId, status) => set((s) => ({
    tasks: s.tasks.map((t) => {
      if (t.id !== parentId || !t.subtasks) {return t}
      const subtasks = t.subtasks.map((sub) =>
        sub.id === subtaskId
          ? { ...sub, status, completedAt: status === 'done' || status === 'error' ? Date.now() : sub.completedAt }
          : sub,
      )
      return { ...t, subtasks, status: deriveGroupStatus(subtasks) }
    }),
  })),
  removeSubtask: (parentId, subtaskId) => set((s) => ({
    tasks: s.tasks.map((t) => {
      if (t.id !== parentId || !t.subtasks) {return t}
      const subtasks = t.subtasks.filter((sub) => sub.id !== subtaskId)
      return { ...t, subtasks, status: deriveGroupStatus(subtasks) }
    }),
  })),

  // ── 区块折叠 ──
  collapsedSections: (() => {
    const DEFAULT_SECTIONS: Record<SectionKey, boolean> = {
      agents: false, tools: false, timeline: false, artifacts: false, board: false,
    }
    const raw = loadJson<Partial<Record<SectionKey, boolean>>>(COLLAPSED_SECTIONS_KEY, {})
    // 逐键类型校验，缺失/非法键回退默认
    const out = { ...DEFAULT_SECTIONS }
    for (const k of Object.keys(DEFAULT_SECTIONS) as SectionKey[]) {
      out[k] = raw[k] === true
    }
    return out
  })(),
  toggleSection: (section) => set((s) => {
    const collapsedSections = { ...s.collapsedSections, [section]: !s.collapsedSections[section] }
    saveJson(COLLAPSED_SECTIONS_KEY, collapsedSections)
    return { collapsedSections }
  }),

  // ── v03: 主视图切换 ──
  panelView: initialPanelView,
  setPanelView: (view) => {
    saveJson(PANEL_VIEW_KEY, view)
    set({ panelView: view })
  },

  // ── v03: 运行态并行子智能体 ──
  subagents: [],
  upsertSubagent: (item) => set((s) => {
    const idx = s.subagents.findIndex((x) => x.id === item.id)
    if (idx >= 0) {
      const next = [...s.subagents]
      next[idx] = { ...next[idx], ...item }
      return { subagents: next }
    }
    return { subagents: [...s.subagents, item] }
  }),
  removeSubagent: (id) => set((s) => ({
    subagents: s.subagents.filter((x) => x.id !== id),
  })),
  clearSubagents: () => set({ subagents: [] }),
  }
})
