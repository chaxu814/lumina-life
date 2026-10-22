// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// Loop Engine Phase 1 冒烟测试 (node 环境, 无真实 LLM / fs)
// 覆盖：创建→默认拆解→确认→运行循环→持久化→触发器
// ============================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// 避免加载真实 appStore（含 zustand persist + localStorage 依赖）
vi.mock('../src/stores/appStore', () => ({
  useStore: {
    getState: () => ({
      llmConfig: { provider: '', baseUrl: '', apiKey: '', model: '', temperature: 0.7, maxTokens: 2000, contextWindow: 0 },
    }),
  },
}))

// ── 注入 node 环境缺失的浏览器全局 ──
const memStore: Record<string, string> = {}
;(globalThis as any).localStorage = {
  getItem: (k: string) => (k in memStore ? memStore[k] : null),
  setItem: (k: string, v: string) => { memStore[k] = v },
  removeItem: (k: string) => { delete memStore[k] },
  clear: () => { Object.keys(memStore).forEach(k => delete memStore[k]) },
}
;(globalThis as any).window = {}

import { LoopEngine } from '../src/services/loopEngine'
import { cronMatches, extractJson } from '../src/services/loopPersist'
import type { LoopTrigger } from '../src/services/loopTypes'

function makeEngine() {
  return new LoopEngine({ getLLMConfig: () => undefined }) // 强制走默认拆解模板
}

beforeEach(() => {
  Object.keys(memStore).forEach(k => delete memStore[k])
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('通用工具', () => {
  it('cronMatches 基础匹配', () => {
    const d = new Date(2026, 7, 6, 15, 30, 0) // 2026-08-06 15:30 周四
    expect(cronMatches('* * * * *', d)).toBe(true)
    expect(cronMatches('30 15 * * *', d)).toBe(true)
    expect(cronMatches('31 15 * * *', d)).toBe(false)
    expect(cronMatches('0 15 * * 1-5', new Date(2026, 7, 6, 15, 0, 0))).toBe(true) // 工作日触发
    expect(cronMatches('*/15 * * * *', d)).toBe(true)
  })

  it('extractJson 容错解析', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 })
    expect(extractJson('结果："strategy":"x","subtasks":[]，请查收')).toBeNull()
    expect(extractJson('{"strategy":"x","subtasks":[]}')).toEqual({ strategy: 'x', subtasks: [] })
    expect(extractJson('no json')).toBeNull()
  })
})

