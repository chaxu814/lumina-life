// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// components/ToolExecutionFeed.tsx — 工具执行反馈
//
// 数据源：taskWorkspaceStore.toolCalls（持久记录），不再读
//          agentRuntimeStore.toolTraces —— 后者每轮对话结束就被
//          resetAgentRuntime() 清空，导致工作区在 Agent 干完活的
//          那一刻变回"暂无工具调用"，看起来就是"工具没联动"。
//
// 展示：默认最近 5 条，可展开全部；点开看参数 / 结果 / 耗时。
// ============================================================

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useTaskWorkspace, summarizeArgs, type ToolCallRecord } from '../stores/taskWorkspaceStore'
import SearchModeBadge, { extractSearchMode, isSearchTool } from './SearchModeBadge'

const ToolExecutionFeed: React.FC = () => {
  const { t } = useTranslation()
  const toolCalls = useTaskWorkspace((s) => s.toolCalls)
  const activeConvId = useTaskWorkspace((s) => s.activeConversationId)
  const collapsedSections = useTaskWorkspace((s) => s.collapsedSections)
  const toggleSection = useTaskWorkspace((s) => s.toggleSection)
  const [expandedAll, setExpandedAll] = useState(false)
  const [openDetail, setOpenDetail] = useState<string | null>(null)
  // 本地手动清空（非破坏性，不影响 store 里的历史）
  const [manuallyCleared, setManuallyCleared] = useState(false)

  // 会话隔离：只显示当前会话的调用；切会话时自动收起"清空"状态
  const prevConvRef = useRef<string | null>(activeConvId)
  useEffect(() => {
    if (prevConvRef.current !== activeConvId) {
      prevConvRef.current = activeConvId
      setManuallyCleared(false)
      setOpenDetail(null)
    }
  }, [activeConvId])

  // 倒序（新的在上面），最新 5 条默认可见
  const items = useMemo<ToolCallRecord[]>(() => {
    if (manuallyCleared) {return []}
    return toolCalls
      .filter((c) => (c.conversationId ?? null) === (activeConvId ?? null))
      .slice()
      .reverse()
  }, [toolCalls, activeConvId, manuallyCleared])

  const running = items.some((i) => i.status === 'running')
  const toolsCollapsed = collapsedSections.tools
  const shown = expandedAll ? items : items.slice(0, 5)

  const header = (
    <div className="tw-section-header">
      <div
        className="tw-section-title tw-section-toggleable"
        onClick={() => toggleSection('tools')}
        title={toolsCollapsed ? t('toolfeed.expand') : t('toolfeed.collapse')}
      >
        {t('toolfeed.title')}
        {items.length > 0 && <span className="tw-section-count">{items.length}</span>}
        {running && <span className="tw-running-dot" />}
        <span className={`tw-chevron ${toolsCollapsed ? 'collapsed' : ''}`}>▾</span>
      </div>
      {!toolsCollapsed && items.length > 0 && (
        <button
          className="tw-clear-btn"
          onClick={() => { setManuallyCleared(true); setOpenDetail(null) }}
          title={t('toolfeed.clear_title')}
        >
          {t('toolfeed.clear')}
        </button>
      )}
    </div>
  )

  if (items.length === 0) {
    return (
      <div>
        {header}
        {!toolsCollapsed && (
          <div className="tw-empty">
            {manuallyCleared ? t('toolfeed.cleared') : t('toolfeed.empty')}
          </div>
        )}
      </div>
    )
  }

  return (
    <div>
      {header}
      {!toolsCollapsed && (
        <div className="tw-tool-feed">
          {shown.map((item) => (
            <div key={item.id} className="tw-tool-row">
              <div
                className="tw-tool-item"
                onClick={() => setOpenDetail(openDetail === item.id ? null : item.id)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    setOpenDetail(openDetail === item.id ? null : item.id)
                  }
                }}
              >
                <span className={`tw-tool-icon ${item.status}`}>
                  {item.status === 'running' ? <span className="tw-spin" />
                    : item.status === 'done' ? '✅'
                    : '❌'}
                </span>
                <span className="tw-tool-name">{item.name}</span>
                {item.durationMs != null && (
                  <span className="tw-tool-duration">{(item.durationMs / 1000).toFixed(1)}s</span>
                )}
                {item.args != null && (
                  <span className="tw-tool-args">{summarizeArgs(item.args, 48)}</span>
                )}
                {isSearchTool(item.name) && extractSearchMode(item.result) && (
                  <SearchModeBadge mode={extractSearchMode(item.result)!} />
                )}
              </div>
              {openDetail === item.id && (
                <div className="tw-tool-detail">
                  {item.args != null && (
                    <div className="tw-tool-detail-row">
                      <span className="tw-tool-detail-key">{t('toolfeed.detail_args')}</span>
                      <span className="tw-tool-detail-val">{summarizeArgs(item.args, 400)}</span>
                    </div>
                  )}
                  {item.result != null && (
                    <div className="tw-tool-detail-row">
                      <span className="tw-tool-detail-key">{t('toolfeed.detail_result')}</span>
                      <span className="tw-tool-detail-val">{summarizeArgs(item.result, 400)}</span>
                    </div>
                  )}
                  <div className="tw-tool-detail-row">
                    <span className="tw-tool-detail-key">{t('toolfeed.detail_started')}</span>
                    <span className="tw-tool-detail-val">{new Date(item.startedAt).toLocaleTimeString()}</span>
                  </div>
                </div>
              )}
            </div>
          ))}
          {items.length > 5 && (
            <button className="tw-tool-toggle" onClick={() => setExpandedAll(!expandedAll)}>
              {expandedAll ? t('toolfeed.collapse_all') : t('toolfeed.expand_all', { count: items.length })}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

export default ToolExecutionFeed
