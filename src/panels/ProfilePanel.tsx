import React, { useRef, useState, useCallback, useEffect } from 'react'
import { useStore } from '../stores/appStore'
import {
  clampCrop, zoomCrop, initialCrop, zoomPercent,
  type CropRect, type CropBounds,
} from '../lib/avatarCrop'

const GENDER_OPTIONS = [
  { value: 'male', label: '♂ 男', emoji: '♂️' },
  { value: 'female', label: '♀ 女', emoji: '♀️' },
  { value: 'other', label: '⚧ 其他', emoji: '⚧' },
  { value: 'secret', label: '🔒 保密', emoji: '🔒' },
] as const

const AVATAR_SIZE = 200  // 压缩后最大尺寸

// 压缩头像为 JPEG base64，避免 localStorage 超限
function compressAvatar(dataUrl: string, maxSize: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      let { width, height } = img
      // 等比缩放
      if (width > maxSize || height > maxSize) {
        const ratio = Math.min(maxSize / width, maxSize / height)
        width = Math.round(width * ratio)
        height = Math.round(height * ratio)
      }
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')!
      ctx.drawImage(img, 0, 0, width, height)
      resolve(canvas.toDataURL('image/jpeg', 0.75))
    }
    img.onerror = () => reject(new Error('图片加载失败'))
    img.src = dataUrl
  })
}

// 裁剪头像（canvas 实现）
function cropAvatar(dataUrl: string, cropX: number, cropY: number, cropW: number, cropH: number, outputSize: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = outputSize
      canvas.height = outputSize
      const ctx = canvas.getContext('2d')!
      ctx.drawImage(img, cropX, cropY, cropW, cropH, 0, 0, outputSize, outputSize)
      resolve(canvas.toDataURL('image/jpeg', 0.75))
    }
    img.onerror = () => reject(new Error('图片加载失败'))
    img.src = dataUrl
  })
}

// ═══════════════════════════════════════════════════════════
// 头像裁剪（2026-10-19 重写）
//
// 旧实现的四个问题（用户实测反馈）：
//   ① 图片没有高度约束，大图直接把弹窗撑爆/底部被切，看不到全貌；
//   ② 裁剪框是方的——头像是圆的，方框选中的内容与最终圆形呈现不一致；
//   ③ 没有实时预览，用户靠想象「圈出来的是不是想用的部分」；
//   ④ 滚轮缩放以左上角为锚，缩放时构图乱跳；且没有边界钳制、
//      没有除滚轮以外的缩放入口（触控板/无滚轮用户无从下手）。
//
// 新版：圆形取景框 + 三分构图线 + 右侧实时圆形预览（canvas 重绘），
// 缩放以中心为锚，全部操作边界钳制；滚轮 / +− 按钮 / 键盘三入口。
// 纯函数在 lib/avatarCrop.ts（Node 环境可单测）。
// ═══════════════════════════════════════════════════════════

// ── 裁剪控件 ──
const PREVIEW_SIZE = 128   // 实时预览圆图画布（CSS 像素）
const MIN_CROP = 24        // 最小裁剪边（显示坐标）

