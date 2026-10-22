// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
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

/** 扩展名 → 语言（给「对话产物」层用） */
const EXT_LANG: Record<string, string> = {
  md: 'markdown', markdown: 'markdown', txt: 'text', log: 'text',
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  py: 'python', java: 'java', go: 'go', rs: 'rust', cpp: 'cpp', c: 'c', h: 'c', cs: 'csharp',
  json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml', xml: 'xml', html: 'html', htm: 'html',
  css: 'css', scss: 'scss', sql: 'sql', sh: 'shell', bash: 'shell', ps1: 'powershell',
  csv: 'csv', tsv: 'csv', vue: 'vue', svelte: 'svelte',
}

/**
 * 【C】产物落盘即入库 —— Worker 用 file_write/file_edit 成功写出文件时，
 * 自动把它登记进「对话产物 / 最近文件」层。
 * 🔧 2026-10-09：此前 addArtifact 只有自测组件在调，真实使用中产物层恒空。
 */
function maybeRecordArtifact(ev: any, store: ReturnType<typeof useTaskWorkspace.getState>): void {
  if (ev.tool !== 'file_write' && ev.tool !== 'file_edit') {return}
  if (ev.error) {return}
  const p = ev.args?.filePath || ev.args?.path
  if (!p || typeof p !== 'string') {return}
  const filename = p.replace(/\\/g, '/').split('/').pop() || p
  const ext = (filename.includes('.') ? filename.split('.').pop()! : '').toLowerCase()
  const now = Date.now()
  const taskId = store.activeTaskId || 'conversation'
  try {
    store.addArtifact({
      id: `${taskId}:${p}`,
      taskId,
      filename,
      language: EXT_LANG[ext] || 'text',
      content: typeof ev.args?.content === 'string' ? ev.args.content : '',
      filePath: p,
      createdAt: now,
      mtime: now,
    })
  } catch { /* 登记失败不影响主流程 */ }
}

/** 后台 runner 事件的工具调用也进「工具执行」列表 */
function recordRunnerToolEvent(ev: any, agentId: string): void {
  if (!ev || !ev.tool) {return}
  const store = useTaskWorkspace.getState()
  if (ev.type === 'tool_start') {
    store.recordToolStart(ev.tool, agentId, null, ev.args)
  } else if (ev.type === 'tool_end') {
    store.recordToolEnd(ev.tool, !ev.error, agentId, null, ev.result)
    maybeRecordArtifact(ev, store)
  } else if (ev.type === 'tool_error') {
    store.recordToolEnd(ev.tool, false, agentId, null, ev.error)
  }
}

export function initTaskWorkspaceBridge(): void {
  if (_initialized) {return}
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
        // 任务一开始跑就自动弹开面板。
        // 🔧 2026-10-09 修复：这里原本是个**空的 if 块**（注释写了"running 时自动弹开面板"
        //   但函数体是空的）→ 后台委托在静默执行，用户永远看不到「任务工作区」在工作，
        //   实测表现为「这个面板好像从没被用过」。补上真正的弹开动作。
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

  // ── 🆕 v03: 子智能体（实习生）生命周期 → 「子智能体」侧边栏实时渲染 ──
  // 任意 owner（Lumina/Yak/热茶）派生的并行子智能体：hire/assign/done/error/fire。
  if (api.onSubtaskEvent) {
    _unsubs.push(api.onSubtaskEvent((ev: any) => {
      if (!ev || !ev.id) {return}
      const store = ws()
      switch (ev.type) {
        case 'assigned':
          store.upsertSubagent({
            id: ev.id,
            title: ev.title || ev.name || '子任务',
            status: 'running',
            owner: ev.owner || 'lumina',
            createdAt: ev.at || Date.now(),
            internName: ev.name,
            sessionId: ev.sessionId,
          })
          break
        case 'done':
          store.upsertSubagent({
            id: ev.id,
            title: ev.title || '',
            status: 'done',
            owner: ev.owner || 'lumina',
            createdAt: ev.at || Date.now(),
            completedAt: ev.at || Date.now(),
            result: ev.result,
            internName: ev.name,
            sessionId: ev.sessionId,
          })
          break
        case 'error':
          store.upsertSubagent({
            id: ev.id,
            title: ev.title || '',
            status: 'error',
            owner: ev.owner || 'lumina',
            createdAt: ev.at || Date.now(),
            completedAt: ev.at || Date.now(),
            error: ev.error,
            internName: ev.name,
            sessionId: ev.sessionId,
          })
          break
        case 'fired':
          // 用完即走：离职即从侧边栏移除
          store.removeSubagent(ev.id)
          break
        // 'hired' 还没领到具体子任务，不进列表（避免空点）
        default:
          break
      }
    }))
  }

  // ── 进度看板（图1）：主进程 / CLI 推来的任务板直接进工作区 ──
  if (api.onTaskBoard) {
    _unsubs.push(api.onTaskBoard((board: any) => {
      if (!board) {return}
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
      if (!ev || !ev.tool) {return}
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
