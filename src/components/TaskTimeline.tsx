// ============================================================
// components/TaskTimeline.tsx — 任务时间线
//
// 左侧时间轴竖线 + 圆点，右侧事件内容。
// 新事件高亮动画；自动滚动到底部（用户上滑时暂停，回底恢复）。
// 支持按事件类型筛选。
//
// v6.3：事件按 parentId 分组渲染，组标题可折叠；区块整体可折叠。
// ============================================================

import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  useTaskWorkspace, type TimelineEvent, type TimelineEventType,
  groupTimelineByParent, UNGROUPED_GROUP,
} from '../stores/taskWorkspaceStore'

const EVENT_ICON: Record<TimelineEventType, string> = {
  thinking: '💭',
  tool_start: '⚡',
  tool_end: '✅',
  tool_error: '❌',
  text: '💬',
  system: '📌',
  artifact: '📄',
}

type Filter = 'all' | 'tool' | 'thinking' | 'message'

const FILTERS: Array<{ key: Filter; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'tool', label: '工具' },
  { key: 'thinking', label: '思考' },
  { key: 'message', label: '消息' },
]

function matchFilter(ev: TimelineEvent, filter: Filter): boolean {
  if (filter === 'all') {return true}
  if (filter === 'tool') {return ev.type === 'tool_start' || ev.type === 'tool_end' || ev.type === 'tool_error'}
  if (filter === 'thinking') {return ev.type === 'thinking'}
  if (filter === 'message') {return ev.type === 'text' || ev.type === 'system'}
  return true
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  return `${hh}:${mm}:${ss}`
}

/** 单条事件行 */
const EventRow: React.FC<{ ev: TimelineEvent; isLast: boolean; onRemove: (id: string) => void }> = ({
  ev, isLast, onRemove,
}) => (
  <div className={`tw-tl-item ${isLast ? 'highlight' : ''}`}>
    <span className={`tw-tl-dot ${ev.type}`} />
    <div className="tw-tl-head">
      <span className="tw-tl-icon">{EVENT_ICON[ev.type] || '•'}</span>
      <span>{ev.agentId}</span>
      <span className="tw-tl-time">{formatTime(ev.timestamp)}</span>
    </div>
    <div className="tw-tl-text">{ev.text}</div>
    <button
      className="tw-tl-delete"
      title="删除此事件"
      onClick={() => onRemove(ev.id)}
    >✕</button>
  </div>
)

const TaskTimeline: React.FC<{ taskId: string | null }> = ({ taskId }) => {
  const timeline = useTaskWorkspace((s) => s.timeline)
  const activeConversationId = useTaskWorkspace((s) => s.activeConversationId)
  const removeTimelineEvent = useTaskWorkspace((s) => s.removeTimelineEvent)
  const clearTimeline = useTaskWorkspace((s) => s.clearTimeline)
  const collapsedSections = useTaskWorkspace((s) => s.collapsedSections)
  const toggleSection = useTaskWorkspace((s) => s.toggleSection)
  const [filter, setFilter] = useState<Filter>('all')
  const [confirmClear, setConfirmClear] = useState(false)
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)

  // 当前任务 + 当前会话的事件：
  // - taskId 为空时显示全部任务事件
  // - 按会话隔离：只显示当前会话的事件；无 conversationId 的旧事件兼容显示
  const events = useMemo(() => {
    const scoped = taskId ? timeline.filter((e) => e.taskId === taskId) : timeline
    const convScoped = scoped.filter(
      (e) => !e.conversationId || e.conversationId === activeConversationId,
    )
    return convScoped.filter((e) => matchFilter(e, filter))
  }, [timeline, taskId, filter, activeConversationId])

  // 按 parentId 分组
  const groups = useMemo(() => groupTimelineByParent(events), [events])
  const groupKeys = Object.keys(groups)

  const lastId = events.length ? events[events.length - 1].id : null

  // 自动滚动到底部（仅在用户贴底时）
  useEffect(() => {
    const el = scrollRef.current
    if (el && stickToBottom.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [lastId, events.length])

  const onScroll = () => {
    const el = scrollRef.current
    if (!el) {return}
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24
    stickToBottom.current = atBottom
  }

  const handleClear = () => {
    clearTimeline(taskId ?? undefined)
    setConfirmClear(false)
  }

  const toggleGroup = (key: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(key)) {next.delete(key)}
      else {next.add(key)}
      return next
    })
  }

  const timelineCollapsed = collapsedSections.timeline

  const renderEventList = (list: TimelineEvent[], groupKey: string) => {
    const isGroupCollapsed = collapsedGroups.has(groupKey)
    return (
      <div key={groupKey} className="tw-tl-group">
        {groupKeys.length > 1 && (
          <div className="tw-tl-group-header" onClick={() => toggleGroup(groupKey)}>
            <span className={`tw-group-chevron ${isGroupCollapsed ? 'collapsed' : ''}`}>▾</span>
            <span className="tw-tl-group-title">
              {groupKey === UNGROUPED_GROUP ? '其他' : `子任务 ${groupKey}`}
            </span>
            <span className="tw-tl-group-count">{list.length}</span>
          </div>
        )}
        {!isGroupCollapsed && (
          list.map((ev) => (
            <EventRow key={ev.id} ev={ev} isLast={ev.id === lastId} onRemove={removeTimelineEvent} />
          ))
        )}
      </div>
    )
  }

  return (
    <div>
      <div className="tw-section-header">
        <div
          className="tw-section-title tw-section-toggleable"
          onClick={() => toggleSection('timeline')}
          title={timelineCollapsed ? '展开' : '折叠'}
        >
          时间线
          <span className={`tw-chevron ${timelineCollapsed ? 'collapsed' : ''}`}>▾</span>
        </div>
        {!timelineCollapsed && events.length > 0 && (
          confirmClear ? (
            <span className="tw-confirm-inline">
              清空？
              <button className="tw-confirm-ok" onClick={handleClear}>确定</button>
              <button className="tw-confirm-cancel" onClick={() => setConfirmClear(false)}>取消</button>
            </span>
          ) : (
            <button className="tw-clear-btn" onClick={() => setConfirmClear(true)}>清空</button>
          )
        )}
      </div>

      {!timelineCollapsed && (
        events.length === 0 ? (
          <div className="tw-empty-state">
            <div className="tw-empty-icon">📋</div>
            <div>暂无事件，执行任务后这里会显示过程</div>
          </div>
        ) : (
          <>
            <div className="tw-filter-bar">
              {FILTERS.map((f) => (
                <button
                  key={f.key}
                  className={`tw-filter-btn ${filter === f.key ? 'active' : ''}`}
                  onClick={() => setFilter(f.key)}
                >
                  {f.label}
                </button>
              ))}
            </div>
            <div className="tw-timeline" ref={scrollRef} onScroll={onScroll} style={{ maxHeight: 320, overflowY: 'auto' }}>
              {groupKeys.map((key) => renderEventList(groups[key], key))}
            </div>
          </>
        )
      )}
    </div>
  )
}

export default TaskTimeline
