// ============================================================
// components/LinkifiedText.tsx — 把消息正文里的 URL 渲染成可点击链接
//
// 点击在内置浏览器（window.luminaAPI.openBrowser）打开，
// 不走系统默认浏览器、不弹新窗。只放行 http/https。
// 换行由外层 pre-wrap 保留；超长链接用 overflowWrap 断行。
// ============================================================
import React from 'react'
import { linkify } from '../utils/linkifyText'

interface LinkifiedTextProps {
  text: string
}

export default function LinkifiedText({ text }: LinkifiedTextProps) {
  const tokens = linkify(text)
  return (
    <>
      {tokens.map((t, i) => {
        if (t.type === 'link' && t.href) {
          const href = t.href
          return (
            <a
              key={i}
              href={href}
              onClick={(e) => {
                e.preventDefault()
                // 防御：只放行 http/https，javascript:/data: 等一律不点
                if (!/^https?:\/\//i.test(href)) return
                try {
                  void window.luminaAPI?.openBrowser?.(href)
                } catch { /* 忽略 */ }
              }}
              style={{
                color: 'var(--accent-600, #6366f1)',
                textDecoration: 'underline',
                textDecorationColor: 'rgba(99,102,241,0.35)',
                textUnderlineOffset: 2,
                cursor: 'pointer',
                overflowWrap: 'anywhere',
                wordBreak: 'break-word',
              }}
            >
              {t.text}
            </a>
          )
        }
        return <React.Fragment key={i}>{t.text}</React.Fragment>
      })}
    </>
  )
}
