// ============================================================
// impl/weather.ts — 天气查询工具 (v2.5)
//
// 无 API Key 的天气查询，使用 wttr.in 免费服务
// ============================================================

import type { ToolDef, ToolResult } from '../types'

export const weatherDef: ToolDef = {
  name: 'weather',
  description: `查询指定城市的当前天气和未来预报。

参数:
- city: 城市名称 (支持中文，如 "北京", "上海", "Tokyo", "New York")
- days: 预报天数 (1-3, 默认 1)`,
  params: {
    city: { type: 'string', description: '城市名称', required: true },
    days: { type: 'number', description: '预报天数 (1-3)', required: false },
  },
  toolsets: ['agent', 'chat'],
}

export async function weather(args: Record<string, any>): Promise<ToolResult> {
  const { city, days = 1 } = args

  if (!city) {
    return { callId: '', ok: false, content: '', error: '需要提供 city 参数' }
  }

  try {
    const encodedCity = encodeURIComponent(city)
    const formatParam = days > 1 ? '?format=j1' : '?format=3'
    const url = `https://wttr.in/${encodedCity}${formatParam}`

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 8000)

    const response = await fetch(url, {
      headers: { 'User-Agent': 'Lumina/2.5' },
      signal: controller.signal,
    })
    clearTimeout(timeout)

    if (!response.ok) {
      return { callId: '', ok: false, content: '', error: `天气查询失败: HTTP ${response.status}` }
    }

    const text = await response.text()

    // 格式化为易读输出
    const lines = text.split('\n').filter(l => l.trim())
    const summary = lines.slice(0, Math.min(lines.length, 15)).join('\n')

    return {
      callId: '',
      ok: true,
      content: `🌤️ ${city} 天气:\n\n${summary}`,
    }
  } catch (err: any) {
    if (err.name === 'AbortError') {
      return { callId: '', ok: false, content: '', error: '天气查询超时，请检查网络连接' }
    }
    return {
      callId: '',
      ok: false,
      content: '',
      error: `天气查询失败: ${err.message}`,
    }
  }
}
