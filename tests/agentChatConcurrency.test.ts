// ============================================================
// agentChatConcurrency.test.ts — 「聊天断断续续」并发根因回归
//
// 【用户实测】
//   「有时候聊天断断续续的。」截图里 Lumina 回：
//   「这一轮对话里我没有看到具体的问题或话题」——说明这一轮的消息丢了/为空。
//
// 【根因（两处簿记缺陷 + 一处前端缺口）】
//   1. `agent:chat` 共用模块级 `activeAgentRunning`，但**被打断的旧请求**
//      在 finally 里**无条件**把它清掉 → 后来者的标记被清 → 再下一个请求
//      以为「没人在跑」→ 不再打断 → 多路并发、事件串台、回复断续。
//   2. 后台刷新（`GroupChatView.refreshLLMPanels` 一次 Promise.all 并发 6 路）
//      与用户对话走同一条通道，会**打断用户正在生成的回复**。
//   3. 前端 `onKeyDown` 不判 `isComposing`：中文输入法选词按回车被当成「发送」，
//      可能把半截内容（甚至空）发出去。
//
// 本文件锁住：
//   · 三个并发决策纯函数的真值表（行为）
//   · handler 确实用了它们、且后台不占 activeAgent / 不 markUserActive（源码不变式）
//   · 前端确实标了 background、确实判了 isComposing（源码不变式）
// ============================================================

import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  shouldReleaseRunningFlag,
  shouldSkipBackgroundRun,
  shouldAbortInFlight,
} from '../electron/ipc/agentIpc'

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), ...rel.split('/')), 'utf-8')

describe('并发决策纯函数 · 真值表', () => {
  describe('shouldReleaseRunningFlag — 谁有权释放 running 标记', () => {
    it('前台 + 自己是最新 → 释放（正常收尾）', () => {
      expect(shouldReleaseRunningFlag(false, 5, 5)).toBe(true)
    })

    it('前台 + 自己已被后来者取代 → 不释放（核心修复：别清后来者的标记）', () => {
      // 旧实现无条件清 → 后来者标记被清 → 后续请求不再打断 → 并发串台
      expect(shouldReleaseRunningFlag(false, 4, 5)).toBe(false)
    })

    it('后台 → 永不释放（后台压根没占这个标记）', () => {
      expect(shouldReleaseRunningFlag(true, 5, 5)).toBe(false)
      expect(shouldReleaseRunningFlag(true, 4, 5)).toBe(false)
    })
  })

  describe('shouldSkipBackgroundRun — 后台是否让路', () => {
    it('后台 + 前台在跑 → 跳过（不抢算力、不打断用户）', () => {
      expect(shouldSkipBackgroundRun(true, true)).toBe(true)
    })

    it('后台 + 前台没跑 → 放行', () => {
      expect(shouldSkipBackgroundRun(true, false)).toBe(false)
    })

    it('前台 → 从不因「有人在跑」而跳过（走打断逻辑）', () => {
      expect(shouldSkipBackgroundRun(false, true)).toBe(false)
      expect(shouldSkipBackgroundRun(false, false)).toBe(false)
    })
  })

  describe('shouldAbortInFlight — 新请求是否打断在途 Agent', () => {
    it('前台 + 有在途 → 打断（用户连发两条，后者打断前者）', () => {
      expect(shouldAbortInFlight(false, true, true)).toBe(true)
    })

    it('后台 + 有在途 → 不打断（核心修复：后台无权掐断用户）', () => {
      expect(shouldAbortInFlight(true, true, true)).toBe(false)
    })

    it('前台但没有在途 → 不打断（无对象可打断）', () => {
      expect(shouldAbortInFlight(false, true, false)).toBe(false)
    })

    it('没有 activeAgent → 不打断', () => {
      expect(shouldAbortInFlight(false, false, true)).toBe(false)
    })
  })
})

