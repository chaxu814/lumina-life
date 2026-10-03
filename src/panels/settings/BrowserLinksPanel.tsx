// ============================================================
// panels/settings/BrowserLinksPanel.tsx — 内置浏览器与回复链接联动设置
//
// 单开关：browser.autoOpenLinks（默认开）。
// 开启后，Lumina 新回复里若含 http/https 链接，自动在内置浏览器打开「主要 URL」。
//
// 【为什么默认开】
// 产品决策：用户希望这个联动默认生效。
// 主进程的 config:get 会用 CONFIG_DEFAULTS 补全缺失键，
// 所以新用户和「从未手动改过」的老用户都读得到 true；
// 而显式关过的用户仍是 false —— 显式设置永远优先于默认值。
//
// 这里的读取用 `!== false` 而不是 `=== true`，是为了和主进程保持同一套语义：
// 键缺失(undefined/null) = 走默认 = 开；只有显式 false 才算关。
// 若两边判据不一致，就会出现「开关显示开着但实际不工作」的幽灵状态。
// ============================================================
import React, { useEffect, useState } from 'react'

const card: React.CSSProperties = {
  borderRadius: 12, border: '1px solid var(--border-light)', padding: 20,
  marginBottom: 16, background: 'var(--surface-0)',
  fontFamily: '"Microsoft YaHei", "微软雅黑", sans-serif',
}

export default function BrowserLinksPanel() {
  const [enabled, setEnabled] = useState(true)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let alive = true
    window.luminaAPI.getConfig().then((cfg: any) => {
      if (!alive) return
      // 键缺失 = 默认开；只有显式 false 才是关。
      // config:get 已用 CONFIG_DEFAULTS 补全，这里的 !== false 是双保险。
      setEnabled(cfg?.browser?.autoOpenLinks !== false)
      setLoaded(true)
    }).catch(() => setLoaded(true))
    return () => { alive = false }
  }, [])

  const toggle = async (v: boolean) => {
    setEnabled(v) // 乐观更新
    try {
      const cfg = await window.luminaAPI.getConfig()
      // config:set 是浅合并，必须带上已有 browser 子键，避免覆盖掉别的浏览器设置
      const browser = { ...((cfg as any)?.browser || {}), autoOpenLinks: v }
      await window.luminaAPI.setConfig({ browser })
    } catch { /* 忽略 */ }
  }

  return (
    <div style={card}>
      <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 10 }}>
        🌐 浏览器链接联动
      </div>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: 16, padding: '8px 4px',
      }}>
        <div>
          <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-primary)' }}>
            新回复自动打开网页
          </div>
          <div style={{
            fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 4,
            lineHeight: 1.6, maxWidth: 520,
          }}>
            开启后，Lumina 的新回复里若包含网址，会自动在内置浏览器打开第一条链接。
            <b>默认开启</b>；回复里的链接本身始终可以点击打开。
            如果你不喜欢自动弹窗，可以随时在这里关掉。
          </div>
        </div>
        <Switch checked={enabled} disabled={!loaded} onChange={toggle} />
      </div>
    </div>
  )
}

function Switch({
  checked, onChange, disabled,
}: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      onClick={() => onChange(!checked)}
      disabled={disabled}
      aria-label="新回复自动打开网页"
      style={{
        width: 40, height: 22, borderRadius: 999, border: 'none', cursor: 'pointer',
        background: checked ? '#3b82f6' : '#cbd5e1', position: 'relative',
        transition: 'background .15s', opacity: disabled ? 0.5 : 1, flexShrink: 0,
      }}
    >
      <span style={{
        position: 'absolute', top: 2, left: checked ? 20 : 2, width: 18, height: 18,
        borderRadius: '50%', background: '#fff', transition: 'left .15s',
        boxShadow: '0 1px 3px rgba(0,0,0,.2)',
      }} />
    </button>
  )
}
