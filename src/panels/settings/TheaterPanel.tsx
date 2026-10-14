// ============================================================
// panels/settings/TheaterPanel.tsx — 团队可见性剧场设置（创新功能 2 的开关）
//
// 一个开关，控制「执行委派时是否把过程实时演给用户看」。
//
// 【为什么默认开、但必须可关】
// 剧场是 Lumina 独特的体验点（常见多 Agent 界面是流程图，这里是戏）。
// 但它本质是**观赏层**，对某些用户是干扰：
//   · 只想拿结果的用户 → 觉得吵
//   · 密集编程时 → 频繁的幕会打断心流
//   · 屏幕小 / 分屏 → 时间轴会挤压对话区
// 所以默认开（这是产品想推的差异化），但绝不能不可关。
//
// 【技术要点】
// 主进程侧 emotionGating 有 enabled 逃生门，剧场侧用 config 开关；
// 这里读写的是普通 lumina-config.json，不碰 Electron 私有 API。
// ============================================================

import React, { useEffect, useState, useCallback } from 'react'

const card: React.CSSProperties = {
  borderRadius: 12,
  border: '1px solid var(--border-light)',
  padding: 20,
  marginBottom: 16,
  background: 'var(--surface-0)',
  fontFamily: '"Microsoft YaHei", "微软雅黑", sans-serif',
}

const row: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  gap: 16, padding: '10px 4px',
}

const title: React.CSSProperties = { fontSize: 12.5, fontWeight: 600, color: 'var(--text-primary)' }
const desc: React.CSSProperties = {
  fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 4, lineHeight: 1.6, maxWidth: 520,
}

interface Props {
  /** 主进程注入的当前开关状态（避免多读一次 config） */
  initialEnabled?: boolean
}

export default function TheaterPanel({ initialEnabled = true }: Props) {
  const [theaterOn, setTheaterOn] = useState(initialEnabled)
  const [emotionGateOn, setEmotionGateOn] = useState(true)
  const [decayOn, setDecayOn] = useState(true)
  const [loaded, setLoaded] = useState(false)
  const [saved, setSaved] = useState(false)

  // 读取现状。三个开关同属一组创新功能，放一起便于用户理解和统一控制。
  useEffect(() => {
    let alive = true
    window.luminaAPI.getConfig().then((cfg: any) => {
      if (!alive) {return}
      const f = cfg?.features || {}
      // 键缺失 = 默认开，与主进程 CONFIG_DEFAULTS 同一语义
      setTheaterOn(f.theater !== false)
      setEmotionGateOn(f.emotionGating !== false)
      setDecayOn(f.affinityDecay !== false)
      setLoaded(true)
    }).catch(() => setLoaded(true))
    return () => { alive = false }
  }, [])

  const persist = useCallback(async (patch: Record<string, boolean>) => {
    try {
      const cfg = await window.luminaAPI.getConfig()
      // config:set 是浅合并，必须带上已有 features 子键
      const features = { ...((cfg as any)?.features || {}), ...patch }
      await window.luminaAPI.setConfig({ features })
      setSaved(true)
      setTimeout(() => setSaved(false), 1600)
    } catch { /* 忽略 */ }
  }, [])

  const toggle = (
    value: boolean,
    setter: (v: boolean) => void,
    key: 'theater' | 'emotionGating' | 'affinityDecay',
  ) => {
    setter(value)                    // 乐观更新
    void persist({ [key]: value })
  }

  return (
    <div>
      {saved && (
        <div style={{
          fontSize: 12, color: '#166534', background: '#f0fdf4',
          border: '1px solid #bbf7d0', borderRadius: 8, padding: '6px 12px', marginBottom: 12,
        }}>
          ✓ 已保存
        </div>
      )}

      {/* ── 剧场 ── */}
      <div style={card}>
        <div style={row}>
          <div>
            <div style={title}>🎭 任务剧场</div>
            <div style={desc}>
              开启后，Yak 写代码、热茶挑刺、Lumina 协调的全过程会以时间轴实时播出，
              每一幕都带角色当下的情绪。你可以在聊天区展开观看，也可以随时收起。
              <b>默认开启</b>；只想要结果的话可以关掉。
            </div>
          </div>
          <Switch
            checked={theaterOn} disabled={!loaded}
            onChange={(v) => toggle(v, setTheaterOn, 'theater')}
            label="任务剧场"
          />
        </div>
      </div>

      {/* ── 情绪门控 ── */}
      <div style={card}>
        <div style={row}>
          <div>
            <div style={title}>💗 情绪影响工具选择</div>
            <div style={desc}>
              让 Lumina 的情绪真正参与决策：她焦躁时会先缓一缓不可逆的操作，
              累了会少接耗时的活。
              <br />
              只会<b>收紧</b>不会放开——情绪好不会解锁更多权限。
              <b>默认开启</b>。
            </div>
          </div>
          <Switch
            checked={emotionGateOn} disabled={!loaded}
            onChange={(v) => toggle(v, setEmotionGateOn, 'emotionGating')}
            label="情绪影响工具选择"
          />
        </div>
      </div>

      {/* ── 关系衰减 ── */}
      <div style={card}>
        <div style={row}>
          <div>
            <div style={title}>🕯️ 关系驱动的记忆衰减</div>
            <div style={desc}>
              早期关系里的随口寒暄会慢慢变淡，相处久了之后的重要记忆会越来越沉。
              让她记得你的每一句话，但更记得你在意的事。
              <br />
              只会调整召回顺序，<b>不会删除任何记忆</b>。<b>默认开启</b>。
            </div>
          </div>
          <Switch
            checked={decayOn} disabled={!loaded}
            onChange={(v) => toggle(v, setDecayOn, 'affinityDecay')}
            label="关系驱动的记忆衰减"
          />
        </div>
      </div>
    </div>
  )
}

function Switch({
  checked, onChange, disabled, label,
}: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) {
  return (
    <button
      onClick={() => onChange(!checked)}
      disabled={disabled}
      aria-label={label}
      aria-pressed={checked}
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
