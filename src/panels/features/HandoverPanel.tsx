// ============================================================
// src/panels/features/HandoverPanel.tsx — 交班模式设置面板
//
// 生成交班卡片（口令 / 本机密钥二选一、TTL 设置）→ 显示二维码
// （可刷新 / 作废交换码）→ 保存 .lumina-handover 文件；
// 展示当前待审批数与卡片过期状态。
//
// 数据来源：window.luminaAPI.handover*（electron/handover/handoverIpc.ts，
//   原生通道 handover:generate / handover:save / handover:revoke / handover:status）。
//   preload 尚未接线时，所有调用防御性降级为「等待接线」提示，不抛错。
// ============================================================

import { useEffect, useState } from 'react'
import type { HandoverCard } from '../../../electron/handover/handoverTypes'

interface HandoverGenerateResult {
  ok: boolean
  disabled?: boolean
  error?: string
  card?: HandoverCard
  container?: string
  exchangeCode?: string
  qrDataUrl?: string
  lanUrl?: string
  expiresAt?: number
  pendingCount?: number
}

interface HandoverStatus {
  pendingCount: number
  flagEnabled: boolean
  activeExchanges: number
  lanIp: string
}

interface LuminaHandoverAPI {
  handoverGenerate?: (opts: { ttlMinutes?: number; mode: 'password' | 'machine'; password?: string }) => Promise<HandoverGenerateResult>
  handoverSave?: (container: string, suggestedName?: string) => Promise<{ ok: boolean; filePath?: string; error?: string }>
  handoverRevoke?: (code: string) => Promise<{ ok: boolean }>
  handoverStatus?: () => Promise<HandoverStatus>
}

function getApi(): LuminaHandoverAPI | null {
  if (typeof window === 'undefined') {return null}
  return ((window as unknown as { luminaAPI?: LuminaHandoverAPI }).luminaAPI || null)
}

