// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// mcpProtocol.ts — MCP 协议版本协商（单一事实源）
//
// 【要解决的问题】
//   MCP 规范迭代快：2024-11-05（初版）→ 2025-03-26 →
//   2025-06-18 → 2026-07-28（第 5 版，官方称「问世以来最大
//   修订」，核心转向「无状态」）。
//   本项目曾把 protocolVersion 硬编码为 2024-11-05（三处）：
//   对接新版 MCP Server 时，握手可能被拒绝或降级，表现为
//   「工具接不上」而排障时无从判断原因。
//
// 【设计：声明最新 + 接受协商 + 失败降级】
//   ① initialize 请求发送我们已知可用的**最新**版本；
//   ② 以 Server 响应的 protocolVersion 为本会话实际版本
//      （规范语义：响应方说了算），记录下来供排障；Server
//      选了更新版本（如 2026-07-28 之后的新规范）也接受——
//       negotiation 的意义就是容忍对方比我们新；
//   ③ 握手被拒（result 为空）时按 FALLBACKS 依次降级重试，
//      照顾只认旧版的老 Server；
//   ④ 全部失败才判定连接失败，不额外抛异常。
//
// 注意：这里**不臆造**未见于公开规范的版本号——链上每一项
// 都是有据可查的已发布版本；对更晚的规范靠 ② 的协商兼容。
// ============================================================

/** 我方声明支持的最新 MCP 协议版本（有据可查的已发布版本） */
export const MCP_LATEST_PROTOCOL_VERSION = '2025-06-18'

/** 握手被拒时的降级链（老 Server 只认旧版本） */
export const MCP_PROTOCOL_FALLBACKS: readonly string[] = ['2025-03-26', '2024-11-05']

/** 完整尝试链：最新优先，逐级降级 */
export const MCP_PROTOCOL_VERSION_CHAIN: readonly string[] = [
  MCP_LATEST_PROTOCOL_VERSION,
  ...MCP_PROTOCOL_FALLBACKS,
]

export interface MCPHandshakeResult {
  /** 握手是否成功（任一版本被接受） */
  ok: boolean
  /** 本会话实际使用的协议版本（Server 响应为准，失败时为 undefined） */
  negotiated?: string
}

/**
 * 带降级重试的 MCP initialize 握手。
 *
 * @param send 用指定 protocolVersion 发送一次 initialize，返回 Server 的 result
 *             （JSON-RPC error / 空 result 均返回 undefined，视为该版本被拒）
 */
export async function mcpInitializeHandshake(
  label: string,
  send: (protocolVersion: string) => Promise<any>,
): Promise<MCPHandshakeResult> {
  for (const version of MCP_PROTOCOL_VERSION_CHAIN) {
    let result: any
    try {
      result = await send(version)
    } catch {
      result = undefined
    }
    if (result) {
      const negotiated = typeof result.protocolVersion === 'string' && result.protocolVersion
        ? result.protocolVersion
        : version
      if (negotiated !== version) {
        console.log(`[MCP:${label}] 协议版本协商: 我方=${version} → 会话=${negotiated}`)
      }
      return { ok: true, negotiated }
    }
    console.warn(`[MCP:${label}] initialize 未被接受（版本 ${version}），尝试降级…`)
  }
  return { ok: false }
}
