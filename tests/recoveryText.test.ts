// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// recoveryText.test.ts — 「恢复流程不能把内部诊断当回答」
//
// 【锁定的真实故障】
//   用户问「A股今天的情况是什么」，聊久之后突然收到：
//   「（我本来想调用一个工具，但这轮没有可用的工具，所以没能执行。
//      你可以换个说法，或到设置里检查工具是否被关闭。）」
//
// 【根因链】
//   ReAct 循环耗尽且聚合不到文本
//     → 第 2 级「总结轮」故意 callLLM([]) 不带工具（提示词也写了"不要调用工具"）
//     → 小模型（实测 4B 档 QwenPaw Flash 4B Q4）无视指令，仍输出 XML 工具调用
//     → callLLM 的 tools.length===0 分支把它替换成诊断文案并返回
//     → 旧实现直接采用 → 上屏 ❌
//
//   为什么"聊久了"才出现：总结轮只在长对话/循环耗尽时才会走到。
//
// 【为什么单测这个纯函数】
//   这类故障不报错、不崩溃，只在特定上下文长度 + 特定模型上偶发 ——
//   只能靠把判断抽出来直接跑，否则永远发现不了。
// ============================================================

import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { pickRecoverySummaryText } from '../electron/agent/recoveryText'

describe('pickRecoverySummaryText — 只采用"真正的回复"', () => {
  it('诊断文案（noToolsHint）一律丢弃 → 空串', () => {
    expect(pickRecoverySummaryText({
      text: '（我本来想调用一个工具，但这轮没有可用的工具，所以没能执行。）',
      noToolsHint: true,
    })).toBe('')
  })

  it('noToolsHint 优先于 text —— 即使文本看着像正常回答也丢弃', () => {
    // 防"以后有人把判断顺序写反"
    expect(pickRecoverySummaryText({ text: '看起来像正常回答', noToolsHint: true })).toBe('')
  })

  it('正常总结文本 → 采用（trim 后）', () => {
    expect(pickRecoverySummaryText({ text: '  A股今天小幅上涨。  ' })).toBe('A股今天小幅上涨。')
  })

  it('空 / 缺字段 / null → 空串（继续走下一级兜底）', () => {
    expect(pickRecoverySummaryText({})).toBe('')
    expect(pickRecoverySummaryText(null)).toBe('')
    expect(pickRecoverySummaryText(undefined)).toBe('')
    expect(pickRecoverySummaryText({ text: '   ' })).toBe('')
  })
})

describe('接线：诊断文案不会被当成回复上屏', () => {
  const runner = fs.readFileSync(
    path.join(process.cwd(), 'electron', 'agentRunner.ts'),
    'utf-8',
  )

  it('callLLM 在「无工具 + 模型仍输出工具调用」时给返回值打标记', () => {
    expect(runner).toMatch(
      /return \{ text: hint, usage: streamUsage, earlyResults: earlyResultsObj, noToolsHint: true \}/,
    )
  })

  it('总结恢复路径经 pickRecoverySummaryText 取舍，而不是直接用 resp.text', () => {
    expect(runner).toMatch(/const resp = await this\.callLLM\(\[\], \{ timeoutOverride: 300 \}\)/)
    expect(runner).toMatch(/const raw = pickRecoverySummaryText\(resp\)/)
    // 防回退：不能退回"直接采用 resp.text"
    expect(runner).not.toMatch(/const raw = \(resp\.text \|\| ''\)\.trim\(\)/)
  })

  it('循环内也丢弃诊断文案（「全路径恢复」同样走 runReActLoop([])）', () => {
    // 同一个坑的第二个入口：不带工具的 ReAct 循环
    expect(runner).toMatch(/const noToolDiag = response\.noToolsHint === true/)
    expect(runner).toMatch(/finalText = noToolDiag \? '' : cleanToolNoiseText/)
  })
})
