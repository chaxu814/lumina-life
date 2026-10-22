// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// tests/permissionGateWiring.test.ts — 闸门「真的接上了」吗
//
// 【这个文件是被一个真实事故逼出来的】
// 2026-10-05 排查「Lumina 偶发回复『模型返回了无法识别的内容』」时发现：
//
//   `ReActEngine` 被 `new ReActEngine(...)` 实例化（agentRunner.ts:783），
//   但全仓库 **`.run()` 从未被调用过一次** —— FIX-3 之后真正跑的是
//   agentRunner 自己的 `runReActLoop()`。
//
//   于是挂在那里的三档权限校验与角色闸门**一行都没执行过**。
//   UI 上的权限选择器切来切去，实际拦不住任何东西。
//
// 这是本项目最危险的一类 bug：**代码存在、类型正确、有测试看着像做了，
// 但它在一条已经废弃的路径上。** 光看代码永远看不出来。
//
// 所以本文件不改运行时行为，只断言一件事：
// **权限与角色闸门出现在真正的执行函数 runReActLoop 里，且单发/并行两条分支都有。**
// 以后谁再把执行路径改掉，这个测试会第一时间红。
// ============================================================

import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

function readSrc(rel: string): string {
  return fs.readFileSync(path.join(process.cwd(), ...rel.split('/')), 'utf-8')
}

const RUNNER = readSrc('electron/agentRunner.ts')

/** 只看真实代码行，剔除注释 —— 否则我们自己写的说明文字会把断言污染。
 *  这个坑很真实：修这个 bug 时我在注释里写了「.run()」三个字，
 *  结果 `.run(` 的匹配数从 0 变成 2，断言当场变红。
 *  “用注释解释一件事” 和 “断言一件事” 之间必须有这层隔离。 */
function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter(line => {
      const t = line.trim()
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
    })
    .join('\n')
}

describe('🔴 前置事实：ReActEngine 是不是死代码', () => {
  it('ReActEngine 被实例化过（说明它曾经是主路径）', () => {
    expect(RUNNER).toContain('new ReActEngine(')
  })

  it('⚠️ 但 .run() 从未被调用 —— 这就是它变成死代码的证据', () => {
    // 这条断言记录的是**当前事实**。如果哪天有人把 ReActEngine 重新接回去，
    // 下面的权限接线测试会失效（因为执行点搬走了），届时应同步更新两处测试。
    const runCalls = codeOnly(RUNNER).match(/\.run\(/g) || []
    expect(runCalls.length, 'ReActEngine.run() 仍无调用方 —— 执行路径是 agentRunner.runReActLoop').toBe(0)
  })

  it('runReActLoop 才是真正的执行函数', () => {
    expect(RUNNER).toMatch(/async runReActLoop\(tools: any\[\]\): Promise<string>/)
  })
})

describe('🔒 权限闸门必须接在真正的执行路径上', () => {
  it('runReActLoop 内部调用了 checkPermissionTier', () => {
    expect(RUNNER).toContain('this.checkPermissionTier(')
  })

  it('runReActLoop 内部调用了 checkRoleGateFor（角色硬闸门）', () => {
    expect(RUNNER).toContain('this.checkRoleGateFor(')
  })

  it('两处调用点都存在：单发分支 + 并行分支', () => {
    const src = codeOnly(RUNNER)
    // 定义是 `private checkPermissionTier(`（不带 this.），调用才是 `this.xxx(`。
    // 所以：期望 **2 个调用点** —— 单发 1 个 + 并行 1 个。
    // 少于 2 说明并行分支漏了 → 可被多工具并行绕过。
    const permCalls = src.match(/this\.checkPermissionTier\(/g) || []
    expect(permCalls.length, '并行分支可能漏接权限校验').toBe(2)

    const roleCalls = src.match(/this\.checkRoleGateFor\(/g) || []
    expect(roleCalls.length, '并行分支可能漏接角色闸门').toBe(2)

    // 定义本身也要在
    expect(src).toContain('private checkPermissionTier(')
    expect(src).toContain('private checkRoleGateFor(')
  })

  it('闸门失败时是把原因写回 messages，而不是默默跳过', () => {
    // 默默跳过 = 模型不知道自己被拒，下一轮会换个方式再试，无限循环
    expect(RUNNER).toMatch(/notExecutedNote\(permBlock\)/)
    expect(RUNNER).toMatch(/notExecutedNote\(pPerm\)/)
  })
})

describe('🛡️ 闸门自身的失败模式必须是「失败关闭」', () => {
  it('权限裁决抛异常时拒绝，而不是放行', () => {
    // 安全层的 try/catch 写成 return null 就等于「出错了随便过」——
    // 那是把可用性凌驾于安全之上的经典错误写法
    const fn = RUNNER.slice(RUNNER.indexOf('private checkPermissionTier'))
    const body = fn.slice(0, fn.indexOf('\n  }\n'))
    expect(body).toContain('catch')
    expect(body).toMatch(/catch[\s\S]*失败关闭/)
  })

  it('skipApproval（无人审批）时：高风险拒绝，不是一律放行', () => {
    const fn = RUNNER.slice(RUNNER.indexOf('private checkPermissionTier'))
    const body = fn.slice(0, fn.indexOf('\n  }\n'))
    expect(body).toMatch(/skipApproval[\s\S]*risk === 'high'[\s\S]*拒绝/)
  })
})

describe('🩺 空回复必须能说清楚原因', () => {
  it('AgentRunner 持有 lastFailureReason 字段', () => {
    expect(RUNNER).toContain('private lastFailureReason')
  })

  it('兜底文案把原因附在【技术信息】里给用户', () => {
    expect(RUNNER).toMatch(/【技术信息·可忽略】失败原因：/)
  })

  it('解析器的 diagnostic 被真的存了下来（不是算完就扔）', () => {
    // 这一条是本次事故的直接教训：xmlResult.diagnostic 曾经被精心计算，
    // 然后全项目没有任何一处读它 —— 用户因此完全无法反馈有效信息
    expect(RUNNER).toContain('this.lastXmlDiagnostic = xmlResult.diagnostic')
  })

  it('最后兜底时把 lastXmlDiagnostic 写进 lastFailureReason', () => {
    expect(RUNNER).toMatch(/this\.lastFailureReason = this\.lastXmlDiagnostic/)
  })
})

describe('🧩 XML 解析器的重复正则已清除', () => {
  const XML = readSrc('electron/llm/xmlToolCall.ts')

  it('INTENT_PATTERNS 里没有连续两条相同的模式', () => {
    const block = XML.slice(XML.indexOf('const INTENT_PATTERNS'), XML.indexOf('export function hasToolCallIntent'))
    const patterns = block.match(/\/[^/\n]+\/[a-z]*,/g) || []
    for (let i = 1; i < patterns.length; i++) {
      expect(patterns[i], `INTENT_PATTERNS 第 ${i} 条与上一条重复`).not.toBe(patterns[i - 1])
    }
  })

  it('补上了复数 <tool_calls>（格式 D 的内层标签，此前整个缺失）', () => {
    expect(XML).toContain('/<tool_calls>/i')
  })

  it('stripTags 也会清掉复数标签', () => {
    // 直接用字符串包含判断，不写转义地狱正则
    expect(XML).toContain("<tool_calls>[\\s\\S]*?<\\/tool_calls>")
  })
})
