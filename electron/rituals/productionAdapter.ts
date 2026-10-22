// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// rituals/productionAdapter.ts — 生产环境依赖适配器
//
// 所有 require 都写在函数体内（懒加载）：
//   - 测试/冷启动不会硬拉 petWindow / pythonManager / dayreplay
//   - 被依赖模块缺失时按约定降级（抛错 → 上层模板兜底）
// ============================================================

import type { RitualDeps } from './types'
import type { MorningSources } from './morningBrief'

/** 默认天气城市（内置城市表中的用户所在城市） */
const DEFAULT_WEATHER_CITY = '河池'

export function productionDeps(): RitualDeps {
  return {
    buildDailyReplay: (): any => {
      // 并行功能：electron/dayreplay 尚未合入时抛错 → 睡前复盘走「无数据」模板
      const { getDayReplay } = require('../dayreplay')
      return getDayReplay().buildDailyReplay()
    },

    llmGenerate: async (prompt: string, opts?: { maxTokens?: number }) => {
      // 与 main.ts lifeLLMCall 同模式：复用桌宠大脑配置；未配置则抛错 → 模板兜底
      const pw = require('../pet/petWindow')
      const cfg = pw.resolvePetBrainConfig()
      if (!cfg) {throw new Error('LLM not configured for rituals')}
      const provider = pw.createPetLLM(cfg)
      const res = await provider.call({
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.9,
        maxTokens: opts?.maxTokens ?? 420,
      })
      return { text: res?.text || '', source: 'llm' as const }
    },

    ttsSpeak: async (text: string) => {
      // 与 systemIpc.ts edge-tts:speak 同通道：POST Python Node /tts
      // 起不来（Python Node 未运行/超时）返回 {ok:false, detail}，detail 不吞
      try {
        const pm = require('../pythonManager')
        const status = pm.getPythonManagerStatus()
        const port = status?.httpPort || 18925
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 30000)
        try {
          const res = await fetch(`http://127.0.0.1:${port}/tts`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, voice: 'zh-CN-XiaoxiaoNeural', speed: 1.0 }),
            signal: controller.signal,
          })
          clearTimeout(timer)
          if (!res.ok) {return { ok: false, detail: `TTS 服务返回 HTTP ${res.status}` }}
          const data = await res.json()
          const hexStr = typeof data?.audio === 'string' ? data.audio : ''
          if (Buffer.from(hexStr, 'hex').length < 100) {
            return { ok: false, detail: 'TTS 返回数据过短或格式异常' }
          }
          return { ok: true }
        } catch (e: any) {
          clearTimeout(timer)
          return { ok: false, detail: e?.name === 'AbortError' ? 'TTS 请求超时' : (e?.message || String(e)) }
        }
      } catch (e: any) {
        return { ok: false, detail: `TTS 通道不可用: ${e?.message || e}` }
      }
    },

    showBubble: (text: string) => {
      try {
        require('../pet/petWindow').sendPetCommand({ type: 'say', text })
      } catch {
        /* 桌宠未启动：气泡通道不存在，上层记 delivered='none' */
      }
    },

    petAction: (motion: string, expression?: string) => {
      try {
        require('../pet/petWindow').sendPetCommand({
          type: 'intent',
          intent: { action: motion, mood: expression || 'gentle' },
        })
      } catch {
        /* 桌宠未启动 */
      }
    },

    budgetAllows: () => {
      try {
        return require('../billing/budgetGuardian').getBudgetGuardian().isNonEssentialCallAllowed()
      } catch {
        return true
      }
    },
  }
}

/** 晨间素材源（全部懒加载 impl 函数；失败由上层 collectMorningDigest 降级） */
export function productionMorningSources(): MorningSources {
  return {
    weather: async () => {
      const { weatherBrief } = require('../tools/impl/weatherBrief')
      const r = await weatherBrief({ city: DEFAULT_WEATHER_CITY })
      if (!r?.ok) {throw new Error(r?.error || '天气查询失败')}
      return String(r.content || '')
    },
    calendar: async () => {
      const { calendarList } = require('../tools/impl/calendar')
      const r = await calendarList({ days: 1 })
      if (!r?.ok) {throw new Error(r?.error || '日历读取失败')}
      return String(r.content || '')
    },
    todo: async () => {
      const { todo } = require('../tools/impl/todo')
      const r = await todo({ action: 'list' })
      if (!r?.ok) {throw new Error(r?.error || '待办读取失败')}
      return String(r.content || '')
    },
    tasks: async () => {
      const { getTaskBoard } = require('../orchestration/taskBoard')
      const board = getTaskBoard()
      const nodes: Array<{ title?: string; status?: string }> = (board as any)?.nodes || []
      const open = nodes.filter(n => n && n.status && n.status !== 'done' && n.status !== 'failed')
      if (!open.length) {return ''}
      return open.slice(0, 5).map(n => `「${n.title}」`).join('、')
    },
  }
}
