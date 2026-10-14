// 临时渲染冒烟测试：拓扑组件在多任务/多 worker 数据下不崩
import { describe, it, expect } from 'vitest'
import React from 'react'
import { renderToString } from 'react-dom/server'
import TeamTopologyView from '../src/panels/TeamTopologyView'

const h = React.createElement
const board = {
  lanes: {
    pending: [],
    claimed: [{ id: 't2', title: '调研同类文件信箱实现细节', status: 'claimed', owner: 'tmp_research_1', blockedBy: [] }],
    running: [
      { id: 't4', title: 'QA 阶段二：端到端验证与缺陷汇报，内容比较长需要两行显示', status: 'running', owner: 'tmp_test_1', blockedBy: ['t1', 't3'] },
      { id: 't6', title: '评审：代码质量与安全', status: 'running', owner: 'recha', blockedBy: ['t1', 't2'] },
    ],
    blocked: [{ id: 't5', title: '集成验收与交付', status: 'blocked', owner: 'lumina', blockedBy: ['t4', 't6'] }],
    done: [
      { id: 't1', title: '后端实现：权限门', status: 'done', owner: 'lumina', blockedBy: [] },
      { id: 't3', title: 'QA 阶段一：契约一致性测试', status: 'done', owner: 'tmp_test_1', blockedBy: [] },
    ],
    failed: [],
  },
  counts: { pending: 0, claimed: 1, running: 2, blocked: 1, done: 2, failed: 0 },
  total: 6,
}

const workers = [
  { id: 'tmp_research_1', icon: '🔎', name: '研究员1', role: 'research', busy: true },
  { id: 'tmp_test_1', icon: '🧪', name: '测试员1', role: 'test', busy: true },
]

describe('TeamTopologyView 渲染', () => {
  it('满载数据 SSR 不崩且包含关键元素', () => {
    const html = renderToString(
      h(TeamTopologyView, { board, workers, counts: { lumina: 3, yak: 0, recha: 1 }, onAction: () => {} }),
    )
    expect(html).toContain('Lumina')
    expect(html).toContain('研究员1')
    expect(html).toContain('无依赖')
    expect(html).toContain('收尾')
    expect(html).toContain('依赖')
    expect(html).toContain('#4')
    expect(html).toContain('执行中 #4')
    // v3.32：成员头像站在任务卡上 + 待命区 + 通讯流面板
    expect(html).toContain('待命区')
    expect(html).toContain('通讯')
  })

  it('空板 SSR 不崩', () => {
    const empty = {
      lanes: { pending: [], claimed: [], running: [], blocked: [], done: [], failed: [] },
      counts: {}, total: 0,
    }
    const html = renderToString(
      h(TeamTopologyView, { board: empty, workers: [], counts: {}, onAction: () => {} }),
    )
    expect(html).toContain('Lumina')
  })
})
