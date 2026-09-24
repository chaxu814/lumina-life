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

  console.log('[TaskWorkspaceBridge] 已订阅后台任务事件')
}
