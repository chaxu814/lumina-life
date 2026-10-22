// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// tests/modelCapabilities.test.ts — 模型能力画像的通用性
//
// 【这个测试要证明什么】
// 用户的要求原话：「就算是不同的模型，都要做通用的适配性，
// 不要出现个别的模型的特立独行。」
//
// 所以这里**故意不给单个模型写断言**，而是拿一大票真实存在的
// 模型名（Qwen / Llama / Mistral / Gemma / Phi / GLM / DeepSeek / Yi /
// InternLM / MiniCPM / Mixtral / OLMo / Command-R …）过一遍，
// 只断言**规则层面**的��质：
//
//   1. 参数量能从名字里解出来（含小数、MoE、后缀变体）
//   2. outputBudget ≤ contextWindow / 2  ← 本模块存在的核心理由
//   3. 小模型不会拿到离谱的预算
//   4. 未知模型也能拿到合理画像（而不是崩溃或返回 256K）
//   5. 显式配置能被采纳，但受档位上限约束
//   6. 运行时反馈优先级最高
//
// 换句话说：**如果明天 HF 上出现一个今天没人见过的新模型，
// 这个测试不需要改一行就应该继续通过。**
// ============================================================

import { describe, it, expect } from 'vitest'
import {
  parseParamSizeB,
  tierForParamSize,
  resolveCapabilities,
  looksVision,
  looksReasoning,
  looksToolCapable,
  explainCapabilities,
  type ResolveInput,
} from '../electron/core/modelCapabilities'

/** 真实存在过的模型名（取自 HF / ModelScope 常见命名） */
const REAL_MODELS = [
  'Qwen2.5-0.5B-Instruct', 'Qwen2.5-1.5B-Instruct', 'Qwen2.5-3B-Instruct',
  'Qwen2.5-7B-Instruct', 'Qwen2.5-14B-Instruct', 'Qwen2.5-32B-Instruct', 'Qwen2.5-72B-Instruct',
  'Qwen2.5-7B-Instruct-GGUF', 'Qwen2-7B-Instruct', 'qwen2.5:7b',
  'Llama-3.1-8B-Instruct', 'llama-3.2-3b-instruct', 'Meta-Llama-3-70B-Instruct',
  'Mistral-7B-Instruct-v0.3', 'Mistral-Nemo-Instruct-2407', 'ministral-3b-instruct',
  'gemma-2-2b-it', 'gemma-2-9b-it', 'gemma-2-27b-it', 'gemma-3-4b-it',
  'Phi-3.5-mini-instruct', 'Phi-4-14B', 'phi-3-medium-4k-instruct',
  'glm-4-9b-chat', 'GLM-4-32B-0414', 'chatglm3-6b',
  'deepseek-coder-33b-instruct', 'DeepSeek-R1-Distill-Qwen-7B', 'deepseek-v3',
  'Yi-1.5-34B-Chat', 'yi-6b-chat', 'Yi-1.5-9B-Chat-16K',
  'InternLM2_5-7B-Chat', 'internlm2_5-20b-chat',
  'MiniCPM3-4B', 'minicpm-v-2_6', 'OpenBMB/MiniCPM2-2B-dpo-fp16',
  'Mixtral-8x7B-Instruct-v0.1', 'Mixtral-8x22B-Instruct-v0.1',
  'OLMo-2-1124-7B-Instruct', 'olmo-2-0325-3B',
  'command-r-35b', 'Nous-Hermes-2-Mistral-7B-DPO',
  'baichuan4-air-7b', 'Baichuan-M1-14B-Instruct', 'granite-3.1-8b-instruct',
  'NeoHorse 1 4B Q4',                       // 用户本机实际在用的
  'QwenPaw Flash 4B Q4',                    // 设置面板显示的
  'gpt-4o', 'gpt-4o-mini', 'claude-3-5-sonnet', 'gemini-1.5-pro', 'deepseek-chat',
]

