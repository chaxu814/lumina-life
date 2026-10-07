// ============================================================
// SpriteGalleryPanel.tsx — 🎨 桌宠工坊 · UGC 精灵表 (2026-10-07)
//
// 【为什么做这个】
//   Live2D / VRM 需要会 Blender、会绑 3D 模型 —— 这把绝大多数想画桌宠的人
//   挡在门外。**精灵表不需要**：一张 8×9 的网格图就能让桌宠跑起来。
//
//   后端（electron/pet/spriteSheet.ts）早就写好了规格、校验器和
//   「把提示词发给会画画的 AI」这条路径，但**没有任何 UI 入口**。
//   本面板把三条创建路径变成可点的按钮，并展示 9 行动作规格。
//
// 【三条路径】
//   ① 单张静态图（1 分钟，自动生成呼吸浮动）
//   ② 把内置提示词发给会画画的 AI（~10 分钟，得到完整动画）
//   ③ 已有图集直接导入
// ============================================================

import React, { useEffect, useState, useCallback } from 'react'

interface SpriteAction {
  id: string
  label: string
  row: number
  frames: number
  mirroredForLeft: boolean
  description: string
}

interface SpriteSpec {
  cols: number
  rows: number
  defaultFrame: number
  maxDim: number
  maxBytes: number
  actions: SpriteAction[]
}

const PATH_CARDS = [
  {
    id: 'static',
    icon: '🖼️',
    title: '单张静态图',
    time: '1 分钟',
    desc: '随便一张立绘就能用。Lumina 会自动为它生成呼吸与浮动动画。',
  },
  {
    id: 'ai',
    icon: '🤖',
    title: '让 AI 画完整精灵表',
    time: '约 10 分钟',
    desc: '把下面的提示词发给任何会画画的 AI，得到 8×9 图集，含跑动 / 工作 / 失败等 9 组动作。',
  },
  {
    id: 'import',
    icon: '📦',
    title: '导入已有图集',
    time: '即刻',
    desc: '已有 8×9 精灵表？直接导入。系统会校验尺寸、像素与体积，并拦截可执行文件。',
  },
]

