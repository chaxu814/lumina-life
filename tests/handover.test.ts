// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// tests/handover.test.ts — 交班模式单测
// 覆盖：卡片聚合 / TTL 过期 / 加密往返与错误口令 / 篡改检测 /
//       交换码随机性与作废 / 二维码载荷决策 / H5 HTML 转义
// ============================================================

import { describe, it, expect, beforeEach } from 'vitest'
import { buildHandoverCard, parseTodoListText } from '../electron/handover/handoverCard'
import {
  encryptCardWithPassword,
  encryptCardWithMachineKey,
  decryptContainer,
  parseContainer,
  containerToString,
} from '../electron/handover/handoverCrypto'
import {
  createExchange,
  lookupExchange,
  revokeExchange,
  decideQrPayload,
  __resetHandoverExchange,
  buildHandoverUrl,
  QR_PAYLOAD_LIMIT,
} from '../electron/handover/handoverExchange'
import { renderHandoverPage } from '../electron/handover/h5'
import { isHandoverExpired, HANDOVER_DEFAULT_TTL_MINUTES, type HandoverCard } from '../electron/handover/handoverTypes'

const NOW = 1_700_000_000_000

function fakeCard(over: Partial<HandoverCard> = {}): HandoverCard {
  return {
    schemaVersion: 1,
    generatedAt: NOW,
    ttlMinutes: 120,
    expiresAt: NOW + 120 * 60_000,
    generatedBy: 'lumina',
    summary: { date: '2026-10-14', costYuan: 1.5, promptTokens: 100, completionTokens: 50, commands: 10, items: [] },
    pendingApprovals: [],
    todos: [],
    agentStates: [],
    ...over,
  }
}

// ── 1. 卡片聚合 ───────────────────────────────────────────────

describe('buildHandoverCard 聚合', () => {
  it('注入假 replay/审批/待办/Agent，逐项映射到卡片', () => {
    const card = buildHandoverCard({
      now: () => NOW,
      replay: () => ({
        date: '2026-10-14',
        stats: { costYuan: 2.5, promptTokens: 111, completionTokens: 222, commands: 7, delegates: 1, turns: 30 },
        items: [{ kind: 'chat', title: '聊了天气', ts: 1 }],
      }),
      pendingApprovals: () => [
        { id: 'ap-1', toolName: 'shell', description: '执行 rm -rf', riskLevel: 'high', createdAt: NOW - 1000 },
      ],
      todos: () => [{ id: 3, text: '写日报', done: false }],
      agentStates: () => [{ id: 'yak', state: 'working', detail: '改代码' }],
    }, { ttlMinutes: 60 })

    expect(card.generatedAt).toBe(NOW)
    expect(card.ttlMinutes).toBe(60)
    expect(card.expiresAt).toBe(NOW + 60 * 60_000)
    expect(card.generatedBy).toBe('lumina')
    expect(card.summary).toMatchObject({
      date: '2026-10-14', costYuan: 2.5, promptTokens: 111, commands: 7, delegates: 1, turns: 30,
    })
    expect(card.summary!.items[0]).toMatchObject({ kind: 'chat', title: '聊了天气' })
    expect(card.pendingApprovals).toEqual([{ id: 'ap-1', title: '执行 rm -rf', createdAt: NOW - 1000, risk: 'high' }])
    expect(card.todos).toEqual([{ id: 3, text: '写日报', done: false }])
    expect(card.agentStates).toEqual([{ id: 'yak', state: 'working', detail: '改代码' }])
  })

  it('Day Replay 模块缺失（返回 null）时 summary=null 且不崩溃', () => {
    const card = buildHandoverCard({
      now: () => NOW,
      replay: () => null,
      pendingApprovals: () => [],
      todos: () => [],
      agentStates: () => [{ id: 'lumina', state: 'unknown' }],
    })
    expect(card.summary).toBeNull()
    expect(card.agentStates[0].state).toBe('unknown')
  })

  it('默认 ttl 为 120 分钟', () => {
    const card = buildHandoverCard({ now: () => NOW })
    expect(card.ttlMinutes).toBe(HANDOVER_DEFAULT_TTL_MINUTES)
  })

  it('parseTodoListText 还原 [ ] / [✓] 行', () => {
    const text = '  [ ] 1. 买牛奶\n  [✓] 2. 写日报\ngarbage line'
    expect(parseTodoListText(text)).toEqual([
      { id: 1, text: '买牛奶', done: false },
      { id: 2, text: '写日报', done: true },
    ])
  })
})