describe('参数量解析 —— 真实命名的各种花样', () => {
  it('能解出整数 B', () => {
    expect(parseParamSizeB('Qwen2.5-7B-Instruct')).toBe(7)
    expect(parseParamSizeB('llama-3.1-8B-Instruct')).toBe(8)
    expect(parseParamSizeB('qwen2.5:7b')).toBe(7)
  })

  it('能解出小数 B（旧实现只认 /(\\d+)B/，1.5B 全解析失败）', () => {
    expect(parseParamSizeB('Qwen2.5-1.5B-Instruct')).toBe(1.5)
    expect(parseParamSizeB('gemma-2-2b-it')).toBe(2)
    expect(parseParamSizeB('MiniCPM2-2B-dpo')).toBe(2)
  })

  it('能解出 MoE 的活跃规模', () => {
    expect(parseParamSizeB('Mixtral-8x7B-Instruct-v0.1')).toBe(56)
    expect(parseParamSizeB('Mixtral-8x22B-Instruct-v0.1')).toBe(176)
  })

  it('带后缀/路径/量化标记也能解', () => {
    expect(parseParamSizeB('Qwen2.5-7B-Instruct-GGUF')).toBe(7)
    expect(parseParamSizeB('Qwen2.5-7B-Instruct')).toBe(7)
    expect(parseParamSizeB('models/Qwen2.5-7B-Instruct')).toBe(7)
  })

  it('解不出来就返回 null，而不是硬编码 7（旧实现的隐性 bug）', () => {
    expect(parseParamSizeB('some-unknown-model-v2')).toBeNull()
    expect(parseParamSizeB('')).toBeNull()
    expect(parseParamSizeB(null)).toBeNull()
    expect(parseParamSizeB('glm-4')).toBeNull()   // GLM-4 的 4 不是参数量
  })

  it('不会把版本号误认成参数量', () => {
    // Llama-3.1-8B：应取 8，不是 3 或 31
    expect(parseParamSizeB('Llama-3.1-8B-Instruct')).toBe(8)
    // Phi-3.5-mini 的 3.5 是**版本号**，不是参数量（它实际是 3.8B）。
    // 名字里没有 B 后缀就应当返回 null —— 宁可回退到保守档，也不猜。
    expect(parseParamSizeB('Phi-3.5-mini-instruct')).toBeNull()
    // gpt-4o / glm-4 同理：4 不是参数量
    expect(parseParamSizeB('gpt-4o-mini')).toBeNull()
  })

  it('名字里没有 B 后缀时宁可返回 null，也不猜一个数', () => {
    // 猜错的代价不对称：猜大了 → 向小模型要天文数字的输出 → 截断；
    // 猜小了 → 窗口偏保守 → 只是少装一点上下文。后者无害。
    for (const m of ['Phi-3.5-mini-instruct', 'glm-4-9b-chat', 'gpt-4o', 'deepseek-chat']) {
      if (parseParamSizeB(m) === null) { continue }
      // 若解析出了值，必须来自带 B 后缀的片段（不是版本号）
      expect(m).toMatch(/\d+(?:\.\d+)?\s*[bB](?![a-zA-Z])/)
    }
  })
})

describe('档位划分', () => {
  it('按参数量单调升档', () => {
    expect(tierForParamSize(0.5)).toBe('nano')
    expect(tierForParamSize(3)).toBe('small')
    expect(tierForParamSize(7)).toBe('medium')
    expect(tierForParamSize(14)).toBe('medium')
    expect(tierForParamSize(32)).toBe('large')
    expect(tierForParamSize(72)).toBe('xlarge')
  })

  it('未知参数量落到 small（保守中位，不猜大也不猜小）', () => {
    expect(tierForParamSize(null)).toBe('small')
  })
})

describe('🔒 核心不变量：outputBudget ≤ contextWindow / 2', () => {
  it('所有真实模型都满足', () => {
    for (const m of REAL_MODELS) {
      const c = resolveCapabilities({ modelName: m })
      expect(
        c.outputBudget,
        `${m} → ctx=${c.contextWindow} out=${c.outputBudget}`,
      ).toBeLessThanOrEqual(Math.floor(c.contextWindow / 2))
    }
  })

  it('用户本机的 4B 模型不会再拿到 32768', () => {
    const c = resolveCapabilities({
      modelName: 'NeoHorse 1 4B Q4',
      explicitContextWindow: 131072,
    })
    // 这是本次故障的现场：显式填了 131072，但档位上限会把它收敛
    expect(c.contextWindow).toBeLessThanOrEqual(131072)
    expect(c.outputBudget).toBeLessThanOrEqual(8192)
    expect(c.outputBudget).toBeLessThanOrEqual(Math.floor(c.contextWindow / 2))
  })

  it('小模型的输出预算是「能说完一段话」的量级，不是天文数字', () => {
    for (const m of ['Qwen2.5-0.5B-Instruct', 'Qwen2.5-1.5B-Instruct', 'llama-3.2-3b-instruct', 'gemma-2-2b-it']) {
      const c = resolveCapabilities({ modelName: m })
      expect(c.outputBudget, m).toBeLessThanOrEqual(2048)
    }
  })
})