export default function SpriteGalleryPanel() {
  const [spec, setSpec] = useState<SpriteSpec | null>(null)
  const [subject, setSubject] = useState('一只可爱的猫娘桌宠')
  const [copied, setCopied] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const api = (window as any).luminaAPI
    api?.sprite?.spec?.()
      .then((r: any) => { if (r?.ok) { setSpec(r) } else { setError(r?.error || '无法读取精灵表规格') } })
      .catch((e: any) => setError(e?.message || String(e)))
  }, [])

  const copyPrompt = useCallback(async (kind: 'ai' | 'static') => {
    try {
      const api = (window as any).luminaAPI
      const r = kind === 'ai'
        ? await api?.sprite?.prompt?.({ subject })
        : await api?.sprite?.quickPrompt?.(subject)
      if (r?.ok && r.prompt) {
        await navigator.clipboard.writeText(r.prompt)
        setCopied(kind)
        setTimeout(() => setCopied(null), 2000)
      } else {
        setError(r?.error || '生成提示词失败')
      }
    } catch (e: any) { setError(e?.message || String(e)) }
  }, [subject])

  const btn: React.CSSProperties = {
    padding: '5px 12px', border: '1px solid var(--border-light)', borderRadius: 6,
    background: 'var(--surface-0)', cursor: 'pointer', fontSize: 12,
    color: 'var(--text-primary)',
  }

  return (
    <div style={{ padding: 20, height: '100%', overflowY: 'auto' }}>
      <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>🎨 桌宠工坊</h2>
      <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 20, lineHeight: 1.7 }}>
        不需要会 Blender、不需要绑 3D 模型 —— 一张 <b>8×9 精灵表</b>就能做出一只属于你的桌宠。
        全程本地处理，不上传、不消耗任何模型额度。
      </p>

      {error && (
        <div style={{ fontSize: 12, color: '#e74c3c', marginBottom: 16 }}>{error}</div>
      )}

      {/* ── 三条创建路径 ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12, marginBottom: 24 }}>
        {PATH_CARDS.map(c => (
          <div key={c.id} style={{
            padding: 14, borderRadius: 12,
            background: 'var(--surface-0)', border: '1px solid var(--border-light)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <span style={{ fontSize: 20 }}>{c.icon}</span>
              <span style={{ fontWeight: 700, fontSize: 13 }}>{c.title}</span>
              <span style={{
                marginLeft: 'auto', fontSize: 10, padding: '1px 6px', borderRadius: 4,
                background: 'var(--surface-100)', color: 'var(--text-secondary)',
              }}>{c.time}</span>
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.7 }}>{c.desc}</div>
          </div>
        ))}
      </div>

      {/* ── AI 提示词生成 ── */}
      <div style={{
        padding: 16, borderRadius: 12, marginBottom: 24,
        background: 'var(--surface-0)', border: '1px solid var(--border-light)',
      }}>
        <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>🤖 生成「AI 画精灵表」的提示词</div>
        <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 10, lineHeight: 1.7 }}>
          填一个主体描述，复制提示词，粘给任何会画画的 AI（或图像模型）。它已经包含
          9 行动作的逐帧描述、网格规格与透明背景等硬性要求。
        </div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
          <input
            value={subject}
            onChange={e => setSubject(e.target.value)}
            placeholder="例如：一只穿卫衣的橘猫、赛博朋克少女…"
            style={{
              flex: 1, padding: '6px 10px', fontSize: 12, borderRadius: 6,
              border: '1px solid var(--border-light)', background: 'var(--surface-100)',
              color: 'var(--text-primary)',
            }}
          />
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button style={btn} onClick={() => copyPrompt('ai')}>
            {copied === 'ai' ? '✅ 已复制精灵表提示词' : '📋 复制精灵表提示词（8×9）'}
          </button>
          <button style={btn} onClick={() => copyPrompt('static')}>
            {copied === 'static' ? '✅ 已复制' : '📋 复制静态图提示词（更快）'}
          </button>
        </div>
      </div>

      {/* ── 9 行动作规格 ── */}
      {spec && (
        <div style={{
          padding: 16, borderRadius: 12,
          background: 'var(--surface-0)', border: '1px solid var(--border-light)',
        }}>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>
            📐 精灵表规格 · {spec.cols} 列 × {spec.rows} 行
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 12, lineHeight: 1.7 }}>
            每格默认 {spec.defaultFrame}×{spec.defaultFrame}px，整张 {spec.cols * spec.defaultFrame}×{spec.rows * spec.defaultFrame}px。
            体积上限 {(spec.maxBytes / 1024 / 1024).toFixed(0)}MB。
            <b>向左跑由第 2 行水平镜像自动补出</b>，不需要单独画。
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {spec.actions.map(a => (
              <div key={a.id} style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '7px 10px', borderRadius: 8, background: 'var(--surface-100)',
              }}>
                <span style={{
                  width: 26, height: 26, borderRadius: 6, flexShrink: 0,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: 'var(--surface-0)', fontSize: 11, fontWeight: 700,
                  color: 'var(--text-secondary)',
                }}>{a.row}</span>
                <div style={{ minWidth: 76, fontWeight: 600, fontSize: 12 }}>{a.label}</div>
                <div style={{ fontSize: 11, color: 'var(--text-secondary)', flex: 1, lineHeight: 1.6 }}>
                  {a.description}
                </div>
                <div style={{ fontSize: 10, color: 'var(--text-tertiary)', whiteSpace: 'nowrap' }}>
                  {a.frames} 帧{a.mirroredForLeft ? ' · 自动镜像左向' : ''}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {!spec && !error && (
        <div style={{ fontSize: 12, color: 'var(--text-tertiary)', padding: 12 }}>正在读取规格…</div>
      )}
    </div>
  )
}
