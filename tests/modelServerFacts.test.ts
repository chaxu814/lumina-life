// ============================================================
// tests/modelServerFacts.test.ts — 服务端事实的解析
//
// 【背景】
// 上一版能力画像的诚实短板：上下文窗口是**按参数量猜的**。
// 而 Lumina 本来就在请求 /v1/models，只是把服务端返回的上下文长度
// 连同整个响应对象一起扔了（`extractModelCapabilities(id)` 只传 id）。
//
// 「已经在问、却没听答案」比「没问」更糟 —— 它让人误以为已经适配过了。
//
// 【这个文件验证什么】
// 各家推理服务报字段的方式完全不同，所以解析器是**遍历候选路径**，
// 而不是判断「是不是 LM Studio」（后者要维护服务商列表，
// 而服务商在增加、字段在变）。本文件用**各家的真实响应形状**验证。
// ============================================================

import { describe, it, expect, beforeEach } from 'vitest'
import {
  parseServerFacts,
  parseServerFactsFor,
  familiesImplyVision,
  rememberServerFacts,
  recallServerFacts,
  __clearServerFactsCache,
} from '../electron/core/modelServerFacts'
import { resolveCapabilities } from '../electron/core/modelCapabilities'

// ── 各服务商的真实响应形状 ──

const LM_STUDIO = {
  object: 'list',
  data: [
    { id: 'qwen2.5-7b-instruct', object: 'model', owned_by: 'lmstudio', max_context_length: 32768 },
  ],
}

const LLAMA_CPP = {
  object: 'list',
  data: [
    { id: 'local-model', meta: { n_ctx: 8192, n_params: 4000000000 } },
  ],
}

const VLLM = {
  object: 'list',
  data: [
    { id: 'Qwen/Qwen2.5-7B-Instruct', max_model_len: 131072, root: '/models', owned_by: 'vllm' },
  ],
}

const OLLAMA = {
  models: [
    {
      name: 'qwen2.5vl:7b',
      details: { families: ['qwen2vl', 'clip'], parameter_size: '8.29B', family: 'qwen2vl' },
      model_info: { 'qwen2vl.block_count': 28, 'qwen2vl.context_length': 32768 },
    },
  ],
}

const OLLAMA_TEXT = {
  models: [
    {
      name: 'qwen2.5:7b',
      details: { families: ['qwen2'], parameter_size: '7.62B' },
      model_info: { 'qwen2.context_length': 32768 },
    },
  ],
}

const MINIMAL = { object: 'list', data: [{ id: 'some-model' }] }

describe('上下文窗口：各家字段名都能解出来', () => {
  it('LM Studio → max_context_length', () => {
    expect(parseServerFacts(LM_STUDIO)?.contextWindow).toBe(32768)
  })

  it('llama.cpp server → meta.n_ctx（嵌在 meta 里）', () => {
    expect(parseServerFacts(LLAMA_CPP)?.contextWindow).toBe(8192)
  })

  it('vLLM → max_model_len', () => {
    expect(parseServerFacts(VLLM)?.contextWindow).toBe(131072)
  })

  it('Ollama → model_info["<arch>.context_length"]（键名带后缀）', () => {
    expect(parseServerFacts(OLLAMA)?.contextWindow).toBe(32768)
  })

  it('只有 id 的最简响应 → contextWindow 为 null（而不是瞎猜一个）', () => {
    const f = parseServerFacts(MINIMAL)
    expect(f).not.toBeNull()
    expect(f?.contextWindow).toBeNull()
  })

  it('荒谬的值会被拒（512 以下 / 1000 万以上）', () => {
    expect(parseServerFacts({ data: [{ id: 'x', max_context_length: 8 }] })?.contextWindow).toBeNull()
    expect(parseServerFacts({ data: [{ id: 'x', max_context_length: 99_999_999 }] })?.contextWindow).toBeNull()
  })
})

