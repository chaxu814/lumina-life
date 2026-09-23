// ============================================================
// components/AgentStatusCards.tsx — Agent 团队状态卡片
//
// 为 lumina / recha / yak 三个内置 Agent + 每个 Loop 任务渲染一张卡片。
// 状态与文案全部从 agentRuntimeStore / loopStore 真实派生，
// 无实时数据时显示"待机中"，不写死假进度。
//
// v6.3：有 subtasks 的任务渲染为父级分组卡片（进度条 + 可折叠子项）。
// ============================================================

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useAgentRuntime } from '../stores/agentRuntimeStore'
import { useLoopStore } from '../stores/loopStore'
import {
  useTaskWorkspace, deriveStatusText,
  aggregateSubtaskProgress, formatDuration, shouldAutoExpand,
} from '../stores/taskWorkspaceStore'
import type { TaskStatus, SubtaskItem, TaskWorkspaceTask } from '../stores/taskWorkspaceStore'

interface AgentDef {
  id: string
  name: string
  emoji: string
}

const BUILTIN_AGENTS: AgentDef[] = [
  { id: 'lumina', name: 'Lumina', emoji: '🐱' },
  { id: 'recha', name: '热茶', emoji: '🍵' },
  { id: 'yak', name: 'Yak', emoji: '📊' },
]

/** 根据 agentId 映射负责人 emoji：lumina→🐱 recha→🍵 yak→📊 loop:→🔁 */
function agentEmoji(agentId?: string): string {
  if (!agentId) return '🔁'
  if (agentId.startsWith('loop:')) return '🔁'
  const found = BUILTIN_AGENTS.find((a) => a.id === agentId)
  return found ? found.emoji : '🔁'
}

const StatusDot: React.FC<{ status: TaskStatus }> = ({ status }) => (
  <span className={`tw-status-dot ${status}`} />
)

const StatusCard: React.FC<{
  name: string
  emoji: string
  text: string
  status: TaskStatus
}> = ({ name, emoji, text, status }) => (
  <div className="tw-agent-card">
    <span className="tw-agent-avatar">{emoji}</span>
    <div className="tw-agent-info">
      <div className="tw-agent-name">{name}</div>
      <div className="tw-agent-status-text">{text}</div>
    </div>
    <StatusDot status={status} />
  </div>
)

/** 单个 Loop 任务卡片：hover 右上角出现 × 隐藏按钮，标题完整显示不截断 */
const LoopStatusCard: React.FC<{
  loop: { id: string; goal?: string; status?: string; runCount?: number }
  onDismiss: (id: string) => void
}> = ({ loop, onDismiss }) => {
  const status: TaskStatus =
    loop.status === 'running' ? 'running'
    : loop.status === 'done' ? 'done'
    : 'idle'
  const text =
    status === 'running' ? `第 ${loop.runCount ?? 0} 轮运行中`
    : status === 'idle' ? '已暂停/待命'
    : '已完成'
  return (
    <div className="tw-agent-card tw-loop-card">
      <span className="tw-agent-avatar">🔁</span>
      <div className="tw-agent-info">
        <div className="tw-agent-name tw-loop-name">{loop.goal || 'Loop 任务'}</div>
        <div className="tw-agent-status-text">{text}</div>
      </div>
      <StatusDot status={status} />
      <button
        className="tw-loop-delete"
        title="隐藏此任务"
        onClick={(e) => { e.stopPropagation(); onDismiss(loop.id) }}
      >✕</button>
    </div>
  )
}

/** 子任务状态文案 */
function subtaskStatusText(s: SubtaskItem): string {
  switch (s.status) {
    case 'done': return '已完成'
    case 'running': return '进行中'
    case 'error': return '失败'
    default: return '待开始'
  }
}

/**
 * 父级分组卡片：有 subtasks 的任务渲染此组件。
 * - running 默认自动展开（用户手动折叠后不再打断）；
 * - 子任务带竖向连接线 + 状态圆点，新完成项高亮动画；
 * - 进度条平滑过渡，chevron 旋转动画。
 */
