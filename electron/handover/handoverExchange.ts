// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// handover/handoverExchange.ts — 局域网交换码注册表（内存态）
//
// 【载荷决策】二维码里只放「拉取 URL」，永远不塞卡片正文：
//   http://<局域网IP>:<端口>/m/handover?k=<短随机交换码>
// 交换码与卡片（或其密文）只在内存 Map 中保存，TTL 到期即销毁，
// 不持久化明文、不写日志。
// ============================================================

import * as crypto from 'crypto'
import * as os from 'os'
import type { HandoverCard } from './handoverTypes'
import type { HandoverContainer } from './handoverCrypto'

/** 卡片 JSON 超过该字节数时绝不允许进二维码（强制走 URL） */
export const QR_PAYLOAD_LIMIT = 1800

const CODE_BYTES = 18 // → base64url 约 24 字符，熵足够

export type ExchangePayload =
  | { kind: 'pbkdf2-container'; container: HandoverContainer }  // 手机页面输入口令解密
  | { kind: 'plain-card'; card: HandoverCard }                  // 本机密钥模式：仅局域网明文下发

export interface ExchangeEntry {
  code: string
  createdAt: number
  expiresAt: number
  payload: ExchangePayload
}

// ── 内存注册表 ───────────────────────────────────────────────

const entries = new Map<string, ExchangeEntry>()

function randomCode(): string {
  return crypto.randomBytes(CODE_BYTES).toString('base64url')
}

export function createExchange(payload: ExchangePayload, ttlMinutes: number, now: number = Date.now()): string {
  // 换一批新码之前，把同一旧码泄漏风险降到最低：码空间 2^144，碰撞忽略
  let code = randomCode()
  while (entries.has(code)) {code = randomCode()}
  entries.set(code, {
    code,
    createdAt: now,
    expiresAt: now + ttlMinutes * 60_000,
    payload,
  })
  return code
}

/** 取交换码对应条目；过期/未知一律返回 null（并顺手销毁过期条目） */
export function lookupExchange(code: string, now: number = Date.now()): ExchangeEntry | null {
  const e = entries.get(code)
  if (!e) {return null}
  if (now >= e.expiresAt) {
    entries.delete(code) // TTL 到期销毁，不复活
    return null
  }
  return e
}

/** 作废交换码（QR 刷新 / 用户主动撤销） */
export function revokeExchange(code: string): boolean {
  return entries.delete(code)
}

/** 当前存活交换码数量（设置面板展示用） */
export function exchangeCount(now: number = Date.now()): number {
  let n = 0
  for (const [, e] of entries) {
    if (now < e.expiresAt) {n++}
  }
  return n
}

/** 测试辅助 */
export function __resetHandoverExchange(): void {
  entries.clear()
}

// ── 局域网地址 & URL ────────────────────────────────────────

/** 第一个非内部 IPv4（供手机扫码），找不到则回退 127.0.0.1 */
export function firstLanIPv4(): string {
  const ifaces = os.networkInterfaces()
  for (const name of Object.keys(ifaces)) {
    for (const info of ifaces[name] || []) {
      if (info.family === 'IPv4' && !info.internal) {return info.address}
    }
  }
  return '127.0.0.1'
}

export function buildHandoverUrl(opts: { code: string; port: number; host?: string }): string {
  const host = opts.host || firstLanIPv4()
  return `http://${host}:${opts.port}/m/handover?k=${encodeURIComponent(opts.code)}`
}

/**
 * 载荷决策：永远优先 URL。仅当「无交换码」且卡片体积远小于 QR_PAYLOAD_LIMIT
 * 时才允许 data: 直嵌；正常流程（有 code）一律返回 URL。
 */
export type QrPayload =
  | { kind: 'url'; url: string }
  | { kind: 'data'; text: string }

export function decideQrPayload(opts: {
  card: HandoverCard
  exchangeCode?: string
  port: number
  host?: string
}): QrPayload {
  if (opts.exchangeCode) {
    return { kind: 'url', url: buildHandoverUrl({ code: opts.exchangeCode, port: opts.port, host: opts.host }) }
  }
  const size = Buffer.byteLength(JSON.stringify(opts.card), 'utf-8')
  if (size > QR_PAYLOAD_LIMIT) {
    // 超阈值：没有交换码也绝不塞正文（调用方应先 createExchange）
    throw new Error(`卡片体积 ${size}B 超过二维码阈值 ${QR_PAYLOAD_LIMIT}B，必须走 URL`)
  }
  return { kind: 'data', text: JSON.stringify(opts.card) }
}

/** 渲染二维码为 PNG data URL（qrcode，纯 JS、MIT） */
export async function renderQrDataUrl(text: string): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const QRCode = require('qrcode') as { toDataURL: (t: string, o?: object) => Promise<string> }
  return QRCode.toDataURL(text, { errorCorrectionLevel: 'M', margin: 2, width: 480 })
}
