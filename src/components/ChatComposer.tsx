// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
import React, { useEffect, useRef, useState } from 'react'
import {
  IconBarChart, IconFile, IconFolder, IconImage, IconMonitor, IconScissors, IconUpload,
} from './Icons'

/**
 * ChatComposer —— 统一输入栏
 *
 * 2026-10-18：桌宠小窗的输入栏（+ ｜ 对话 ｜ 更多 ｜ 发送）被用户点名「做得不错」，
 * 要求把同一套结构搬到 Lumina Agent 与团队群聊，并保持观感一致。
 *
 * 这个组件只负责「长什么样」和「弹出层怎么开合」，所有业务动作都由 props 传进来：
 * 它不读 store、不发消息、不碰 agent —— 三个界面各自的发送逻辑（含 IME 处理、
 * 同步发送锁、附件解析）差别太大，硬塞进组件只会把差异藏进 if 里。
 *
 * 样式在 src/styles/composer.css，类名统一 cc- 前缀（chat composer）。
 */

export interface ComposerQuickOption {
  key: string
  label: string
  active: boolean
  onPick: () => void
}

export interface ComposerMenuItem {
  key: string
  /** 线性图标节点（2026-10-18：从 emoji 字符串改为 ReactNode，尺寸由 size 控制） */
  icon: React.ReactNode
  label: string
  /** 平铺到工具栏时用的短标签（不填则用 label）。2026-10-20 新增 */
  shortLabel?: string
  /** 右侧灰字：快捷键 / 当前值 / 数量 */
  hint?: string
  onClick?: () => void
  /** 开关行：右侧画一个胶囊开关，点一下切换 */
  toggle?: { on: boolean; onChange: (v: boolean) => void }
  disabled?: boolean
  /** 与上一项之间加一条分隔线 */
  dividerBefore?: boolean
  /** 快捷选择：横向一排小胶囊，点一下即生效（Lucky Agent 的预设就用这个） */
  quick?: ComposerQuickOption[]
  /** 高亮当前项（例如「思考」已开启） */
  active?: boolean
}

export interface ComposerAttachment {
  name: string
  size?: number
  /** 图片附件的缩略图 */
  dataUrl?: string
}

export interface ChatComposerProps {
  value: string
  onChange: (v: string) => void
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void
  onPaste?: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void
  placeholder?: string
  textareaRef?: React.RefObject<HTMLTextAreaElement | null>
  /** 切换这个 key 会重新挂载 textarea（Electron 从别的面板回来时修焦点用） */
  textareaKey?: string
  minHeight?: number
  disabled?: boolean

  attachments?: ComposerAttachment[]
  onRemoveAttachment?: (i: number) => void
  onPickFiles: () => void
  onScreenshot?: () => void
  onSearch?: (q: string) => void
  searchPlaceholder?: string

  moreItems?: ComposerMenuItem[]
  /**
   * 要**平铺**到输入栏下方的项（key 列表）。未列出的项仍收在「更多」弹层里。
   * 2026-10-20：用户反馈「更多」点开才看见太绕，主流产品（豆包等）是平铺一行。
   */
  inlineKeys?: string[]
  /** 「对话 ›」胶囊（Lumina Agent 用来切会话，群聊不需要） */
  convSlot?: React.ReactNode
  /** 输入框右下角的模型选择器 */
  modelSlot?: React.ReactNode

  /** 输入卡片**上方**的自定义区块（「为你推荐」等）。2026-10-20 新增 */
  aboveCard?: React.ReactNode

  sending?: boolean
  canSend?: boolean
  onSend: () => void
  onAbort?: () => void

  /** 需要挂在输入卡片内的浮层（表情面板等） */
  overlay?: React.ReactNode
  /** 输入卡片上方的一行小字（附件提示、状态等） */
  hint?: React.ReactNode
  /** 输入卡片下方的一行小字 */
  footerNote?: React.ReactNode
}

type PopKey = 'plus' | 'more' | null

