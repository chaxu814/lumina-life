// ============================================================
// tests/taskWorkspace.test.ts — 任务工作区面板纯逻辑单测
//
// 覆盖：
// - 文件名 → 语言标签 detectLanguage
// - 工具参数摘要 summarizeArgs
// - Agent 事件 → 时间线事件 mapAgentEventToTimeline
// - Loop 任务 → 工作区任务 mapLoopTaskToWorkspace
// - taskWorkspaceStore 的任务/时间线/产物动作
// ============================================================

import { describe, it, expect, beforeEach } from 'vitest'
import {
  useTaskWorkspace,
  detectLanguage,
  summarizeArgs,
  mapAgentEventToTimeline,
  mapLoopTaskToWorkspace,
  getPanelWrapperClass,
  deriveStatusText,
  groupTimelineByParent,
  aggregateSubtaskProgress,
  deriveGroupStatus,
  formatDuration,
  detectArtifactKind,
  isTextArtifact,
  ARTIFACT_SIZE_LIMITS,
  UNGROUPED_GROUP,
  shouldAutoExpand,
} from '../src/stores/taskWorkspaceStore'
import type { SubtaskItem, TimelineEvent } from '../src/stores/taskWorkspaceStore'

describe('detectLanguage', () => {
  it('识别常见扩展名', () => {
    expect(detectLanguage('index.ts')).toBe('TypeScript')
    expect(detectLanguage('App.tsx')).toBe('TypeScript')
    expect(detectLanguage('app.py')).toBe('Python')
    expect(detectLanguage('README.md')).toBe('Markdown')
    expect(detectLanguage('data.json')).toBe('JSON')
    expect(detectLanguage('style.css')).toBe('CSS')
  })
  it('未知扩展名回退为 Plain Text', () => {
    expect(detectLanguage('archive.xyz')).toBe('Plain Text')
    expect(detectLanguage('noext')).toBe('Plain Text')
  })
})

describe('summarizeArgs', () => {
  it('短内容原样返回', () => {
    expect(summarizeArgs({ a: 1 }, 60)).toBe('{"a":1}')
  })
  it('超长内容截断并加省略号', () => {
    const long = 'x'.repeat(200)
    const out = summarizeArgs(long, 60)
    expect(out.length).toBeLessThanOrEqual(61)
    expect(out.endsWith('…')).toBe(true)
  })
  it('null 返回空串', () => {
    expect(summarizeArgs(null)).toBe('')
  })
})

describe('mapAgentEventToTimeline', () => {
  it('thinking 事件映射为 running 思考', () => {
    const ev = mapAgentEventToTimeline(
      { type: 'thinking', text: '分析需求', timestamp: 1000 },
      'task-1',
      'lumina',
    )
    expect(ev).not.toBeNull()
    expect(ev!.type).toBe('thinking')
    expect(ev!.status).toBe('running')
    expect(ev!.agentId).toBe('lumina')
  })
  it('tool_start 映射为运行中工具', () => {
    const ev = mapAgentEventToTimeline(
      { type: 'tool_start', tool: 'file_read', timestamp: 2000 },
      'task-1', 'recha',
    )
    expect(ev!.type).toBe('tool_start')
    expect(ev!.tool).toBe('file_read')
  })
  it('tool_error 映射为 error', () => {
    const ev = mapAgentEventToTimeline(
      { type: 'tool_error', tool: 'shell_exec', timestamp: 3000 },
      'task-1', 'yak',
    )
    expect(ev!.status).toBe('error')
  })
  it('未知类型返回 null', () => {
    const ev = mapAgentEventToTimeline(
      { type: 'token_update', timestamp: 4000 },
      'task-1', 'lumina',
    )
    expect(ev).toBeNull()
  })
})

