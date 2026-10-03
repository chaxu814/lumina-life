// ============================================================
// components/SubagentCards.tsx — 子智能体（实习生）进度卡片
//
// 功能：
//   1. 消费 useTaskWorkspace.subagents，把 InternPool 派生的并行子智能体
//      渲染成卡片列表（数据链路见 services/taskWorkspaceBridge.ts 的 onSubtaskEvent）
//   2. 每张卡：左侧 owner 图标 + 实习生名，中部任务标题摘要，右侧状态徽章
//   3. 点击展开详情：done → result，error → error；失败原因同时内联在卡片行
//      （不让用户必须点开才知道出错）
//   4. done / error 卡片保留在列表里但视觉弱化，可一键「清除已完成」
//   5. 空状态直接返回 null，不渲染任何占位
//
// 样式：styles/subagent-cards.css（与 .task-dispatcher-* 同一套动效语言）
// ============================================================

import React, { useCallback, useMemo, useState } from 'react'
import { useTaskWorkspace, type SubagentItem, type TaskStatus } from '../stores/taskWorkspaceStore'
import { TEAM_MEMBERS } from '../data/agentRoles'

/** 未知 owner 的兜底图标（写转义避免不同编辑器编码问题） */
const FALLBACK_ICON = '\u{1F916}'

/** 状态 → 徽章文案。注意 idle 也要有对应呈现，不能漏。 */
const STATUS_META: Record<TaskStatus, { label: string; spin: boolean }> = {
  running: { label: '工作中', spin: true },
  done: { label: '已完成', spin: false },
  error: { label: '失败', spin: false },
  idle: { label: '待机', spin: false },
}

/** 终态卡片（已完成 / 失败）：弱化显示但不清除 */
const TERMINAL: TaskStatus[] = ['done', 'error']

function ownerMeta(owner: string) {
  return TEAM_MEMBERS.find((m) => m.id === owner)
}

function fmtDuration(ms: number): string {
  if (ms < 1000) {return '<1 秒'}
  const s = Math.round(ms / 1000)
  if (s < 60) {return `${s} 秒`}
  const m = Math.floor(s / 60)
  const rest = s % 60
  return rest ? `${m} 分 ${rest} 秒` : `${m} 分`
}

function fmtClock(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function SubagentCard({ item }: { item: SubagentItem }) {
  const [open, setOpen] = useState(false)
  const toggle = useCallback(() => setOpen((v) => !v), [])

  const meta = STATUS_META[item.status]
  const owner = ownerMeta(item.owner)
  const icon = owner?.icon ?? FALLBACK_ICON

  // 主标题：实习生名优先，缺省回退到 owner 名（避免与下面的任务标题重复）
  const primary = item.internName || owner?.name || item.owner
  const spent = item.completedAt ? fmtDuration(item.completedAt - item.createdAt) : null

  return (
    <div className={`sa-card is-${item.status}`}>
      <button
        type="button"
        className="sa-row"
        onClick={toggle}
        aria-expanded={open}
        title={open ? '收起详情' : '展开详情'}
      >
        <span className="sa-icon" aria-hidden="true">{icon}</span>
        <span className="sa-main">
          <span className="sa-primary">{primary}</span>
          <span className="sa-sub">{item.title || '（无标题子任务）'}</span>
          {/* 失败原因内联：不让用户点了卡片才知道出错了 */}
          {item.status === 'error' && item.error && (
            <span className="sa-error-inline">⚠ {item.error}</span>
          )}
        </span>
        <span className="sa-right">
          <span className={`sa-badge is-${item.status}`}>
            {meta.spin && <i className="sa-spin" aria-hidden="true" />}
            {meta.label}
          </span>
          <span className={`sa-caret${open ? ' is-open' : ''}`} aria-hidden="true">▾</span>
        </span>
      </button>

      {/* 展开区：grid-template-rows 0fr→1fr，实现内容自适应高度的平滑展开 */}
      <div className="sa-expand" data-open={open ? 'true' : 'false'}>
        <div className="sa-expand-inner">
          <div className="sa-detail">
            {item.status === 'error' ? (
              <>
                <div className="sa-detail-label is-error">失败原因</div>
                <div className="sa-detail-text is-error">{item.error || '（未提供错误信息）'}</div>
              </>
            ) : (
              <>
                <div className="sa-detail-label">完成摘要</div>
                <div className="sa-detail-text">
                  {item.result || (item.status === 'running' ? '正在执行…' : '（无结果输出）')}
                </div>
              </>
            )}
            <div className="sa-meta">
              <span>owner · {item.owner}</span>
              <span>开始 {fmtClock(item.createdAt)}</span>
              {item.completedAt && <span>耗时 {spent}</span>}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export default function SubagentCards({ sessionId }: { sessionId?: string } = {}) {
  const allSubagents = useTaskWorkspace((s) => s.subagents)

  // 按会话过滤：子智能体池是全局的，不加这个切会话时会看到别的会话的实习生。
  // 判定口径：
  //   · 传了 sessionId → 只显示属于它的；未派活的（无 sessionId）也算当前会话的
  //     （它们刚 hire 出来还没 assign，此刻就是为本会话准备的）
  //   · 没传 sessionId → 不过滤，退回旧的「显示全部」行为
  const subagents = useMemo(() => {
    if (!sessionId) {return allSubagents}
    return allSubagents.filter((s) => !s.sessionId || s.sessionId === sessionId)
  }, [allSubagents, sessionId])

  // 空状态：不渲染任何东西，避免在输入区上方留一块死空间
  if (subagents.length === 0) {return null}

  const active = subagents.filter((s) => s.status === 'running').length
  const finished = subagents.filter((s) => TERMINAL.includes(s.status)).length

  // 清除已完成：只从**当前可见的**子里移除，避免误删其他会话的卡片
  const clearFinished = useCallback(() => {
    useTaskWorkspace.setState((s) => {
      if (!sessionId) {
        return { subagents: s.subagents.filter((x) => !TERMINAL.includes(x.status)) }
      }
      return {
        subagents: s.subagents.filter((x) => {
          const mine = !x.sessionId || x.sessionId === sessionId
          return !(mine && TERMINAL.includes(x.status))
        }),
      }
    })
  }, [sessionId])

  return (
    <div className="sa-list">
      <div className="sa-head">
        <span className="sa-head-title">子智能体 {subagents.length}</span>
        {active > 0 && <span className="sa-head-active">{active} 进行中</span>}
        {finished > 0 && (
          <button
            type="button"
            className="sa-clear"
            onClick={clearFinished}
            title="清除已完成 / 失败的卡片"
          >
            清除已完成
          </button>
        )}
      </div>

      {subagents.map((item) => (
        <SubagentCard key={item.id} item={item} />
      ))}
    </div>
  )
}