export default function ChatComposer(props: ChatComposerProps) {
  const {
    value, onChange, onKeyDown, onPaste, placeholder, textareaRef, textareaKey,
    minHeight = 52, disabled,
    attachments = [], onRemoveAttachment, onPickFiles, onScreenshot, onSearch,
    searchPlaceholder = '搜索…',
    moreItems = [], convSlot, modelSlot,
    inlineKeys = [], aboveCard,
    sending, canSend, onSend, onAbort,
    overlay, hint, footerNote,
  } = props

  const [pop, setPop] = useState<PopKey>(null)
  const [search, setSearch] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)

  // 点空白处关掉弹层。用 mousedown 而不是 click：
  // 弹层里的按钮如果先触发 mousedown 就把自己关了，click 就落空了。
  useEffect(() => {
    if (!pop) { return }
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node | null
      if (rootRef.current && t && rootRef.current.contains(t)) { return }
      setPop(null)
    }
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') { setPop(null) } }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onEsc)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onEsc)
    }
  }, [pop])

  useEffect(() => { if (pop !== 'plus') { setSearch('') } }, [pop])

  const togglePop = (k: Exclude<PopKey, null>) => {
    setPop(p => (p === k ? null : k))
  }
  const close = () => setPop(null)

  const runItem = (item: ComposerMenuItem) => {
    if (item.disabled) { return }
    if (item.toggle) {
      item.toggle.onChange(!item.toggle.on)
      return
    }
    close()
    item.onClick?.()
  }

  const showPlus = !disabled
  const sendable = !!canSend

  // 平铺 / 收纳的划分：inlineKeys 里有的进工具栏，其余仍收在「更多」。
  // 用 key 而不是位置，避免调用方调整顺序时把某两项对调错位。
  const inlineSet = new Set(inlineKeys)
  const inlineItems = moreItems.filter(i => inlineSet.has(i.key))
  const overflowItems = moreItems.filter(i => !inlineSet.has(i.key))

  return (
    <div className="cc-root" ref={rootRef}>
      {hint}
      {aboveCard}

      <div className={'cc-card' + (disabled ? ' cc-card-disabled' : '')}>
        {/* ── 附件条 ── */}
        {attachments.length > 0 && (
          <div className="cc-attach">
            {attachments.map((a, i) => (
              <span key={`${a.name}-${i}`} className="cc-chip" title={a.name}>
                {a.dataUrl
                  ? <img src={a.dataUrl} alt="" />
                  : <span className="cc-chip-ico">{fileIcon(a.name)}</span>}
                <span className="cc-chip-name">{a.name}</span>
                {onRemoveAttachment && (
                  <button type="button" className="cc-chip-x" title="移除"
                    onClick={() => onRemoveAttachment(i)}>×</button>
                )}
              </span>
            ))}
          </div>
        )}

        {/* ── 文本域 ── */}
        <div className="cc-input-wrap">
          <textarea
            key={textareaKey}
            ref={textareaRef}
            className="cc-input"
            value={value}
            placeholder={placeholder}
            onChange={e => onChange(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            rows={1}
            disabled={disabled}
            style={{ minHeight }}
          />
          <div className="cc-send-wrap">
            {modelSlot}
            {sending ? (
              <button type="button" className="cc-stop" onClick={() => onAbort?.()} title="中断回复">
                <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
                  <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" strokeWidth="2.5"
                    strokeDasharray="50 50" strokeLinecap="round" />
                </svg>
                <span>中断</span>
              </button>
            ) : (
              <button type="button" className={'cc-send' + (sendable ? ' cc-send-on' : '')}
                onClick={() => { if (sendable) { onSend() } }}
                disabled={!sendable}
                aria-label="发送消息" title="发送消息（Enter）">
                <svg width="17" height="17" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M12 4.25 3.8 12.9c-.33.35-.08.93.4.93h4.35v5.42c0 .3.24.54.54.54h5.82c.3 0 .54-.24.54-.54v-5.42h4.35c.48 0 .73-.58.4-.93L12 4.25Z"
                    fill="currentColor" />
                </svg>
              </button>
            )}
          </div>
        </div>

        {/* ── 底部一行：+ ｜ 对话 ｜ 平铺工具 ｜ 更多 ── */}
        <div className="cc-foot">
          {showPlus && (
            <button type="button" className={'cc-plus' + (pop === 'plus' ? ' open' : '')}
              onClick={() => togglePop('plus')} title="添加（上传文件 / 截图提问）">
              <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </button>
          )}
          {convSlot}
          {inlineItems.length > 0 && (
            <div className="cc-tools">
              {inlineItems.map(item => (
                <button type="button" key={item.key}
                  className={'cc-tool'
                    + (item.active || item.toggle?.on ? ' on' : '')
                    + (item.disabled ? ' off' : '')}
                  title={item.hint ? `${item.label} · ${item.hint}` : item.label}
                  onClick={() => runItem(item)}>
                  <span className="cc-tool-ico">{item.icon}</span>
                  <span className="cc-tool-label">{item.shortLabel || item.label}</span>
                  {item.toggle && <span className={'cc-tool-dot' + (item.toggle.on ? ' on' : '')} />}
                </button>
              ))}
            </div>
          )}
          {overflowItems.length > 0 && (
            <button type="button" className={'cc-pill' + (pop === 'more' ? ' on' : '')}
              onClick={() => togglePop('more')} title="更多功能">
              更多<span className="cc-chev">›</span>
            </button>
          )}
          <div style={{ flex: 1 }} />
          {footerNote}
        </div>

        {/* ── 「+」弹层 ── */}
        {pop === 'plus' && (
          <div className="cc-pop" style={{ left: 0, width: 248 }}>
            <div className="cc-pop-head">添加</div>
            <button type="button" className="cc-pop-item" onClick={() => { close(); onPickFiles() }}>
              <span className="cc-pop-ico"><IconUpload size={16} /></span>
              <span className="cc-pop-label">上传文件或图片</span>
              <span className="cc-pop-kbd">Ctrl+1</span>
            </button>
            {onScreenshot && (
              <button type="button" className="cc-pop-item" onClick={() => { close(); onScreenshot() }}>
                <span className="cc-pop-ico"><IconScissors size={16} /></span>
                <span className="cc-pop-label">截图提问</span>
                <span className="cc-pop-kbd">Ctrl+4</span>
              </button>
            )}
            {onSearch && (
              <input className="cc-pop-search" placeholder={searchPlaceholder}
                value={search} autoFocus
                onChange={e => setSearch(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && search.trim()) { close(); onSearch(search.trim()) }
                }} />
            )}
          </div>
        )}

        {/* ── 「更多」弹层（只放未平铺的项） ── */}
        {pop === 'more' && (
          <div className="cc-pop" style={{ left: 34, width: 262 }}>
            <div className="cc-pop-head">更多</div>
            {overflowItems.map(item => (
              <React.Fragment key={item.key}>
                {item.dividerBefore && <div className="cc-pop-sep" />}
                <div className={'cc-pop-row' + (item.active ? ' on' : '') + (item.disabled ? ' off' : '')}>
                  <button type="button" className="cc-pop-item" onClick={() => runItem(item)}
                    title={item.hint || item.label}>
                    <span className="cc-pop-ico">{item.icon}</span>
                    <span className="cc-pop-label">{item.label}</span>
                    {item.toggle ? (
                      <span className={'cc-sw' + (item.toggle.on ? ' on' : '')}>
                        <span className="cc-sw-dot" />
                      </span>
                    ) : item.hint ? (
                      <span className="cc-pop-kbd">{item.hint}</span>
                    ) : null}
                  </button>
                  {item.quick && item.quick.length > 0 && (
                    <div className="cc-quick">
                      {item.quick.map(o => (
                        <button type="button" key={o.key}
                          className={'cc-quick-btn' + (o.active ? ' on' : '')}
                          onClick={() => o.onPick()}>
                          {o.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </React.Fragment>
            ))}
          </div>
        )}

        {overlay}
      </div>
    </div>
  )
}

function fileIcon(name: string): React.ReactNode {
  const n = (name || '').toLowerCase()
  if (/\.(png|jpe?g|gif|webp|svg|bmp)$/.test(n)) { return <IconImage size={14} /> }
  if (/\.(pdf|docx?|txt|md)$/.test(n)) { return <IconFile size={14} /> }
  if (/\.(xlsx?|csv)$/.test(n)) { return <IconBarChart size={14} /> }
  if (/\.(py|js|ts|tsx|java|cpp|c|h|html|css|json|xml|sh|bat|ps1)$/.test(n)) { return <IconMonitor size={14} /> }
  return <IconFolder size={14} />
}
