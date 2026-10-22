// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// tests/groupChatRouting.test.ts
//
// 【要防的真实故障】2026-10-07 用户反馈：「我叫他们写代码的时候怎么可能说不会呢」
//
// 根因：GroupChatView 的 `routeToAgent` 把两个角色**接反了** ——
//     case 'coding':   return 热茶   // 编码派给「只读审查员」（她没有写权限！）
//     case 'analysis': return Yak    // 分析派给「代码工程师」
//   于是用户不 @ 人、直接发编码需求时，请求被派给热茶，
//   热茶按权限只能回「我不会写代码」—— 用户得到的是死胡同。
//
// 项目里 delegate_to 的注释早就写过这个坑（「历史版本这里是反的，会把编码
// 任务派给没有写权限的一方，等于任务注定失败」），主委托路径修了，
// **群聊这条路由漏了**。本测试把正确的映射钉死。
//
// 另外锁住「能力守卫」：@ 了只读成员却要它写代码时，应改派给有写权限的成员。
// ============================================================

import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

const root = path.resolve(__dirname, '..')
const gcSrc = fs.readFileSync(path.join(root, 'src', 'panels', 'GroupChatView.tsx'), 'utf-8')

describe('群聊 routeToAgent — 角色映射不能反', () => {
  it('coding 必须派给 Yak（代码工程师），不能派给热茶', () => {
    // 取 routeToAgent 函数体
    const start = gcSrc.indexOf('const routeToAgent')
    expect(start, '找不到 routeToAgent').toBeGreaterThan(-1)
    const body = gcSrc.slice(start, start + 900)

    const codingLine = body.match(/case 'coding':\s*return[^\n]*/)
    expect(codingLine, '找不到 coding 分支').toBeTruthy()
    expect(codingLine![0], 'coding 必须派给 yak —— 派给热茶会导致「我不会写代码」').toContain("'yak'")
    expect(codingLine![0], 'coding 不能派给 recha').not.toContain("'recha'")
  })

  it('analysis 必须派给热茶（审查员），不能派给 Yak', () => {
    const start = gcSrc.indexOf('const routeToAgent')
    const body = gcSrc.slice(start, start + 900)

    const analysisLine = body.match(/case 'analysis':\s*return[^\n]*/)
    expect(analysisLine, '找不到 analysis 分支').toBeTruthy()
    expect(analysisLine![0], 'analysis 必须派给 recha').toContain("'recha'")
    expect(analysisLine![0], 'analysis 不能派给 yak').not.toContain("'yak'")
  })
})

describe('能力守卫 — @ 只读成员要它写代码时应改派', () => {
  it('存在 upgradeReadOnlyTarget 且只对 recha 生效', () => {
    expect(gcSrc).toContain('upgradeReadOnlyTarget')
    const start = gcSrc.indexOf('const upgradeReadOnlyTarget')
    expect(start).toBeGreaterThan(-1)
    const body = gcSrc.slice(start, start + 1200)
    // 只针对只读成员 recha
    expect(body).toContain("targetId !== 'recha'")
    // 改派目标是 yak
    expect(body).toContain("'yak'")
  })

  it('明确的审查意图不被改派（尊重用户的 @ 选择）', () => {
    const start = gcSrc.indexOf('const upgradeReadOnlyTarget')
    const body = gcSrc.slice(start, start + 1200)
    // 审查关键词存在 → 返回 null（不改派）
    expect(body).toMatch(/审查\|review|review\|审查/)
    expect(body).toContain('return null')
  })

  it('@ 分支里真的调用了守卫', () => {
    const start = gcSrc.indexOf('const mentioned = parseMention')
    const body = gcSrc.slice(start, start + 600)
    expect(body).toContain('upgradeReadOnlyTarget')
  })
})

describe('热茶人格 — 不再生硬回「我不会写代码」', () => {
  const recha = fs.readFileSync(
    path.join(root, 'electron', 'agents', 'recha', 'AGENTS.md'), 'utf-8',
  )

  it('明确禁止生硬拒绝，并要求给出可行路径', () => {
    expect(recha).toContain('绝对不要说「我不会写代码」')
    expect(recha).toContain('Yak')
  })

  it('仍保持只读权限约束（没有把写权限放开）', () => {
    expect(recha).toMatch(/只读|不写代码/)
  })
})

describe('本地模型适配 — 群聊不得硬编码 256K 上下文', () => {
  // 【要防的故障】群聊曾把 contextWindow / maxTokens 硬编码成 262144（256K）。
  //   对本地小模型是致命的：
  //     ① runner 以为窗口有 256K → 不裁剪历史 → 每轮全量 prefill（首字变分钟级）
  //     ② max_tokens 索要 256K 输出 → 本地服务端拒绝/截断
  //        → 表现正是「模型连续 0 轮未产出可用内容」
  //   必须取用户实际配置（0 = 自动检测，服务端报告优先）。
  it('GroupChatView 里不再有硬编码的 contextWindow: 262144', () => {
    expect(gcSrc).not.toMatch(/contextWindow:\s*262144/)
  })

  it('GroupChatView 里不再有硬编码的 maxTokens: 262144', () => {
    expect(gcSrc).not.toMatch(/maxTokens:\s*262144/)
  })

  it('流水线取 effectiveLlmConfig.contextWindow（含 0=自动检测）', () => {
    expect(gcSrc).toContain('const CTX_WIN')
    expect(gcSrc).toMatch(/contextWindow:\s*CTX_WIN/)
    expect(gcSrc).toContain('effectiveLlmConfig.contextWindow || 0')
  })

  it('历史预算在未知窗口时用保守默认，不再假设 256K', () => {
    expect(gcSrc).not.toMatch(/MAX_HISTORY_TOKENS[^\n]*262144/)
  })
})