function CropModal({ src, onDone, onCancel }: {
  src: string
  onDone: (dataUrl: string) => void
  onCancel: () => void
}) {
  const [crop, setCrop] = useState<CropRect>({ x: 0, y: 0, size: 100 })
  const [dragging, setDragging] = useState(false)
  const [imgLoaded, setImgLoaded] = useState(false)
  const imgRef = useRef<HTMLImageElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const previewRef = useRef<HTMLCanvasElement>(null)

  const boundsOf = useCallback(() => {
    const c = containerRef.current
    return { w: c?.clientWidth || 0, h: c?.clientHeight || 0 }
  }, [])

  // 初始化裁剪区域为图片中心的正方形
  const initCrop = useCallback(() => {
    const b = boundsOf()
    if (b.w < MIN_CROP || b.h < MIN_CROP) {return}
    setCrop(initialCrop(b))
  }, [boundsOf])

  // 滚轮缩放：以裁剪框中心为锚。用原生非 passive 监听，确保 preventDefault 生效。
  useEffect(() => {
    const el = containerRef.current
    if (!el) {return}
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      setCrop(prev => zoomCrop(prev, prev.size - e.deltaY * 0.4, boundsOf()))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [imgLoaded, boundsOf])

  // 实时圆形预览：把 img 的裁剪区域画进 canvas（圆形裁切）
  useEffect(() => {
    const img = imgRef.current
    const canvas = previewRef.current
    if (!img || !canvas || !imgLoaded || !img.naturalWidth) {return}
    const ctx = canvas.getContext('2d')
    if (!ctx) {return}
    const dpr = window.devicePixelRatio || 1
    const cssW = PREVIEW_SIZE, cssH = PREVIEW_SIZE
    if (canvas.width !== cssW * dpr) {canvas.width = cssW * dpr; canvas.height = cssH * dpr}
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, cssW, cssH)
    const scaleX = img.naturalWidth / (img.offsetWidth || 1)
    const scaleY = img.naturalHeight / (img.offsetHeight || 1)
    ctx.save()
    ctx.beginPath()
    ctx.arc(cssW / 2, cssH / 2, cssW / 2, 0, Math.PI * 2)
    ctx.clip()
    ctx.drawImage(
      img,
      crop.x * scaleX, crop.y * scaleY, crop.size * scaleX, crop.size * scaleY,
      0, 0, cssW, cssH,
    )
    ctx.restore()
  }, [crop, imgLoaded])

  // 拖拽：按下时记录抓取偏移，拖动不跳变；点在框外则把框心移到指针处
  const grabOffset = useRef({ x: 0, y: 0, inside: false })
  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault()
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) {return}
    const px = e.clientX - rect.left
    const py = e.clientY - rect.top
    const inside = px >= crop.x && px <= crop.x + crop.size && py >= crop.y && py <= crop.y + crop.size
    grabOffset.current = {
      x: inside ? px - crop.x : crop.size / 2,
      y: inside ? py - crop.y : crop.size / 2,
      inside,
    }
    if (!inside) {
      setCrop(prev => clampCrop({ ...prev, x: px - prev.size / 2, y: py - prev.size / 2 }, boundsOf()))
    }
    setDragging(true)
  }

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!dragging) {return}
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) {return}
    setCrop(prev => clampCrop({
      ...prev,
      x: e.clientX - rect.left - grabOffset.current.x,
      y: e.clientY - rect.top - grabOffset.current.y,
    }, boundsOf()))
  }

  const handleMouseUp = () => setDragging(false)

  // 键盘：方向键移动（Shift = 1px 精调），+/- 缩放
  const handleKeyDown = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 1 : 10
    const b = boundsOf()
    const nudge = (dx: number, dy: number) => {
      e.preventDefault()
      setCrop(prev => clampCrop({ ...prev, x: prev.x + dx, y: prev.y + dy }, b))
    }
    if (e.key === 'ArrowLeft') {nudge(-step, 0)}
    else if (e.key === 'ArrowRight') {nudge(step, 0)}
    else if (e.key === 'ArrowUp') {nudge(0, -step)}
    else if (e.key === 'ArrowDown') {nudge(0, step)}
    else if (e.key === '+' || e.key === '=') {e.preventDefault(); setCrop(prev => zoomCrop(prev, prev.size * 1.1, b))}
    else if (e.key === '-' || e.key === '_') {e.preventDefault(); setCrop(prev => zoomCrop(prev, prev.size * 0.9, b))}
    else if (e.key === 'Escape') {onCancel()}
  }

  const handleDone = async () => {
    const img = imgRef.current
    if (!img) {return}
    // 从显示坐标映射到原图坐标
    const scaleX = img.naturalWidth / img.offsetWidth
    const scaleY = img.naturalHeight / img.offsetHeight
    const dataUrl = await cropAvatar(
      src,
      Math.round(crop.x * scaleX),
      Math.round(crop.y * scaleY),
      Math.round(crop.size * scaleX),
      Math.round(crop.size * scaleY),
      AVATAR_SIZE,
    )
    onDone(dataUrl)
  }

  // 缩放百分比（相对图片短边）
  const zoomPct = imgLoaded && containerRef.current
    ? zoomPercent(crop, boundsOf())
    : 100

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 9999,
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    }} onKeyDown={(e) => { if (e.key === 'Escape') {onCancel()} }}>
      <div style={{
        background: 'var(--surface-0)', borderRadius: 12, padding: 16, maxWidth: '92vw', maxHeight: '92vh',
        display: 'flex', flexDirection: 'column', gap: 12,
      }}>
        <div style={{ fontSize: 14, fontWeight: 600 }}>裁剪头像 — 拖动调整位置 · 滚轮 / +− 调整大小 · 方向键微调</div>
        <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          {/* 左：图片 + 圆形取景框 */}
          <div
            ref={containerRef}
            tabIndex={0}
            role="application"
            aria-label="头像裁剪区域：拖动移动，滚轮缩放，方向键微调"
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
            onKeyDown={handleKeyDown}
            style={{
              position: 'relative', cursor: 'crosshair', overflow: 'hidden',
              maxHeight: '58vh', width: 'fit-content', lineHeight: 0,
              borderRadius: 8, outline: 'none', flex: 'none',
            }}
          >
            <img
              ref={imgRef}
              src={src}
              alt="裁剪"
              onLoad={() => { setImgLoaded(true); setTimeout(initCrop, 50) }}
              style={{ maxWidth: '100%', maxHeight: '58vh', display: 'block', userSelect: 'none', pointerEvents: 'none' }}
            />
            {imgLoaded && (
              <>
                {/* 框外压暗 */}
                <div style={{
                  position: 'absolute', left: crop.x, top: crop.y,
                  width: crop.size, height: crop.size,
                  boxShadow: '0 0 0 9999px rgba(0,0,0,0.45)',
                  borderRadius: '50%', pointerEvents: 'none',
                }} />
                {/* 圆形取景框描边 */}
                <div style={{
                  position: 'absolute', left: crop.x, top: crop.y,
                  width: crop.size, height: crop.size,
                  border: '2px solid #fff', borderRadius: '50%', pointerEvents: 'none',
                }} />
                {/* 三分构图线（仅框内可见的两细线） */}
                <div style={{
                  position: 'absolute', left: crop.x, top: crop.y, width: crop.size, height: crop.size,
                  borderRadius: '50%', overflow: 'hidden', pointerEvents: 'none',
                }}>
                  <div style={{ position: 'absolute', left: '33.33%', top: 0, bottom: 0, width: 1, background: 'rgba(255,255,255,0.55)' }} />
                  <div style={{ position: 'absolute', left: '66.66%', top: 0, bottom: 0, width: 1, background: 'rgba(255,255,255,0.55)' }} />
                  <div style={{ position: 'absolute', top: '33.33%', left: 0, right: 0, height: 1, background: 'rgba(255,255,255,0.55)' }} />
                  <div style={{ position: 'absolute', top: '66.66%', left: 0, right: 0, height: 1, background: 'rgba(255,255,255,0.55)' }} />
                </div>
              </>
            )}
          </div>

          {/* 右：实时圆形预览 + 缩放控制 */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, minWidth: 150 }}>
            <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>实时预览</div>
            <div style={{
              width: PREVIEW_SIZE, height: PREVIEW_SIZE, borderRadius: '50%', overflow: 'hidden',
              border: '1.5px solid var(--border-light)', background: 'var(--surface-100)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <canvas ref={previewRef} style={{ width: PREVIEW_SIZE, height: PREVIEW_SIZE, display: 'block' }} />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <button onClick={() => setCrop(p => zoomCrop(p, p.size * 0.9, boundsOf()))}
                aria-label="缩小裁剪框"
                style={{ width: 28, height: 28, borderRadius: 6, border: '1px solid var(--border-light)', background: 'var(--surface-0)', cursor: 'pointer', fontSize: 15 }}>−</button>
              <span style={{ fontSize: 11, color: 'var(--text-secondary)', minWidth: 40, textAlign: 'center' }}>{zoomPct}%</span>
              <button onClick={() => setCrop(p => zoomCrop(p, p.size * 1.1, boundsOf()))}
                aria-label="放大裁剪框"
                style={{ width: 28, height: 28, borderRadius: 6, border: '1px solid var(--border-light)', background: 'var(--surface-0)', cursor: 'pointer', fontSize: 15 }}>＋</button>
              <button onClick={initCrop}
                style={{ padding: '4px 10px', borderRadius: 6, border: '1px solid var(--border-light)', background: 'var(--surface-0)', cursor: 'pointer', fontSize: 11, color: 'var(--text-secondary)' }}>重置</button>
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={onCancel} style={{
            padding: '6px 16px', borderRadius: 6, border: '1px solid #d1d5db',
            background: 'var(--surface-100)', cursor: 'pointer', fontSize: 13,
          }}>取消</button>
          <button onClick={handleDone} disabled={!imgLoaded} style={{
            padding: '6px 16px', borderRadius: 6, border: 'none',
            background: imgLoaded ? '#3b82f6' : '#93c5fd', color: '#fff',
            cursor: imgLoaded ? 'pointer' : 'not-allowed', fontSize: 13,
          }}>确认裁剪</button>
        </div>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════
// ProfilePanel
// ═══════════════════════════════════════════════════════════
export default function ProfilePanel() {
  const profile = useStore(s => s.profile)
  const setProfile = useStore(s => s.setProfile)
  const [tagInput, setTagInput] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)
  const [cropSrc, setCropSrc] = useState<string | null>(null)

  // 持久化头像加载检测 - 如果 base64 损坏则清除
  useEffect(() => {
    if (profile.avatar && !profile.avatar.startsWith('data:image/')) {
      console.warn('[ProfilePanel] 头像数据无效，已清除')
      setProfile({ avatar: '' })
    }
  }, [])

  const handleAvatarUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file || !file.type.startsWith('image/')) {return}
    const reader = new FileReader()
    reader.onload = () => setCropSrc(reader.result as string)
    reader.readAsDataURL(file)
    // 重置 input 以允许重新选择同一文件
    e.target.value = ''
  }

  const handleCropDone = async (dataUrl: string) => {
    try {
      const compressed = await compressAvatar(dataUrl, AVATAR_SIZE)
      setProfile({ avatar: compressed })
    } catch {
      // 降级：直接使用裁剪结果
      setProfile({ avatar: dataUrl })
    }
    setCropSrc(null)
  }

  const handleRemoveAvatar = () => {
    setProfile({ avatar: '' })
  }

  const addTag = () => {
    const t = tagInput.trim()
    if (!t || profile.tags.includes(t) || profile.tags.length >= 10) {return}
    setProfile({ tags: [...profile.tags, t] })
    setTagInput('')
  }

  const removeTag = (i: number) => {
    setProfile({ tags: profile.tags.filter((_, idx) => idx !== i) })
  }

  return (
    <div style={{ padding: 20, height: '100%', overflowY: 'auto' }}>
        <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 20 }}>🎨 个性化</h2>

      {/* ═══ 头像 ═══ */}
      <div style={{ marginBottom: 24, textAlign: 'center' }}>
        <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }}
          onChange={handleAvatarUpload} />
        <div
          onClick={() => fileRef.current?.click()}
          style={{
            width: 80, height: 80, borderRadius: '50%', margin: '0 auto 8px',
            border: '2px dashed #d1d5db', cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            overflow: 'hidden', transition: 'border-color .2s',
            background: 'var(--surface-100)', position: 'relative',
          }}
          onMouseEnter={e => (e.currentTarget as HTMLElement).style.borderColor = '#93c5fd'}
          onMouseLeave={e => (e.currentTarget as HTMLElement).style.borderColor = '#d1d5db'}
        >
          {profile.avatar ? (
            <img src={profile.avatar} alt="头像" style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              onError={(e) => { (e.currentTarget as HTMLElement).style.display = 'none' }} />
          ) : (
            <span style={{ fontSize: 32, color: '#d1d5db' }}>👤</span>
          )}
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 4 }}>
          点击上传头像（支持裁剪）
          {profile.avatar && (
            <> · <span onClick={handleRemoveAvatar} style={{ color: '#ef4444', cursor: 'pointer' }}>移除</span></>
          )}
        </div>
      </div>

      {/* ═══ 裁剪弹窗 ═══ */}
      {cropSrc && (
        <CropModal
          src={cropSrc}
          onDone={handleCropDone}
          onCancel={() => setCropSrc(null)}
        />
      )}

      {/* ═══ 昵称 ═══ */}
      <div style={{ marginBottom: 16 }}>
        <label style={labelStyle}>昵称</label>
        <input
          value={profile.nickname}
          onChange={e => setProfile({ nickname: e.target.value })}
          placeholder="你的昵称..."
          maxLength={20}
          style={inputStyle}
        />
      </div>

      {/* ═══ 性别 ═══ */}
      <div style={{ marginBottom: 16 }}>
        <label style={labelStyle}>性别</label>
        <div style={{ display: 'flex', gap: 6 }}>
          {GENDER_OPTIONS.map(opt => (
            <button
              key={opt.value}
              onClick={() => setProfile({ gender: opt.value as any })}
              style={{
                flex: 1, padding: '6px 4px', borderRadius: 6, fontSize: 12,
                border: profile.gender === opt.value ? '2px solid #3b82f6' : '1px solid var(--border-light)',
                background: profile.gender === opt.value ? 'var(--accent-50)' : 'var(--surface-0)',
                cursor: 'pointer', transition: 'all .15s',
              }}
            >{opt.label}</button>
          ))}
        </div>
      </div>

      {/* ═══ 生日 ═══ */}
      <div style={{ marginBottom: 16 }}>
        <label style={labelStyle}>生日</label>
        <input
          type="date"
          value={profile.birthday}
          onChange={e => setProfile({ birthday: e.target.value })}
          style={inputStyle}
        />
      </div>

      {/* ═══ 标签 ═══ */}
      <div style={{ marginBottom: 16 }}>
        <label style={labelStyle}>标签（最多 10 个）</label>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
          {profile.tags.map((tag, i) => (
            <span key={i} style={{
              padding: '2px 10px', borderRadius: 12, fontSize: 12,
              background: 'var(--accent-50)', color: '#3b82f6', display: 'flex', alignItems: 'center', gap: 4,
            }}>
              {tag}
              <span onClick={() => removeTag(i)} style={{ cursor: 'pointer', fontWeight: 700 }}>×</span>
            </span>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            value={tagInput}
            onChange={e => setTagInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && addTag()}
            placeholder="输入标签..."
            maxLength={10}
            style={{ ...inputStyle, flex: 1 }}
          />
          <button onClick={addTag} style={{
            padding: '6px 12px', borderRadius: 6, border: '1px solid #d1d5db',
            background: 'var(--surface-100)', cursor: 'pointer', fontSize: 13,
          }}>添加</button>
        </div>
      </div>

      {/* ═══ 气泡颜色 ═══ */}
      <div style={{ marginBottom: 16 }}>
        <label style={labelStyle}>我的气泡颜色</label>
        <div style={{ display: 'flex', gap: 6 }}>
          {['var(--accent-50)', 'var(--red-100)', 'var(--green-100)', '#fff7ed', '#f5f3ff', '#fdf2f8', '#ecfeff', 'var(--surface-0)'].map(color => (
            <div
              key={color}
              onClick={() => setProfile({ bubbleColorUser: color })}
              style={{
                width: 28, height: 28, borderRadius: 14, background: color,
                border: profile.bubbleColorUser === color ? '2px solid #3b82f6' : '1px solid var(--border-light)',
                cursor: 'pointer', transition: 'all .15s',
              }}
            />
          ))}
        </div>
      </div>

      <div style={{ marginBottom: 16 }}>
        <label style={labelStyle}>Lumina 气泡颜色</label>
        <div style={{ display: 'flex', gap: 6 }}>
          {['var(--surface-100)', 'var(--green-100)', 'var(--accent-50)', '#fff7ed', '#f5f3ff', '#fdf2f8', '#ecfeff', 'var(--surface-0)'].map(color => (
            <div
              key={color}
              onClick={() => setProfile({ bubbleColorAgent: color })}
              style={{
                width: 28, height: 28, borderRadius: 14, background: color,
                border: profile.bubbleColorAgent === color ? '2px solid #f472b6' : '1px solid var(--border-light)',
                cursor: 'pointer', transition: 'all .15s',
              }}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

// ── 共享样式 ──
const labelStyle: React.CSSProperties = {
  display: 'block', fontSize: 13, fontWeight: 500, color: 'var(--text-primary)', marginBottom: 6,
}
const inputStyle: React.CSSProperties = {
  width: '100%', padding: '7px 10px', borderRadius: 6, border: '1px solid #d1d5db',
  fontSize: 13, outline: 'none', boxSizing: 'border-box',
}
