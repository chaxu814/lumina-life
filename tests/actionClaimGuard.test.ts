// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
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
import fs from 'fs'
import path from 'path'
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

// ═══════════════════════════════════════════════════════
// 2026-10-04：从「本轮有任何工具就不判」升级为「按动作逐个核对」
//
// 旧逻辑只要本轮调过**任意一个**工具就整个关掉检查，于是漏掉：
//   模型先调 datetime，再说「已经帮你记住了」→ memory_save 一次没碰 → 不报
// 下面这些用例锁住新行为。
// ═══════════════════════════════════════════════════════

describe('按动作核对：调了别的工具冒充完成（新增能力）', () => {
  it('调了无关工具后声称「已记住」→ 抓（memory_save 没被碰过）', () => {
    const r = checkActionClaims({
      text: '✅ 记住了！煤球是只橘猫。',
      toolsUsedThisTurn: ['datetime'],
    })
    expect(r.suspected, '调了 datetime 不代表记忆存了，应该抓到').toBe(true)
    expect(r.labels).toContain('保存记忆')
  })

  it('文案要说清是「调了别的工具」，而不是笼统说没调工具', () => {
    const r = checkActionClaims({
      text: '已经帮你保存好了。',
      toolsUsedThisTurn: ['datetime'],
    })
    expect(r.notice).toContain('datetime')
    expect(r.notice).not.toContain('没有实际调用任何工具')
  })

  it('真的调了该动作的工具 → 不判（不能因为有工具就放过，也不能因为有声明就误报）', () => {
    const r = checkActionClaims({
      text: '✅ 记住了！煤球是只橘猫。',
      toolsUsedThisTurn: ['datetime', 'memory_save'],
    })
    expect(r.suspected).toBe(false)
    expect(r.notice).toBe('')
  })

  it('混合场景：只兑现了其中一个动作 → 只报未兑现的那个', () => {
    // 调了 web_search（搜索达成），但没有 file_write（写文件没达成）
    const r = checkActionClaims({
      text: '已经搜索完资料，并已保存到 report.md。',
      toolsUsedThisTurn: ['web_search'],
    })
    expect(r.suspected).toBe(true)
    expect(r.labels).toContain('写文件')
    expect(r.labels).not.toContain('搜索')
  })

  it('调了与声明无关的工具时，诚实回答仍然不判（防过度打扰）', () => {
    for (const t of [
      '我没办法保存记忆，这个功能没开。',
      '搞定！还有什么想问的吗？',
      '斐波那契数列的定义是…',
    ]) {
      expect(checkActionClaims({ text: t, toolsUsedThisTurn: ['datetime'] }).suspected,
        `误报了: "${t}"`).toBe(false)
    }
  })
})

describe('接线：agentRunner 必须传真实工具名', () => {
  it('调用点传的是 lastToolNames，不是硬编码的空数组', () => {
    // 【为什么去注释后再断言 —— 这是本文件第三次踩这个坑了】
    // 修复说明里必然会引用旧的错误写法（如「此前固定传 toolsUsedThisTurn: []」），
    // 那是**引述历史**而不是**当下代码**。不去注释就会把修复说明判成违规。
    // 前两次分别栽在 SwimlaneCanvas 的 eslint 指令和 channelKeyRoundTrip 上。
    const raw = fs.readFileSync(path.join(__dirname, '..', 'electron/agentRunner.ts'), 'utf8')
    const src = raw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split(/\r?\n/)
      .map(line => (/^\s*\/\//.test(line) ? '' : line))
      .join('\n')
    expect(src).toMatch(/checkActionClaims\(\{\s*text:\s*finalText,\s*toolsUsedThisTurn:\s*lastToolNames\s*\}\)/)
    // 旧写法：固定传 [] 且被 zero-length 总闸包住
    expect(src, '仍在固定传空数组').not.toMatch(/toolsUsedThisTurn:\s*\[\s*\]/)
    expect(src, '零工具总闸还在，新能力不会生效')
      .not.toMatch(/claimGuardChecked\s*&&\s*finalText\s*&&\s*lastToolNames\.length\s*===\s*0/)
  })
})
