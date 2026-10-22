// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// tests/conversationSummary.test.ts — 「对话摘要」六层聚合纯函数单测
//
// 覆盖（全部从真实 store 状态派生，验证分类/排序/去重/空态）：
// - deriveConversationArtifacts：文档类产物（md/html/code/json/text）
// - deriveConversationResources：图片/PDF 资源
// - deriveRecentFiles：带磁盘路径、按 mtime 倒序、限量
// - deriveTaskPlan：进度看板条目
// - deriveUsedSkills：本次用过的工具去重
// - deriveSubagentList：运行态 + 父任务 subtasks 合并、过滤 idle、正序
// - artifactIconKey：按文件名/类型映射图标
// ============================================================
import { describe, it, expect } from 'vitest'
import {
  deriveConversationArtifacts,
  deriveConversationResources,
  deriveRecentFiles,
  deriveTaskPlan,
  deriveUsedSkills,
  deriveSubagentList,
  artifactIconKey,
  detectArtifactKind,
} from '../src/stores/taskWorkspaceStore'
import type { ArtifactItem, TaskWorkspaceTask, SubagentItem, ToolCallRecord } from '../src/stores/taskWorkspaceStore'

function art(partial: Partial<ArtifactItem> & { filename: string }): ArtifactItem {
  return {
    id: partial.id ?? `a-${partial.filename}`,
    taskId: 't1',
    filename: partial.filename,
    language: 'Plain Text',
    content: partial.content ?? '',
    createdAt: partial.createdAt ?? 1,
    ...partial,
  }
}

describe('artifactIconKey — 按文件名/类型映射图标', () => {
  it('md → md，html → html', () => {
    expect(artifactIconKey(detectArtifactKind('a.md'), 'a.md')).toBe('md')
    expect(artifactIconKey(detectArtifactKind('a.html'), 'a.html')).toBe('html')
  })
  it('图片 → image，pdf → pdf', () => {
    expect(artifactIconKey('image', 'p.png')).toBe('image')
    expect(artifactIconKey('pdf', 'd.pdf')).toBe('pdf')
  })
  it('json/code → json/code', () => {
    expect(artifactIconKey('json', 'd.json')).toBe('json')
    expect(artifactIconKey('code', 'x.ts')).toBe('code')
  })
})

describe('deriveConversationArtifacts — 文档类产物', () => {
  it('只保留文档类，排除图片/PDF，按创建时间倒序', () => {
    const list = [
      art({ filename: 'README.md', createdAt: 1 }),
      art({ filename: 'report.html', createdAt: 3 }),
      art({ filename: 'photo.png', createdAt: 2 }), // 图片 → 不算产物
      art({ filename: 'main.py', createdAt: 4 }),
    ]
    const out = deriveConversationArtifacts(list)
    expect(out.map((a) => a.filename)).toEqual(['main.py', 'report.html', 'README.md'])
  })
  it('空数组返回空', () => {
    expect(deriveConversationArtifacts([])).toEqual([])
  })
})

describe('deriveConversationResources — 图片/PDF 资源', () => {
  it('只收 image/pdf，按创建时间倒序', () => {
    const list = [
      art({ filename: 'a.png', createdAt: 1 }),
      art({ filename: 'b.md', createdAt: 2 }), // md 不算资源
      art({ filename: 'c.pdf', createdAt: 3 }),
    ]
    const out = deriveConversationResources(list)
    expect(out.map((a) => a.filename)).toEqual(['c.pdf', 'a.png'])
  })
})

describe('deriveRecentFiles — 最近文件', () => {
  it('只收带 filePath 的，按 mtime 倒序，限量', () => {
    const list = [
      art({ filename: 'old.md', filePath: '/a/old.md', createdAt: 1, mtime: 100 }),
      art({ filename: 'new.md', filePath: '/a/new.md', createdAt: 2, mtime: 300 }),
      art({ filename: 'nofile.md', createdAt: 3 }), // 无磁盘路径 → 排除
      art({ filename: 'mid.md', filePath: '/a/mid.md', createdAt: 4, mtime: 200 }),
    ]
    const out = deriveRecentFiles(list, 2)
    expect(out.map((a) => a.filename)).toEqual(['new.md', 'mid.md'])
    expect(out).toHaveLength(2)
  })
})

describe('deriveTaskPlan — 任务规划', () => {
  it('无看板返回空数组', () => {
    expect(deriveTaskPlan(null)).toEqual([])
  })
  it('有看板返回条目', () => {
    const board = {
      title: '修复交付说明.md',
      items: [
        { id: 'i1', text: '第一步', status: 'done' as const },
        { id: 'i2', text: '第二步', status: 'active' as const },
      ],
      updatedAt: 1,
    }
    expect(deriveTaskPlan(board)).toHaveLength(2)
  })
})

describe('deriveUsedSkills — 技能（去重）', () => {
  it('按调用先后去重', () => {
    const calls: ToolCallRecord[] = [
      { id: '1', name: 'file_read', agentId: 'yak', status: 'done', startedAt: 1 },
      { id: '2', name: 'shell_exec', agentId: 'yak', status: 'done', startedAt: 2 },
      { id: '3', name: 'file_read', agentId: 'yak', status: 'done', startedAt: 3 },
    ]
    expect(deriveUsedSkills(calls)).toEqual(['file_read', 'shell_exec'])
  })
  it('空调用返回空', () => {
    expect(deriveUsedSkills([])).toEqual([])
  })
})

describe('deriveSubagentList — 子智能体合并', () => {
  const runtime: SubagentItem[] = [
    { id: 'intern_yak_小陈', title: '工程层角色翻转', status: 'running', owner: 'yak', createdAt: 2 },
    { id: 'intern_recha_小李', title: 'API安全审查', status: 'done', owner: 'recha', createdAt: 1 },
    { id: 'idle1', title: '还没领活', status: 'idle', owner: 'lumina', createdAt: 0 },
  ]
  const tasks: TaskWorkspaceTask[] = [
    {
      id: 't1', title: '父任务', createdAt: 1, agentId: 'lumina', status: 'running',
      subtasks: [
        { id: 'sub-old-1', title: '旧数据模型子任务', status: 'done', agentId: 'yak', createdAt: 3 },
      ],
    },
  ]

  it('合并运行态 + 父任务 subtasks，过滤 idle，按创建时间正序', () => {
    const out = deriveSubagentList(runtime, tasks)
    // idle1 被过滤
    expect(out.find((s) => s.id === 'idle1')).toBeUndefined()
    // 旧 subtasks 也进列表
    expect(out.find((s) => s.id === 'sub-old-1')).toBeDefined()
    // 正序：createdAt 1 → 2 → 3
    expect(out.map((s) => s.createdAt)).toEqual([1, 2, 3])
  })

  it('运行态已有的 id 不被父任务 subtasks 覆盖', () => {
    const runtimeDup: SubagentItem[] = [
      { id: 'sub-old-1', title: '运行态更新的标题', status: 'running', owner: 'yak', createdAt: 5 },
    ]
    const out = deriveSubagentList(runtimeDup, tasks)
    const s = out.find((x) => x.id === 'sub-old-1')!
    expect(s.title).toBe('运行态更新的标题')
    expect(s.status).toBe('running')
  })

  it('空运行态 + 空任务 → 空列表', () => {
    expect(deriveSubagentList([], [])).toEqual([])
  })
})