describe('多模态：服务端说优先于名字猜', () => {
  it('Ollama 的架构族能识别出视觉模型（名字里没有 vl 也不怕）', () => {
    // families 含 clip → 说明是视觉模型。这是正则做不到的
    expect(familiesImplyVision(['qwen2vl', 'clip'])).toBe(true)
    expect(parseServerFacts(OLLAMA)?.supportsVision).toBe(true)
  })

  it('纯文本模型的 families 不含视觉架构', () => {
    expect(familiesImplyVision(['qwen2'])).toBe(false)
    expect(parseServerFacts(OLLAMA_TEXT)?.supportsVision).toBe(false)
  })

  it('families 为空时不猜（返回 null，交给上层命名规则）', () => {
    expect(familiesImplyVision([])).toBeNull()
  })

  it('显式的 multimodal/vision 字段优先于 families', () => {
    const f = parseServerFacts({ data: [{ id: 'x', families_hint: 0, multimodal: true }] })
    expect(f?.supportsVision).toBe(true)
  })

  it('input_modalities 数组含 image 算支持', () => {
    const f = parseServerFacts({ data: [{ id: 'x', input_modalities: ['text', 'image'] }] })
    expect(f?.supportsVision).toBe(true)
  })

  it('input_modalities 只有 text 算不支持', () => {
    const f = parseServerFacts({ data: [{ id: 'x', input_modalities: ['text'] }] })
    expect(f?.supportsVision).toBe(false)
  })
})

describe('参数量：服务端报的 details.parameter_size 优先', () => {
  it('Ollama 报的 8.29B 能解析出来', () => {
    expect(parseServerFacts(OLLAMA)?.paramSizeText).toBe('8.29B')
  })

  it('服务端值会改变档位判定（8.29B → medium，而不是按名字猜）', () => {
    const facts = parseServerFacts(OLLAMA)!
    const caps = resolveCapabilities({
      modelName: 'qwen2.5vl:7b',       // 名字里只有 7
      server: { paramSizeText: facts.paramSizeText },
    })
    expect(caps.paramSizeB).toBe(8.29)
    expect(caps.tier).toBe('medium')
  })
})

describe('多模型时不能张冠李戴', () => {
  const MANY = {
    data: [
      { id: 'model-a', max_context_length: 4096 },
      { id: 'model-b', max_context_length: 131072 },
    ],
  }

  it('按名字精确匹配', () => {
    expect(parseServerFactsFor(MANY, 'model-b')?.contextWindow).toBe(131072)
    expect(parseServerFactsFor(MANY, 'model-a')?.contextWindow).toBe(4096)
  })

  it('大小写不敏感', () => {
    expect(parseServerFactsFor(MANY, 'MODEL-B')?.contextWindow).toBe(131072)
  })

  it('部分匹配（LM Studio 报的 id 常带路径/后缀）', () => {
    expect(parseServerFactsFor(MANY, 'model-b-instruct')?.contextWindow).toBe(131072)
  })

  it('找不到就返回 null，绝不拿第一个模型的数据糊弄', () => {
    expect(parseServerFactsFor(MANY, 'does-not-exist')).toBeNull()
  })

  it('⚠️ parseServerFacts（取第一条）只用于「只有一个模型」的场景', () => {
    // 这个函数不做匹配，只取第一个 —— 测试里显式记录这个局限，
    // 免得以后有人拿它去处理多模型列表
    expect(parseServerFacts(MANY)?.contextWindow).toBe(4096)
  })
})

describe('畸形输入不能崩', () => {
  it('各种垃圾输入都返回 null 而不是抛异常', () => {
    for (const bad of [null, undefined, 0, '', 'string', [], {}, { data: null }, { models: 'x' }]) {
      expect(() => parseServerFacts(bad as unknown), String(bad)).not.toThrow()
      expect(parseServerFacts(bad as unknown), String(bad)).toBeNull()
    }
  })
})