// ── 2. TTL 过期判定 ──────────────────────────────────────────

describe('isHandoverExpired', () => {
  const card = fakeCard()

  it('未过期（expiresAt 前 1ms）返回 false', () => {
    expect(isHandoverExpired(card, card.expiresAt - 1)).toBe(false)
  })

  it('临界时刻（now == expiresAt）判定过期', () => {
    expect(isHandoverExpired(card, card.expiresAt)).toBe(true)
  })

  it('过期后返回 true', () => {
    expect(isHandoverExpired(card, card.expiresAt + 1)).toBe(true)
  })
})

// ── 3. 加密往返 / 错误口令 / 篡改 / 本机密钥 ──────────────────

describe('handoverCrypto', () => {
  it('scrypt 口令容器加解密往返一致', () => {
    const card = fakeCard()
    const c = encryptCardWithPassword(card, 's3cret-pass', 'scrypt')
    expect(c.kdf).toBe('scrypt')
    expect(decryptContainer(c, 's3cret-pass')).toEqual(card)
  })

  it('pbkdf2 口令容器加解密往返一致（手机 WebCrypto 同参数）', () => {
    const card = fakeCard()
    const c = encryptCardWithPassword(card, 'pw', 'pbkdf2-sha256')
    expect(c.kdf).toBe('pbkdf2-sha256')
    expect(decryptContainer(c, 'pw')).toEqual(card)
  })

  it('错误口令解密抛错', () => {
    const c = encryptCardWithPassword(fakeCard(), 'right', 'scrypt')
    expect(() => decryptContainer(c, 'wrong')).toThrow()
  })

  it('密文字段被篡改（AEAD tag 校验失败）抛错', () => {
    const c = encryptCardWithPassword(fakeCard(), 'right', 'scrypt')
    const flipped = c.ct.slice(0, -2) + (c.ct.slice(-2) === 'AA' ? 'BB' : 'AA')
    expect(() => decryptContainer({ ...c, ct: flipped }, 'right')).toThrow()
  })

  it('tag 被篡改抛错', () => {
    const c = encryptCardWithPassword(fakeCard(), 'right', 'pbkdf2-sha256')
    const badTag = c.tag.slice(0, -2) + (c.tag.slice(-2) === '00' ? '11' : '00')
    expect(() => decryptContainer({ ...c, tag: badTag }, 'right')).toThrow()
  })

  it('文件容器 <-> 字符串往返（.lumina-handover）', () => {
    const c = encryptCardWithPassword(fakeCard(), 'pw', 'scrypt')
    const parsed = parseContainer(containerToString(c))
    expect(decryptContainer(parsed, 'pw')).toEqual(fakeCard())
  })

  it('本机密钥容器往返（非 Electron 环境 base64 降级）', () => {
    const card = fakeCard()
    const c = encryptCardWithMachineKey(card)
    expect(c.kdf).toBe('machine')
    expect(decryptContainer(c)).toEqual(card)
  })
})

// ── 4. 交换码注册表 / 二维码载荷决策 ───────────────────────────

