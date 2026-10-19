// ============================================================
// PersonaAvatar — Agent 头像统一渲染
//
// 2026-10-19：Lumina 的头像从 emoji（🐱）换成正式立绘
// （src/assets/lumina-avatar.png，源图 1440×1440）。
// 其他成员（Yak 📊 / 热茶 🍵 / 自定义 Agent）继续用 emoji图标。
//
// 为什么单独抽组件而不是在各处写三元：
//   聊天消息（3 处）、思考指示器、流式气泡、顶栏人格标签、
//   群聊 feed 都要渲染头像，此前每处都是 `persona?.icon || '🐱'`
//   手写兜底——立绘上线时漏改任何一处都会出现「一半🐱一半照片」。
// ============================================================

import type { CSSProperties } from 'react'
import luminaAvatar from '../assets/lumina-avatar.png'

interface PersonaAvatarProps {
  /** persona.id；lumina 用立绘，其余用 emoji */
  personaId?: string
  /** persona.icon（emoji）；personaId 非 lumina 时使用 */
  icon?: string
  /** 像素边长 */
  size?: number
  /** 圆形裁剪（默认 true） */
  circle?: boolean
  style?: CSSProperties
}

export function PersonaAvatar({
  personaId,
  icon,
  size = 32,
  circle = true,
  style,
}: PersonaAvatarProps) {
  if (personaId === 'lumina') {
    return (
      <img
        src={luminaAvatar}
        alt="Lumina"
        width={size}
        height={size}
        style={{
          width: size,
          height: size,
          objectFit: 'cover',
          borderRadius: circle ? '50%' : undefined,
          flex: 'none',
          display: 'block',
          ...style,
        }}
      />
    )
  }
  return (
    <span
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.56),
        lineHeight: 1,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flex: 'none',
        fontFamily: '"Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif',
        ...style,
      }}
    >
      {icon || '🐱'}
    </span>
  )
}

export default PersonaAvatar
