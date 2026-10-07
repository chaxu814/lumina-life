// ============================================================
// tests/jsonMemoryStore.test.ts
// 验证 JSON 兜底记忆存储：事实增删查 + 语义记忆 + 落盘持久化 + 重载
// （不依赖 better-sqlite3 原生模块，可在任意 Node 下运行）
// ============================================================
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { JsonMemoryStore } from '../electron/memory/jsonMemoryStore'

const TMP = path.join(os.tmpdir(), `lumina-jsonmem-${Date.now()}-${Math.floor(Math.random() * 1e6)}`)
const DB = path.join(TMP, 'mem.json')

beforeEach(() => {
  if (fs.existsSync(DB)) { fs.unlinkSync(DB) }
})
afterAll(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { /* noop */ }
})

describe('JsonMemoryStore — 事实记忆', () => {
  it('addFact 后 getFacts 能取到，且同内容去重累加 hit_count', () => {
    const s = new JsonMemoryStore(DB)
    const id = s.addFact({ category: 'preference', content: '喜欢美式咖啡不加糖', confidence: 1.0, source: 'agent_tool' as any })
    expect(id).toBeGreaterThan(0)
    const facts = s.getFacts('preference', 50)
    expect(facts.length).toBe(1)
    expect(facts[0].content).toContain('美式咖啡')

    // 同内容再写一次：不应新增行，只累加命中
    s.addFact({ category: 'preference', content: '喜欢美式咖啡不加糖', confidence: 1.0, source: 'agent_tool' as any })
    expect(s.getFacts('preference', 50).length).toBe(1)
  })

  it('deleteFact 能删除', () => {
    const s = new JsonMemoryStore(DB)
    const id = s.addFact({ category: 'agent_memory', content: 'k::v', confidence: 1.0, source: 'agent_tool' as any })
    expect(s.deleteFact(id)).toBe(true)
    expect(s.getFacts('agent_memory', 50).length).toBe(0)
  })

  it('correctFact 纠偏：更强说法覆盖，旧条目降权', () => {
    const s = new JsonMemoryStore(DB)
    const old = s.addFact({ category: 'user', content: '上海', confidence: 0.6, source: 'model_inferred' })
    const r = s.correctFact(old, { category: 'user', content: '上海', confidence: 0.95, source: 'user_confirmed' })
    expect(r.ok).toBe(true)
    const facts = s.getFacts('user', 50)
    expect(facts[0].confidence).toBeGreaterThan(0.9)
  })
})

describe('JsonMemoryStore — 持久化与重载', () => {
  it('写入后落盘，新建实例能读回', () => {
    const s1 = new JsonMemoryStore(DB)
    s1.addFact({ category: 'preference', content: '榴莲好吃', confidence: 1.0, source: 'agent_tool' as any })
    s1.addMemory({ key: 'proj', value: 'Lumina AI' })

    const s2 = new JsonMemoryStore(DB) // 模拟重启
    expect(s2.getFacts('preference', 50).length).toBe(1)
    const mem = s2.getAllMemories()
    expect(mem.find(m => m.key === 'proj')?.value).toBe('Lumina AI')
  })
})

describe('JsonMemoryStore — 注入文本不崩溃', () => {
  it('getMemoryInjectionText / getStructuredMemory 对任意状态可用', () => {
    const s = new JsonMemoryStore(DB)
    s.addFact({ category: 'user', content: '恐高', confidence: 0.95, source: 'user_stated' })
    s.saveUserProfile({ name: '小明', preferences: ['喝美式'] })
    expect(typeof s.getMemoryInjectionText()).toBe('string')
    const sm = s.getStructuredMemory()
    expect(sm.user.name).toBe('小明')
  })
})
