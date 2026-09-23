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
  if (args == null) return ''
  let str: string
  try {
    str = typeof args === 'string' ? args : JSON.stringify(args)
  } catch {
    str = String(args)
  }
  str = str.replace(/\s+/g, ' ').trim()
  if (str.length <= max) return str
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

// ─── 已隐藏 Loop 任务的持久化（localStorage） ─────────────
// 背景：Loop 任务通过 createElectronLoopPersistence() 持久化到磁盘，
// 历史会话中创建的数学题任务（已暂停）会一直回流到面板。
// 这里只记录"用户主动隐藏"的 Loop 原始 ID，不真正删除 Loop 引擎数据，
// 用户清空 localStorage 或调用 restore 即可找回。

const DISMISS_KEY = 'lumina_tw_dismissed_loops'

/** 从 localStorage 读取已隐藏的 Loop ID 列表；不可用时降级为空数组 */
function loadDismissedLoops(): string[] {
  try {
    if (typeof localStorage === 'undefined') return []
    const raw = localStorage.getItem(DISMISS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((x): x is string => typeof x === 'string')
  } catch {
    return []
  }
}

/** 把已隐藏的 Loop ID 列表写回 localStorage；不可用时静默忽略 */
function saveDismissedLoops(ids: string[]): void {
  try {
    if (typeof localStorage === 'undefined') return
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
    if (!groups[key]) groups[key] = []
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
    if (s.status === 'done') done++
    else if (s.status === 'running') running++
    else if (s.status === 'error') error++
    else idle++
  }
  const total = subtasks.length
  const percent = total > 0 ? Math.round(((done + error) / total) * 100) : 0
  return { total, done, running, error, idle, percent }
}

/** 从子任务状态推导父任务整体状态：有error→error，有running→running，全done→done，否则idle */
export function deriveGroupStatus(subtasks: SubtaskItem[]): TaskStatus {
  if (subtasks.length === 0) return 'idle'
  const { done, running, error } = aggregateSubtaskProgress(subtasks)
  if (error > 0) return 'error'
  if (running > 0) return 'running'
  if (done === subtasks.length) return 'done'
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
  if (task.status !== 'running') return false
  if (collapsedGroupIds.includes(task.id)) return false
  if (hasActiveExpanded) return false
  return true
}

/** 格式化耗时：ms → "12.3s" / "2m 5s" / "1h 2m" */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0s'
  if (ms < 1000) return `${Math.round(ms)}ms`
  const totalSec = ms / 1000
  if (totalSec < 60) return `${Math.round(totalSec * 10) / 10}s`
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
  if (ext === 'pdf') return 'pdf'
  if (IMAGE_EXTS.has(ext)) return 'image'
  if (ext === 'json') return 'json'
  if (ext === 'csv' || ext === 'tsv') return 'csv'
  if (ext === 'md' || ext === 'markdown') return 'markdown'
  if (CODE_EXTS.has(ext)) return 'code'
  if (TEXT_EXTS.has(ext)) return 'text'
  // 无扩展名或未知：用内容嗅探
  const head = (content || '').slice(0, 256).trim()
  if (head.startsWith('{') || head.startsWith('[')) {
    try { JSON.parse(head); return 'json' } catch { /* 非合法 JSON，回退 text */ }
  }
  if (head.includes(',') && head.includes('\n')) return 'csv'
  if (head.length > 0) return 'text'
  return 'binary'
}

/** 判定是否为文本类（可安全以字符串处理） */
export function isTextArtifact(kind: ArtifactKind): boolean {
  return kind === 'code' || kind === 'markdown' || kind === 'json'
    || kind === 'csv' || kind === 'text'
}

// ─── 持久化 helper（分组折叠 / 区块折叠 / 宽度 / 最近产物） ──

const COLLAPSED_GROUPS_KEY = 'lumina_tw_collapsed_groups'
const COLLAPSED_SECTIONS_KEY = 'lumina_tw_collapsed_sections'
const PANEL_WIDTH_KEY = 'lumina_tw_panel_width'
const LAST_ARTIFACT_KEY = 'lumina_tw_last_artifact'

function loadJson<T>(key: string, fallback: T): T {
  try {
    if (typeof localStorage === 'undefined') return fallback
    const raw = localStorage.getItem(key)
    if (!raw) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

/** 读取字符串数组型持久化，非数组或元素非字符串时回退默认值 */
function loadStringArray(key: string, fallback: string[] = []): string[] {
  try {
    if (typeof localStorage === 'undefined') return fallback
    const raw = localStorage.getItem(key)
    if (!raw) return fallback
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return fallback
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

function saveJson(key: string, value: unknown): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(key, JSON.stringify(value))
  } catch { /* 隐私模式/Node 测试环境降级 */ }
}

export type SectionKey = 'agents' | 'tools' | 'timeline' | 'artifacts'

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

  /** 产物标签页 */
  artifacts: ArtifactItem[]
  activeArtifactId: string | null
  addArtifact: (a: ArtifactItem) => void
  closeArtifact: (id: string) => void
  setActiveArtifact: (id: string | null) => void

  /** 同步 Loop 任务（由组件在 effect 中调用） */
  syncLoopTasks: (loops: LoopTaskShape[]) => void

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
    if (s.dismissedLoopIds.includes(loopId)) return s
    const next = [...s.dismissedLoopIds, loopId]
    saveDismissedLoops(next)
    // 同时从工作区 tasks 里移除对应卡片
    const tasks = s.tasks.filter((t) => t.agentId !== `loop:${loopId}`)
    return { dismissedLoopIds: next, tasks }
  }),
  restoreLoopTask: (loopId) => set((s) => {
    if (!s.dismissedLoopIds.includes(loopId)) return s
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
    if (toDismiss.length === 0) return 0
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
      if (t.id !== parentId) return t
      const subtasks = t.subtasks ? [...t.subtasks, subtask] : [subtask]
      // 父任务状态随子任务聚合
      return { ...t, subtasks, status: deriveGroupStatus(subtasks) }
    }),
  })),
  updateSubtaskStatus: (parentId, subtaskId, status) => set((s) => ({
    tasks: s.tasks.map((t) => {
      if (t.id !== parentId || !t.subtasks) return t
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
      if (t.id !== parentId || !t.subtasks) return t
      const subtasks = t.subtasks.filter((sub) => sub.id !== subtaskId)
      return { ...t, subtasks, status: deriveGroupStatus(subtasks) }
    }),
  })),

  // ── 区块折叠 ──
  collapsedSections: (() => {
    const DEFAULT_SECTIONS: Record<SectionKey, boolean> = {
      agents: false, tools: false, timeline: false, artifacts: false,
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
  }
})
