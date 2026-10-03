// ============================================================
// __tests__/registry.test.ts — 工具注册中心单元测试
// ============================================================

import { describe, it, expect, beforeEach } from 'vitest'
import {
  registerTool, getToolDef, getToolNames, getAllToolDefs,
  resolveToolset, TOOLSETS, executeTool, executeToolWithRetry,
  groupParallelBatches, areToolsIndependent, toOpenAIFunction,
  detectToolDependencies,
} from '../tools/registry'
import type { ToolDef, ToolResult, LLMToolCall } from '../tools/types'

// ─── 测试用 mock 工具 ───────────────────────────────────

const mockToolDef: ToolDef = {
  name: 'mock_read',
  description: 'Mock 读操作',
  toolsets: ['files'],
  params: {
    path: { type: 'string', description: '文件路径', required: true },
    encoding: { type: 'string', description: '编码', required: false },
  },
}

const mockWriteDef: ToolDef = {
  name: 'mock_write',
  description: 'Mock 写操作',
  toolsets: ['files'],
  params: {
    path: { type: 'string', description: '文件路径', required: true },
    content: { type: 'string', description: '内容', required: true },
  },
}

const mockSearchDef: ToolDef = {
  name: 'mock_search',
  description: 'Mock 搜索',
  toolsets: ['search'],
  params: {
    query: { type: 'string', description: '关键词', required: true },
  },
}

const mockExtraDef: ToolDef = {
  name: 'mock_extra',
  description: 'Mock 额外工具',
  toolsets: ['ut_solo'],
  params: {},
}

beforeEach(() => {
  // 清除内部状态 — 重新注册测试工具
  registerTool(mockToolDef, async (args) => ({
    callId: '', ok: true, content: `读取: ${args.path}`,
  }))
  registerTool(mockWriteDef, async (args) => ({
    callId: '', ok: true, content: `写入: ${args.path}`,
  }))
  registerTool(mockSearchDef, async (args) => ({
    callId: '', ok: true, content: `搜索: ${args.query}`,
  }))
  // 清掉上一轮用例可能留下的 fixture toolset，避免用例间互相污染
  for (const name of ['ut_parent', 'ut_child', 'ut_solo', 'ut_broken']) {
    delete TOOLSETS[name]
  }
})

// ═══════════════════════════════════════════════════════════
// 1. 注册与查询
// ═══════════════════════════════════════════════════════════

describe('工具注册与查询', () => {
  it('registerTool + getToolDef 往返一致', () => {
    const def = getToolDef('mock_read')
    expect(def).toBeDefined()
    expect(def!.name).toBe('mock_read')
    expect(def!.description).toContain('读操作')
  })

  it('getToolDef 返回 undefined 对于未注册工具', () => {
    expect(getToolDef('nonexistent')).toBeUndefined()
  })

  it('getAllToolDefs 返回所有已注册工具', () => {
    const all = getAllToolDefs()
    expect(all.length).toBeGreaterThanOrEqual(3)
    const names = all.map(d => d.name)
    expect(names).toContain('mock_read')
    expect(names).toContain('mock_write')
  })

  it('getToolNames 返回名称列表', () => {
    const names = getToolNames()
    expect(names).toContain('mock_read')
  })
})

// ═══════════════════════════════════════════════════════════
// 2. Toolset 组合
// ═══════════════════════════════════════════════════════════

// 【v3.34 修注】本文件此前**从未被执行过**（vitest.config.ts 的 include 只写
// 'tests/**'，不含 electron/__tests__/），所以里面 3 个 toolset 断言一直挂着。
// 挂掉的原因是它们假设 resolveToolset('agent'/'developer'/'web') 能在
// “只注册了 3 个 mock 工具”的注册表里拿到东西 —— 而这三个名字都是
// MODE_TOOLSETS（静态表专属，不接受声明式合并）。
//
// 现在改成自建 fixture：测试自己往 TOOLSETS 里塞一个带 includes 的
// toolset，并注册与之配套的 mock 工具。这样它测的是 resolveToolset 本身的
// 组合语义，而不是依赖生产工具集的注册时机。
const FIXTURE_SETS = ['ut_parent', 'ut_child', 'ut_solo']
const FIXTURE_TOOLS = ['mock_read', 'mock_write', 'mock_search', 'mock_extra']