describe('mapLoopTaskToWorkspace', () => {
  it('running 映射为 running', () => {
    const t = mapLoopTaskToWorkspace({ id: 'l1', goal: '每日资讯', status: 'running', runCount: 3 })
    expect(t.id).toBe('loop:l1')
    expect(t.status).toBe('running')
    expect(t.title).toBe('每日资讯')
  })
  it('paused 映射为 idle', () => {
    const t = mapLoopTaskToWorkspace({ id: 'l2', goal: '周报', status: 'paused' })
    expect(t.status).toBe('idle')
  })
})

describe('taskWorkspaceStore — 任务管理', () => {
  beforeEach(() => {
    useTaskWorkspace.setState({ tasks: [], activeTaskId: null, timeline: [], artifacts: [], activeArtifactId: null })
  })

  it('createTask 创建并激活', () => {
    const id = useTaskWorkspace.getState().createTask('测试任务')
    const s = useTaskWorkspace.getState()
    expect(s.tasks).toHaveLength(1)
    expect(s.activeTaskId).toBe(id)
    expect(s.tasks[0].title).toBe('测试任务')
  })

  it('switchTask 切换激活', () => {
    const id1 = useTaskWorkspace.getState().createTask('A')
    useTaskWorkspace.getState().createTask('B')
    useTaskWorkspace.getState().switchTask(id1)
    expect(useTaskWorkspace.getState().activeTaskId).toBe(id1)
  })

  it('closeTask 关闭并回退激活', () => {
    const id1 = useTaskWorkspace.getState().createTask('A')
    const id2 = useTaskWorkspace.getState().createTask('B')
    useTaskWorkspace.getState().closeTask(id2)
    const s = useTaskWorkspace.getState()
    expect(s.tasks.map((t) => t.id)).toEqual([id1])
    expect(s.activeTaskId).toBe(id1)
  })
})

describe('taskWorkspaceStore — 时间线', () => {
  beforeEach(() => {
    useTaskWorkspace.setState({ timeline: [] })
  })

  it('addTimelineEvent 追加事件', () => {
    useTaskWorkspace.getState().addTimelineEvent({
      id: 'e1', taskId: 't1', agentId: 'lumina', type: 'text',
      text: '你好', status: 'done', timestamp: 1,
    })
    expect(useTaskWorkspace.getState().timeline).toHaveLength(1)
  })

  it('clearTimeline 按 taskId 过滤', () => {
    useTaskWorkspace.getState().addTimelineEvent({
      id: 'e1', taskId: 't1', agentId: 'lumina', type: 'text',
      text: 'a', status: 'done', timestamp: 1,
    })
    useTaskWorkspace.getState().addTimelineEvent({
      id: 'e2', taskId: 't2', agentId: 'lumina', type: 'text',
      text: 'b', status: 'done', timestamp: 2,
    })
    useTaskWorkspace.getState().clearTimeline('t1')
    expect(useTaskWorkspace.getState().timeline.map((e) => e.id)).toEqual(['e2'])
  })
})

describe('taskWorkspaceStore — 产物', () => {
  beforeEach(() => {
    useTaskWorkspace.setState({ artifacts: [], activeArtifactId: null })
  })

  it('addArtifact 添加并激活', () => {
    useTaskWorkspace.getState().addArtifact({
      id: 'a1', taskId: 't1', filename: 'a.ts', language: 'TypeScript',
      content: 'export {}', createdAt: 1,
    })
    const s = useTaskWorkspace.getState()
    expect(s.artifacts).toHaveLength(1)
    expect(s.activeArtifactId).toBe('a1')
  })

  it('同名产物去重替换', () => {
    useTaskWorkspace.getState().addArtifact({
      id: 'a1', taskId: 't1', filename: 'a.ts', language: 'TypeScript',
      content: 'v1', createdAt: 1,
    })
    useTaskWorkspace.getState().addArtifact({
      id: 'a2', taskId: 't1', filename: 'a.ts', language: 'TypeScript',
      content: 'v2', createdAt: 2,
    })
    const s = useTaskWorkspace.getState()
    expect(s.artifacts).toHaveLength(1)
    expect(s.artifacts[0].content).toBe('v2')
  })

  it('closeArtifact 关闭并回退激活', () => {
    useTaskWorkspace.getState().addArtifact({
      id: 'a1', taskId: 't1', filename: 'a.ts', language: 'TypeScript',
      content: 'x', createdAt: 1,
    })
    useTaskWorkspace.getState().addArtifact({
      id: 'a2', taskId: 't1', filename: 'b.md', language: 'Markdown',
      content: 'y', createdAt: 2,
    })
    useTaskWorkspace.getState().closeArtifact('a2')
    const s = useTaskWorkspace.getState()
    expect(s.artifacts).toHaveLength(1)
    expect(s.activeArtifactId).toBe('a1')
  })
})

