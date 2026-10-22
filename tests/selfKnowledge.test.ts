// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// tests/selfKnowledge.test.ts — Agent 自我认知
//
// 背景：实测用户问「团队有谁」「Lucky agent 是什么」时热茶答不上来。
// 本测试钉住：任何 Agent 的自我认知都必须包含
//   ① 项目身份  ② 团队三人  ③ 铁则  ④ Lucky 模式的正确解释  ⑤ 自己的身份
// ============================================================

import { describe, it, expect } from 'vitest'
import { buildSelfKnowledgeBlock, collectRuntimeFacts, buildFullSelfDescription } from '../electron/selfKnowledge'
import { buildWorkerSystemPrompt } from '../electron/orchestration/delegationPrompt'
import { aboutLumina, aboutLuminaDef } from '../electron/tools/impl/aboutLumina'

describe('buildSelfKnowledgeBlock', () => {
  it('包含项目身份', () => {
    const s = buildSelfKnowledgeBlock('lumina')
    expect(s).toContain('Lumina Life')
    expect(s).toContain('团队 Agent')
  })

  it('包含完整团队三人（Lumina / Yak / 热茶）', () => {
    const s = buildSelfKnowledgeBlock('lumina')
    expect(s).toContain('Lumina')
    expect(s).toContain('Yak')
    expect(s).toContain('热茶')
  })

  it('包含团队铁则（用户只跟 Lumina 说话）', () => {
    const s = buildSelfKnowledgeBlock('lumina')
    expect(s).toContain('用户')
    expect(s).toContain('后台成员')
  })

  it('正确解释 Lucky 模式 —— 是循环控制模式，不是成员', () => {
    const s = buildSelfKnowledgeBlock('lumina')
    expect(s).toContain('Lucky')
    expect(s).toContain('循环控制模式')
    // 必须明确澄清 Lucky 不是团队成员
    expect(s).toMatch(/团队里没有叫 Lucky 的成员|不是一位 agent|不是某个团队成员/)
  })

  it('注入当前身份（热茶 / Yak / Lumina 各不相同）', () => {
    expect(buildSelfKnowledgeBlock('recha')).toContain('热茶')
    expect(buildSelfKnowledgeBlock('yak')).toContain('Yak')
    expect(buildSelfKnowledgeBlock('lumina')).toContain('Lumina')
  })

  it('compact 版更短，但仍含团队与 Lucky 说明', () => {
    const full = buildSelfKnowledgeBlock('recha')
    const compact = buildSelfKnowledgeBlock('recha', { compact: true })
    expect(compact.length).toBeLessThan(full.length)
    expect(compact).toContain('热茶')
    expect(compact).toContain('Lucky')
  })
})

describe('Worker 委托 prompt 注入自我认知', () => {
  it('buildWorkerSystemPrompt 输出包含团队与 Lucky', () => {
    const p = buildWorkerSystemPrompt({
      to: 'recha',
      from: 'lumina',
      taskType: 'review',
      task: '审一下这段代码',
    })
    expect(p).toContain('热茶')
    expect(p).toContain('Yak')
    expect(p).toContain('Lucky')
    expect(p).toContain('自我认知')
  })
})

describe('优势与使用方法（用户问"有什么用/怎么用"时要说得出）', () => {
  it('常驻块包含优势框架（不只是功能清单）', () => {
    const s = buildSelfKnowledgeBlock('lumina')
    expect(s).toContain('优势')
    expect(s).toContain('有身体的团队 Agent')
  })

  it('常驻块包含"怎么用"的引导', () => {
    const s = buildSelfKnowledgeBlock('lumina')
    expect(s).toContain('怎么用')
    expect(s).toMatch(/大白话|直接说|提需求/)
  })

  it('compact 版也带优势与怎么用', () => {
    const s = buildSelfKnowledgeBlock('yak', { compact: true })
    expect(s).toContain('优势')
    expect(s).toContain('怎么用')
  })

  it('完整自省快照含"我的优势"与"怎么用"章节', () => {
    const s = buildFullSelfDescription()
    expect(s).toContain('我的优势')
    expect(s).toContain('怎么用')
    expect(s).toMatch(/桌宠绑定真实执行状态|看见.*干活/)
    expect(s).toMatch(/Ctrl\+Space|语音|设置 → LLM/)
  })
})

describe('对用户表达纪律（防止把内部资料照抄给用户）', () => {
  it('自我认知包含"对用户表达纪律"', () => {
    const s = buildSelfKnowledgeBlock('lumina')
    expect(s).toContain('对用户表达纪律')
    expect(s).toMatch(/大白话|别长篇大论/)
  })

  it('纪律要求：不暴露文件名/路径、不贴 markdown 符号', () => {
    const s = buildSelfKnowledgeBlock('lumina')
    expect(s).toMatch(/文件名|路径/)
    expect(s).toMatch(/markdown|加粗|星号/)
  })

  it('Lucky 说明里的内部路径必须被标注为"不要对用户提"', () => {
    const s = buildSelfKnowledgeBlock('lumina')
    const idx = s.indexOf('electron/luckyMode.ts')
    expect(idx, '内部路径应保留给模型理解').toBeGreaterThanOrEqual(0)
    const around = s.slice(Math.max(0, idx - 30), idx + 60)
    expect(around, '内部路径旁必须标注勿对用户提及').toMatch(/仅供|勿|不要对用户/)
  })
})

describe('动态事实（不再硬编码）', () => {
  it('版本为实时值，不是硬编码的 0.1.0-preview', () => {
    const s = buildSelfKnowledgeBlock('lumina')
    expect(s).not.toContain('0.1.0-preview')
    const facts = collectRuntimeFacts()
    if (facts.version) {expect(s).toContain(facts.version)}
  })

  it('平台来自 process.platform', () => {
    expect(collectRuntimeFacts().platform).toBeTruthy()
  })

  it('读不到的事实会省略，不编造（toolCount 要么是数字要么缺省）', () => {
    const f = collectRuntimeFacts()
    if (f.toolCount !== undefined) {expect(typeof f.toolCount).toBe('number')}
  })
})

describe('about_lumina 自省工具', () => {
  it('Def 名称与工具集正确', () => {
    expect(aboutLuminaDef.name).toBe('about_lumina')
    expect(aboutLuminaDef.toolsets).toContain('self')
  })

  it('返回完整自省快照（身份/团队/Lucky/边界）', async () => {
    const r = await aboutLumina({})
    expect(r.ok).toBe(true)
    expect(r.content).toContain('Lumina Life')
    expect(r.content).toContain('热茶')
    expect(r.content).toContain('Lucky')
    expect(r.content).toContain('已知边界')
  })

  it('buildFullSelfDescription 含版本与平台字段', () => {
    const s = buildFullSelfDescription()
    expect(s).toContain('版本')
    expect(s).toContain('平台')
  })
})
