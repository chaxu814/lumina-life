// ============================================================
// services/taskWorkspaceBridge.ts — 后台任务事件 → 任务工作区 store (v02)
//
// 修复问题 E：委托任务（Yak/热茶 fork 执行）此前主进程跑了但
// 事件没人转发到渲染进程，右侧面板恒显"暂无工具调用/暂无事件"。
// 本桥接订阅 task:* IPC 事件，实时灌入 taskWorkspaceStore：
//   - task:created  → 建任务卡片，running 时自动弹开面板
//   - task:progress → 更新进度文案
//   - task:runner-event → 工具调用/思考实时进时间线
//   - task:done/error → 收尾汇总
// ============================================================

import { useTaskWorkspace, mapAgentEventToTimeline } from '../stores/taskWorkspaceStore'

let _initialized = false
const _unsubs: Array<() => void> = []

/** 后台 runner 事件的工具调用也进「工具执行」列表 */
function recordRunnerToolEvent(ev: any, agentId: string): void {
  if (!ev || !ev.tool) return
  const store = useTaskWorkspace.getState()
  if (ev.type === 'tool_start') {
    store.recordToolStart(ev.tool, agentId, null, ev.args)
  } else if (ev.type === 'tool_end') {
    store.recordToolEnd(ev.tool, !ev.error, agentId, null, ev.result)
  } else if (ev.type === 'tool_error') {
    store.recordToolEnd(ev.tool, false, agentId, null, ev.error)
  }
}

export function initTaskWorkspaceBridge(): void {
  if (_initialized) return
  const api = (window as any).luminaAPI
  if (!api) { return }
  _initialized = true

  const ws = () => useTaskWorkspace.getState()

  // ── 任务创建：建卡片 + running 时自动弹开面板 ──
  if (api.onTaskCreated) {
    _unsubs.push(api.onTaskCreated((task: any) => {
      const store = ws()
      const wid = store.upsertRemoteTask({
        id: task.id,
        title: task.title,
        status: task.status,
        assignee: task.assignee,
        createdAt: task.createdAt,
        progress: task.progress,
      })
      store.switchTask(wid)
      if (task.status === 'running') {
        store.setPanelOpen(true)
      }
    }))
  }

  // ── 进度更新 ──
  if (api.onTaskProgress) {
    _unsubs.push(api.onTaskProgress((ev: any) => {
      ws().setRemoteTaskStatus(ev.taskId, ev.status, ev.progress)
    }))
  }

  // ── Worker 实时事件 → 时间线 ──
  if (api.onTaskRunnerEvent) {
    _unsubs.push(api.onTaskRunnerEvent((payload: any) => {
      const store = ws()
      const wid = `remote:${payload.taskId}`
      const mapped = mapAgentEventToTimeline(payload.event, wid, payload.assignee || 'worker')
      if (mapped) {
        store.addTimelineEvent(mapped)
      }
      // 后台任务跑的工具也进「工具执行」列表，否则只有前台聊天能看到
      recordRunnerToolEvent(payload.event, payload.assignee || 'worker')
    }))
  }

  // ── 进度看板（图1）：主进程 / CLI 推来的任务板直接进工作区 ──
  if (api.onTaskBoard) {
    _unsubs.push(api.onTaskBoard((board: any) => {
      if (!board) return
      ws().setBoard({ title: board.title, items: board.items || [] })
      ws().setPanelOpen(true)
    }))
  }
  // 启动时拉一次主进程持有的看板
  if (api.getTaskBoard) {
    api.getTaskBoard()
      .then((r: any) => {
        if (r?.ok && r.board) {
          ws().setBoard({ title: r.board.title, items: r.board.items || [] })
        }
      })
      .catch(() => { /* 主进程没起/无数据，忽略 */ })
  }

  // ── 前台聊天/群聊的工具调用 → 持久工具记录 ──
  //
  // 为什么放在这里而不是 ChatPanel：这是唯一一处订阅就能覆盖
  // 单聊 + 团队群聊 + 委托回复 的位置，各面板自己订阅会漏掉群聊分支。
  // 也因此这份记录不能依赖 agentRuntimeStore —— ChatPanel 每轮结束都会
  // resetAgentRuntime() 清空它，工作区会跟着一起清空成"暂无工具调用"。
  if (api.onAgentEvent) {
    _unsubs.push(api.onAgentEvent((ev: any) => {
      if (!ev || !ev.tool) return
      const store = ws()
      const convId = store.activeConversationId
      if (ev.type === 'tool_start') {
        store.recordToolStart(ev.tool, 'lumina', convId, ev.args)
      } else if (ev.type === 'tool_end') {
        store.recordToolEnd(ev.tool, !ev.error, 'lumina', convId, ev.result)
      } else if (ev.type === 'tool_error') {
        store.recordToolEnd(ev.tool, false, 'lumina', convId, ev.error)
      }
    }))
  }

  // ── 完成：状态收尾 + 汇总 ──
  if (api.onTaskDone) {
    _unsubs.push(api.onTaskDone((task: any) => {
      const store = ws()
      store.setRemoteTaskStatus(task.id, 'done', '✅ 任务完成')
      store.addTimelineEvent({
        id: `tl-done-${task.id}-${Date.now()}`,
        taskId: `remote:${task.id}`,
        agentId: task.assignee || 'worker',
        type: 'system',
        text: `✅ ${task.title} 完成（${task.progress || ''}）`,
        status: 'done',
        timestamp: Date.now(),
      })
    }))
  }

  // ── 失败：状态收尾 + 错误汇总 ──
  if (api.onTaskError) {
    _unsubs.push(api.onTaskError((task: any) => {
      const store = ws()
      store.setRemoteTaskStatus(task.id, 'error', `❌ ${task.error || '失败'}`)
      store.setPanelOpen(true)
      store.addTimelineEvent({
        id: `tl-err-${task.id}-${Date.now()}`,
        taskId: `remote:${task.id}`,
        agentId: task.assignee || 'worker',
        type: 'system',
        text: `❌ ${task.title} 失败：${task.error || '未知错误'}`,
        status: 'error',
        timestamp: Date.now(),
      })
    }))
  }

  // 看板变化 → 回写主进程，CLI / 其他窗口能读到同一份进度
  if (api.setTaskBoard) {
    _unsubs.push(useTaskWorkspace.subscribe((s) => {
      api.setTaskBoard(s.board)
    }))
  }

  console.log('[TaskWorkspaceBridge] 已订阅后台任务事件')
}
