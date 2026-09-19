// ============================================================
// agentNotify.ts — Agent 回复完成的 Windows 后台通知
//
// 当主窗口不在前台（未聚焦 / 最小化 / 隐藏到托盘）时，
// Agent（Lumina / Team Agent）回复完成后弹出系统 Toast 通知，
// 点击通知回到应用。窗口在前台时静默，不打扰正常聊天。
//
// 连续多条回复（群聊多 Agent 快速连发）在合并窗口内自动合并为
// 一条通知，例如「Yak 🔧 等 3 条新回复」。
// ============================================================

import { Notification, BrowserWindow } from 'electron'

const AGENT_NAMES: Record<string, string> = {
  lumina: 'Lumina 🐱',
  yak: 'Yak 🔧',
  recha: '热茶 🫖',
}

/** 连续回复合并窗口（ms） */
const MERGE_WINDOW_MS = 2500
/** 通知正文最大长度 */
const MAX_BODY = 160

let pendingCount = 0
let pendingWho = ''
let pendingBody = ''
let flushTimer: ReturnType<typeof setTimeout> | null = null

/** 去掉 Markdown 标记，取纯文本预览 */
function stripMarkdown(text: string): string {
  return (text || '')
    .replace(/```[\s\S]*?```/g, '［代码］')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_#>~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 主窗口是否处于后台（未聚焦 / 最小化 / 隐藏） */
function isBackground(win: BrowserWindow | null | undefined): boolean {
  if (!win || win.isDestroyed()) {return false}
  try {
    return !win.isFocused() || win.isMinimized() || !win.isVisible()
  } catch {
    return false
  }
}

function resetPending(): void {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }
  pendingCount = 0
  pendingWho = ''
  pendingBody = ''
}

function flushNow(win: BrowserWindow | null | undefined): void {
  flushTimer = null
  if (pendingCount <= 0) {return}
  const count = pendingCount
  const who = pendingWho
  const body = pendingBody
  pendingCount = 0
  pendingWho = ''
  pendingBody = ''

  // 合并等待期间用户已回到前台 → 不打扰
  if (!isBackground(win)) {return}

  try {
    if (!Notification.isSupported()) {return}
    const title = count > 1 ? `${who} 等 ${count} 条新回复` : `${who} 已回复`
    const notif = new Notification({
      title,
      body: body.slice(0, MAX_BODY) + (body.length > MAX_BODY ? '…' : ''),
      silent: false,
    })
    notif.on('click', () => {
      try {
        if (win && !win.isDestroyed()) {
          if (win.isMinimized()) {win.restore()}
          win.show()
          win.focus()
        }
      } catch { /* ignore */ }
    })
    notif.show()
    console.log(`[agentNotify] 🔔 已发送后台通知: ${title}`)
  } catch (e) {
    console.warn('[agentNotify] 通知发送失败:', e)
  }
}

/**
 * Agent 回复完成时调用（由 agent:chat 处理器触发）。
 * 仅在主窗口处于后台时弹出 Windows 通知；连续多条自动合并。
 */
export function notifyAgentReply(
  mainWindow: BrowserWindow | null | undefined,
  opts: { personaId?: string; isGroupChat?: boolean; body: string },
): void {
  try {
    // 前台正在看 → 不打扰，并撤销尚未发出的合并通知
    if (!isBackground(mainWindow)) {
      if (flushTimer) {resetPending()}
      return
    }

    const who = opts.isGroupChat
      ? (AGENT_NAMES[opts.personaId || ''] || opts.personaId || 'Team Agent 🤖')
      : 'Lumina 🐱'

    pendingCount += 1
    pendingWho = who
    pendingBody = stripMarkdown(opts.body)

    if (!flushTimer) {
      flushTimer = setTimeout(() => flushNow(mainWindow), MERGE_WINDOW_MS)
    }
  } catch (e) {
    console.warn('[agentNotify] notifyAgentReply 异常:', e)
  }
}
