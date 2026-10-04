// =============================================================
// tests/vagueTaskGuard.test.ts — 模糊任务守卫
//
// 核心要锁住的不变式：**宁可多问一次，不要瞎干一次**。
// 每一条用例都对应一种「模型容易猜错而用户已经付出代价」的真实场景。
// =============================================================

import { describe, it, expect } from 'vitest'
import {
  assessVagueness,
  hasSpecificTarget,
  detectDimension,
  renderClarificationRule,
} from '../electron/orchestration/vagueTaskGuard'

describe('hasSpecificTarget · 强信号识别', () => {
  it('识别 Windows 绝对路径', () => {
    expect(hasSpecificTarget('优化一下 K:\\2\\Lumina AI\\electron\\agentRunner.ts')).toBe(true)
  })

  it('识别带扩展名的文件名', () => {
    expect(hasSpecificTarget('重构 src/panels/ChatPanel.tsx')).toBe(true)
  })

  it('识别具名函数', () => {
    expect(hasSpecificTarget('优化一下 getToolsForMode 这个函数')).toBe(true)
  })

  it('识别报错类型', () => {
    expect(hasSpecificTarget('修一下 TypeError: undefined is not a function')).toBe(true)
  })

  it('识别行号', () => {
    expect(hasSpecificTarget('看看 3280 行附近')).toBe(true)
  })

  it('纯指代词不算具体目标（守卫拿不到历史，宁可多问）', () => {
    // 关键不变式：对话历史里也许有，但守卫是纯函数看不到，
    // 所以「这段代码」不能被当成明确目标 —— 否则重演瞎干的老问题
    expect(hasSpecificTarget('优化一下这段代码')).toBe(false)
  })

  it('空串不算', () => {
    expect(hasSpecificTarget('')).toBe(false)
  })
})

describe('detectDimension · 优化维度识别', () => {
  const cases: Array<[string, string]> = [
    ['性能太慢了，优化下', '性能'],
    ['这段有安全风险', '安全'],
    ['代码太乱不好维护', '可维护性'],
    ['补一下测试', '测试'],
    ['界面太丑了', '界面'],
    ['重构一下架构', '架构'],
  ]
  it.each(cases)('「%s」→ %s', (input, expect_) => {
    expect(detectDimension(input)).toBe(expect_)
  })

  it('无维度返回 null', () => {
    expect(detectDimension('随便搞搞')).toBe(null)
  })
})

describe('assessVagueness · 核心场景', () => {
  it('「优化一下这个项目」→ 必须澄清（这是发布评测点名的场景）', () => {
    const v = assessVagueness('优化一下这个项目')
    expect(v.level).toBe('vague')
    expect(v.needsClarification).toBe(true)
    expect(v.options.length).toBeGreaterThan(0)
    expect(v.question).not.toBe('')
  })

  it('「帮我优化下代码」→ 必须澄清', () => {
    expect(assessVagueness('帮我优化下代码').needsClarification).toBe(true)
  })

  it('「优化一下这段代码的性能」→ underdefined（知道维度但没有目标）', () => {
    const v = assessVagueness('优化一下这段代码的性能')
    expect(v.level).toBe('underdefined')
    expect(v.needsClarification).toBe(true)
    expect(v.missing).toContain('target')
  })

  it('「优化 K:\\2\\a\\b.ts 的性能」→ specific，不再追问', () => {
    const v = assessVagueness('优化 K:\\2\\a\\b.ts 的性能')
    expect(v.level).toBe('specific')
    expect(v.needsClarification).toBe(false)
    expect(v.options).toEqual([])
  })

  it('「把这个函数的空指针修了」→ 无上文时仍要问（有上文则不问）', () => {
    // 「这个函数」是指代。守卫是纯函数看不到历史，所以默认按未解析处理。
    // 【为什么不直接判 specific】赌对了省一轮，赌错了用户白等一个无用产出。
    expect(assessVagueness('把这个函数的空指针修了').needsClarification).toBe(true)
    // 调用方明确告知上文已有锚点时就不该再问 —— 否则追问会退化成骚扰
    expect(assessVagueness('把这个函数的空指针修了', { deicticsResolvable: true })
      .needsClarification).toBe(false)
  })

  it('「写个爬虫」→ 不追问（短但明确的祈使句）', () => {
    // 第一版把「< 8 字」直接判模糊，把这种明确命令也追问了。
    // 短只说明信息少，不等于目标不清。
    expect(assessVagueness('写个爬虫').needsClarification).toBe(false)
  })

  it('「审一下这段代码」→ 同样取决于上文是否有锚点', () => {
    // 「审」本身没有歧义（不需要问「审哪个维度」），
    // 但「这段代码」在无上文时指代空气 —— 与「把这个函数改了」是同一个问题。
    expect(assessVagueness('审一下这段代码').needsClarification).toBe(true)
    expect(assessVagueness('审一下这段代码', { deicticsResolvable: true })
      .needsClarification).toBe(false)
  })

  it('纯聊天场景（assumeCoding=false）永不追问', () => {
    // 最重要的一条：对陪伴类对话追问「你想优化什么」是灾难性体验
    expect(assessVagueness('今天有点累', { assumeCoding: false }).needsClarification).toBe(false)
    expect(assessVagueness('优化一下', { assumeCoding: false }).needsClarification).toBe(false)
  })

  it('空输入按模糊处理（防御性）', () => {
    const v = assessVagueness('')
    expect(v.needsClarification).toBe(true)
    expect(Array.isArray(v.options)).toBe(true)
  })
})