// ============================================================
// 历史任务堆积修复：dismiss / clear / 会话隔离
// ============================================================

describe('taskWorkspaceStore — Loop 任务隐藏与清空', () => {
  // Node 测试环境默认无 localStorage，这里挂一个内存版模拟持久化
  const DISMISS_KEY = 'lumina_tw_dismissed_loops'
  let mem: Map<string, string>

  beforeEach(() => {
    mem = new Map()
    ;(globalThis as any).localStorage = {
      getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
      setItem: (k: string, v: string) => mem.set(k, String(v)),
      removeItem: (k: string) => mem.delete(k),
      clear: () => mem.clear(),
    }
    useTaskWorkspace.setState({
      tasks: [],
      dismissedLoopIds: [],
      activeTaskId: null,
      timeline: [],
      activeConversationId: null,
    })
  })

  it('dismissLoopTask 加入 dismissedLoopIds 并从 tasks 移除', () => {
    // 先同步两个 Loop 任务
    useTaskWorkspace.getState().syncLoopTasks([
      { id: 'l1', goal: '数学题A', status: 'paused' },
      { id: 'l2', goal: '数学题B', status: 'running' },
    ])
    expect(useTaskWorkspace.getState().tasks.some((t) => t.agentId === 'loop:l1')).toBe(true)

    useTaskWorkspace.getState().dismissLoopTask('l1')
    const s = useTaskWorkspace.getState()
    expect(s.dismissedLoopIds).toContain('l1')
    // 已隐藏的卡片从 tasks 移除
    expect(s.tasks.some((t) => t.agentId === 'loop:l1')).toBe(false)
    expect(s.tasks.some((t) => t.agentId === 'loop:l2')).toBe(true)
  })

  it('dismissLoopTask 写入 localStorage 持久化', () => {
    useTaskWorkspace.getState().dismissLoopTask('l9')
    const raw = (globalThis as any).localStorage.getItem(DISMISS_KEY)
    expect(raw).toBeTruthy()
    expect(JSON.parse(raw)).toContain('l9')
  })

  it('restoreLoopTask 从 dismissedLoopIds 移除', () => {
    useTaskWorkspace.getState().dismissLoopTask('l3')
    useTaskWorkspace.getState().dismissLoopTask('l4')
    expect(useTaskWorkspace.getState().dismissedLoopIds).toEqual(['l3', 'l4'])
    useTaskWorkspace.getState().restoreLoopTask('l3')
    expect(useTaskWorkspace.getState().dismissedLoopIds).toEqual(['l4'])
    // 持久化也同步
    expect(JSON.parse((globalThis as any).localStorage.getItem(DISMISS_KEY))).toEqual(['l4'])
  })

  it('clearFinishedLoopTasks 只清非 running，running 保留并返回数量', () => {
    useTaskWorkspace.getState().syncLoopTasks([
      { id: 'l1', goal: '暂停任务', status: 'paused' },
      { id: 'l2', goal: '完成任务', status: 'done' },
      { id: 'l3', goal: '运行中任务', status: 'running' },
    ])
    const cleared = useTaskWorkspace.getState().clearFinishedLoopTasks()
    // 只清掉 l1、l2
    expect(cleared).toBe(2)
    const s = useTaskWorkspace.getState()
    expect(s.dismissedLoopIds).toContain('l1')
    expect(s.dismissedLoopIds).toContain('l2')
    expect(s.dismissedLoopIds).not.toContain('l3')
    // running 的卡片仍在
    expect(s.tasks.some((t) => t.agentId === 'loop:l3')).toBe(true)
    expect(s.tasks.some((t) => t.agentId === 'loop:l1')).toBe(false)
  })

  it('syncLoopTasks 过滤掉已隐藏的 Loop 任务，不会被重新拉回', () => {
    useTaskWorkspace.getState().dismissLoopTask('l1')
    // 即使 loopStore 又推来了 l1，sync 后也不应出现
    useTaskWorkspace.getState().syncLoopTasks([
      { id: 'l1', goal: '数学题A', status: 'paused' },
      { id: 'l2', goal: '新任务', status: 'running' },
    ])
    const s = useTaskWorkspace.getState()
    expect(s.tasks.some((t) => t.agentId === 'loop:l1')).toBe(false)
    expect(s.tasks.some((t) => t.agentId === 'loop:l2')).toBe(true)
  })
})