const GroupTaskCard: React.FC<{
  task: TaskWorkspaceTask
  hasActiveExpanded: boolean
}> = ({ task, hasActiveExpanded }) => {
  const collapsedGroupIds = useTaskWorkspace((s) => s.collapsedGroupIds)
  const toggleGroupCollapse = useTaskWorkspace((s) => s.toggleGroupCollapse)
  const subtasks = task.subtasks || []
  const progress = aggregateSubtaskProgress(subtasks)

  // 默认展开逻辑：running 且未被用户手动折叠、且尚无其他活跃组自动展开
  const isCollapsed = collapsedGroupIds.includes(task.id)
  const autoExpand = shouldAutoExpand(task, collapsedGroupIds, hasActiveExpanded)
  const showExpanded = !isCollapsed && (autoExpand || !isCollapsed)

  // 追踪上一次各子任务状态，用于"刚完成"高亮
  const prevStatusRef = useRef<Map<string, TaskStatus>>(new Map())
  const [justCompletedId, setJustCompletedId] = useState<string | null>(null)
  useEffect(() => {
    const prev = prevStatusRef.current
    for (const sub of subtasks) {
      const old = prev.get(sub.id)
      if (old && old !== 'done' && sub.status === 'done') {
        setJustCompletedId(sub.id)
        const timer = setTimeout(() => setJustCompletedId((cur) => (cur === sub.id ? null : cur)), 1600)
        prev.set(sub.id, sub.status)
        return () => clearTimeout(timer)
      }
      prev.set(sub.id, sub.status)
    }
  }, [subtasks])

  // 跟随最新子任务变化滚动（仅展开态、面板可见时）
  const subtaskListRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!showExpanded || !subtaskListRef.current) return
    const last = subtaskListRef.current.lastElementChild
    if (last) (last as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [subtasks.length, showExpanded])

  const duration = task.createdAt
    ? formatDuration((task.subtasks?.[0]?.completedAt || Date.now()) - task.createdAt)
    : ''

  return (
    <div className="tw-group-card">
      <div
        className="tw-group-header"
        onClick={() => toggleGroupCollapse(task.id)}
      >
        <span className={`tw-status-dot ${task.status}`} />
        <span className="tw-group-emoji">{agentEmoji(task.agentId)}</span>
        <span className="tw-group-title" title={task.title}>{task.title}</span>
        <span className="tw-group-meta">{subtasks.length}项 · {duration}</span>
        <span
          className={`tw-group-chevron ${showExpanded ? '' : 'collapsed'}`}
        >▾</span>
      </div>
      <div className="tw-group-progress-bar">
        <div
          className={`tw-group-progress-fill ${task.status}`}
          style={{ width: `${progress.percent}%` }}
        />
      </div>
      <div className="tw-group-progress-text">
        {progress.done}/{progress.total} 完成
        {progress.error > 0 && ` · ${progress.error} 失败`}
      </div>
      <div
        className={`tw-group-subtasks-wrap ${showExpanded ? 'expanded' : 'collapsed'}`}
      >
        <div className="tw-group-subtasks" ref={subtaskListRef}>
          {subtasks.map((sub) => {
            const subDur = sub.completedAt && sub.createdAt
              ? formatDuration(sub.completedAt - sub.createdAt)
              : ''
            return (
              <div
                key={sub.id}
                className={`tw-subtask-item ${sub.status} ${sub.id === justCompletedId ? 'just-completed' : ''}`}
              >
                <span className={`tw-subtask-dot ${sub.status}`}>
                  {sub.status === 'done' ? '✓' : sub.status === 'error' ? '✕' : ''}
                </span>
                <span className="tw-subtask-title" title={sub.title}>{sub.title}</span>
                {sub.agentId && <span className="tw-subtask-agent">{agentEmoji(sub.agentId)}</span>}
                {subDur && <span className="tw-subtask-dur">{subDur}</span>}
                <span className="tw-subtask-status">{subtaskStatusText(sub)}</span>
                {sub.status === 'error' && (
                  <button
                    className="tw-subtask-retry"
                    title="重试"
                    onClick={(e) => { e.stopPropagation(); console.log('[selftest] retry subtask', sub.id) }}
                  >↻</button>
                )}
              </div>
            )
          })}
          {subtasks.length === 0 && (
            <div className="tw-subtask-empty">暂无子任务</div>
          )}
        </div>
      </div>
    </div>
  )
}