function fmtTs(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export default function HandoverPanel() {
  const [mode, setMode] = useState<'password' | 'machine'>('password')
  const [password, setPassword] = useState('')
  const [ttl, setTtl] = useState(120)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<HandoverGenerateResult | null>(null)
  const [status, setStatus] = useState<HandoverStatus | null>(null)
  const [notice, setNotice] = useState('')
  const [expired, setExpired] = useState(false)

  const api = getApi()
  const wired = !!api?.handoverGenerate

  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        if (api?.handoverStatus) {
          const s = await api.handoverStatus()
          if (alive) {setStatus(s)}
        }
      } catch { /* 忽略 */ }
    }
    load()
    return () => {alive = false}
  }, [api])

  useEffect(() => {
    if (!result?.expiresAt) {return}
    const timer = setInterval(() => {
      setExpired(Date.now() >= (result.expiresAt || 0))
    }, 5000)
    return () => clearInterval(timer)
  }, [result?.expiresAt])

  const generate = async () => {
    setBusy(true)
    setNotice('')
    try {
      const r = await api!.handoverGenerate!({ ttlMinutes: ttl > 0 ? ttl : 120, mode, password })
      setResult(r)
      setExpired(!!r.card && Date.now() >= r.card.expiresAt)
      if (!r.ok) {setNotice(r.error || (r.disabled ? '交班模式未在 feature flag 中开启' : '生成失败'))}
    } catch (e: any) {
      setNotice(String(e?.message || e))
    } finally {
      setBusy(false)
    }
  }

  const save = async () => {
    if (!result?.container) {return}
    try {
      const r = await api!.handoverSave!(result.container)
      setNotice(r.ok ? `已保存：${r.filePath}` : r.error || '已取消')
    } catch (e: any) {
      setNotice(String(e?.message || e))
    }
  }

  const revoke = async () => {
    if (!result?.exchangeCode) {return}
    try {
      await api!.handoverRevoke!(result.exchangeCode)
      setNotice('交换码已作废，请重新生成二维码')
      setResult(null)
    } catch (e: any) {
      setNotice(String(e?.message || e))
    }
  }

  const card = result?.card

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '4px 2px' }}>
      <div style={{ fontSize: 13, color: 'var(--text-2, #9fb0c0)', lineHeight: 1.7 }}>
        生成一张本地交班快照（今日摘要 · 待审批 · 待办 · Agent 状态），
        手机扫码在同一局域网查看并可远程批准/拒绝。不做云同步；卡片带 TTL，过期后操作锁定。
      </div>

      {!wired && (
        <div style={{ padding: 10, borderRadius: 10, fontSize: 13, color: '#e3b341', border: '1px solid rgba(227,179,65,.4)' }}>
          功能主体已就绪，等待集成阶段挂载 IPC 通道（handover:generate 等）与 feature flag（handover.enabled）。
        </div>
      )}

      <label style={{ fontSize: 13, color: 'var(--text-2, #9fb0c0)' }}>
        <input type="radio" checked={mode === 'password'} onChange={() => setMode('password')} style={{ marginRight: 6 }} />
        口令加密（手机页面输入口令解密）
      </label>
      {mode === 'password' && (
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="设置交班口令"
          style={{ padding: 9, borderRadius: 9, background: 'var(--bg, #0d1117)', border: '1px solid var(--line, #242e3b)', color: 'inherit' }}
        />
      )}
      <label style={{ fontSize: 13, color: 'var(--text-2, #9fb0c0)' }}>
        <input type="radio" checked={mode === 'machine'} onChange={() => setMode('machine')} style={{ marginRight: 6 }} />
        本机密钥（免口令，仅本机可解；局域网扫码直接查看）
      </label>

      <label style={{ fontSize: 13, color: 'var(--text-2, #9fb0c0)' }}>
        有效期（分钟，默认 120）：
        <input
          type="number"
          min={5}
          value={ttl}
          onChange={(e) => setTtl(Number(e.target.value))}
          style={{ width: 90, marginLeft: 8, padding: 6, borderRadius: 8, background: 'var(--bg, #0d1117)', border: '1px solid var(--line, #242e3b)', color: 'inherit' }}
        />
      </label>

      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={generate} disabled={busy || !wired} style={{ flex: 1, padding: 10, borderRadius: 10, border: 'none', background: 'linear-gradient(135deg,#ec4899,#a371f7)', color: '#fff', fontWeight: 650 }}>
          {busy ? '生成中…' : '生成交班卡片'}
        </button>
        <button onClick={save} disabled={!result?.ok} style={{ padding: 10, borderRadius: 10, border: '1px solid var(--line, #242e3b)', background: 'transparent', color: 'inherit' }}>
          保存 .lumina-handover
        </button>
        <button onClick={revoke} disabled={!result?.exchangeCode} style={{ padding: 10, borderRadius: 10, border: '1px solid var(--line, #242e3b)', background: 'transparent', color: '#f85149' }}>
          作废二维码
        </button>
      </div>

      {notice && <div style={{ fontSize: 13, color: 'var(--text-2, #9fb0c0)' }}>{notice}</div>}

      {status && (
        <div style={{ fontSize: 13, color: 'var(--text-3, #6b7c8f)' }}>
          当前待审批 {status.pendingCount} 条 · 存活交换码 {status.activeExchanges} 个 · 局域网 IP {status.lanIp}
        </div>
      )}

      {card && result?.qrDataUrl && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, padding: 12, borderRadius: 12, border: '1px solid var(--line, #242e3b)' }}>
          {expired && <div style={{ fontSize: 13, color: '#f85149' }}>已过期（生成于 {fmtTs(card.generatedAt)}）——操作已锁定，请重新生成</div>}
          <img src={result.qrDataUrl} alt="交班二维码" style={{ width: 220, height: 220 }} />
          <div style={{ fontSize: 12, color: 'var(--text-3, #6b7c8f)', wordBreak: 'break-all' }}>{result.lanUrl}</div>
          <div style={{ fontSize: 12, color: 'var(--text-3, #6b7c8f)' }}>
            待审批 {card.pendingApprovals.length} 条 · 待办 {card.todos.length} 项 · 过期 {fmtTs(card.expiresAt)}
          </div>
        </div>
      )}
    </div>
  )
}
