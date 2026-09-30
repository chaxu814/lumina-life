// ============================================================
// components/TaskBoardPanel.tsx — 进度看板（图1 样式）
//
// 展示 Agent / 外部任务板的推进情况：
//   ✓ 已完成        （勾 + 淡灰删除线文案）
//   6 进行中        （彩色序号圆点 + 深色加粗）
//   8 待开始        （灰色序号 + 浅灰文案）
// 每条可挂交付物（结果），点开直接在工作区产物区打开 / 外部打开。
//
// 数据来自 taskWorkspaceStore.board，可由 taskBoard:set IPC 或
// Agent 调 task_board_update 工具写入。
// ============================================================

import React from 'react'
import { useTaskWorkspace, boardProgress, type BoardItem } from '../stores/taskWorkspaceStore'

const DeliverableChip: React.FC<{ item: BoardItem }> = ({ item }) => {
  const d = item.deliverable
  const setActiveArtifact = useTaskWorkspace((s) => s.setActiveArtifact)

  if (!d) return null

  const onClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (d.kind === 'artifact' && d.ref) {
      // 切到产物区并激活对应产物
      setActiveArtifact(d.ref)
    } else if (d.kind === 'url' && d.ref) {
      window.luminaAPI?.openExternal?.(d.ref)
    } else if (d.kind === 'file' && d.ref) {
      window.luminaAPI?.openPath?.(d.ref)
    }
  }

  const icon = d.kind === 'artifact' ? '📎' : d.kind === 'url' ? '🔗' : d.kind === 'file' ? '📄' : '💬'

  return (
    <button
      className="tw-board-deliverable"
      onClick={onClick}
      title={`${d.kind}: ${d.label}`}
      type="button"
    >
      <span className="tw-board-deliverable-icon">{icon}</span>
      <span className="tw-board-deliverable-label">{d.label}</span>
    </button>
  )
}

const TaskBoardPanel: React.FC = () => {
  const board = useTaskWorkspace((s) => s.board)
  const collapsedSections = useTaskWorkspace((s) => s.collapsedSections)
  const toggleSection = useTaskWorkspace((s) => s.toggleSection)
  const updateBoardItem = useTaskWorkspace((s) => s.updateBoardItem)
  const clearBoard = useTaskWorkspace((s) => s.clearBoard)

  if (!board) return null

  const collapsed = collapsedSections.board
  const { done, total, percent } = boardProgress(board)

  return (
    <div className="tw-board">
      <div className="tw-section-header">
        <div
          className="tw-section-title tw-section-toggleable"
          onClick={() => toggleSection('board')}
          title={collapsed ? '展开' : '折叠'}
        >
          {board.title}
          <span className="tw-section-count">{done}/{total}</span>
          <span className={`tw-chevron ${collapsed ? 'collapsed' : ''}`}>▾</span>
        </div>
        {!collapsed && (
          <button className="tw-clear-btn" onClick={clearBoard} title="清空看板">清空</button>
        )}
      </div>

      {!collapsed && (
        <>
          <div className="tw-board-progress">
            <div className="tw-board-progress-bar">
              <div className="tw-board-progress-fill" style={{ width: `${percent}%` }} />
            </div>
            <span className="tw-board-progress-text">{percent}%</span>
          </div>

          <ol className="tw-board-list">
            {board.items.map((item, i) => (
              <li
                key={item.id}
                className={`tw-board-item ${item.status}`}
                title={item.text}
              >
                <span className="tw-board-marker" aria-hidden>
                  {item.status === 'done' ? '✓' : i + 1}
                </span>
                <div className="tw-board-body">
                  <span className="tw-board-text">{item.text}</span>
                  <DeliverableChip item={item} />
                </div>
                {/* 手动翻转状态：pending ↔ active ↔ done */}
                <button
                  className="tw-board-toggle"
                  title="切换状态"
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    const next =
                      item.status === 'done' ? 'pending'
                      : item.status === 'active' ? 'done'
                      : 'active'
                    updateBoardItem(item.id, { status: next })
                  }}
                >
                  ⇄
                </button>
              </li>
            ))}
          </ol>
        </>
      )}
    </div>
  )
}

export default TaskBoardPanel