describe('LoopEngine 生命周期', () => {
  it('创建 → 拆解 → reviewing', async () => {
    const e = makeEngine()
    await e.init()
    const loop = await e.createLoop('每天收盘后盯盘并给出次日操作建议')
    expect(loop).toBeTruthy()
    expect(loop!.status).toBe('reviewing')
    expect(loop!.subtasks.length).toBeGreaterThanOrEqual(3)
    expect(loop!.subtasks.every(s => s.status === 'pending')).toBe(true)
    expect(loop!.progress.persistenceKey).toBe(`${loop!.id}-progress`)
    await e.dispose()
  })

  it('confirm → 运行一轮 → runCount/产出/子任务重置', async () => {
    const e = makeEngine()
    await e.init()
    const loop = (await e.createLoop('每周整理行业热点并输出周报'))!
    await e.confirmLoop(loop.id)
    expect(e.getLoop(loop.id)!.status).toBe('running')

    await e.runCycle(loop.id)
    const l1 = e.getLoop(loop.id)!
    expect(l1.runCount).toBe(1)
    expect(l1.outputs.length).toBe(1)
    expect(l1.outputs[0].content).toContain('第 1 轮')
    expect(l1.subtasks.every(s => s.status === 'pending')).toBe(true)

    await e.runCycle(loop.id)
    expect(e.getLoop(loop.id)!.runCount).toBe(2)
    await e.dispose()
  })

  it('暂停后定时触发不再执行；恢复后才触发', async () => {
    const e = makeEngine()
    await e.init()
    const id = (await e.createLoop('每一天'))!.id
    await e.confirmLoop(id)
    // 立即到期的 interval 触发器
    e.getLoop(id)!.triggers = [{ id: 't1', type: 'interval', config: { intervalMs: 1 }, enabled: true }]
    e.getLoop(id)!.lastRunAt = Date.now() - 10000
    await e.pauseLoop(id)
    e.checkTriggers(new Date())
    expect(e.getLoop(id)!.runCount).toBe(0)

    await e.resumeLoop(id)
    e.getLoop(id)!.lastRunAt = Date.now() - 10000
    e.checkTriggers(new Date())
    // checkTriggers 内部异步触发 runCycle，等待一拍断言
    await new Promise<void>(r => setTimeout(r, 10))
    expect(e.getLoop(id)!.runCount).toBe(1)
    await e.dispose()
  })

  it('message 关键词触发器触发；无关消息不触发', async () => {
    const e = makeEngine()
    await e.init()
    const loop = (await e.createLoop('监听热点'))!
    await e.confirmLoop(loop.id)
    const trigger: LoopTrigger = { id: 'm1', type: 'message', config: { keywords: ['股票', '收盘'] }, enabled: true }
    loop.triggers = [trigger]

    const fired = await e.notifyMessage('主人，今天股票收盘了')
    expect(fired).toContain(loop.id)
    expect(e.getLoop(loop.id)!.runCount).toBe(1)

    const before = e.getLoop(loop.id)!.runCount
    await e.notifyMessage('今天天气不错')
    expect(e.getLoop(loop.id)!.runCount).toBe(before)
    await e.dispose()
  })

  it('跨 Session 恢复：新引擎实例取回状态且运行中置为 paused', async () => {
    const e1 = makeEngine()
    await e1.init()
    const loop = (await e1.createLoop('每天读三篇行业新闻'))!
    await e1.confirmLoop(loop.id)
    await e1.runCycle(loop.id)
    await e1.dispose()

    const e2 = makeEngine()
    await e2.init()
    const restored = e2.getLoop(loop.id)
    expect(restored).toBeTruthy()
    expect(restored!.status).toBe('paused')
    expect(restored!.runCount).toBe(1)
    expect(restored!.subtasks.length).toBeGreaterThan(0)
    await e2.dispose()
  })
})

// ============================================================
// detectLoopIntent — OKR 意图识别
// ============================================================
import { detectLoopIntent } from '../src/services/loopEngine'

describe('detectLoopIntent', () => {
  it('识别「帮我每天收集 XXX」→ interval 24h', () => {
    const result = detectLoopIntent('帮我每天收集新闻资讯')
    expect(result).toBeTruthy()
    expect(result!.goal).toContain('收集')
    expect(result!.goal).toContain('新闻')
    expect(result!.trigger.type).toBe('interval')
    expect(result!.trigger.config?.intervalMs).toBe(86400000)
  })

  it('识别「每周生成 XXX」→ interval 168h', () => {
    const result = detectLoopIntent('每周生成一份系统检查报告')
    expect(result).toBeTruthy()
    expect(result!.goal).toContain('生成')
    expect(result!.trigger.type).toBe('interval')
    expect(result!.trigger.config?.intervalMs).toBe(168 * 3600000)
  })

  it('识别「每天凌晨整理 XXX」→ interval 24h', () => {
    const result = detectLoopIntent('每天凌晨 3 点整理数据')
    expect(result).toBeTruthy()
    expect(result!.goal).toContain('整理')
    expect(result!.trigger.type).toBe('interval')
    expect(result!.trigger.config?.intervalMs).toBe(24 * 3600000)
  })

  it('普通聊天不触发', () => {
    expect(detectLoopIntent('你好')).toBeNull()
    expect(detectLoopIntent('帮我查一下天气')).toBeNull()
    expect(detectLoopIntent('做一首诗')).toBeNull()
    // "帮我做新闻" 中"做"不在 OKR_VERBS，不触发
    expect(detectLoopIntent('帮我做新闻报告')).toBeNull()
  })

  it('去掉角色前缀也能识别', () => {
    const result = detectLoopIntent('Lumina 帮我每天检查服务器')
    expect(result).toBeTruthy()
    expect(result!.goal).toContain('检查')
    expect(result!.goal).toContain('服务器')
  })
})