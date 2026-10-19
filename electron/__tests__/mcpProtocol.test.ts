// ============================================================
// __tests__/mcpProtocol.test.ts — MCP 协议版本协商单元测试
//
// 覆盖（对应 P1-1「MCP 协议锁定 2024-11-05」的修复）：
//   ① 默认发送最新已知版本（2025-06-18），不再硬编码初版
//   ② Server 选择更新版本时以响应为准（negotiation）
//   ③ 最新被拒时按降级链重试（老 Server 兼容）
//   ④ 全部被拒才失败；发送异常不逃逸
//   ⑤ 降级尝试的顺序与日志可观测
// ============================================================

import { describe, it, expect, vi } from 'vitest'
import {
  MCP_LATEST_PROTOCOL_VERSION,
  MCP_PROTOCOL_VERSION_CHAIN,
  mcpInitializeHandshake,
} from '../mcpProtocol'

describe('MCP 协议版本协商', () => {
  it('最新版本是有据可查的已发布版本（非臆造）', () => {
    expect(MCP_LATEST_PROTOCOL_VERSION).toBe('2025-06-18')
  })

  it('尝试链 = 最新 + 降级链，且最新在最前', () => {
    expect(MCP_PROTOCOL_VERSION_CHAIN[0]).toBe(MCP_LATEST_PROTOCOL_VERSION)
    expect(MCP_PROTOCOL_VERSION_CHAIN).toEqual(['2025-06-18', '2025-03-26', '2024-11-05'])
    // 不允许重复
    expect(new Set(MCP_PROTOCOL_VERSION_CHAIN).size).toBe(MCP_PROTOCOL_VERSION_CHAIN.length)
  })

  it('Server 接受时回握手成功，且默认请求最新版本', async () => {
    const send = vi.fn(async (version: string) => ({ protocolVersion: version }))
    const r = await mcpInitializeHandshake('t', send)
    expect(r.ok).toBe(true)
    expect(r.negotiated).toBe(MCP_LATEST_PROTOCOL_VERSION)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][0]).toBe('2025-06-18')
  })

  it('Server 选择更新版本时以响应为准（向前兼容未来规范）', async () => {
    const send = vi.fn(async (version: string) => ({ protocolVersion: '2026-07-28' }))
    const r = await mcpInitializeHandshake('t', send)
    expect(r.ok).toBe(true)
    // 请求的是旧版，但会话版本取 Server 声明的值
    expect(r.negotiated).toBe('2026-07-28')
    expect(send.mock.calls[0][0]).toBe('2025-06-18')
  })

  it('Server 未回 protocolVersion 时回落为请求版本', async () => {
    const send = vi.fn(async () => ({}))
    const r = await mcpInitializeHandshake('t', send)
    expect(r.ok).toBe(true)
    expect(r.negotiated).toBe(MCP_LATEST_PROTOCOL_VERSION)
  })

  it('最新版本被拒时按降级链重试（老 Server 只认旧版）', async () => {
    const accepted: string[] = []
    const send = vi.fn(async (version: string) => {
      accepted.push(version)
      // 模拟老 Server：只认 2024-11-05
      if (version === '2024-11-05') {return { protocolVersion: version }}
      return undefined
    })
    const r = await mcpInitializeHandshake('t', send)
    expect(r.ok).toBe(true)
    expect(r.negotiated).toBe('2024-11-05')
    expect(accepted).toEqual(['2025-06-18', '2025-03-26', '2024-11-05'])
  })

  it('全部版本被拒才判定失败', async () => {
    const send = vi.fn(async () => undefined)
    const r = await mcpInitializeHandshake('t', send)
    expect(r.ok).toBe(false)
    expect(r.negotiated).toBeUndefined()
    expect(send).toHaveBeenCalledTimes(MCP_PROTOCOL_VERSION_CHAIN.length)
  })

  it('send 抛异常视为该版本被拒，不逃逸出握手', async () => {
    const send = vi.fn(async (version: string) => {
      if (version === '2025-06-18') {throw new Error('boom')}
      return { protocolVersion: version }
    })
    const r = await mcpInitializeHandshake('t', send)
    expect(r.ok).toBe(true)
    expect(r.negotiated).toBe('2025-03-26')
  })

  it('Server 回非字符串 protocolVersion 时忽略并回落', async () => {
    const send = vi.fn(async () => ({ protocolVersion: 123 }))
    const r = await mcpInitializeHandshake('t', send)
    expect(r.ok).toBe(true)
    expect(r.negotiated).toBe(MCP_LATEST_PROTOCOL_VERSION)
  })
})