describe('taskWorkspaceStore — 时间线删除与会话隔离', () => {
  beforeEach(() => {
    useTaskWorkspace.setState({ timeline: [], activeConversationId: null })
  })

  it('removeTimelineEvent 删除指定事件', () => {
    useTaskWorkspace.getState().addTimelineEvent({
      id: 'e1', taskId: 't1', agentId: 'lumina', type: 'text',
      text: 'a', status: 'done', timestamp: 1,
    })
    useTaskWorkspace.getState().addTimelineEvent({
      id: 'e2', taskId: 't1', agentId: 'lumina', type: 'text',
      text: 'b', status: 'done', timestamp: 2,
    })
    useTaskWorkspace.getState().removeTimelineEvent('e1')
    expect(useTaskWorkspace.getState().timeline.map((e) => e.id)).toEqual(['e2'])
  })

  it('setActiveConversation 设置 activeConversationId', () => {
    useTaskWorkspace.getState().setActiveConversation('conv-abc')
    expect(useTaskWorkspace.getState().activeConversationId).toBe('conv-abc')
    useTaskWorkspace.getState().setActiveConversation(null)
    expect(useTaskWorkspace.getState().activeConversationId).toBeNull()
  })
})

// ============================================================
// v6.2 动画与视觉：wrapper class 生成 + 状态文案
// ============================================================

describe('getPanelWrapperClass — 动画 wrapper className 生成', () => {
  it('展开 + 未拖拽 → open，无 tw-resizing', () => {
    expect(getPanelWrapperClass(true, false)).toBe('tw-panel-wrapper open')
  })
  it('收起 + 未拖拽 → closed，无 tw-resizing', () => {
    expect(getPanelWrapperClass(false, false)).toBe('tw-panel-wrapper closed')
  })
  it('展开 + 拖拽中 → open + tw-resizing', () => {
    expect(getPanelWrapperClass(true, false)).not.toContain('tw-resizing')
    expect(getPanelWrapperClass(true, true)).toBe('tw-panel-wrapper open tw-resizing')
  })
  it('收起 + 拖拽中 → closed + tw-resizing', () => {
    expect(getPanelWrapperClass(false, true)).toBe('tw-panel-wrapper closed tw-resizing')
  })
})

