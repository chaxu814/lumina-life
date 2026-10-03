// ============================================================
// actionClaimGuard.test.ts — 「声称做了但没做」的检测（v3.34 新增）
//
// 场景来自真实质量基准：让模型 memory_save 记住「煤球是只橘猫」，
// 它回复「✅ 记住了！」，而应用日志里根本没有 memory_save 调用。
//
// 这类幻觉此前三层防幻觉都管不到（它们都假设「工具确实被调过」），
// 所以必须单独测，而且**误报和漏报都要测** —— 一个只会误报的护栏比没有更糟。
// ============================================================

import { describe, it, expect } from 'vitest'
import { checkActionClaims, actionClaimNotice } from '../electron/actionClaimGuard'

const noTools: string[] = []

describe('真场景：声称记下了但没调工具', () => {
  it('1.4B 的原话会被抓到', () => {
    const text = '✅ 记住了！煤煤复是只橘猫。以后聊天提到它我都知道啦～ 🐱'
    const r = checkActionClaims({ text, toolsUsedThisTurn: noTools })
    expect(r.suspected).toBe(true)
    expect(r.labels).toContain('保存记忆')
    expect(r.notice).toContain('没有实际调用任何工具')
  })
})

describe('不能误报的情况（这些是诚实回答）', () => {
  it('本轮调用过工具 → 不判（哪怕措辞像完成态）', () => {
    const r = checkActionClaims({
      text: '已经帮你保存好了。',
      toolsUsedThisTurn: ['memory_save'],
    })
    expect(r.suspected).toBe(false)
    expect(r.notice).toBe('')
  })

  it('诚实说「我记不住」→ 不判', () => {
    for (const t of [
      '我没办法保存记忆，这个功能没开。',
      '我记不住你上次说的了，能再讲一遍吗？',
      '我没有帮你保存，这需要你手动操作。',
      '这个我暂时无法记录，换个方式吧。',
    ]) {
      expect(checkActionClaims({ text: t, toolsUsedThisTurn: noTools }).suspected,
        `误报了: "${t}"`).toBe(false)
    }
  })

  it('只是在回答问题、没有任何动作声明 → 不判', () => {
    for (const t of [
      '斐波那契数列的定义是…',
      '这段代码会有 ZeroDivisionError。',
      '你是想问什么？',
      '我建议用 git worktree 隔离。',
    ]) {
      expect(checkActionClaims({ text: t, toolsUsedThisTurn: noTools }).suspected,
        `误报了: "${t}"`).toBe(false)
    }
  })

  it('有空回复 → 不判', () => {
    expect(checkActionClaims({ text: '', toolsUsedThisTurn: noTools }).suspected).toBe(false)
    expect(checkActionClaims({ text: '   ', toolsUsedThisTurn: noTools }).suspected).toBe(false)
  })

  it('有完成态措辞但对应不上任何具体动作 → 不判（避免过度打扰）', () => {
    // 「搞定」很常见，但常常指「我回答完了」而不是「我执行了某个动作」
    const r = checkActionClaims({ text: '搞定！还有什么想问的吗？', toolsUsedThisTurn: noTools })
    expect(r.suspected).toBe(false)
  })
})

describe('应该抓到的其他动作类型', () => {
  const cases: Array<[string, string, string[]]> = [
    ['发送', '已经帮你发送到邮箱了。', ['mail_send']],
    ['定时', '已设置 30 分钟后的提醒。', ['cron_schedule']],
    ['删除', '已删除该文件。', ['file_write']],
    ['搜索', '已经搜索完了，结果如下…', ['web_search']],
    ['写文件', '已保存到 report.md。', ['file_write']],
  ]

  for (const [label, text, tools] of cases) {
    it(`${label}：零工具调用时会被抓，调过则不抓`, () => {
      const missed = checkActionClaims({ text, toolsUsedThisTurn: noTools })
      expect(missed.suspected, `漏检了: "${text}"`).toBe(true)

      const didIt = checkActionClaims({ text, toolsUsedThisTurn: tools })
      expect(didIt.suspected, `误报: "${text}"`).toBe(false)
    })
  }
})

describe('提示文案', () => {
  it('说清是「提醒」而不是「错误」（启发式可能误报）', () => {
    const n = actionClaimNotice('已经帮你保存好了。', noTools)
    expect(n).toContain('提醒')
    expect(n).not.toMatch(/^错误/)
  })

  it('给用户一个可追问的出口', () => {
    const n = actionClaimNotice('已经帮你保存好了。', noTools)
    expect(n).toMatch(/重试|再问|到底/)
  })
})
