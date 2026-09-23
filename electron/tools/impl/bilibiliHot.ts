// ============================================================
// impl/bilibiliHot.ts — B站热搜/热门榜推送工具
//
// 数据源: https://api.bilibili.com/x/web-interface/popular （官方公开接口，无需 Key）
// 工具:
//   - bilibili_hot_search: 拉取 B站热门视频榜，返回可读列表
//   - bilibili_hot_push:   主动推送模式，格式化热搜文本并通过通知提醒
// ============================================================

import type { ToolDef, ToolResult } from '../types'
import { httpGet } from '../utils/httpClient'

const BILIBILI_POPULAR_URL = 'https://api.bilibili.com/x/web-interface/popular?ps=20&pn=1'
const REQUEST_TIMEOUT_MS = 10000

interface BilibiliItem {
  title?: string
  bvid?: string
  short_link_v2?: string
  owner?: { name?: string; mid?: number }
  stat?: { view?: number; like?: number; danmaku?: number }
}

/** 调用 B站热门榜 API，返回解析后的列表（已截断到 limit 条） */
async function fetchBilibiliHot(limit: number): Promise<BilibiliItem[]> {
  const resp = await httpGet(
    BILIBILI_POPULAR_URL,
    { Referer: 'https://www.bilibili.com/', 'User-Agent': 'Lumina/1.0' },
    REQUEST_TIMEOUT_MS,
  )

  if (!resp.ok) {
    throw new Error(`B站 API 返回 HTTP ${resp.status}`)
  }

  let json: any
  try {
    json = JSON.parse(resp.text)
  } catch {
    throw new Error('B站 API 返回内容不是合法 JSON')
  }

  // code=0 表示成功；data.list 是热门视频数组
  if (json && json.code !== 0) {
    throw new Error(`B站 API 错误: ${json?.message || '未知错误'} (code=${json?.code})`)
  }

  const list = json?.data?.list
  if (!Array.isArray(list)) {
    throw new Error('B站 API 返回数据格式异常（缺少 data.list）')
  }

  return (list as BilibiliItem[]).slice(0, Math.max(1, limit))
}

/** 把榜单数据格式化为易读文本 */
export function formatBilibiliHot(items: BilibiliItem[]): string {
  if (items.length === 0) {
    return '🔥 B站热门榜: 当前没有可展示的内容。'
  }

  const lines = items.map((it, i) => {
    const rank = `${i + 1}.`.padEnd(4, ' ')
    const title = (it.title || '(无标题)').trim()
    const owner = it.owner?.name ? `  @${it.owner.name}` : ''
    const views = it.stat?.view != null ? `  👀 ${Number(it.stat.view).toLocaleString()}` : ''
    const url = it.short_link_v2 || (it.bvid ? `https://www.bilibili.com/video/${it.bvid}` : '')
    return `${rank}${title}${owner}${views}\n     ${url || '(链接缺失)'}`
  })

  return `🔥 B站热门榜 Top ${items.length}\n（数据来源: bilibili.com/popular）\n\n${lines.join('\n')}`
}

/** 主进程内发送系统通知（Electron Notification 优先，失败则静默） */
function pushNotification(title: string, body: string): void {
  try {
    const electron = require('electron')
    const Notification = electron?.Notification
    if (Notification && typeof Notification === 'function') {
      new Notification({ title, body: body.slice(0, 200) }).show()
      return
    }
  } catch { /* 非 Electron 主进程环境，忽略 */ }
  console.log(`[bilibili_hot_push] 通知: ${title} — ${body.slice(0, 80)}`)
}

// ── 工具 1: 拉取热门榜 ──────────────────────────────────

export const bilibiliHotSearchDef: ToolDef = {
  name: 'bilibili_hot_search',
  description: `拉取 B站热门视频榜（官方公开接口，无需登录/Key）。
返回排名、标题、UP主、播放量与链接。

参数:
- limit: 返回条数 (1-20, 默认 10)`,
  params: {
    limit: { type: 'number', description: '返回条数 (1-20)', required: false },
  },
  toolsets: ['agent'],
}

export async function bilibiliHotSearch(args: Record<string, any>): Promise<ToolResult> {
  const limit = Math.min(20, Math.max(1, Number(args.limit) || 10))

  try {
    const items = await fetchBilibiliHot(limit)
    return { callId: '', ok: true, content: formatBilibiliHot(items) }
  } catch (err: any) {
    return {
      callId: '',
      ok: false,
      content: '',
      error: `获取 B站热门榜失败: ${err?.message || err}`,
    }
  }
}

// ── 工具 2: 主动推送 ──────────────────────────────────

export const bilibiliHotPushDef: ToolDef = {
  name: 'bilibili_hot_push',
  description: `主动推送模式：拉取 B站热门榜，格式化为可读文本，并通过系统通知推送提醒。
适合定时任务 / 主动唤起场景。

参数:
- limit: 返回条数 (1-10, 默认 5)`,
  params: {
    limit: { type: 'number', description: '推送条数 (1-10)', required: false },
  },
  toolsets: ['agent'],
}

export async function bilibiliHotPush(args: Record<string, any>): Promise<ToolResult> {
  const limit = Math.min(10, Math.max(1, Number(args.limit) || 5))

  try {
    const items = await fetchBilibiliHot(limit)
    const text = formatBilibiliHot(items)

    // 推送通知：标题 + 第一条标题作为摘要
    const firstTitle = items[0]?.title || ''
    pushNotification('🔥 B站热门榜已更新', `Top ${items.length}：${firstTitle}`)

    return {
      callId: '',
      ok: true,
      content: `✅ 已推送 B站热门榜 Top ${items.length}。\n\n${text}`,
    }
  } catch (err: any) {
    return {
      callId: '',
      ok: false,
      content: '',
      error: `推送 B站热门榜失败: ${err?.message || err}`,
    }
  }
}
