// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// tests/agentRunnerTextSplit.test.ts
//
// 【要防的问题】
//   agentRunner.ts 的纯函数辅助块被抽到 agentRunner.text.ts 后，
//   **既有调用点与测试仍从 '../electron/agentRunner' 导入** ——
//   如果只做了 `export {x} from`（纯转发、不建本地绑定），
//   agentRunner.ts 内部调用就会找不到符号；如果漏了 re-export，
//   外部导入会断。本测试同时锁「内部可用」与「外部可导入」。
// ============================================================

import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

// 从**旧路径**导入（验证 re-export 生效）
import {
  notExecutedNote,
  sanitizeHistoryForApi,
  describeRunFailure,
  clearModelToolBlacklist,
} from '../electron/agentRunner'

const root = path.resolve(__dirname, '..')
const runnerSrc = fs.readFileSync(path.join(root, 'electron', 'agentRunner.ts'), 'utf-8')
const textSrc = fs.readFileSync(path.join(root, 'electron', 'agentRunner.text.ts'), 'utf-8')

describe('agentRunner 辅助块拆分 —— 向后兼容', () => {
  it('旧路径仍能导入（re-export 生效）', () => {
    expect(typeof notExecutedNote).toBe('function')
    expect(typeof sanitizeHistoryForApi).toBe('function')
    expect(typeof describeRunFailure).toBe('function')
    expect(typeof clearModelToolBlacklist).toBe('function')
  })

  it('agentRunner.ts 同时 import 与 re-export（只转发会丢本地绑定）', () => {
    expect(runnerSrc).toContain("from './agentRunner.text'")
    // 必须有 import（本地绑定，供文件内部调用）
    expect(runnerSrc).toMatch(/import\s*\{[\s\S]*?notExecutedNote[\s\S]*?\}\s*from\s*'\.\/agentRunner\.text'/)
    // 也必须有 export（外部兼容）
    expect(runnerSrc).toMatch(/export\s*\{[\s\S]*?notExecutedNote[\s\S]*?\}/)
  })

  it('原实现已不在 agentRunner.ts 内重复定义', () => {
    expect(runnerSrc).not.toContain('export function notExecutedNote')
    expect(runnerSrc).not.toContain('export function describeRunFailure')
    expect(textSrc).toContain('export function notExecutedNote')
    expect(textSrc).toContain('export function describeRunFailure')
  })
})

describe('行为不变', () => {
  it('notExecutedNote 明确写「不是结果」', () => {
    const s = notExecutedNote('权限不足')
    expect(s).toContain('未执行成功')
    expect(s).toContain('不是结果')
    expect(s).toContain('权限不足')
  })

  it('sanitizeHistoryForApi 把孤儿 tool 消息降级为 user', () => {
    const out = sanitizeHistoryForApi([
      { role: 'user', content: 'hi' },
      { role: 'tool', tool_call_id: 'x', content: '结果' },
    ])
    expect(out[1].role).toBe('user')
    expect(String(out[1].content)).toContain('历史工具结果')
  })

  it('describeRunFailure 对本地鉴权失败给本地化建议', () => {
    const s = describeRunFailure('401 unauthorized', { isLocal: true })
    expect(s).toContain('LM Studio')
  })

  it('describeRunFailure 对云端鉴权失败给账户建议', () => {
    const s = describeRunFailure('401 unauthorized', { isLocal: false })
    expect(s).toContain('API Key')
  })
})