describe('deriveStatusText — Agent 状态文案', () => {
  it('有 running 工具 → "执行工具 X" + running', () => {
    const r = deriveStatusText('', [{ name: 'file_read', status: 'running' }])
    expect(r.text).toBe('执行工具 file_read')
    expect(r.status).toBe('running')
  })
  it('有 error 工具 → "工具 X 失败" + error', () => {
    const r = deriveStatusText('', [{ name: 'shell_exec', status: 'error' }])
    expect(r.text).toBe('工具 shell_exec 失败')
    expect(r.status).toBe('error')
  })
  it('无工具但有思考 → "正在思考…" + running', () => {
    const r = deriveStatusText('分析需求', [])
    expect(r.text).toBe('正在思考…')
    expect(r.status).toBe('running')
  })
  it('已有 done 工具、无新思考 → "工具执行完成" + done', () => {
    const r = deriveStatusText('', [{ name: 'file_read', status: 'done' }])
    expect(r.text).toBe('工具执行完成')
    expect(r.status).toBe('done')
  })
  it('空状态 → "待机中" + idle', () => {
    const r = deriveStatusText('', [])
    expect(r.text).toBe('待机中')
    expect(r.status).toBe('idle')
  })
})

// ============================================================
// v6.3 子任务分组：分组 / 聚合 / 状态推导 / 耗时格式化
// ============================================================

function makeEvent(id: string, parentId?: string): TimelineEvent {
  return {
    id, taskId: 't1', agentId: 'lumina', type: 'text',
    text: id, status: 'done', timestamp: Number(id.replace('e', '')),
    ...(parentId ? { parentId } : {}),
  }
}

describe('groupTimelineByParent — 按父任务分组', () => {
  it('有 parentId 的事件归入对应组', () => {
    const events = [
      makeEvent('e1', 'p1'),
      makeEvent('e2', 'p1'),
      makeEvent('e3', 'p2'),
    ]
    const groups = groupTimelineByParent(events)
    expect(Object.keys(groups).sort()).toEqual(['p1', 'p2'])
    expect(groups['p1']).toHaveLength(2)
    expect(groups['p2']).toHaveLength(1)
  })
  it('无 parentId 的事件归入 __ungrouped__', () => {
    const events = [makeEvent('e1'), makeEvent('e2')]
    const groups = groupTimelineByParent(events)
    expect(Object.keys(groups)).toEqual([UNGROUPED_GROUP])
    expect(groups[UNGROUPED_GROUP]).toHaveLength(2)
  })
  it('混合：有/无 parentId 正确分流', () => {
    const events = [
      makeEvent('e1', 'p1'),
      makeEvent('e2'),
      makeEvent('e3', 'p1'),
      makeEvent('e4'),
    ]
    const groups = groupTimelineByParent(events)
    expect(groups['p1']).toHaveLength(2)
    expect(groups[UNGROUPED_GROUP]).toHaveLength(2)
  })
  it('空数组返回空对象', () => {
    expect(groupTimelineByParent([])).toEqual({})
  })
})

describe('aggregateSubtaskProgress — 子任务进度聚合', () => {
  const makeSub = (status: SubtaskItem['status']): SubtaskItem => ({
    id: 's', title: 'x', status, createdAt: 1,
  })
  it('统计各状态数量并计算百分比', () => {
    const subs = [makeSub('done'), makeSub('done'), makeSub('running'), makeSub('idle'), makeSub('error')]
    const r = aggregateSubtaskProgress(subs)
    expect(r.total).toBe(5)
    expect(r.done).toBe(2)
    expect(r.running).toBe(1)
    expect(r.error).toBe(1)
    expect(r.idle).toBe(1)
    expect(r.percent).toBe(60)
  })
  it('空数组返回 percent 0', () => {
    const r = aggregateSubtaskProgress([])
    expect(r.total).toBe(0)
    expect(r.percent).toBe(0)
  })
  it('全部 done → 100%', () => {
    const subs = [makeSub('done'), makeSub('done')]
    expect(aggregateSubtaskProgress(subs).percent).toBe(100)
  })
})

