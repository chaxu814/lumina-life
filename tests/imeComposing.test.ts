// ============================================================
// imeComposing.test.ts — 中文输入法回车误提交（系统性缺陷回归）
//
// 【为什么单独一个测试文件】
//   2026-10-10 排查「聊天断断续续」时发现：**全仓 onKeyDown 无一处**
//   判 `isComposing`。对中文用户这是必踩的坑 —— 拼音打字按回车本来只是
//   「确认候选词」，却被当成「发送」，于是：
//     · 半截内容被发出去；或
//     · 输入框已被清空 → 发出空消息
//       → 模型回「这一轮对话里我没有看到具体的问题或话题」（用户实测截图）
//
//   修法：抽出 `src/lib/ime.ts` 的 `isImeComposing()`，所有
//   「回车即提交」的输入框统一走它。本文件锁住行为 + 覆盖范围。
// ============================================================

import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { isImeComposing } from '../src/lib/ime'

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), ...rel.split('/')), 'utf-8')

describe('isImeComposing — 输入法组词判定', () => {
  it('nativeEvent.isComposing 为 true → 是组词（忽略回车）', () => {
    expect(isImeComposing({ nativeEvent: { isComposing: true }, keyCode: 13 })).toBe(true)
  })

  it('keyCode === 229 → 是组词（部分输入法/浏览器的等价信号）', () => {
    expect(isImeComposing({ nativeEvent: { isComposing: false }, keyCode: 229 })).toBe(true)
  })

  it('普通回车（isComposing=false, keyCode=13）→ 不是组词（应提交）', () => {
    expect(isImeComposing({ nativeEvent: { isComposing: false }, keyCode: 13 })).toBe(false)
  })

  it('没有 nativeEvent 时按 keyCode 判断，不抛错', () => {
    expect(isImeComposing({ keyCode: 13 })).toBe(false)
    expect(isImeComposing({ keyCode: 229 })).toBe(true)
    expect(isImeComposing({})).toBe(false)
  })

  it('null / undefined → 安全返回 false', () => {
    expect(isImeComposing(null)).toBe(false)
    expect(isImeComposing(undefined)).toBe(false)
  })
})

describe('IME 守卫覆盖范围 · 源码不变式', () => {
  // 所有「回车即提交」的用户文本输入点。新增同类输入框时请一并加进来。
  const ENTER_SUBMIT_FILES = [
    'src/panels/GroupChatView.tsx',      // 群聊发送 + 团队决策讨论（2 个输入框）
    'src/panels/ChatPanel.tsx',          // 普通聊天发送
    'src/components/AgentMoments.tsx',   // 朋友圈发帖
    'src/components/NoteCycle.tsx',      // 随手记
    'src/components/DecisionCard.tsx',   // 决策卡片自定义输入
    'src/components/TaskWorkspacePanel.tsx', // 任务追加
    'src/components/LuckyModeSettings.tsx',  // 幸运模式子任务
    'src/panels/DeepResearchPanel.tsx',  // 深度研究问题
  ]

  for (const f of ENTER_SUBMIT_FILES) {
    it(`${f} 的 Enter 提交判了 isComposing`, () => {
      const src = read(f)
      expect(src, `${f} 未引入 isImeComposing`).toMatch(/isImeComposing/)
    })
  }

  it('每个「e.key === \'Enter\'」提交点前面都有 isImeComposing 守卫', () => {
    // 非文本元素上的 Enter（折叠开关等）没有「输入法组词」概念，无需守卫。
    // 用「代码特征」而非行号做白名单，代码一改行号也不会失效。
    const NON_TEXT_ENTER_ALLOWLIST = [
      /setCollapsed\(c => !c\)/,   // DecisionCard 的折叠头（<div tabIndex={0}>，非输入框）
    ]
    for (const f of ENTER_SUBMIT_FILES) {
      const src = read(f)
      const lines = src.split('\n')
      lines.forEach((line, i) => {
        if (!/key === 'Enter'/.test(line)) {return}
        if (NON_TEXT_ENTER_ALLOWLIST.some(re => re.test(line))) {return}
        // 往上找 6 行内必须出现守卫
        const window = lines.slice(Math.max(0, i - 6), i + 1).join('\n')
        expect(window, `${f}:${i + 1} 的 Enter 处理缺少 isImeComposing 守卫`).toMatch(/isImeComposing/)
      })
    }
  })

  it('两个聊天输入框都有「同步发送锁」（setSending 异步挡不住同 tick 二次回车）', () => {
    expect(read('src/panels/GroupChatView.tsx')).toMatch(/sendLockRef/)
    expect(read('src/panels/ChatPanel.tsx')).toMatch(/chatSendLockRef/)
  })
})
