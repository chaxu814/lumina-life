// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// complexityAnalyzer.test.ts — 复杂度分析器回归测试
//
// v2 修复背景：旧版把 `整体|全面|大规模|重构|重新` 写成一条正则，
// 「重构整个项目的架构，全面优化」只计 25 分，低于阈值 50 → 误判为 simple。
// 而重构类任务恰恰最需要 plan→execute→review→verify 全流程。
//
// 本测试把「重构类必判 complex」固定为回归契约，防止以后改权重表时又漏掉。
import { describe, it, expect } from 'vitest'
import { assessComplexity, type ComplexityLevel } from '../electron/orchestration/complexityAnalyzer'

/** 简化任务：应保持 simple（防止修过头变成「什么都判 complex」） */
const SIMPLE_CASES = [
  '帮我把这个变量改名',
  '修复登录页面报错',
  '写个爬虫抓取豆瓣电影列表',
  '加一行日志',
  '格式化这个文件',
  '删除这行注释',
  '重命名这个方法',
  '查一下配置在哪',
  '把文案改得更简洁一点',
  '给我看看这个函数干了啥',
]

/** 复杂任务：应判 complex */
const COMPLEX_CASES = [
  '从零搭建一个完整的电商系统，包括用户、订单、支付、数据库设计',
  '重构整个项目的架构，全面优化',            // ← v2 修复目标
  '调研一下市面上的向量数据库，做个技术选型对比',
  '实现一个多模态 AI 应用模块，涉及数据库和鉴权，要能部署上线',
  '把整个前端架构重构一遍',
  '把这个模块重新设计一下',
  '数据库迁移到新版本，并做兼容处理',
  '在生产环境部署这个服务',
  '实现支付模块和鉴权系统',
  '帮我做个架构设计和技术选型',
]

describe('assessComplexity — 简化任务不误升级', () => {
  for (const t of SIMPLE_CASES) {
    it(`simple: ${t}`, () => {
      const r = assessComplexity(t)
      expect(r.level).toBe('simple')
      expect(r.suggestPhasedExecution).toBe(false)
    })
  }
})

describe('assessComplexity — 复杂任务不漏判', () => {
  for (const t of COMPLEX_CASES) {
    it(`complex: ${t}`, () => {
      const r = assessComplexity(t)
      expect(r.level).toBe('complex')
      expect(r.suggestPhasedExecution).toBe(true)
    })
  }
})

describe('assessComplexity — v2 专项回归', () => {
  it('「重构整个项目的架构，全面优化」必须判 complex（曾经的 bug）', () => {
    const r = assessComplexity('重构整个项目的架构，全面优化')
    expect(r.level).toBe('complex')
    expect(r.score).toBeGreaterThanOrEqual(50)
    // 必须能解释出「重构」这个信号，否则门控提示对用户毫无意义
    expect(r.triggers.some(t => t.includes('重构'))).toBe(true)
  })

  it('高危操作即使描述简短也强制升级（重构 + 简单信号）', () => {
    // 「改一下这个变量」是 simple 信号，但「重构」+「架构」应压过它
    const r = assessComplexity('重构这个模块的架构，顺便改一下这个变量')
    expect(r.level).toBe('complex')
  })

  it('生产环境操作强制升级', () => {
    const r = assessComplexity('在生产环境发布这个服务')
    expect(r.level).toBe('complex')
  })

  it('多信号会触发叠加加成并记录说明', () => {
    const r = assessComplexity('从零搭建电商系统，需要数据库、支付、鉴权，并部署上线')
    expect(r.level).toBe('complex')
    expect(r.triggers.some(t => t.includes('独立复杂度信号'))).toBe(true)
  })

  it('分数始终归一化在 0-100', () => {
    const extreme = '重构架构重构架构重构架构' + '生产环境支付鉴权数据库迁移'.repeat(5)
    const r = assessComplexity(extreme)
    expect(r.score).toBeLessThanOrEqual(100)
    expect(r.score).toBeGreaterThanOrEqual(0)
  })

  it('空字符串 / 极短输入不崩', () => {
    expect(() => assessComplexity('')).not.toThrow()
    expect(() => assessComplexity('嗯')).not.toThrow()
    const r = assessComplexity('')
    expect(r.level).toBe('simple')
  })

  it('fileCount 与 taskType 仍参与计分（向后兼容）', () => {
    const base = assessComplexity('处理这个模块')
    const withFiles = assessComplexity('处理这个模块', { fileCount: 8 })
    expect(withFiles.score).toBeGreaterThan(base.score)
  })
})

describe('assessComplexity — suggestedPhases 合理性', () => {
  it('高风险复杂任务应包含 review 阶段', () => {
    const r = assessComplexity('实现支付系统，要能部署到生产环境')
    expect(r.level).toBe('complex')
    expect(r.suggestedPhases).toBeDefined()
    expect(r.suggestedPhases!.length).toBeGreaterThan(0)
  })

  it('simple 任务不产出阶段建议', () => {
    const r = assessComplexity('帮我把这个变量改名')
    expect(r.suggestedPhases).toBeUndefined()
  })
})