describe('记忆层：探测 → 运行时 的零 IO 通路', () => {
  beforeEach(() => { __clearServerFactsCache() })

  it('存进去能同步读回来', () => {
    rememberServerFacts('qwen2.5-7b-instruct', parseServerFacts(LM_STUDIO))
    expect(recallServerFacts('qwen2.5-7b-instruct')?.contextWindow).toBe(32768)
  })

  it('大小写不敏感', () => {
    rememberServerFacts('Qwen2.5-7B-Instruct', parseServerFacts(LM_STUDIO))
    expect(recallServerFacts('qwen2.5-7b-instruct')).not.toBeNull()
  })

  it('后缀/变体名能模糊命中（qwen2.5:7b vs Qwen2.5-7B-Instruct）', () => {
    rememberServerFacts('Qwen2.5-7B-Instruct', parseServerFacts(LM_STUDIO))
    expect(recallServerFacts('qwen2.5:7b')).not.toBeNull()
  })

  it('没探测过的模型返回 null → 上层回退到命名规则', () => {
    expect(recallServerFacts('never-probed-model')).toBeNull()
  })

  it('null 事实不会被存进去', () => {
    rememberServerFacts('x', null)
    expect(recallServerFacts('x')).toBeNull()
  })

  it('容量有上限，不会无限增长', () => {
    for (let i = 0; i < 260; i++) {
      rememberServerFacts(`m-${i}`, { contextWindow: 4096, supportsVision: null, supportsTools: null, families: [], paramSizeText: null })
    }
    // 存了 260 条但上限 200：最早的应该被淘汰
    expect(recallServerFacts('m-0')).toBeNull()
    expect(recallServerFacts('m-259')).not.toBeNull()
  })
})

describe('端到端：服务端事实真的改变了最终画像', () => {
  beforeEach(() => { __clearServerFactsCache() })

  it('没服务端数据 → 按参数量估算，source=size', () => {
    const c = resolveCapabilities({ modelName: 'Qwen2.5-7B-Instruct' })
    expect(c.source.contextWindow).toBe('size')
  })

  it('有服务端数据 → 用真值，source=server', () => {
    const c = resolveCapabilities({
      modelName: 'Qwen2.5-7B-Instruct',
      server: { contextWindow: 65536 },
    })
    expect(c.contextWindow).toBe(65536)
    expect(c.source.contextWindow).toBe('server')
  })

  it('🔒 不变式在有服务端数据时依然成立', () => {
    for (const ctx of [2048, 4096, 8192, 32768, 131072, 262144]) {
      const c = resolveCapabilities({ modelName: 'some-model', server: { contextWindow: ctx } })
      expect(c.outputBudget, `server ctx=${ctx}`).toBeLessThanOrEqual(Math.floor(c.contextWindow / 2))
    }
  })

  it('服务端说支持视觉 → 覆盖命名规则的 false', () => {
    const c = resolveCapabilities({
      modelName: 'plain-looking-name',   // 名字里没有任何视觉标记
      server: { supportsVision: true },
    })
    expect(c.supportsVision).toBe(true)
    expect(c.source.vision).toBe('server')
  })

  it('运行时 400 反馈仍然压过服务端（实测胜过一切）', () => {
    const c = resolveCapabilities({
      modelName: 'x',
      server: { supportsTools: true, supportsVision: true },
      runtime: { supportsTools: false, supportsVision: false },
    })
    expect(c.supportsTools).toBe(false)
    expect(c.supportsVision).toBe(false)
    expect(c.source.tools).toBe('runtime')
  })

  it('显式配置与服务端真值差距过大时，以服务端为准（用户填的是旧值）', () => {
    // 用户在 LM Studio 里把 n_ctx 从 32K 改成了 128K，但配置里还写着 32768
    const c = resolveCapabilities({
      modelName: 'Qwen2.5-7B-Instruct',
      explicitContextWindow: 32768,
      server: { contextWindow: 131072 },
    })
    expect(c.contextWindow).toBe(131072)
    expect(c.source.contextWindow).toBe('server')
  })

  it('显式配置与服务端接近时，尊重用户（可能在服务端允许范围内故意调小）', () => {
    const c = resolveCapabilities({
      modelName: 'Qwen2.5-7B-Instruct',
      explicitContextWindow: 16384,
      server: { contextWindow: 32768 },
    })
    expect(c.contextWindow).toBe(16384)
    expect(c.source.contextWindow).toBe('explicit')
  })
})
