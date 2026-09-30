// ============================================================
// components/TaskWorkspacePanel.tsx — Agent 团队任务工作区面板
//
// 右侧抽屉式面板（始终挂载，CSS 过渡开合）：
// - 外层 .tw-panel-wrapper：width/flex-basis 从 0 过渡到 var(--tw-panel-w)
// - 内层 .tw-panel：transform: translateX 从 100% 滑入，opacity 淡入
// - 顶部任务标签页 + Agent 状态卡片 + 时间线 + 工具反馈 + 底部输入
// - 宽度可拖拽调整（280-500px），拖拽期间临时禁用过渡
//
// 桥接：订阅 agentRuntimeStore.agentEvents → 时间线；
//       同步 loopStore.tasks → 任务卡片。
// ============================================================

import React, { useEffect, useRef, useState, useCallback } from 'react'
import { useTaskWorkspace, mapAgentEventToTimeline, getPanelWrapperClass } from '../stores/taskWorkspaceStore'
import { useAgentRuntime } from '../stores/agentRuntimeStore'
import { useLoopStore } from '../stores/loopStore'
import { useStore } from '../stores/appStore'
import AgentStatusCards from './AgentStatusCards'
import TaskTimeline from './TaskTimeline'
import ToolExecutionFeed from './ToolExecutionFeed'
import TaskBoardPanel from './TaskBoardPanel'
import ArtifactViewer from './ArtifactViewer'
// dev-only：产物渲染器自检条；生产构建被静态替换为 false 并 tree-shake
import ArtifactSelfTest from './ArtifactSelfTest'