describe('未知模型不能崩，也不能拿到幻想值', () => {
  it('完全不认识的名字拿到的是保守画像，不是 256K', () => {
    const c = resolveCapabilities({ modelName: 'brand-new-model-2099-turbo' })
    expect(c.contextWindow).toBeLessThanOrEqual(8192)
    expect(c.outputBudget).toBeGreaterThan(0)
    expect(c.tier).toBe('small')
    expect(c.paramSizeB).toBeNull()
  })

  it('空模型名不崩', () => {
    const c = resolveCapabilities({ modelName: '' })
    expect(c.contextWindow).toBeGreaterThan(0)
    expect(c.outputBudget).toBeGreaterThan(0)
  })

  it('整个输入为空对象也能给出结果', () => {
    const c = resolveCapabilities({} as ResolveInput)
    expect(c.contextWindow).toBeGreaterThan(0)
  })
})

describe('特征识别按「架构命名」而非「具体模型」', () => {
  it('多模态：命中家族规则', () => {
    for (const m of ['Qwen2.5-VL-7B-Instruct', 'llava-1.5-13b', 'MiniCPM-v-2_6', 'bakllava-1', 'gemma-3-4b-it', 'llava-next-34b']) {
      expect(looksVision(m), m).toBe(true)
    }
  })

  it('纯文本模型不会被误判成多模态', () => {
    for (const m of ['Qwen2.5-7B-Instruct', 'llama-3.1-8B-Instruct', 'mistral-7b-instruct', 'deepseek-coder-33b']) {
      expect(looksVision(m), m).toBe(false)
    }
  })

  it('推理模型：命中家族规则', () => {
    for (const m of ['QwQ-32B', 'DeepSeek-R1-Distill-Qwen-7B', 'deepseek-r1', 'magistral-7b', 'phi-4-reasoning']) {
      expect(looksReasoning(m), m).toBe(true)
    }
    expect(looksReasoning('Qwen2.5-7B-Instruct')).toBe(false)
  })

  it('工具调用预期：主流指令模型为 true，未知模型不硬猜', () => {
    for (const m of ['Qwen2.5-7B-Instruct', 'Llama-3.1-8B-Instruct', 'Hermes-2-Mistral-7B', 'GLM-4-9B-Chat', 'gpt-4o', 'deepseek-chat']) {
      expect(looksToolCapable(m), m).toBe(true)
    }
    // 认不出来 → 预期 false，让运行时 400 去纠正，而不是乐观假设
    expect(looksToolCapable('mystery-model-x1')).toBe(false)
  })
})

describe('优先级：运行时反馈 > 命名规则 > 档位表', () => {
  it('运行时说支持工具，就覆盖命名规则的 false', () => {
    const c = resolveCapabilities({
      modelName: 'mystery-model-x1',          // 命名规则说 false
      runtime: { supportsTools: true },
    })
    expect(c.supportsTools).toBe(true)
    expect(c.source.tools).toBe('runtime')
  })

  it('运行时说支持视觉，就覆盖命名规则的 false', () => {
    const c = resolveCapabilities({
      modelName: 'weird-vision-less-name',      // 命名里没有 vl
      runtime: { supportsVision: true },
    })
    expect(c.supportsVision).toBe(true)
    expect(c.source.vision).toBe('runtime')
  })

  it('显式上下文被采纳时，来源标记为 explicit', () => {
    const c = resolveCapabilities({ modelName: 'Qwen2.5-7B-Instruct', explicitContextWindow: 32768 })
    expect(c.contextWindow).toBe(32768)
    expect(c.source.contextWindow).toBe('explicit')
  })

  it('离谱的显式值被档位上限收敛（不是照单全收）', () => {
    const c = resolveCapabilities({ modelName: 'Qwen2.5-0.5B-Instruct', explicitContextWindow: 2_000_000 })
    // nano 档 × 4 = 16384 上限
    expect(c.contextWindow).toBeLessThanOrEqual(16_384)
  })

  it('小于 1024 的显式值被忽略（那不是有效窗口）', () => {
    const c = resolveCapabilities({ modelName: 'Qwen2.5-7B-Instruct', explicitContextWindow: 512 })
    expect(c.contextWindow).toBeGreaterThanOrEqual(1024)
  })
})

describe('可解释性：用户能看懂数字从哪来', () => {
  it('explainCapabilities 说出参数量与档位', () => {
    const c = resolveCapabilities({ modelName: 'Qwen2.5-7B-Instruct' })
    const s = explainCapabilities(c)
    expect(s).toContain('7B')
    expect(s).toContain('medium')
  })

  it('参数量未知时不编造', () => {
    const s = explainCapabilities(resolveCapabilities({ modelName: 'mystery' }))
    expect(s).toContain('参数量未知')
  })
})

describe('超时也随档位走（不是固定 300s）', () => {
  it('小模型不会等太久，大模型给得起', () => {
    const small = resolveCapabilities({ modelName: 'Qwen2.5-1.5B-Instruct' }).timeoutMs
    const large = resolveCapabilities({ modelName: 'Qwen2.5-72B-Instruct' }).timeoutMs
    expect(large).toBeGreaterThan(small)
  })
})