describe('assessVagueness · 不变式', () => {
  const inputs = [
    '优化一下这个项目', '改进代码', '完善一下', '提升性能', '搞一搞',
    '重构一下', '整理一下', '看看', '', 'x', '优化 K:\\a\\b.ts',
    '把这个函数重构了', '重构整个架构到微服务', '帮我写个脚本',
  ]

  it('needsClarification=true 时，question 与 options 一定非空', () => {
    for (const input of inputs) {
      const v = assessVagueness(input)
      if (v.needsClarification) {
        expect(v.question, `「${input}」要追问却没给问题`).not.toBe('')
        expect(v.options.length, `「${input}」要追问却没给选项`).toBeGreaterThan(0)
      }
    }
  })

  it('level=specific 时 options 必为空数组（不制造多余决策点）', () => {
    for (const input of inputs) {
      const v = assessVagueness(input)
      if (v.level === 'specific') {
        expect(v.options, `「${input}」已明确却还给了选项`).toEqual([])
      }
    }
  })

  it('assumeCoding=false 时永远 specific', () => {
    for (const input of inputs) {
      expect(assessVagueness(input, { assumeCoding: false }).level).toBe('specific')
    }
  })

  it('纯函数：同样输入永远同样输出（可缓存、可测试）', () => {
    for (const input of inputs) {
      expect(assessVagueness(input)).toEqual(assessVagueness(input))
    }
  })
})

describe('renderClarificationRule · 注入 prompt 的内容', () => {
  it('specific 时不产出任何规则（不污染正常请求的 prompt）', () => {
    expect(renderClarificationRule(assessVagueness('写个爬虫'))).toBe('')
  })

  it('vague 时规则里必须包含「不要调用工具」的硬约束', () => {
    const r = renderClarificationRule(assessVagueness('优化一下这个项目'))
    // 去掉 Markdown 强调再断言：规则文本里的 **不要** 会被加粗标记拆开，
    // 直接用字面量断言会漏判 —— 那是断言写得脆，不是规则写得错。
    const plain = r.replace(/\*\*/g, '')
    expect(plain).toContain('不要')
    expect(plain).toMatch(/写文件|执行命令/)
    // 必须明确禁止「猜一个解释然后开干」——这是弱模型最常见的失败
    expect(plain).toMatch(/不要猜/)
  })

  it('规则里带上问句与选项（模型只负责转述，不负责自己想问什么）', () => {
    const v = assessVagueness('优化一下这个项目')
    const r = renderClarificationRule(v)
    expect(r).toContain(v.question)
    for (const o of v.options) {expect(r).toContain(o)}
  })

  it('要求「用户回答后立即开始」——防止追问变成反复确认', () => {
    const r = renderClarificationRule(assessVagueness('优化一下'))
    expect(r).toMatch(/立即开始|不要再确认/)
  })
})