const AgentStatusCards: React.FC = () => {
  const lastThinking = useAgentRuntime((s) => s.lastThinking)
  const toolTraces = useAgentRuntime((s) => s.toolTraces)
  const loopTasks = useLoopStore((s) => s.tasks)
  // 从任务工作区 store 读取"已隐藏 Loop 任务"与对应动作
  const dismissedLoopIds = useTaskWorkspace((s) => s.dismissedLoopIds)
  const dismissLoopTask = useTaskWorkspace((s) => s.dismissLoopTask)
  const clearFinishedLoopTasks = useTaskWorkspace((s) => s.clearFinishedLoopTasks)
  const tasks = useTaskWorkspace((s) => s.tasks)
  const collapsedGroupIds = useTaskWorkspace((s) => s.collapsedGroupIds)
  const toggleSection = useTaskWorkspace((s) => s.toggleSection)
  const collapsedSections = useTaskWorkspace((s) => s.collapsedSections)
  // 内联确认弹层（非浏览器 confirm）
  const [confirmClear, setConfirmClear] = useState(false)

  const builtin = useMemo(() => {
    return BUILTIN_AGENTS.map((agent) => {
      // 当前运行时事件是全局共享的，三张卡片共用派生结果；
      // 不伪造单 Agent 专属进度，只反映全局活动状态。
      const { text, status } = deriveStatusText(lastThinking, toolTraces)
      return { ...agent, text, status }
    })
  }, [lastThinking, toolTraces])

  // 过滤掉已被用户隐藏的 Loop 任务
  const visibleLoops = useMemo(
    () => loopTasks.filter((l) => !dismissedLoopIds.includes(l.id)),
    [loopTasks, dismissedLoopIds],
  )

  // 有 subtasks 的工作区任务渲染为分组卡片，其余 Loop 走普通卡片
  const groupedTasks = useMemo(
    () => tasks.filter((t) => t.subtasks && t.subtasks.length > 0),
    [tasks],
  )

  // 计算每个 running 分组是否已有更早的活跃分组自动展开（最多自动展开一个）
  let seenActiveExpanded = false
  const groupFlags = new Map<string, boolean>()
  for (const t of groupedTasks) {
    const auto = shouldAutoExpand(t, collapsedGroupIds, seenActiveExpanded)
    groupFlags.set(t.id, auto)
    if (auto) seenActiveExpanded = true
  }

  // 仅当存在非 running 的 Loop 任务时才显示"清空已完成"按钮
  const hasFinished = visibleLoops.some((l) => l.status !== 'running')

  const handleClearFinished = () => {
    clearFinishedLoopTasks()
    setConfirmClear(false)
  }

  const agentsCollapsed = collapsedSections.agents

  return (
    <div>
      <div className="tw-section-header">
        <div
          className="tw-section-title tw-section-toggleable"
          onClick={() => toggleSection('agents')}
          title={agentsCollapsed ? '展开' : '折叠'}
        >
          Agent 团队状态
          <span className={`tw-chevron ${agentsCollapsed ? 'collapsed' : ''}`}>▾</span>
        </div>
        {!agentsCollapsed && hasFinished && (
          confirmClear ? (
            <span className="tw-confirm-inline">
              确定清空所有已完成/暂停的任务？
              <button className="tw-confirm-ok" onClick={handleClearFinished}>确定</button>
              <button className="tw-confirm-cancel" onClick={() => setConfirmClear(false)}>取消</button>
            </span>
          ) : (
            <button className="tw-clear-btn" onClick={() => setConfirmClear(true)}>🗑 清空已完成</button>
          )
        )}
      </div>
      {!agentsCollapsed && (
        <div className="tw-agent-cards">
          {builtin.map((a) => (
            <StatusCard key={a.id} name={a.name} emoji={a.emoji} text={a.text} status={a.status} />
          ))}
          {/* 有子任务的工作区任务 → 分组卡片 */}
          {groupedTasks.map((t) => (
            <GroupTaskCard key={t.id} task={t} hasActiveExpanded={!groupFlags.get(t.id)} />
          ))}
          {/* 全部被隐藏或无 Loop 任务时直接留白，不渲染占位 */}
          {visibleLoops.map((loop) => (
            <LoopStatusCard key={loop.id} loop={loop} onDismiss={dismissLoopTask} />
          ))}
        </div>
      )}
    </div>
  )
}

export default AgentStatusCards
