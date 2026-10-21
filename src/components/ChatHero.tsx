import React from 'react'

/**
 * ChatHero —— 空会话的「落地页」头部（2026-10-21）
 *
 * 用户拿豆包截图对比后明确要求：空对话不要「角色头像 + XX 已就绪」，
 * 要「大标题 + 对话/工作 分段控件 + 下方推荐」的版式。
 *
 * 这里只做版式，不碰业务：
 * - tabs 由调用方给（团队群聊映射 chat/work 任务类型，单聊映射 general/colleague）；
 * - children 放「为你推荐」，这样推荐与标题同处一个内容列，窗口矮时会一起滚动，
 *   而不是像之前那样被钉在输入框上方、把欢迎语挤没。
 */
export interface ChatHeroTab {
  key: string
  label: string
}

export interface ChatHeroProps {
  title?: string
  tabs?: ChatHeroTab[]
  /** 当前高亮的分段 key；传空字符串表示都不高亮（例如用户选了「代码开发」这类非二选一角色） */
  activeTab?: string
  onTabChange?: (key: string) => void
  children?: React.ReactNode
}

export default function ChatHero(props: ChatHeroProps) {
  const { title = '有什么我能帮你的吗？', tabs = [], activeTab = '', onTabChange, children } = props

  return (
    <div className="ch-root">
      <h1 className="ch-title">{title}</h1>

      {tabs.length > 0 && (
        <div className="ch-seg" role="tablist" aria-label="对话模式">
          {tabs.map(t => {
            const on = activeTab === t.key
            return (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={on}
                className={'ch-seg-btn' + (on ? ' on' : '')}
                onClick={() => { if (!on) { onTabChange?.(t.key) } }}
              >
                {t.label}
              </button>
            )
          })}
        </div>
      )}

      {children ? <div className="ch-body">{children}</div> : null}
    </div>
  )
}