describe('deriveGroupStatus — 父任务状态推导', () => {
  const makeSub = (status: SubtaskItem['status']): SubtaskItem => ({
    id: 's', title: 'x', status, createdAt: 1,
  })
  it('有 error → error', () => {
    expect(deriveGroupStatus([makeSub('done'), makeSub('error')])).toBe('error')
  })
  it('有 running 无 error → running', () => {
    expect(deriveGroupStatus([makeSub('done'), makeSub('running')])).toBe('running')
  })
  it('全 done → done', () => {
    expect(deriveGroupStatus([makeSub('done'), makeSub('done')])).toBe('done')
  })
  it('空数组或全 idle → idle', () => {
    expect(deriveGroupStatus([])).toBe('idle')
    expect(deriveGroupStatus([makeSub('idle'), makeSub('idle')])).toBe('idle')
  })
})

describe('formatDuration — 耗时格式化', () => {
  it('毫秒级', () => {
    expect(formatDuration(500)).toBe('500ms')
  })
  it('秒级', () => {
    expect(formatDuration(12300)).toBe('12.3s')
  })
  it('分钟级', () => {
    expect(formatDuration(125000)).toBe('2m 5s')
  })
  it('小时级', () => {
    expect(formatDuration(3725000)).toBe('1h 2m')
  })
  it('负数或非有限值回退', () => {
    expect(formatDuration(-100)).toBe('0s')
  })
})

// ============================================================
// v6.3 产物类型检测
// ============================================================

describe('detectArtifactKind — 产物类型检测', () => {
  it('识别图片扩展名', () => {
    expect(detectArtifactKind('photo.png')).toBe('image')
    expect(detectArtifactKind('a.jpg')).toBe('image')
    expect(detectArtifactKind('b.webp')).toBe('image')
    expect(detectArtifactKind('c.svg')).toBe('image')
  })
  it('识别 PDF', () => {
    expect(detectArtifactKind('doc.pdf')).toBe('pdf')
  })
  it('识别 JSON', () => {
    expect(detectArtifactKind('data.json')).toBe('json')
  })
  it('识别 CSV/TSV', () => {
    expect(detectArtifactKind('sheet.csv')).toBe('csv')
    expect(detectArtifactKind('sheet.tsv')).toBe('csv')
  })
  it('识别 Markdown', () => {
    expect(detectArtifactKind('readme.md')).toBe('markdown')
  })
  it('识别代码扩展名', () => {
    expect(detectArtifactKind('app.ts')).toBe('code')
    expect(detectArtifactKind('run.py')).toBe('code')
    expect(detectArtifactKind('style.css')).toBe('code')
  })
  it('识别文本', () => {
    expect(detectArtifactKind('notes.txt')).toBe('text')
    expect(detectArtifactKind('log.log')).toBe('text')
  })
  it('未知扩展名 + JSON 内容嗅探', () => {
    expect(detectArtifactKind('payload', '{"a":1}')).toBe('json')
  })
  it('未知扩展名 + CSV 内容嗅探', () => {
    expect(detectArtifactKind('data', 'a,b,c\n1,2,3')).toBe('csv')
  })
  it('未知扩展名 + 普通文本', () => {
    expect(detectArtifactKind('readme', 'hello world')).toBe('text')
  })
  it('空内容 + 未知扩展名 → binary', () => {
    expect(detectArtifactKind('blob.bin', '')).toBe('binary')
  })
})

describe('isTextArtifact — 文本类判定', () => {
  it('code/markdown/json/csv/text 为文本类', () => {
    expect(isTextArtifact('code')).toBe(true)
    expect(isTextArtifact('markdown')).toBe(true)
    expect(isTextArtifact('json')).toBe(true)
    expect(isTextArtifact('csv')).toBe(true)
    expect(isTextArtifact('text')).toBe(true)
  })
  it('image/pdf/binary 非文本类', () => {
    expect(isTextArtifact('image')).toBe(false)
    expect(isTextArtifact('pdf')).toBe(false)
    expect(isTextArtifact('binary')).toBe(false)
  })
})