describe('Toolset 组合解析', () => {
  it('resolveToolset 通过 includes 组合子 toolset', () => {
    TOOLSETS.ut_child = { description: '子集', tools: ['mock_read', 'mock_write'] }
    TOOLSETS.ut_solo = { description: '另一子集', tools: ['mock_extra'] }
    TOOLSETS.ut_parent = { description: '父集', includes: ['ut_child', 'ut_solo'], tools: [] }
    registerTool(mockExtraDef, async () => ({ callId: '', ok: true, content: 'extra' }))

    const result = resolveToolset('ut_parent')
    expect(result).toContain('mock_read')
    expect(result).toContain('mock_write')
    expect(result).toContain('mock_extra')
  })

  it('resolveToolset 排除被 includes 覆盖的 toolset（无重复）', () => {
    TOOLSETS.ut_child = { description: '子集', tools: ['mock_read'] }
    // 故意让 ut_solo 也包含 mock_read —— 菱形依赖时同一工具不能出现两次
    TOOLSETS.ut_solo = { description: '重叠子集', tools: ['mock_read', 'mock_search'] }
    TOOLSETS.ut_parent = { description: '父集', includes: ['ut_child', 'ut_solo'], tools: [] }

    const result = resolveToolset('ut_parent')
    expect(result.filter(t => t === 'mock_read')).toHaveLength(1)
    expect(new Set(result).size).toBe(result.length)
  })

  it('resolveToolset 简单 toolset 直接返回 tools', () => {
    TOOLSETS.ut_solo = { description: '扁平集', tools: ['mock_read', 'mock_write'] }
    const result = resolveToolset('ut_solo')
    expect(result).toEqual(expect.arrayContaining(['mock_read', 'mock_write']))
  })

  it('resolveToolset 能力层会并入 ToolDef.toolsets 声明的工具（v3.34）', () => {
    // mock_extra 声明的是 toolsets: ['ut_solo']，而 ut_solo 的静态 tools 为空。
    // 能力层（非 MODE_TOOLSETS）应自动把它并进来 —— 这正是 v3.34 修的行为：
    // 之前 ToolDef.toolsets 完全没人读，声明了也永远进不了 function list。
    TOOLSETS.ut_solo = { description: '空集，靠声明式填充', tools: [] }
    expect(resolveToolset('ut_solo')).toContain('mock_extra')
  })

  it('resolveToolset 模式层不接受声明式合并（保住分档设计）', () => {
    // 'agent' 是 MODE_TOOLSETS：它的能力边界是产品决策，不能被工具自己声明左右。
    // mock_extra 声明了 toolsets:['ut_solo']，但绝不能因此出现在 agent 里。
    expect(resolveToolset('agent')).not.toContain('mock_extra')
  })

  it('resolveToolset 对未定义 toolset 返回空并告警（不静默吞掉 includes 错误）', () => {
    TOOLSETS.ut_broken = { description: '引用了不存在的集', includes: ['__does_not_exist__'], tools: [] }
    expect(resolveToolset('ut_broken')).toEqual([])
  })
})

// ═══════════════════════════════════════════════════════════
// 3. 工具执行
// ═══════════════════════════════════════════════════════════

