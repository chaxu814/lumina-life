import React, { useRef, useState, useCallback, useEffect } from 'react'
import { useStore } from '../stores/appStore'

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

// ── 裁剪控件 ──
function CropModal({ src, onDone, onCancel }: {
  src: string
  onDone: (dataUrl: string) => void
  onCancel: () => void
}) {
  const [crop, setCrop] = useState({ x: 0, y: 0, size: 100 })
  const [dragging, setDragging] = useState(false)
  const [imgLoaded, setImgLoaded] = useState(false)
  const imgRef = useRef<HTMLImageElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  // 初始化裁剪区域为图片中心的正方形
  const initCrop = useCallback(() => {
    const img = imgRef.current
    const container = containerRef.current
    if (!img || !container) return
    const displayW = img.offsetWidth
    const displayH = img.offsetHeight
    const minDim = Math.min(displayW, displayH)
    const size = Math.round(minDim * 0.7)
    setCrop({
      x: Math.round((displayW - size) / 2),
      y: Math.round((displayH - size) / 2),
      size,
    })
  }, [])

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault()
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return
    setDragging(true)
    setCrop(prev => ({
      ...prev,
      x: e.clientX - rect.left - prev.size / 2,
      y: e.clientY - rect.top - prev.size / 2,
    }))
  }

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!dragging) return
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return
    setCrop(prev => ({
      ...prev,
      x: Math.max(0, Math.min(e.clientX - rect.left - prev.size / 2, rect.width - prev.size)),
      y: Math.max(0, Math.min(e.clientY - rect.top - prev.size / 2, rect.height - prev.size)),
    }))
  }

  const handleMouseUp = () => setDragging(false)

  const handleDone = async () => {
    const img = imgRef.current
    if (!img) return
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

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 9999,
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    }}>
      <div style={{
        background: 'var(--surface-0)', borderRadius: 12, padding: 16, maxWidth: '90vw', maxHeight: '90vh',
        display: 'flex', flexDirection: 'column', gap: 12,
      }}>
        <div style={{ fontSize: 14, fontWeight: 600 }}>裁剪头像 — 拖动调整位置，滚轮调整大小</div>
        <div
          ref={containerRef}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          onWheel={(e) => {
            e.preventDefault()
            setCrop(prev => ({
              ...prev,
              size: Math.max(40, Math.min(prev.size - e.deltaY * 0.5, 500)),
            }))
          }}
          style={{ position: 'relative', cursor: 'crosshair', overflow: 'hidden', maxHeight: '60vh' }}
        >
          <img
            ref={imgRef}
            src={src}
            alt="裁剪"
            onLoad={() => { setImgLoaded(true); setTimeout(initCrop, 50) }}
            style={{ maxWidth: '100%', display: 'block', userSelect: 'none', pointerEvents: 'none' }}
          />
          {imgLoaded && (
            <div style={{
              position: 'absolute', left: crop.x, top: crop.y,
              width: crop.size, height: crop.size,
              border: '2px solid #fff', boxShadow: '0 0 0 9999px rgba(0,0,0,0.4)',
              borderRadius: 4, pointerEvents: 'none',
            }} />
          )}
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
    if (!file || !file.type.startsWith('image/')) return
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
    if (!t || profile.tags.includes(t) || profile.tags.length >= 10) return
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