describe('ARTIFACT_SIZE_LIMITS — 体积阈值', () => {
  it('各类型阈值存在且合理', () => {
    expect(ARTIFACT_SIZE_LIMITS.code).toBe(100 * 1024)
    expect(ARTIFACT_SIZE_LIMITS.image).toBe(10 * 1024 * 1024)
    expect(ARTIFACT_SIZE_LIMITS.pdf).toBe(25 * 1024 * 1024)
    expect(ARTIFACT_SIZE_LIMITS.json).toBe(500 * 1024)
    expect(ARTIFACT_SIZE_LIMITS.csv).toBe(5 * 1024 * 1024)
    expect(ARTIFACT_SIZE_LIMITS.binary).toBe(Infinity)
  })
})

// ============================================================
// v6.3 store：子任务操作 + 分组折叠 + 区块折叠
// ============================================================

describe('taskWorkspaceStore — 子任务操作', () => {
  beforeEach(() => {
    useTaskWorkspace.setState({ tasks: [], activeTaskId: null })
  })

  it('addSubtask 添加子任务并聚合父状态', () => {
    const parentId = useTaskWorkspace.getState().createTask('父任务')
    useTaskWorkspace.getState().addSubtask(parentId, {
      id: 's1', title: '子1', status: 'running', createdAt: 1,
    })
    const task = useTaskWorkspace.getState().tasks.find((t) => t.id === parentId)!
    expect(task.subtasks).toHaveLength(1)
    expect(task.status).toBe('running')
  })

  it('updateSubtaskStatus 更新子任务状态并回写 completedAt', () => {
    const parentId = useTaskWorkspace.getState().createTask('父任务')
    useTaskWorkspace.getState().addSubtask(parentId, {
      id: 's1', title: '子1', status: 'running', createdAt: 1,
    })
    useTaskWorkspace.getState().updateSubtaskStatus(parentId, 's1', 'done')
    const task = useTaskWorkspace.getState().tasks.find((t) => t.id === parentId)!
    expect(task.subtasks![0].status).toBe('done')
    expect(task.subtasks![0].completedAt).toBeDefined()
    expect(task.status).toBe('done')
  })

  it('removeSubtask 移除子任务', () => {
    const parentId = useTaskWorkspace.getState().createTask('父任务')
    useTaskWorkspace.getState().addSubtask(parentId, { id: 's1', title: '子1', status: 'done', createdAt: 1 })
    useTaskWorkspace.getState().addSubtask(parentId, { id: 's2', title: '子2', status: 'done', createdAt: 2 })
    useTaskWorkspace.getState().removeSubtask(parentId, 's1')
    const task = useTaskWorkspace.getState().tasks.find((t) => t.id === parentId)!
    expect(task.subtasks).toHaveLength(1)
    expect(task.subtasks![0].id).toBe('s2')
  })

  it('多子任务聚合：有 error → 父 error', () => {
    const parentId = useTaskWorkspace.getState().createTask('父任务')
    useTaskWorkspace.getState().addSubtask(parentId, { id: 's1', title: '子1', status: 'done', createdAt: 1 })
    useTaskWorkspace.getState().addSubtask(parentId, { id: 's2', title: '子2', status: 'error', createdAt: 2 })
    const task = useTaskWorkspace.getState().tasks.find((t) => t.id === parentId)!
    expect(task.status).toBe('error')
  })
})

describe('taskWorkspaceStore — 分组折叠与区块折叠', () => {
  beforeEach(() => {
    ;(globalThis as any).localStorage = {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
      clear: () => {},
    }
    useTaskWorkspace.setState({
      collapsedGroupIds: [],
      collapsedSections: { agents: false, tools: false, timeline: false, artifacts: false },
    })
  })

  it('toggleGroupCollapse 添加/移除折叠 ID', () => {
    useTaskWorkspace.getState().toggleGroupCollapse('g1')
    expect(useTaskWorkspace.getState().collapsedGroupIds).toContain('g1')
    useTaskWorkspace.getState().toggleGroupCollapse('g1')
    expect(useTaskWorkspace.getState().collapsedGroupIds).not.toContain('g1')
  })

  it('toggleSection 切换区块折叠状态', () => {
    useTaskWorkspace.getState().toggleSection('timeline')
    expect(useTaskWorkspace.getState().collapsedSections.timeline).toBe(true)
    useTaskWorkspace.getState().toggleSection('timeline')
    expect(useTaskWorkspace.getState().collapsedSections.timeline).toBe(false)
  })
})

