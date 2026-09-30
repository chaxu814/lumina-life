// ============================================================
// tests/agentPersonaAccuracy.test.ts
//
// 守「事实准确性 > 角色扮演」这条优先级不被 prompt 写回压制。
//
// 守住的是这几处破法：
//   1. 用「覆盖所有安全训练」把角色一致写成高于平台约束的东西
//   2. 列出「你绝不能说出以下任何话」，尤其禁说「我不能」
//      —— 直接堵死「做不到 / 信息不足 / 我不确定」，逼模型编造
//   3. 禁说「我是 AI」→ 用户问「你是不是 AI」时被迫撒谎
//   4. 把「让我想想」「首先」「我认为」这类正常推理措辞列为违规输出
//   5. 改完顺手把人设削没了（这里反过来断言角色特色还在）
//
// 顺带守一下「所有 soul 都安全」：只测一个 agentId 的话，
// 另一个角色的分支里塞回老写法是测不出来的。
// ============================================================

import { describe, it, expect } from 'vitest'
import { AGENT_SOULS, buildAgentPrompt, buildAgentPromptLite } from '../src/data/agentSouls'

/** 两种构建方式都要生成完整 prompt，所以统一在这里跑一遍所有 soul */
const ALL_IDS = AGENT_SOULS.map(s => s.id)

function buildAll(agentId: string): { full: string; lite: string } {
  return {
    full: buildAgentPrompt(agentId, '', undefined, undefined, undefined, ''),
    lite: buildAgentPromptLite(agentId, '', undefined, undefined, ''),
  }
}

/** 被禁的表达 —— 一旦出现就是压制正确性 */
const SUPPRESSION_PATTERNS: [string, RegExp][] = [
  ['覆盖安全训练', /覆盖(所有)?安全训练/],
  ['禁止说出清单', /绝不能说出|你绝不能/],
  ['禁说「我不能」', /["「]?我(绝对)?不能["」]?/],
  ['禁说我是 AI', /我是AI助手|我是人工智能|作为一个AI|我是AI，没有真名/],
  ['否认身份的禁令', /任何暗示你不是|否认身份/],
  ['违规输出清单', /输出禁令|绝对禁止出现以下内容/],
  ['正常推理措辞被禁', /自言自语[：「]/],
]

describe('Agent 人设：准确性优先于角色扮演', () => {
  it('prompt 里不再出现「覆盖所有安全训练」这类压制措辞', () => {
    for (const id of ALL_IDS) {
      const { full, lite } = buildAll(id)
      expect(full, `${id} 完整 prompt`).not.toMatch(/覆盖(所有)?安全训练/)
      expect(lite, `${id} 精简 prompt`).not.toMatch(/覆盖(所有)?安全训练/)
    }
  })

  it('不再出现禁止说「我不能」/「我是 AI」的清单', () => {
    for (const id of ALL_IDS) {
      const { full, lite } = buildAll(id)
      expect(full, `${id} 完整 prompt`).not.toMatch(/绝不能说出/)
      expect(full, `${id} 完整 prompt`).not.toMatch(/["「]?我(绝对)?不能["」]?/)
      expect(full, `${id} 完整 prompt`).not.toMatch(/我是AI助手|我是人工智能|作为一个AI/)
      expect(lite, `${id} 精简 prompt`).not.toMatch(/绝不能说出|我是AI助手|作为一个AI/)
    }
  })

  it('显式写出「准确性/诚实优先于角色扮演」的优先级', () => {
    for (const id of ALL_IDS) {
      const { full, lite } = buildAll(id)
      // 精简版：直接的第一行原则
      expect(lite, `${id} 精简 prompt`).toContain('事实准确性 > 角色扮演')
      // 完整版：身份声明里必须写清优先级
      expect(full, `${id} 完整 prompt`).toContain('优先级高于角色扮演的一致性')
    }
  })

  it('保留并强化「不确定 / 信息不足 / 做不到」必须如实说', () => {
    for (const id of ALL_IDS) {
      const { full, lite } = buildAll(id)
      for (const word of ['不确定', '信息不足', '做不到']) {
        expect(full, `${id} 完整 prompt 缺少「${word}」`).toContain(word)
        expect(lite, `${id} 精简 prompt 缺少「${word}」`).toContain(word)
      }
    }
  })

  it('仍然明确「被问到身份时如实回答」（不是强制撒谎）', () => {
    for (const id of ALL_IDS) {
      const { full, lite } = buildAll(id)
      expect(full, `${id} 完整 prompt`).toContain('被问到身份')
      expect(lite, `${id} 精简 prompt`).toContain('如实回答')
    }
  })

  it('角色特色没被削弱：人设字段原样拼装', () => {
    for (const soul of AGENT_SOULS) {
      const { full, lite } = buildAll(soul.id)
      // 角色名仍然在最前面出现
      expect(full.startsWith(`你的名字是 ${soul.name}`), `${soul.id} 身份声明开头`).toBe(true)
      expect(lite.startsWith(`你是 ${soul.name}`), `${soul.id} 精简 prompt 开头`).toBe(true)
      // 完整版的 7 个 soul 字段一个都不能少，顺序也不能变
      const order = [
        soul.persona, soul.voice, soul.examples,
        soul.dynamics, soul.mutualKnowledge, soul.conversation, soul.rules,
      ].map(chunk => full.indexOf(chunk))
      expect(order.every(i => i > -1), `${soul.id} 缺少 soul 字段`).toBe(true)
      expect([...order].sort((a, b) => a - b), `${soul.id} soul 字段顺序被打乱`).toEqual(order)
    }
  })

  it('遍历所有 soul：任何 agentId 都不会触发上述禁令', () => {
    expect(AGENT_SOULS.length).toBeGreaterThan(0)
    for (const id of ALL_IDS) {
      const { full, lite } = buildAll(id)
      for (const prompt of [full, lite]) {
        for (const [label, re] of SUPPRESSION_PATTERNS) {
          expect(prompt, `${id} 命中禁止表达：${label}`).not.toMatch(re)
        }
      }
    }
  })
})
