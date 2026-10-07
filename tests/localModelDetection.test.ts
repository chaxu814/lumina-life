// ============================================================
// tests/localModelDetection.test.ts
//
// 【要防的故障】2026-10-07 实测发现：LM Studio 的 **OpenAI 兼容端点
//   `/v1/models` 什么能力都不报** —— 每个模型条目只有 id/object/owned_by，
//   没有 max_context_length。于是「一键检测本地模型」：
//     · 拿不到上下文窗口 → 只能猜（或被硬编码成 128000/256000）
//     · 一个真正的 VLM 被误判成「不支持图片输入」
//
//   它真正的元数据在**原生端点 `/api/v0/models`**：
//     { id, type: 'vlm'|'llm', max_context_length, capabilities: ['tool_use'], state }
//
// 本测试用**实测抓到的真实响应**锁住解析行为。
// ============================================================

import { describe, it, expect, vi, afterEach } from 'vitest'
import { parseServerFactsFor } from '../electron/core/modelServerFacts'

// ── 实测抓自 http://127.0.0.1:1234/v1/models（注意：没有能力字段）──
const REAL_V1_MODELS = {
  data: [
    { id: 'mimo-v2.6-distill-qwen-9b@q8_0', object: 'model', owned_by: 'organization_owner' },
    { id: 'qwenpaw-flash-4b@q4_k_m', object: 'model', owned_by: 'organization_owner' },
  ],
}

// ── 实测抓自 http://127.0.0.1:1234/api/v0/models（原生，字段齐全）──
const REAL_NATIVE_MODELS = {
  data: [
    {
      id: 'mimo-v2.6-distill-qwen-9b@q8_0', object: 'model', type: 'vlm',
      publisher: 'LLM', arch: 'qwen35', compatibility_type: 'gguf',
      quantization: 'Q8_0', state: 'not-loaded', max_context_length: 262144,
    },
    {
      id: 'qwenpaw-flash-4b@q4_k_m', object: 'model', type: 'vlm',
      publisher: 'LLM', arch: 'qwen35', compatibility_type: 'gguf',
      quantization: 'Q4_K_M', state: 'not-loaded', max_context_length: 262144,
      capabilities: ['tool_use'],
    },
  ],
}

describe('LM Studio 端点差异 — /v1 报不出能力，原生端点可以', () => {
  it('/v1/models 拿不到上下文窗口（这正是自动检测失效的原因）', () => {
    const f = parseServerFactsFor(REAL_V1_MODELS, 'mimo-v2.6-distill-qwen-9b@q8_0')
    expect(f).not.toBeNull()
    expect(f!.contextWindow).toBeNull()
  })

  it('原生 /api/v0/models 能读到 max_context_length', () => {
    const f = parseServerFactsFor(REAL_NATIVE_MODELS, 'mimo-v2.6-distill-qwen-9b@q8_0')
    expect(f).not.toBeNull()
    expect(f!.contextWindow).toBe(262144)
  })

  it('type: vlm → 识别为视觉模型（/v1 会误判为不支持）', () => {
    const f = parseServerFactsFor(REAL_NATIVE_MODELS, 'mimo-v2.6-distill-qwen-9b@q8_0')
    expect(f!.supportsVision).toBe(true)
  })

  it('capabilities: ["tool_use"] → 识别为支持工具调用', () => {
    const f = parseServerFactsFor(REAL_NATIVE_MODELS, 'qwenpaw-flash-4b@q4_k_m')
    expect(f!.supportsTools).toBe(true)
  })

  it('未声明 capabilities 时不谎报「不支持工具」（返回未知而非 false）', () => {
    // mimo 那条没有 capabilities 字段 → 应为 null（未知），不能是 false
    const f = parseServerFactsFor(REAL_NATIVE_MODELS, 'mimo-v2.6-distill-qwen-9b@q8_0')
    expect(f!.supportsTools).toBeNull()
  })

  it('type: llm → 明确不是视觉模型', () => {
    const f = parseServerFactsFor(
      { data: [{ id: 'neohorse-1-9b@q8_0', type: 'llm', max_context_length: 262144 }] },
      'neohorse-1-9b@q8_0',
    )
    expect(f!.supportsVision).toBe(false)
    expect(f!.contextWindow).toBe(262144)
  })
})

describe('probeLocalFacts — 端点回退顺序', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

  it('优先 /v1/models；它没能力字段时回退到 /api/v0/models', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(String(url))
      const body = String(url).includes('/api/v0/models') ? REAL_NATIVE_MODELS : REAL_V1_MODELS
      return { ok: true, json: async () => body } as any
    }))
    const { probeLocalFacts } = await import('../electron/core/localProviderDiscovery')
    const facts = await probeLocalFacts('http://127.0.0.1:1234/v1', 'mimo-v2.6-distill-qwen-9b@q8_0')
    expect(calls[0]).toContain('/v1/models')
    expect(calls.some(u => u.includes('/api/v0/models'))).toBe(true)
    expect(facts!.contextWindow).toBe(262144)
  })
})
