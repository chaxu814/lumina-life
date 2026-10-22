// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// 复现 2026-10-04 的真实故障：LM Studio 跑在 http://192.168.1.2:1234（漏了 /v1）
// 应用拼出 /chat/completions 打到非 API 路径 → LM Studio 返回 HTTP 200 + 空 body
// → streamText 全程为空 → `text: undefined` → 界面上「发不出消息」且无任何报错
//
// 实测证据（见 commit 25db943 之后的排查）：
//   POST http://192.168.1.2:1234/chat/completions     -> 200  content长度=0
//   POST http://192.168.1.2:1234/v1/chat/completions  -> 200  content长度=57
import { describe, it, expect } from 'vitest'
import { safeOrigin, buildReasoningFallbackText } from '../electron/core/llmProvider'
import { isLocalEndpoint, isLocalInferenceRuntime, extractHost } from '../src/services/isLocalEndpoint'
import fs from 'fs'

describe('空回复必须报错（不能静默返回 undefined）', () => {
  const src = fs.readFileSync('electron/core/llmProvider.ts', 'utf-8')

  it('不再用 `text: streamText || undefined` 静默返回空', () => {
    expect(src).not.toMatch(/text:\s*streamText\s*\|\|\s*undefined/)
  })

  it('空内容走 error 分支，且带可执行诊断', () => {
    expect(src).toMatch(/模型服务返回了空内容/)
    // 诊断要直接点出最常见的原因：漏 /v1
    expect(src).toMatch(/必须以 \/v1 结尾/)
  })

  it('safeOrigin 只返回 origin，不泄露 userinfo / path', () => {
    expect(safeOrigin('http://192.168.1.2:1234/v1')).toBe('http://192.168.1.2:1234')
    // 带凭据的 URL 也不能把 key 带出去
    expect(safeOrigin('https://user:SECRETKEY@api.example.com/v1')).toBe('https://api.example.com')
    expect(safeOrigin('http://a:b@1.2.3.4:1/v1?key=abc')).not.toContain('abc')
    // 解析不了就返回空串，绝不回退到原文
    expect(safeOrigin('这不是一个URL')).toBe('')
    expect(safeOrigin('')).toBe('')
    expect(safeOrigin(null)).toBe('')
  })

  it('reasoning 兜底仍优先于空回复报错', () => {
    expect(buildReasoningFallbackText('  ')).toBe('')
    expect(buildReasoningFallbackText('我在推理')).toContain('我在推理')
  })

  it('有工具调用时不算「空回复」（function calling 的 content 本来就是空的）', () => {
    // 这条是真回归：修空回复时没考虑 tool_calls，导致所有工具调用被打成错误。
    // 由 tests/llmProvider.test.ts 的「解析工具调用」用例当场抓出。
    const src = fs.readFileSync('electron/core/llmProvider.ts', 'utf-8')
    expect(src).toMatch(/const hasToolCalls = streamToolCalls && streamToolCalls\.length > 0/)
    expect(src).toMatch(/if \(\(!streamText \|\| !streamText\.trim\(\)\) && !hasToolCalls\)/)
  })
})

describe('isLocalEndpoint：局域网 IP 也要认得出', () => {
  it('本机回环', () => {
    expect(isLocalEndpoint('http://127.0.0.1:1234/v1')).toBe(true)
    expect(isLocalEndpoint('http://localhost:1234/v1')).toBe(true)
    expect(isLocalEndpoint('http://[::1]:1234/v1')).toBe(true)
  })

  it('私有网段（用户的真实场景：LM Studio 在内网另一台机）', () => {
    expect(isLocalEndpoint('http://192.168.1.2:1234/v1')).toBe(true)
    expect(isLocalEndpoint('http://192.168.0.5:8080/v1')).toBe(true)
    expect(isLocalEndpoint('http://10.0.0.7:11434/v1')).toBe(true)
    expect(isLocalEndpoint('http://172.16.0.1:1234/v1')).toBe(true)
    expect(isLocalEndpoint('http://172.31.255.254:1234/v1')).toBe(true)
  })

  it('公网端点不能误判成本地', () => {
    expect(isLocalEndpoint('https://api.openai.com/v1')).toBe(false)
    expect(isLocalEndpoint('https://api.deepseek.com/v1')).toBe(false)
    // 172.32 超出 172.16/12，是公网地址
    expect(isLocalEndpoint('http://172.32.0.1:1234/v1')).toBe(false)
    // 192.169 才是公网（常见误写）
    expect(isLocalEndpoint('http://192.169.0.1:1234/v1')).toBe(false)
  })

  it('鲁棒性：缺协议、空值、脏输入', () => {
    expect(isLocalEndpoint('192.168.1.2:1234/v1')).toBe(true)   // 漏协议
    expect(isLocalEndpoint('')).toBe(false)
    expect(isLocalEndpoint(null)).toBe(false)
    expect(isLocalEndpoint(undefined)).toBe(false)
    // 端口号里带 127 不能被当成 host
    expect(extractHost('http://api.example.com:12700/v1')).toBe('api.example.com')
  })

  it('isLocalInferenceRuntime 额外认 ollama / lmstudio 字样', () => {
    expect(isLocalInferenceRuntime('http://192.168.1.2:1234/v1')).toBe(true)
    expect(isLocalInferenceRuntime('http://ollama.internal:11434/v1')).toBe(true)
    expect(isLocalInferenceRuntime('https://api.openai.com/v1')).toBe(false)
  })

  it('GroupChatView 已改用共用判定，不再自己拼字符串', () => {
    const gc = fs.readFileSync('src/panels/GroupChatView.tsx', 'utf-8')
    // 变量名随就绪配置重构从 llmConfig 改为 readinessConfig，这里只锁「调用了共用判定」
    expect(gc).toMatch(/isLocalInferenceRuntime\(\s*[A-Za-z_$][\w$]*\.baseUrl\s*\)/)
    expect(gc).not.toMatch(/baseUrl\?\.includes\('127\.0\.0\.1'\)/)
  })
})
