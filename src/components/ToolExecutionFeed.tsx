// ============================================================
// components/ToolExecutionFeed.tsx — 工具执行反馈
//
// 从 agentRuntimeStore.toolTraces + agentEvents 提取工具执行事件。
// 克制展示：默认只显示最近 3 条，可展开全部；点击展开查看完整参数。
// ============================================================

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useAgentRuntime } from '../stores/agentRuntimeStore'
import { useTaskWorkspace, summarizeArgs } from '../stores/taskWorkspaceStore'
interface FeedItem {
  key: string
  name: string
  status: 'running' | 'done' | 'error'
  args?: unknown
  result?: unknown
}

const ToolExecutionFeed: React.FC = () => {
  const toolTraces = useAgentRuntime((s) => s.toolTraces)
  const agentEvents = useAgentRuntime((s) => s.agentEvents)
  // 订阅当前会话 ID：toolTraces 是全局数据且无会话标记，
  // 切换会话时把旧快照作为基线隐藏，只显示新会话期间新增的工具调用。
  const activeConvId = useTaskWorkspace((s) => s.activeConversationId)
  const collapsedSections = useTaskWorkspace((s) => s.collapsedSections)
  const toggleSection = useTaskWorkspace((s) => s.toggleSection)
  const [expandedAll, setExpandedAll] = useState(false)
  const [openDetail, setOpenDetail] = useState<string | null>(null)
  // 本地手动清空（非破坏性，不影响全局 toolTraces）
  const [manuallyCleared, setManuallyCleared] = useState(false)

  // 合并 toolTraces（实时状态）与 agentEvents 中的参数/结果
  const itemsByName = useMemo<Map<string, FeedItem>>(() => {
    // 以 toolTraces 为主（最近状态），再回填参数
    const byName = new Map<string, FeedItem>()
    toolTraces.forEach((t) => {
      byName.set(t.name, { key: t.name, name: t.name, status: t.status })
    })
    // 从 agentEvents 回填参数/结果
    agentEvents.forEach((ev) => {
      if ((ev.type === 'tool_start' || ev.type === 'tool_end' || ev.type === 'tool_error') && ev.tool) {
        const existing = byName.get(ev.tool)
        if (existing) {
          if (ev.args != null) existing.args = ev.args
          if (ev.result != null) existing.result = ev.result
        }
      }
    })
    return byName
  }, [toolTraces, agentEvents])

  // 会话隔离基线：切换会话时，把当前已有的工具名记为"旧会话遗留"，不再显示
  const prevConvRef = useRef<string | null>(activeConvId)
  const baselineRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (prevConvRef.current !== activeConvId) {
      baselineRef.current = new Set(itemsByName.keys())
      prevConvRef.current = activeConvId
      setManuallyCleared(false)
    }
  }, [activeConvId, itemsByName])

  // 可见项：基线之后新增的工具名（基线中已有的视为上个会话遗留，隐藏）
  const items = useMemo<FeedItem[]>(() => {
    if (manuallyCleared) return []
    const result: FeedItem[] = []
    for (const [name, item] of itemsByName) {
      if (!baselineRef.current.has(name)) result.push(item)
    }
    return result
  }, [itemsByName, manuallyCleared])

  if (items.length === 0) {
    return (
      <div>
        <div className="tw-section-header">
          <div
            className="tw-section-title tw-section-toggleable"
            onClick={() => toggleSection('tools')}
            title={collapsedSections.tools ? '展开' : '折叠'}
          >
            工具执行
            <span className={`tw-chevron ${collapsedSections.tools ? 'collapsed' : ''}`}>▾</span>
          </div>
        </div>
        {!collapsedSections.tools && <div className="tw-empty">暂无工具调用</div>}
      </div>
    )
  }

  const shown = expandedAll ? items : items.slice(-3)
  const running = items.some((i) => i.status === 'running')
  const toolsCollapsed = collapsedSections.tools

  return (
    <div>
      <div className="tw-section-header">
        <div
          className="tw-section-title tw-section-toggleable"
          onClick={() => toggleSection('tools')}
          title={toolsCollapsed ? '展开' : '折叠'}
        >
          工具执行{running ? '（运行中…）' : ''}
          <span className={`tw-chevron ${toolsCollapsed ? 'collapsed' : ''}`}>▾</span>
        </div>
        {!toolsCollapsed && (
          <button className="tw-clear-btn" onClick={() => setManuallyCleared(true)}>清空</button>
        )}
      </div>
      {!toolsCollapsed && (
      <div className="tw-tool-feed">
        {shown.map((item) => (
          <div key={item.key}>
            <div
              className="tw-tool-item"
              onClick={() => setOpenDetail(openDetail === item.key ? null : item.key)}
              style={{ cursor: 'pointer' }}
            >
              {item.status === 'running' && <span className="tw-spin" />}
              {item.status === 'done' && <span>✅</span>}
              {item.status === 'error' && <span>❌</span>}
              <span className="tw-tool-name">{item.name}</span>
              {item.args != null && (
                <span className="tw-tool-args">{summarizeArgs(item.args, 60)}</span>
              )}
            </div>
            {openDetail === item.key && item.args != null && (
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', padding: '4px 8px' }}>
                <div>参数：{summarizeArgs(item.args, 400)}</div>
                {item.result != null && (
                  <div style={{ marginTop: 2 }}>结果：{summarizeArgs(item.result, 400)}</div>
                )}
              </div>
            )}
          </div>
        ))}
        {items.length > 3 && (
          <button className="tw-tool-toggle" onClick={() => setExpandedAll(!expandedAll)}>
            {expandedAll ? '收起' : `展开全部 ${items.length} 条`}
          </button>
        )}
      </div>
      )}
    </div>
  )
}

export default ToolExecutionFeed
