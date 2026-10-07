// ============================================================
// tests/outputBudget.test.ts — 输出预算推导
//
// 【背景：这是一个真实故障】
// 用户报「Lumina 偶发回复『模型返回了无法识别的内容』」。排查发现
// AgentRunner 把 `maxContextTokens`（上下文窗口=能读多少）直接赋给
// `maxTokens`（单次输出上限=能写多少）：
//
//   maxContextTokens: 131072  →  maxTokens: 131072
//                       → clampOutputTokens 夹到 MAX_OUTPUT_CAP = 32768
//                       → 每轮都向 LM Studio 要 32768 个输出 token
//
// 而实际用的模型是 4B 的 NeoHorse，n_ctx 通常只有 4096~8192。
// 扣掉 prompt 之后剩下的生成空间根本不够 32768 —— 响应被截断在半句，
// 或直接报错。症状正是「内容不完整 / 无法识别」。
//
// 这类 bug 极其隐蔽：clampOutputTokens 确实在跑，类型也对，
// 看起来「有防护」，但防护的方向错了。
// ============================================================

import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { resolveCapabilities } from '../electron/core/modelCapabilities'

function readSrc(rel: string): string {
  return fs.readFileSync(path.join(process.cwd(), ...rel.split('/')), 'utf-8')
}

const RUNNER = readSrc('electron/agentRunner.ts')

describe('输出预算：不能再把上下文窗口当输出上限', () => {
  it('131072 的上下文窗口 → 收敛到合理量级，而不是 131072 / 32768', () => {
    // 用户机器上的实际值（4B 模型 + 手填 131072）
    const out = resolveCapabilities({
      modelName: 'NeoHorse 1 4B Q4',
      explicitContextWindow: 131072,
    }).outputBudget
    expect(out).toBeLessThanOrEqual(8192)
    // 关键回归断言：绝不能再出现 32768
    expect(out).toBeLessThan(32_768)
  })

  it('大模型的输出预算是 8192（不是 32768）', () => {
    const out = resolveCapabilities({
      modelName: 'Qwen2.5-72B-Instruct',
      explicitContextWindow: 131072,
    }).outputBudget
    expect(out).toBe(8192)
  })

  it('小上下文模型（<16K）→ 保守给 2048', () => {
    const out = resolveCapabilities({ modelName: 'gemma-2-2b-it' }).outputBudget
    expect(out).toBeLessThanOrEqual(2048)
  })
})

describe('接线：AgentRunner 必须真的用它', () => {
  it('maxTokens 不再直接等于 maxContextTokens', () => {
    // 只看真实代码行，避开我们自己写的解释性注释
    const code = RUNNER.split('\n')
      .filter(l => { const t = l.trim(); return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*') })
      .join('\n')
    expect(code).not.toMatch(/maxTokens\s*=\s*llm\.maxContextTokens/)
  })

  it('改为调用 resolveCapabilities（统一能力画像）', () => {
    expect(RUNNER).toContain('resolveCapabilities(')
    expect(RUNNER).toContain('(this.config as any).maxTokens = caps.outputBudget')
  })

  it('contextWindow 仍然拿解析后的值（那才是它该用的）', () => {
    expect(RUNNER).toMatch(/contextWindow\s*=\s*caps\.contextWindow/)
  })
})