describe('handoverExchange', () => {
  beforeEach(() => __resetHandoverExchange())

  it('交换码可凭码取回，TTL 到期后销毁', () => {
    const card = fakeCard()
    const c = encryptCardWithPassword(card, 'pw', 'pbkdf2-sha256')
    const code = createExchange({ kind: 'pbkdf2-container', container: c }, 120, NOW)
    expect(code.length).toBeGreaterThan(16)
    const e = lookupExchange(code, NOW + 60_000)
    expect(e?.payload.kind).toBe('pbkdf2-container')
    // 过期
    expect(lookupExchange(code, NOW + 120 * 60_000)).toBeNull()
    // 销毁后不可复活
    expect(lookupExchange(code, NOW)).toBeNull()
  })

  it('连续生成的交换码互不相同（随机性）', () => {
    const codes = new Set<string>()
    for (let i = 0; i < 10; i++) {
      const c = encryptCardWithPassword(fakeCard(), 'pw', 'pbkdf2-sha256')
      codes.add(createExchange({ kind: 'pbkdf2-container', container: c }, 120, NOW))
    }
    expect(codes.size).toBe(10)
  })

  it('revoke 作废交换码', () => {
    const c = encryptCardWithPassword(fakeCard(), 'pw', 'pbkdf2-sha256')
    const code = createExchange({ kind: 'pbkdf2-container', container: c }, 120, NOW)
    expect(revokeExchange(code)).toBe(true)
    expect(lookupExchange(code, NOW)).toBeNull()
    expect(revokeExchange(code)).toBe(false)
  })

  it('buildHandoverUrl 形态：http://ip:port/m/handover?k=', () => {
    const url = buildHandoverUrl({ code: 'abc123', port: 3456 })
    expect(url).toMatch(/^http:\/\/[^/]+:3456\/m\/handover\?k=abc123$/)
  })

  it('载荷决策：有交换码 → 永远返回 URL（不在二维码塞正文）', () => {
    const card = fakeCard()
    const p = decideQrPayload({ card, exchangeCode: 'xyz', port: 3456 })
    expect(p.kind).toBe('url')
    if (p.kind === 'url') {expect(p.url).toContain('/m/handover?k=xyz')}
  })

  it('载荷决策：超大卡片无交换码时拒绝直嵌（强制走 URL）', () => {
    const big = fakeCard({ summary: { date: 'x', items: new Array(200).fill({ kind: 'a', title: '字'.repeat(60), ts: 0 }) } })
    expect(Buffer.byteLength(JSON.stringify(big), 'utf-8')).toBeGreaterThan(QR_PAYLOAD_LIMIT)
    expect(() => decideQrPayload({ card: big, port: 3456 })).toThrow(/阈值/)
  })

  it('载荷决策：小卡片且无交换码才允许 data 直嵌', () => {
    const small = fakeCard()
    const p = decideQrPayload({ card: small, port: 3456 })
    expect(p.kind).toBe('data')
  })
})

// ── 5. H5 页面 HTML 转义 / 过期态 ─────────────────────────────

describe('renderHandoverPage', () => {
  it('审批标题含 <script> 时被转义，不在页面生成可执行脚本', () => {
    const evil = '<script>alert(1)</scr' + 'ipt>'
    const html = renderHandoverPage({
      state: 'ok-plain',
      card: fakeCard({ pendingApprovals: [{ id: 'a1', title: evil, createdAt: NOW, risk: 'high' }] }),
    })
    // 原始攻击串不得出现在页面里
    expect(html).not.toContain('<script>alert(1)</scr')
    // 经 embedJson 转义为 \u003cscript...
    expect(html).toContain('\\u003cscript')
  })

  it('过期态页面展示「已过期」提示', () => {
    const html = renderHandoverPage({ state: 'expired' })
    expect(html).toContain('已过期')
  })

  it('未知/作废交换码页面给出提示且不渲染卡片', () => {
    const html = renderHandoverPage({ state: 'unknown' })
    expect(html).toContain('交换码')
  })

  it('口令模式页面包含解密入口（WebCrypto）', () => {
    const c = encryptCardWithPassword(fakeCard(), 'pw', 'pbkdf2-sha256')
    const html = renderHandoverPage({ state: 'ok-container', container: c })
    expect(html).toContain('PBKDF2')
    expect(html).toContain('交班口令')
    // 容器以转义形式嵌入，非明文卡片
    expect(html).not.toContain('"summary"')
  })
})