const TaskWorkspacePanel: React.FC = () => {
  const {
    panelOpen, panelWidth, setPanelWidth,
    togglePanel, setPanelOpen,
    tasks, activeTaskId, createTask, closeTask, switchTask,
    addTimelineEvent, syncLoopTasks, setActiveConversation,
  } = useTaskWorkspace()

  const loopTasks = useLoopStore((s) => s.tasks)
  const agentEvents = useAgentRuntime((s) => s.agentEvents)
  // 订阅当前会话 ID，用于时间线/工具反馈按会话隔离
  const activeConvId = useStore((s) => s.activeConversationId)
  const [inputText, setInputText] = useState('')
  const [isResizing, setIsResizing] = useState(false)
  const resizerRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const lastEventCount = useRef(0)

  // ── 同步 Loop 任务到工作区 ──
  useEffect(() => {
    syncLoopTasks(loopTasks)
  }, [loopTasks, syncLoopTasks])


  // ── 会话隔离：把当前会话 ID 同步给任务工作区 store ──
  useEffect(() => {
    setActiveConversation(activeConvId)
  }, [activeConvId, setActiveConversation])

  // ── 桥接 Agent 运行时事件 → 时间线（打上当前会话标记） ──
  useEffect(() => {
    if (agentEvents.length <= lastEventCount.current) {
      lastEventCount.current = agentEvents.length
      return
    }
    // 只把新增事件追加到当前激活任务（无任务则挂到内置默认 task）
    const targetTaskId = activeTaskId || '__runtime__'
    for (let i = lastEventCount.current; i < agentEvents.length; i++) {
      const ev = agentEvents[i]
      const mapped = mapAgentEventToTimeline(ev, targetTaskId, 'lumina')
      if (mapped) {
        // 标记事件所属会话，供时间线按会话过滤
        mapped.conversationId = activeConvId
        addTimelineEvent(mapped)
      }
    }
    lastEventCount.current = agentEvents.length
  }, [agentEvents, activeTaskId, addTimelineEvent, activeConvId])

  // ── 拖拽调整宽度（拖拽期间禁用 CSS 过渡，松手后恢复） ──
  const onResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setIsResizing(true)
    const startX = e.clientX
    const startWidth = panelRef.current?.getBoundingClientRect().width || panelWidth
    const onMove = (ev: MouseEvent) => {
      // 面板在右侧，向左拖变宽
      const delta = startX - ev.clientX
      setPanelWidth(startWidth + delta)
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      setIsResizing(false)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [panelWidth, setPanelWidth])

  // ── 底部追加任务输入：发送到当前对话 ──
  const handleSend = () => {
    const text = inputText.trim()
    if (!text) return
    const convId = useStore.getState().activeConversationId
    useStore.getState().addMessage(convId, 'user', text)
    // 同时在时间线记一条 system 事件
    const targetTaskId = activeTaskId || '__runtime__'
    addTimelineEvent({
      id: `tl-user-${Date.now()}`,
      taskId: targetTaskId,
      agentId: 'user',
      type: 'system',
      text: `追加任务：${text}`,
      status: 'running',
      timestamp: Date.now(),
      conversationId: activeConvId,
    })
    setInputText('')
  }

  // ── 始终挂载 wrapper + panel；开合完全由 CSS class 驱动 ──
  // panelOpen=false 时 wrapper width:0 + overflow:hidden，panel transform: translateX(100%)
  const wrapperClass = getPanelWrapperClass(panelOpen, isResizing)
  const wrapperStyle = {
    '--tw-panel-w': `${panelWidth}px`,
  } as React.CSSProperties

  return (
    <div
      className={wrapperClass}
      style={wrapperStyle}
      data-panel-open={panelOpen ? 'true' : 'false'}
    >
      <div
        ref={panelRef}
        className="tw-panel"
        style={{ width: panelWidth }}
      >
        <div
          ref={resizerRef}
          className="tw-resizer"
          onMouseDown={onResizeStart}
          onDoubleClick={() => setPanelWidth(360)}
        />

        {/* 顶部任务标签栏 */}
        <div className="tw-tabbar">
          {/* 内置浏览器入口：Agent 用 browser_* 工具操作时，用户在这里能直接看到 */}
          <button
            className="tw-tab tw-tab-browser"
            title="打开内置浏览器"
            onClick={() => { window.luminaAPI?.openBrowser?.() }}
          >
            <span>🌐 浏览器</span>
          </button>
          {tasks.slice(-5).map((t) => (
            <div
              key={t.id}
              className={`tw-tab ${t.id === activeTaskId ? 'active' : ''}`}
              onClick={() => switchTask(t.id)}
              title={t.title}
            >
              <span>{t.title.length > 8 ? t.title.slice(0, 8) + '…' : t.title}</span>
              <span className="tw-tab-close" onClick={(e) => { e.stopPropagation(); closeTask(t.id) }}>✕</span>
            </div>
          ))}
          <button
            className="tw-tab-new"
            title="新建任务"
            onClick={() => createTask(`任务 ${tasks.length + 1}`)}
          >＋</button>
          <button className="tw-panel-close" title="收起面板" onClick={togglePanel}>⟨</button>
        </div>

        {/* 内容区 */}
        <div className="tw-content">
          <AgentStatusCards />
          <TaskBoardPanel />
          <ToolExecutionFeed />
          <TaskTimeline taskId={activeTaskId === '__runtime__' ? null : activeTaskId} />
        </div>

        {/* 产物渲染区（有产物时覆盖内容区显示在上方） */}
        <ArtifactViewer />

        {/* dev-only 自检条：仅开发环境渲染，生产构建 tree-shake */}
        {import.meta.env.DEV && <ArtifactSelfTest />}

        {/* 底部追加任务输入 */}
        <div className="tw-input-area">
          <textarea
            className="tw-textarea"
            placeholder="追加任务或指令，回车发送…"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                handleSend()
              }
            }}
          />
          <div className="tw-send-row">
            <button className="tw-send-btn" onClick={handleSend}>发送</button>
          </div>
        </div>

        {/* 角落桌宠小元素 */}
        <div className="tw-pet-corner">🐱</div>
      </div>
    </div>
  )
}

export default TaskWorkspacePanel