describe('agentIpc.ts 源码不变式', () => {
  const src = read('electron/ipc/agentIpc.ts')

  it('存在请求序号 activeAgentRunToken（用于「只有最新请求能清标记」）', () => {
    expect(src).toMatch(/let activeAgentRunToken = 0/)
    expect(src).toMatch(/const runToken = \+\+activeAgentRunToken/)
  })

  it('running 标记的释放走 shouldReleaseRunningFlag（而非无条件清）', () => {
    // 三条释放路径（端点不可达 / sendMessage finally / 外层 finally）都用它
    const calls = (src.match(/shouldReleaseRunningFlag\(isBackground, runToken, activeAgentRunToken\)/g) || []).length
    expect(calls, '三处释放点都应经 shouldReleaseRunningFlag').toBe(3)
    // 不得再有「无条件清标记」的写法
    expect(src).not.toMatch(/^\s*activeAgentRunning = false\s*\/\/\s*🆕 v5\.4/m)
  })

  it('后台请求不占用 activeAgent 引用（否则用户点「中断」会打到后台）', () => {
    expect(src).toMatch(/if \(!isBackground\) \{activeAgent = runner\}/)
  })

  it('只有前台请求 markUserActive（后台不该刷新「用户活跃」时间戳）', () => {
    expect(src).toMatch(/if \(!isBackground\) \{\s*(?:\/\/[^\n]*\n\s*)*llmCoordinator\.markUserActive\(\)/)
  })

  it('后台在前台在跑时直接跳过', () => {
    expect(src).toMatch(/shouldSkipBackgroundRun\(isBackground, activeAgentRunning\)/)
    expect(src).toMatch(/BACKGROUND_SKIPPED_FOREGROUND_RUNNING/)
  })

  it('打断判定走 shouldAbortInFlight', () => {
    expect(src).toMatch(/shouldAbortInFlight\(isBackground, !!activeAgent, activeAgentRunning\)/)
  })

  it('后台任务不触发系统通知（否则窗口在后台时会刷「等 6 条新回复」）', () => {
    expect(src).toMatch(/if \(!isBackground\) \{\s*notifyAgentReply\(/)
  })

  it('后台任务不发 XP（否则自主刷新会刷虚等级）', () => {
    expect(src).toMatch(/if \(!isBackground\) \{\s*try \{\s*const xpResult = xpManager\.addXp/)
  })
})

describe('前端源码不变式', () => {
  it('GroupChatView 的自主刷新标记 background:true（6 路并发不再互相/对用户打断）', () => {
    const src = read('src/panels/GroupChatView.tsx')
    expect(src).toMatch(/refreshLLMPanels/)
    // baseConfig 里必须带 background: true
    const base = src.slice(src.indexOf('const baseConfig = {'), src.indexOf('// 并行请求三个Agent的任务'))
    expect(base).toMatch(/background:\s*true/)
    // 该 baseConfig 被两处 agentChat 使用（任务 + 朋友圈），共 6 路
    const spawns = (src.match(/window\.luminaAPI\.agentChat\(\{/g) || []).length
    expect(spawns).toBeGreaterThanOrEqual(2)
  })

  it('两个输入框的 Enter 都判了 isComposing（中文输入法选词不误发）', () => {
    for (const f of ['src/panels/GroupChatView.tsx', 'src/panels/ChatPanel.tsx']) {
      const src = read(f)
      expect(src, `${f} 缺少 isComposing 守卫`).toMatch(/isComposing/)
    }
  })

  it('群聊发送有同步锁（setSending 异步，挡不住同 tick 二次 Enter）', () => {
    const src = read('src/panels/GroupChatView.tsx')
    expect(src).toMatch(/sendLockRef/)
    expect(src).toMatch(/if \(sendLockRef\.current\) \{return\}/)
  })

  it('普通聊天发送有同步锁', () => {
    const src = read('src/panels/ChatPanel.tsx')
    expect(src).toMatch(/chatSendLockRef/)
    expect(src).toMatch(/if \(chatSendLockRef\.current\) \{return\}/)
  })

  it('自驱 Loop 执行器标记 background（不该打断用户对话）', () => {
    const src = read('src/services/loopExecutor.ts')
    expect(src).toMatch(/background:\s*true/)
    // 被让路时要如实说明原因，而不是误报「模型返回空」
    expect(src).toMatch(/BACKGROUND_SKIPPED_FOREGROUND_RUNNING/)
  })
})