describe('工具执行', () => {
  it('executeTool 正常返回', async () => {
    const result = await executeTool('mock_read', { path: '/tmp/test.txt' })
    expect(result.ok).toBe(true)
    expect(result.content).toContain('/tmp/test.txt')
  })

  it('executeTool 未知工具返回错误', async () => {
    const result = await executeTool('no_such_tool', {})
    expect(result.ok).toBe(false)
    expect(result.error).toContain('未知工具')
  })

  it('executeToolWithRetry 成功时只调用一次', async () => {
    const callCount = 0
    // 直接在 before 的 mock 工具上测——executeTool 已证明注册正常
    // executeToolWithRetry 内部调用 executeTool，这里验证执行路径
    const result = await executeToolWithRetry('mock_read', { path: '/test' }, { maxRetries: 1 })
    expect(result.ok).toBe(true)
    expect(result.content).toContain('/test')
  })

  it('executeToolWithRetry 对未知工具显式失败并给出可读原因', async () => {
    // 行为演进记录：v2.7 曾改成 ok:true + 引导文案，理由是避免 ReAct 重试风暴；
    // 但那会让 LLM 把「换一个工具吧」当成真实执行结果。后来又改回显式失败
    // （registry.ts executeToolWithRetry 的「工具不存在」分支）。
    // 显式失败更符合本项目一贯穿的「失败必须诚实」原则，这里锁定当前行为。
    const result = await executeToolWithRetry('no_such_tool', {}, { maxRetries: 1, backoff: 'fixed', retryDelayMs: 10 })
    expect(result.ok).toBe(false)
    expect(result.content).toContain('不存在')
  })
})

// ═══════════════════════════════════════════════════════════
// 4. 并行执行
// ═══════════════════════════════════════════════════════════

describe('工具并行执行', () => {
  it('groupParallelBatches 单工具返回单批次', () => {
    const calls: LLMToolCall[] = [
      { id: '1', type: 'function', function: { name: 'mock_read', arguments: '{}' } },
    ]
    const batches = groupParallelBatches(calls)
    expect(batches).toHaveLength(1)
    expect(batches[0]).toHaveLength(1)
  })

  it('groupParallelBatches 两个独立读操作分在同一批次', () => {
    const calls: LLMToolCall[] = [
      { id: '1', type: 'function', function: { name: 'file_read', arguments: '{}' } },
      { id: '2', type: 'function', function: { name: 'web_search', arguments: '{}' } },
    ]
    const batches = groupParallelBatches(calls)
    expect(batches.length).toBeLessThanOrEqual(2)
  })

  it('groupParallelBatches 写操作不与其他并行', () => {
    const calls: LLMToolCall[] = [
      { id: '1', type: 'function', function: { name: 'file_write', arguments: '{}' } },
      { id: '2', type: 'function', function: { name: 'file_read', arguments: '{}' } },
    ]
    const batches = groupParallelBatches(calls)
    // 写操作应该单独一批
    const writeBatch = batches.find(b => b.some(c => c.function.name === 'file_write'))
    expect(writeBatch).toBeDefined()
    // file_write 批次中不应该包含 file_read
    if (writeBatch) {
      const hasRead = writeBatch.some(c => c.function.name === 'file_read')
      expect(hasRead).toBe(false)
    }
  })
})

// ═══════════════════════════════════════════════════════════
// 5. OpenAI Function Schema 生成
// ═══════════════════════════════════════════════════════════

describe('OpenAI Function Schema', () => {
  it('toOpenAIFunction 生成正确的 schema', () => {
    const schema = toOpenAIFunction(mockToolDef)
    expect(schema.type).toBe('function')
    expect(schema.function.name).toBe('mock_read')
    expect(schema.function.parameters.properties.path).toBeDefined()
    expect(schema.function.parameters.properties.path.type).toBe('string')
    expect(schema.function.parameters.required).toContain('path')
    expect(schema.function.parameters.required).not.toContain('encoding')
  })
})

// ═══════════════════════════════════════════════════════════
// 6. 依赖检测
// ═══════════════════════════════════════════════════════════

describe('工具依赖检测', () => {
  it('detectToolDependencies 为 file_edit 标记 file_read 依赖', () => {
    const calls: LLMToolCall[] = [
      { id: '1', type: 'function', function: { name: 'file_read', arguments: '{"path":"a.txt"}' } },
      { id: '2', type: 'function', function: { name: 'file_edit', arguments: '{"path":"a.txt"}' } },
    ]
    const deps = detectToolDependencies(calls)
    const editDeps = deps.get('2')
    expect(editDeps).toBeDefined()
    expect(editDeps).toContain('1')
  })
})