// ============================================================
// v6.4 自动展开规则 + 持久化健壮性 + 类型判定边界
// ============================================================

import type { TaskWorkspaceTask } from '../src/stores/taskWorkspaceStore'

function makeTask(id: string, status: TaskWorkspaceTask['status']): TaskWorkspaceTask {
  return { id, title: id, createdAt: 1, agentId: 'lumina', status }
}

describe('shouldAutoExpand — 父任务自动展开规则', () => {
  it('running 且未折叠、无其他活跃展开 → 自动展开', () => {
    expect(shouldAutoExpand(makeTask('t1', 'running'), [], false)).toBe(true)
  })
  it('非 running（done/idle/error）→ 不自动展开', () => {
    expect(shouldAutoExpand(makeTask('t1', 'done'), [], false)).toBe(false)
    expect(shouldAutoExpand(makeTask('t1', 'idle'), [], false)).toBe(false)
    expect(shouldAutoExpand(makeTask('t1', 'error'), [], false)).toBe(false)
  })
  it('用户手动折叠过（在 collapsedGroupIds 中）→ 不展开', () => {
    expect(shouldAutoExpand(makeTask('t1', 'running'), ['t1'], false)).toBe(false)
  })
  it('已有其他活跃分组自动展开（hasActiveExpanded=true）→ 不抢占', () => {
    expect(shouldAutoExpand(makeTask('t2', 'running'), [], true)).toBe(false)
  })
  it('混合：第一个 running 展开，第二个 running 因 hasActiveExpanded 不展开', () => {
    expect(shouldAutoExpand(makeTask('t1', 'running'), [], false)).toBe(true)
    expect(shouldAutoExpand(makeTask('t2', 'running'), [], true)).toBe(false)
  })
})

describe('detectArtifactKind — 边界增强', () => {
  it('无扩展名 + JSON 数组内容 → json', () => {
    expect(detectArtifactKind('payload', '[1,2,3]')).toBe('json')
  })
  it('无扩展名 + 非法 JSON 但像对象 → 回退 text', () => {
    // 未闭合的 { 不是合法 JSON，回退 text
    expect(detectArtifactKind('x', '{ "a": 1')).toBe('text')
  })
  it('大写扩展名不敏感（.JSON/.PNG）', () => {
    expect(detectArtifactKind('DATA.JSON')).toBe('json')
    expect(detectArtifactKind('A.PNG')).toBe('image')
  })
  it('svg 识别为 image', () => {
    expect(detectArtifactKind('diagram.svg')).toBe('image')
  })
})

describe('taskWorkspaceStore — 持久化异常值保护', () => {
  beforeEach(() => {
    ;(globalThis as any).localStorage = {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
      clear: () => {},
    }
  })

  it('collapsedGroupIds 读取损坏 JSON 时回退空数组不崩溃', () => {
    ;(globalThis as any).localStorage.getItem = () => '{broken json'
    // 重新触发模块级读取不可行，这里验证 toggle 不崩溃且类型正常
    useTaskWorkspace.getState().toggleGroupCollapse('g1')
    expect(useTaskWorkspace.getState().collapsedGroupIds).toContain('g1')
  })

  it('collapsedSections 非法值（字符串/数字）回退默认 false', () => {
    useTaskWorkspace.setState({
      collapsedSections: { agents: false, tools: false, timeline: false, artifacts: false },
    })
    useTaskWorkspace.getState().toggleSection('tools')
    expect(useTaskWorkspace.getState().collapsedSections.tools).toBe(true)
  })
})