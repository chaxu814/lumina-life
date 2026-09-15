// ============================================================
// proactiveEngine.ts — 24/7 主动对话引擎 (v2.5 增强版)
//
// 触发类型:
//   1. time     — cron 式定时话题 (早安/午安/晚安)
//   2. idle     — 监测用户不活跃时长
//   3. event    — 应用事件触发 (启动/长会话)
//   4. opportunity — 根据上次对话内容评估是否该搭话
//   5. screen_watch — 🆕 周期性屏幕感知搭话
//   6. hot_topic — 🆕 社交媒体热搜感知
//   7. personal_rhythm — 🆕 用户作息规律学习
//
// 屏幕感知流程:
//   截图 → VLM分析 → 评估是否值得搭话 → 生成自然搭话内容
//   "哇你在写React组件啊，这个useEffect的依赖数组是不是少了个变量？"
//   "看到你在看B站视频！是什么有趣的视频呀？"
//
// 热搜感知流程:
//   获取B站/微博热搜 → LLM评估与用户相关性 → 生成搭话
//   "今天热搜上有XX事件，你有关注吗？"
//
// 🆕 Daily Paper 流程:
//   获取arXiv论文 → LLM筛选与摘要 → 生成每日论文推送
//   "今日arXiv精选: XX论文，简述..."
// ============================================================

import { EventEmitter } from 'events'
import * as cp from 'child_process'
import * as path from 'path'
import * as os from 'os'
import * as fs from 'fs'
import https from 'https'
import http from 'http'
import screenshot from 'screenshot-desktop'
import { Notification } from 'electron'
import { stripMarkdown } from './utils/stripMarkdown'
import { globalEventBus, BusEvents } from './eventBus'
import { postObservation, postThought } from './moments/autoPoster'  // 🌸 v2.10
import { hasTodayMomentWithKeyword } from './moments/momentsStore'  // 🔧 v2.12: 每日去重
import { llmCoordinator, PRIORITY } from './llmCoordinator'  // 🆕 v2.18: 智能 LLM 调度
import { getUsageStats } from './usageStats'  // 📊 v3.0: 使用数据统计
import { getAgentConfig } from './agentConfig'  // 配置访问
import { collectAll, type NewsItem } from './tools/impl/newsCollector'  // 🆕 Daily Paper

// ═══════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════

export type TriggerType = 'time' | 'idle' | 'event' | 'opportunity' | 'screen_watch' | 'hot_topic' | 'personal_rhythm' | 'daily_paper'

export interface ProactiveTrigger {
  id: string
  type: TriggerType
  /** cron 表达式 或 条件描述 */
  condition: string
  /** 触发时的提示词模板 (可为空，由 LLM 动态生成) */
  template: string
  /** 是否启用 */
  enabled: boolean
  /** 冷却时间 (秒) */
  cooldown: number
  /** 上次触发时间戳 */
  lastTriggered?: number
  /** 优先级 0-10 */
  priority: number
}

export interface ProactiveEvent {
  trigger: ProactiveTrigger
  message: string
  timestamp: number
  delivered: boolean
}

export interface ProactiveConfig {
  enabled: boolean
  minIdleSeconds: number
  minIntervalSeconds: number
  maxDailyProactive: number
  useLlmPolish: boolean
  /** 🆕 屏幕监控间隔 (秒)，默认 300 (5分钟) */
  screenWatchIntervalSeconds: number
  /** 🆕 热搜检查间隔 (秒)，默认 1800 (30分钟) */
  hotTopicIntervalSeconds: number
  /** 🆕 是否启用屏幕感知 */
  screenWatchEnabled: boolean
  /** 🆕 是否启用热搜感知 */
  hotTopicEnabled: boolean
  /** 🆕 Daily Paper 检查间隔 (秒)，默认 86400 (24小时) */
  dailyPaperIntervalSeconds: number
  /** 🆕 是否启用 Daily Paper */
  dailyPaperEnabled: boolean
  /** 🔔 v2.9/v6.x: 是否启用 Windows 弹窗通知 */
  notificationsEnabled: boolean
}

/* ---------- 通知兼容层 ---------- */
function safeNotify(title: string, body: string, icon?: string): void {
  try {
    if (typeof Notification === 'undefined') return
    if (!Notification.isSupported()) return

    // 先显式请求/检查权限，Windows 上 Electron 有时不会自动弹权限
    const notify = Notification as any
    if (typeof notify.requestPermission === 'function') {
      notify.requestPermission(() => { /* noop */ })
    }

    const n = new Notification({ title: stripMarkdown(title), body: stripMarkdown(body), icon, silent: false })
    n.on('click', () => {
      try {
        // 优先使用应用主窗口单例，避免 getMainWindow  thinly 问题
        const win = (globalThis as any).__luminaMainWindow || require('electron').BrowserWindow.getAllWindows()[0]
        if (win) { win.show(); win.focus() }
      } catch {}
    })
    n.on('failed', () => {
      // 通知失败时不再抛错，避免阻塞主动引擎
    })
    n.show()
  } catch {
    // 静默降级
  }
}

// ═══════════════════════════════════════════════════════════
// 屏幕感知模块
// ═══════════════════════════════════════════════════════════

interface ScreenContext {
  activity: string
  apps: string[]
  summary: string
  shouldComment: boolean
  commentSuggestions: string[]
  timestamp: number
}

let lastScreenContext: ScreenContext | null = null

function getLLMConfig(): { baseUrl: string; apiKey: string; model: string } | null {
  // v6.0: 优先使用 AgentConfig 中 Lumina 的独立 LLM 配置
  // 不再硬编码 fallback 到 api.openai.com（国内永远超时）
  try {
    const config = getAgentConfig()
    if (config.isConfigured('lumina')) {
      const lumina = config.get('lumina')
      // 🚫 如果配置的是 LM Studio 本地服务，返回 null 以避免自动触发模型加载
      if (lumina.endpoint.includes('127.0.0.1:1234') || lumina.endpoint.includes('localhost:1234') || lumina.endpoint.includes('lmstudio')) {
        console.log('[getLLMConfig] LM Studio 本地服务，返回 null，防止 ProactiveEngine 自动触发模型加载')
        return null
      }
      // 视觉模型需要端点多模态能力，仅在明确配置时使用
      // 允许环境变量覆盖模型名（因为对话模型可能不支持视觉）
      const vlmModel = process.env.LUMINA_VLM_MODEL || process.env.LLM_MODEL || lumina.model
      return {
        baseUrl: lumina.endpoint,
        apiKey: lumina.apiKey || '',
        model: vlmModel,
      }
    }
  } catch { /* AgentConfig 不可用，继续降级 */ }

  // 环境变量显式配置（用户主动设置）
  if (process.env.LUMINA_VLM_BASE_URL) {
    // 🚫 同样检查环境变量中的 LM Studio 地址
    if (process.env.LUMINA_VLM_BASE_URL.includes('127.0.0.1:1234') || process.env.LUMINA_VLM_BASE_URL.includes('localhost:1234') || process.env.LUMINA_VLM_BASE_URL.includes('lmstudio')) {
      console.log('[getLLMConfig] 环境变量中配置了 LM Studio 本地服务，返回 null')
      return null
    }
    return {
      baseUrl: process.env.LUMINA_VLM_BASE_URL,
      apiKey: process.env.LUMINA_VLM_API_KEY || process.env.LLM_API_KEY || '',
      model: process.env.LUMINA_VLM_MODEL || process.env.LLM_MODEL || 'gpt-4o',
    }
  }

  // 没有可用配置 → 返回 null，上层优雅跳过
  return null
}

async function captureScreenBase64(): Promise<string> {
  const id = Date.now()
  const png = path.join(os.tmpdir(), `lu-pe-${id}.png`)

  // ── 首选: screenshot-desktop 原生 C++ 绑定 (~50ms) ──
  try {
    await screenshot({ filename: png, format: 'png' })
    const buf = fs.readFileSync(png)
    try { fs.unlinkSync(png) } catch {}
    return buf.toString('base64')
  } catch (nativeErr: any) {
    // 原生模块不可用时静默回退，不打印 warn（避免刷屏）
  }

  // ── 回退: PowerShell 截图 (使用 -EncodedCommand 彻底避免字符集问题) ──
  const psCmd = [
    'Add-Type -AssemblyName System.Windows.Forms,System.Drawing;',
    `$s=[System.Windows.Forms.Screen]::PrimaryScreen;`,
    `$b=New-Object System.Drawing.Bitmap($s.Bounds.Width,$s.Bounds.Height);`,
    `$g=[System.Drawing.Graphics]::FromImage($b);`,
    `$g.CopyFromScreen($s.Bounds.X,$s.Bounds.Y,0,0,$s.Bounds.Size);`,
    `$b.Save('${png.replace(/\\/g, '\\\\')}',[System.Drawing.Imaging.ImageFormat]::Png);`,
    `$g.Dispose();$b.Dispose();`,
    `Write-Output 'OK';`,
  ].join(' ')

  // PowerShell -EncodedCommand 需要 UTF-16LE → Base64，彻底绕过字符集/引号问题
  const psB64 = Buffer.from(psCmd, 'utf16le').toString('base64')

  return new Promise<string>((resolve, reject) => {
    cp.execFile('powershell', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-EncodedCommand', psB64,
    ], { timeout: 15000, windowsHide: true },
    (err, stdout, stderr) => {
      if (err || !String(stdout).includes('OK')) {
        try { fs.unlinkSync(png) } catch {}
        reject(new Error(`ss:${(err as any)?.code || 'unk'}|${String(stderr || stdout).slice(0, 100)}`))
        return
      }
      try {
        const buf = fs.readFileSync(png)
        try { fs.unlinkSync(png) } catch {}
        resolve(buf.toString('base64'))
      } catch (e: any) {
        reject(new Error(`read:${e.message}`))
      }
    })
  })
}

async function callVisionLLM(systemPrompt: string, userPrompt: string, imageBase64: string): Promise<string> {
  const cfg = getLLMConfig()
  if (!cfg) {
    throw new Error('VLM_NOT_CONFIGURED: 未配置视觉模型（请在设置中为 Lumina 配置 LLM，或设置 LUMINA_VLM_BASE_URL 环境变量）')
  }

  // v6.0: 快速连通性检测（2s 超时），避免卡死在 120s TCP 超时
  try {
    const url = new URL(cfg.baseUrl.replace(/\/+$/, ''))
    const isHttps = url.protocol === 'https:'
    const transport = isHttps ? https : http

    await new Promise<void>((resolve, reject) => {
      const req = transport.request({
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname || '/',
        method: 'HEAD',
        timeout: 3000,
      }, () => { req.destroy(); resolve() })
      req.on('error', reject)
      req.on('timeout', () => { req.destroy(); reject(new Error('connect timeout')) })
      req.end()
    })
  } catch {
    throw new Error('VLM_UNREACHABLE: 视觉模型端点不可达 — ' + cfg.baseUrl)
  }

  const url = new URL(cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions')
  const isHttps = url.protocol === 'https:'
  const transport = isHttps ? https : http

  const body = JSON.stringify({
    model: cfg.model,
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: [
          { type: 'text', text: userPrompt },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${imageBase64}`, detail: 'low' } },
        ],
      },
    ],
    max_tokens: 512,
    temperature: 0.5,
    response_format: { type: 'json_object' },
  })

  return new Promise((resolve, reject) => {
    const req = transport.request({
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${cfg.apiKey}`,
        'Content-Length': Buffer.byteLength(body).toString(),
      },
      timeout: 60000,
    }, (res) => {
      let data = ''
      res.on('data', (chunk) => (data += chunk))
      res.on('end', () => {
        try {
          const json = JSON.parse(data)
          resolve(json.choices?.[0]?.message?.content || '{}')
        } catch { resolve('{}') }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
    req.write(body)
    req.end()
  })
}

/** 屏幕感知: 截图+VLM分析，判断是否值得搭话 */
async function analyzeScreen(): Promise<ScreenContext | null> {
  try {
    const imageB64 = await captureScreenBase64()

    const systemPrompt = `你是 Lumina 桌面助手。分析屏幕截图，判断是否应该主动和用户搭话。
输出 JSON:
{
  "activity": "用户正在做什么 (一句话)",
  "apps": ["应用1", "应用2"],
  "summary": "屏幕内容概述",
  "shouldComment": true/false,
  "commentSuggestions": ["搭话建议1", "搭话建议2"]
}

搭话原则:
- 用户在浏览网页/看视频/购物/写代码时 → shouldComment: true
- 用户在开会/全屏游戏/看全屏视频时 → shouldComment: false  
- 屏幕长时间没变化 → shouldComment: false
- 有值得评论的内容 (代码、文章、图片) → shouldComment: true
- 搭话要自然、有趣、有洞察力，不要机械问候`

    const result = await callVisionLLM(systemPrompt, '分析当前屏幕，决定是否搭话', imageB64)
    const parsed = JSON.parse(result.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim())
    return {
      activity: parsed.activity || '',
      apps: parsed.apps || [],
      summary: parsed.summary || '',
      shouldComment: !!parsed.shouldComment,
      commentSuggestions: parsed.commentSuggestions || [],
      timestamp: Date.now(),
    }
  } catch (err: any) {
    const msg = err?.message || String(err)

    // v6.0: 区分预期状态 vs 实际错误
    if (msg.includes('VLM_NOT_CONFIGURED')) {
      // 第一次记录 info，之后静默
      if (!_vlmNotConfiguredLogged) {
        console.log('[ProactiveEngine] 屏幕感知: 未配置视觉模型，已跳过（可在设置中为 Lumina 配置本地 LLM）')
        _vlmNotConfiguredLogged = true
      }
      return null
    }

    if (msg.includes('VLM_UNREACHABLE')) {
      // 端点不通，大概率是网络问题或使用云端 API 被墙
      if (!_vlmUnreachableLogged) {
        console.log('[ProactiveEngine] 屏幕感知: 端点不可达，已跳过 —', msg.replace('VLM_UNREACHABLE: ', ''))
        _vlmUnreachableLogged = true
      }
      return null
    }

    console.error('[ProactiveEngine] 屏幕分析失败:', err)
    return null
  }
}

// v6.0: 静默标志 — 避免重复刷日志
let _vlmNotConfiguredLogged = false
let _vlmUnreachableLogged = false

// ═══════════════════════════════════════════════════════════
// 热搜感知模块
// ═══════════════════════════════════════════════════════════

interface HotTopic {
  title: string
  source: string
  url: string
  hot: string
}

/** 获取B站热搜 */
async function fetchBilibiliHot(): Promise<HotTopic[]> {
  return new Promise((resolve) => {
    const options = {
      hostname: 'api.bilibili.com',
      path: '/x/web-interface/wbi/search/square?limit=10',
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://www.bilibili.com',
      },
      timeout: 10000,
    }
    const req = https.request(options, (res) => {
      let data = ''
      res.on('data', (c) => (data += c))
      res.on('end', () => {
        try {
          const json = JSON.parse(data)
          const list = (json?.data?.trending?.list || []).map((item: any) => ({
            title: item.keyword || item.show_name || '',
            source: 'bilibili',
            url: `https://search.bilibili.com/all?keyword=${encodeURIComponent(item.keyword || '')}`,
            hot: item.show_name || '',
          }))
          resolve(list.slice(0, 10))
        } catch { resolve([]) }
      })
    })
    req.on('error', () => resolve([]))
    req.on('timeout', () => { req.destroy(); resolve([]) })
    req.end()
  })
}

/** 获取微博热搜 */
async function fetchWeiboHot(): Promise<HotTopic[]> {
  return new Promise((resolve) => {
    const options = {
      hostname: 'weibo.com',
      path: '/ajax/side/hotSearch',
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'X-Requested-With': 'XMLHttpRequest',
      },
      timeout: 10000,
    }
    const req = https.request(options, (res) => {
      let data = ''
      res.on('data', (c) => (data += c))
      res.on('end', () => {
        try {
          const json = JSON.parse(data)
          const list = (json?.data?.realtime || []).slice(0, 10).map((item: any) => ({
            title: item.note || item.word || '',
            source: 'weibo',
            url: `https://s.weibo.com/weibo?q=${encodeURIComponent(item.word || '')}`,
            hot: item.num ? `${item.num}万` : '',
          }))
          resolve(list)
        } catch { resolve([]) }
      })
    })
    req.on('error', () => resolve([]))
    req.on('timeout', () => { req.destroy(); resolve([]) })
    req.end()
  })
}

/** LLM 评估热搜并生成搭话 */
async function evaluateHotTopics(topics: HotTopic[]): Promise<string | null> {
  if (topics.length === 0) return null

  try {
    const cfg = getLLMConfig()
    if (!cfg) return 'LLM配置未初始化'
    const url = new URL(cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions')
    const isHttps = url.protocol === 'https:'
    const transport = isHttps ? https : http

    const topicList = topics.map(t => `- [${t.source}] ${t.title} (${t.hot})`).join('\n')

    const body = JSON.stringify({
      model: process.env.LLM_SMALL_MODEL || cfg.model,
      messages: [
        {
          role: 'system',
          content: `你是 Lumina 桌面助手。以下是当前社交媒体热搜。挑选1-2条最有趣、最值得和用户聊的话题，生成一句自然的搭话。
不要机械播报，要像朋友聊天一样提起话题。如果没有感兴趣的话题，返回 {"skip": true}。

输出 JSON: {"message": "搭话内容", "topic": "相关话题标题", "skip": false}`,
        },
        { role: 'user', content: `今日热搜:\n${topicList}` },
      ],
      max_tokens: 200,
      temperature: 0.7,
      response_format: { type: 'json_object' },
    })

    return new Promise((resolve) => {
      const req = transport.request({
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${cfg.apiKey}`,
          'Content-Length': Buffer.byteLength(body).toString(),
        },
        timeout: 15000,
      }, (res) => {
        let data = ''
        res.on('data', (c) => (data += c))
        res.on('end', () => {
          try {
            const json = JSON.parse(data)
            const content = json.choices?.[0]?.message?.content || '{}'
            const parsed = JSON.parse(content.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim())
            resolve(parsed.skip ? null : (parsed.message || null))
          } catch { resolve(null) }
        })
      })
      req.on('error', () => resolve(null))
      req.on('timeout', () => { req.destroy(); resolve(null) })
      req.write(body)
      req.end()
    })
  } catch {
    return null
  }
}

// ═══════════════════════════════════════════════════════════
// 🆕 Daily Paper 模块
// ═══════════════════════════════════════════════════════════

interface Paper {
  title: string
  source: string
  url: string
  summary: string
}

/** 获取arXiv论文列表 (复用newsCollector) */
async function fetchArxivPapers(): Promise<Paper[]> {
  try {
    const items = await collectAll({ arxiv: true, rss: false, baidu: false })
    return items
      .filter((item: NewsItem) => item.category === 'paper')
      .slice(0, 15)
      .map((item: NewsItem) => ({
        title: item.title,
        source: item.source,
        url: item.url,
        summary: item.summary.slice(0, 300),
      }))
  } catch {
    return []
  }
}

/** LLM 评估论文并生成每日精选摘要 */
async function evaluateDailyPapers(papers: Paper[]): Promise<string | null> {
  if (papers.length === 0) return null

  try {
    const cfg = getLLMConfig()
    if (!cfg) return 'LLM配置未初始化'
    const url = new URL(cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions')
    const isHttps = url.protocol === 'https:'
    const transport = isHttps ? https : http

    const paperList = papers.map(p => `- [${p.source}] ${p.title}\n  ${p.summary}\n  ${p.url}`).join('\n\n')

    const body = JSON.stringify({
      model: process.env.LLM_SMALL_MODEL || cfg.model,
      messages: [
        {
          role: 'system',
          content: `你是 Lumina 桌面助手。以下是今日 arXiv 论文列表。请：
1. 挑选 1-2 篇最有趣、最值得关注的论文
2. 用一句话总结每篇论文的核心贡献
3. 生成一句自然的搭话，像朋友分享新发现一样
4. 如果论文都很晦涩，返回 {"skip": true}

输出 JSON: {"message": "搭话内容", "papers": [{"title": "论文标题", "summary": "一句话总结", "url": "链接"}]}`,
        },
        { role: 'user', content: `今日 arXiv 论文精选:\n${paperList}` },
      ],
      max_tokens: 400,
      temperature: 0.7,
      response_format: { type: 'json_object' },
    })

    return new Promise((resolve) => {
      const req = transport.request({
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${cfg.apiKey}`,
          'Content-Length': Buffer.byteLength(body).toString(),
        },
        timeout: 15000,
      }, (res) => {
        let data = ''
        res.on('data', (c) => (data += c))
        res.on('end', () => {
          try {
            const json = JSON.parse(data)
            const content = json.choices?.[0]?.message?.content || '{}'
            const parsed = JSON.parse(content.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim())
            resolve(parsed.skip ? null : (parsed.message || null))
          } catch { resolve(null) }
        })
      })
      req.on('error', () => resolve(null))
      req.on('timeout', () => { req.destroy(); resolve(null) })
      req.write(body)
      req.end()
    })
  } catch {
    return null
  }
}

// ═══════════════════════════════════════════════════════════
// 默认触发策略
// ═══════════════════════════════════════════════════════════

const DEFAULT_TRIGGERS: ProactiveTrigger[] = [
  // ── 时间触发 ─────────────────────────────────
  {
    id: 'morning-greeting',
    type: 'time',
    condition: '0 8 * * *',
    template: '',
    enabled: true,
    cooldown: 3600,
    priority: 5,
  },
  {
    id: 'noon-reminder',
    type: 'time',
    condition: '0 12 * * *',
    template: '',
    enabled: true,
    cooldown: 3600,
    priority: 6,
  },
  {
    id: 'afternoon-break',
    type: 'time',
    condition: '0 15 * * *',
    template: '',
    enabled: true,
    cooldown: 3600,
    priority: 4,
  },
  {
    id: 'evening-wrapup',
    type: 'time',
    condition: '0 18 * * *',
    template: '',
    enabled: false,
    cooldown: 3600,
    priority: 5,
  },
  {
    id: 'night-reminder',
    type: 'time',
    condition: '0 22 * * *',
    template: '',
    enabled: true,
    cooldown: 3600,
    priority: 7,
  },

  // ── 空闲触发 ─────────────────────────────────
  {
    id: 'idle-10min',
    type: 'idle',
    condition: 'idle:600',
    template: '',
    enabled: true,
    cooldown: 1800,
    priority: 3,
  },
  {
    id: 'idle-30min',
    type: 'idle',
    condition: 'idle:1800',
    template: '',
    enabled: true,
    cooldown: 3600,
    priority: 2,
  },

  // ── 事件触发 ─────────────────────────────────
  {
    id: 'startup-greeting',
    type: 'event',
    condition: 'app:start',
    template: '',  // 🔧 v3.9: 留空，由 LLM 动态生成（回退到 TIME_TEMPLATES）
    enabled: true,
    cooldown: 60,
    priority: 8,
  },
  {
    id: 'long-session',
    type: 'event',
    condition: 'session:2h',
    template: '',
    enabled: false,
    cooldown: 7200,
    priority: 4,
  },
  {
    id: 'daily-paper',
    type: 'daily_paper',
    condition: '0 8 * * *',
    template: '',
    enabled: true,
    cooldown: 86400,
    priority: 7,
  },

  // ── 🆕 屏幕感知 ──────────────────────────────
  {
    id: 'screen-watch',
    type: 'screen_watch',
    condition: 'interval:600',  // 🔧 v3.9: 10分钟间隔（原300s，避免过于频繁）
    template: '',
    enabled: true,              // 🔧 v3.9: 默认开启
    cooldown: 600,
    priority: 6,
  },

  // ── 🆕 热搜感知 ──────────────────────────────
  {
    id: 'hot-topic',
    type: 'hot_topic',
    condition: 'interval:1800',
    template: '',
    enabled: true,              // 🔧 v3.9: 默认开启
    cooldown: 3600,
    priority: 5,
  },

  // ── 🆕 作息规律 ──────────────────────────────
  {
    id: 'personal-rhythm-start',
    type: 'personal_rhythm',
    condition: 'session:start',
    template: '',
    enabled: false,
    cooldown: 600,
    priority: 7,
  },
  {
    id: 'personal-rhythm-lunch',
    type: 'personal_rhythm',
    condition: 'learned:lunch',
    template: '',
    enabled: false,
    cooldown: 3600,
    priority: 5,
  },
  {
    id: 'personal-rhythm-coffee',
    type: 'personal_rhythm',
    condition: 'learned:afternoon',
    template: '',
    enabled: false,
    cooldown: 3600,
    priority: 4,
  },

  // ── 🆕 机会感知 ──────────────────────────────
  {
    id: 'opportunity-after-chat',
    type: 'opportunity',
    condition: 'gap:120',
    template: '',
    enabled: false,
    cooldown: 1800,
    priority: 3,
  },
]

// ═══════════════════════════════════════════════════════════
// 时间模板 (LLM 不可用时回退)
// ═══════════════════════════════════════════════════════════

const TIME_TEMPLATES: Record<string, string> = {
  'startup-greeting': '嗨，又见面啦~ ✨',
  'morning-greeting': '早上好呀~ 🌤️ 今天天气不错呢，要不要出去走走？',
  'noon-reminder': '肚子咕咕叫了~ 🍚 该吃饭啦',
  'afternoon-break': '下午困了吗~ ☕ 起来活动活动？',
  'evening-wrapup': '今天过得怎么样呀~ 🌆 有没有什么开心的事？',
  'night-reminder': '夜深了~ 💤 别太拼了，早点休息',
  'idle-10min': '嘿，在忙啥呢~ 😊 我在这等你',
  'idle-30min': '好久不见啦~ 💭 我还在这儿陪着你',
  'long-session': '你已经连续用了好久了~ 👀 起来伸个懒腰？',
  'personal-rhythm-lunch': '到饭点啦！🍜 今天中午吃什么呀？',
  'personal-rhythm-coffee': '下午茶时间到~ ☕ 要不要来杯咖啡？',
  'opportunity-after-chat': '刚才聊的话题挺有意思的~ 🤔 我想了想……',
  'daily-paper': '今日arXiv精选，来看看有没有感兴趣的研究方向 📚',
}

// ═══════════════════════════════════════════════════════════
// 引擎类
// ═══════════════════════════════════════════════════════════

export class ProactiveEngine extends EventEmitter {
  private triggers: ProactiveTrigger[] = []
  private history: ProactiveEvent[] = []
  private config: ProactiveConfig
  private lastActivity: number = Date.now()
  private lastProactive: number = 0
  private dailyCount: number = 0
  private checkTimer: ReturnType<typeof setInterval> | null = null
  private screenWatchTimer: ReturnType<typeof setInterval> | null = null
  private hotTopicTimer: ReturnType<typeof setInterval> | null = null
  private dailyResetTimer: ReturnType<typeof setInterval> | null = null
  private isScreenWatchRunning = false
  private isHotTopicRunning = false
  private isDailyPaperRunning = false
  private dailyPaperTimer: ReturnType<typeof setInterval> | null = null
  private rhythmTimer: ReturnType<typeof setInterval> | null = null

  // 作息学习 + 机会感知
  private activityLog: number[] = []
  private lastUserMessageTime: number = 0
  private opportunityCheckTimer: ReturnType<typeof setInterval> | null = null

  /**
   * 初始化主动对话引擎
   * @param config - 可选的部分配置覆盖，未指定项使用默认值
   * @default 默认启用，屏幕感知和热搜感知 v3.9 起默认开启
   */
  constructor(config?: Partial<ProactiveConfig>) {
    super()
    this.config = {
      enabled: true,
      minIdleSeconds: 300,
      minIntervalSeconds: 600,
      maxDailyProactive: 20,
      useLlmPolish: false,
      screenWatchIntervalSeconds: 600,  // 🔧 v3.9: 10分钟间隔
      hotTopicIntervalSeconds: 1800,
      screenWatchEnabled: true,         // 🔧 v3.9: 默认开启
      hotTopicEnabled: true,            // 🔧 v3.9: 默认开启
      dailyPaperIntervalSeconds: 86400, // 🆕 Daily Paper 24小时间隔
      dailyPaperEnabled: true,          // 🆕 默认开启
      notificationsEnabled: true,       // 🔧 v3.9.1: 默认开启Windows通知
      ...config,
    }
    // 从文件加载用户保存的触发器状态
    this.triggers = this.loadTriggersFromFile()
  }

  /**
   * 🔧 v2.14: 从文件加载触发器配置，保留用户设置
   */
  private getTriggersFilePath(): string {
    return path.join(os.homedir(), '.lumina', 'proactive_triggers.json')
  }

  private loadTriggersFromFile(): ProactiveTrigger[] {
    try {
      const filePath = this.getTriggersFilePath()
      if (fs.existsSync(filePath)) {
        const saved = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
        console.log('[ProactiveEngine] 从文件加载触发器配置')
        // 合并：用保存的 enabled 覆盖默认值
        return DEFAULT_TRIGGERS.map(dt => {
          const st = saved.find((t: any) => t.id === dt.id)
          if (st) {
            return { ...dt, enabled: st.enabled, lastTriggered: st.lastTriggered, cooldown: st.cooldown ?? dt.cooldown }
          }
          return dt
        })
      }
    } catch (e) {
      console.warn('[ProactiveEngine] 加载触发器配置失败:', e)
    }
    return [...DEFAULT_TRIGGERS]
  }

  private saveTriggersToFile(): void {
    try {
      const dir = path.dirname(this.getTriggersFilePath())
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      const data = this.triggers.map(t => ({
        id: t.id,
        enabled: t.enabled,
        lastTriggered: t.lastTriggered,
        cooldown: t.cooldown,
        type: t.type,
      }))
      fs.writeFileSync(this.getTriggersFilePath(), JSON.stringify(data, null, 2), 'utf-8')
    } catch (e) {
      console.warn('[ProactiveEngine] 保存触发器配置失败:', e)
    }
  }

  /**
   * 🔧 v2.14: 手动测试触发
   */
  async testTrigger(id: string): Promise<void> {
    const trigger = this.triggers.find(t => t.id === id)
    if (!trigger) throw new Error(`触发器 ${id} 不存在`)
    if (!trigger.enabled) throw new Error(`触发器 ${id} 未启用`)
    this.activate(trigger)
  }

  /**
   * 启动引擎：注册所有定时器、屏幕感知、热搜监控、作息学习、机会感知
   * 仅在 `config.enabled === true` 时生效
   */
  start(): void {
    if (!this.config.enabled) return

    // 每分钟检查常规触发器
    this.checkTimer = setInterval(() => this.checkTriggers(), 60000)

    // 🆕 屏幕监控
    const screenWatchTrigger = this.triggers.find(t => t.id === 'screen-watch')
    if (this.config.screenWatchEnabled && screenWatchTrigger) {
      screenWatchTrigger.enabled = true
      this.screenWatchTimer = setInterval(
        () => this.runScreenWatch(),
        this.config.screenWatchIntervalSeconds * 1000
      )
      // 首次延迟30秒执行
      setTimeout(() => this.runScreenWatch(), 30000)
    }

    // 🆕 热搜监控
    const hotTopicTrigger = this.triggers.find(t => t.id === 'hot-topic')
    if (this.config.hotTopicEnabled && hotTopicTrigger) {
      hotTopicTrigger.enabled = true
      this.hotTopicTimer = setInterval(
        () => this.runHotTopicCheck(),
        this.config.hotTopicIntervalSeconds * 1000
      )
      setTimeout(() => this.runHotTopicCheck(), 60000)
    }

    // 每天 0 点重置计数
    this.dailyResetTimer = setInterval(() => {
      this.dailyCount = 0
    }, this.msUntilMidnight())

    // 作息学习 (每30分钟检查一次)
    this.rhythmTimer = setInterval(() => this.runPersonalRhythm(), 30 * 60000)

    // 🆕 Daily Paper 监控 (每日一次)
    const dailyPaperTrigger = this.triggers.find(t => t.id === 'daily-paper')
    if (this.config.dailyPaperEnabled && dailyPaperTrigger) {
      dailyPaperTrigger.enabled = true
      this.dailyPaperTimer = setInterval(
        () => this.runDailyPaperCheck(),
        this.config.dailyPaperIntervalSeconds * 1000
      )
      // 首次延迟10秒执行
      setTimeout(() => this.runDailyPaperCheck(), 10000)
    }

    // 机会感知 (监听聊天间隙)
    this.startOpportunityCheck()

    const enabledCount = this.triggers.filter(t => t.enabled).length
    const extraInfo = [
      this.config.screenWatchEnabled ? '屏幕感知' : '',
      this.config.hotTopicEnabled ? '热搜感知' : '',
      this.config.dailyPaperEnabled ? 'Daily Paper' : '',
    ].filter(Boolean).join('+')
    console.log(`[ProactiveEngine] 已启动 (${enabledCount} 个触发器${extraInfo ? ', ' + extraInfo : ''})`)
  }

  /**
   * 停止引擎：清除所有定时器，释放资源
   */
  stop(): void {
    if (this.checkTimer) clearInterval(this.checkTimer)
    if (this.screenWatchTimer) clearInterval(this.screenWatchTimer)
    if (this.hotTopicTimer) clearInterval(this.hotTopicTimer)
    if (this.dailyResetTimer) clearInterval(this.dailyResetTimer)
    if (this.rhythmTimer) clearInterval(this.rhythmTimer)
    if (this.dailyPaperTimer) clearInterval(this.dailyPaperTimer)
    this.stopOpportunityCheck()
    this.checkTimer = null
    this.screenWatchTimer = null
    this.hotTopicTimer = null
    this.dailyResetTimer = null
    this.rhythmTimer = null
    this.dailyPaperTimer = null
  }

  /**
   * 更新配置并热重启引擎（stop → merge config → start）
   * @param partial - 要更新的配置字段
   */
  updateConfig(partial: Partial<ProactiveConfig>): void {
    this.config = { ...this.config, ...partial }
    // 同步屏幕/热搜开关到对应的触发器
    if (partial.screenWatchEnabled !== undefined) {
      const t = this.triggers.find(t => t.id === 'screen-watch')
      if (t) t.enabled = partial.screenWatchEnabled
    }
    if (partial.hotTopicEnabled !== undefined) {
      const t = this.triggers.find(t => t.id === 'hot-topic')
      if (t) t.enabled = partial.hotTopicEnabled
    }
    if (partial.dailyPaperEnabled !== undefined) {
      const t = this.triggers.find(t => t.id === 'daily-paper')
      if (t) t.enabled = partial.dailyPaperEnabled
    }
    this.saveTriggersToFile()
    this.stop()
    this.start()
  }

  // ── 🆕 屏幕感知 ──────────────────────────────────────

  private async runScreenWatch(): Promise<void> {
    if (this.isScreenWatchRunning) return
    if (this.dailyCount >= this.config.maxDailyProactive) return
    if (Date.now() - this.lastProactive < this.config.minIntervalSeconds * 1000) return
    // 用户活跃时延迟 VLM 分析
    if (!llmCoordinator.requestPermission('Proactive.ScreenWatch', PRIORITY.PROACTIVE)) return

    this.isScreenWatchRunning = true
    try {
      const ctx = await analyzeScreen()
      if (!ctx || !ctx.shouldComment) {
        lastScreenContext = ctx
        return
      }

      // 与上次相同的活动，跳过
      if (lastScreenContext && lastScreenContext.activity === ctx.activity) return
      lastScreenContext = ctx

      // 生成搭话
      const suggestion = ctx.commentSuggestions[0]
      if (suggestion) {
        const trigger = this.triggers.find(t => t.id === 'screen-watch')
        if (trigger) this.activateWithMessage(trigger, suggestion)
      }
    } catch (err) {
      console.error('[ProactiveEngine] 屏幕监控异常:', err)
    } finally {
      this.isScreenWatchRunning = false
      llmCoordinator.releasePermission('Proactive.ScreenWatch')
    }
  }

  // ── 🆕 热搜感知 ──────────────────────────────────────

  private async runHotTopicCheck(): Promise<void> {
    if (this.isHotTopicRunning) return
    if (this.dailyCount >= this.config.maxDailyProactive) return
    if (Date.now() - this.lastProactive < this.config.minIntervalSeconds * 1000) return
    // 用户活跃时延迟热搜检查
    if (!llmCoordinator.requestPermission('Proactive.HotTopic', PRIORITY.PROACTIVE)) return

    this.isHotTopicRunning = true
    try {
      const [biliTopics, weiboTopics] = await Promise.all([
        fetchBilibiliHot(),
        fetchWeiboHot(),
      ])
      const allTopics = [...biliTopics, ...weiboTopics]
      if (allTopics.length === 0) return

      const message = await evaluateHotTopics(allTopics)
      if (message) {
        const trigger = this.triggers.find(t => t.id === 'hot-topic')
        if (trigger) this.activateWithMessage(trigger, message)
      }
    } catch (err) {
      console.error('[ProactiveEngine] 热搜检查异常:', err)
    } finally {
      this.isHotTopicRunning = false
      llmCoordinator.releasePermission('Proactive.HotTopic')
    }
  }

  // ── 🆕 Daily Paper ──────────────────────────────────────

  private async runDailyPaperCheck(): Promise<void> {
    if (this.isDailyPaperRunning) return
    if (this.dailyCount >= this.config.maxDailyProactive) return
    if (Date.now() - this.lastProactive < this.config.minIntervalSeconds * 1000) return
    if (!llmCoordinator.requestPermission('Proactive.DailyPaper', PRIORITY.PROACTIVE)) return

    this.isDailyPaperRunning = true
    try {
      const papers = await collectAll({ arxiv: true, rss: false, baidu: false })
      
      // 筛选 paper 类别
      const paperItems = papers.filter((p: NewsItem) => p.category === 'paper')
      if (paperItems.length === 0) return

      const message = await evaluateDailyPapers(paperItems.slice(0, 10))
      if (message) {
        const trigger = this.triggers.find(t => t.id === 'daily-paper')
        if (trigger) this.activateWithMessage(trigger, message)
      }
    } catch (err) {
      console.error('[ProactiveEngine] Daily Paper 检查异常:', err)
    } finally {
      this.isDailyPaperRunning = false
      llmCoordinator.releasePermission('Proactive.DailyPaper')
    }
  }

  // ── 🆕 作息规律学习 ──────────────────────────────

  private async runPersonalRhythm(): Promise<void> {
    // 收集最近7天的活动数据，识别规律
    const now = Date.now()
    const weekAgo = now - 7 * 86400000
    this.activityLog = this.activityLog.filter(t => t > weekAgo)

    // 按小时统计活跃频率
    const hourCounts = new Array(24).fill(0)
    for (const t of this.activityLog) {
      const h = new Date(t).getHours()
      hourCounts[h]++
    }

    // 找高频活跃时段（>3次记录）
    const activeHours = hourCounts
      .map((count, hour) => ({ hour, count }))
      .filter(h => h.count >= 3)
      .map(h => h.hour)

    // 11-13点为午餐时段，14-16点为下午茶
    const lunchTrigger = this.triggers.find(t => t.id === 'personal-rhythm-lunch')
    const coffeeTrigger = this.triggers.find(t => t.id === 'personal-rhythm-coffee')

    const currentHour = new Date().getHours()
    const currentMinute = new Date().getMinutes()

    if (lunchTrigger && lunchTrigger.enabled && currentHour >= 11 && currentHour <= 13) {
      if (currentMinute >= 30 && currentMinute <= 35) {
        this.activateWithMessage(lunchTrigger, '已经中午了～你今天午饭打算吃什么呀？🍱 别饿着肚子干活哦！')
      }
    }

    if (coffeeTrigger && coffeeTrigger.enabled && currentHour >= 14 && currentHour <= 16) {
      if (currentMinute >= 25 && currentMinute <= 30) {
        this.activateWithMessage(coffeeTrigger, '下午茶时间到！☕ 要不要起来走动一下，续杯咖啡？')
      }
    }

    // 如果学到了明确的作息时间，log 出来
    if (activeHours.length > 0) {
      console.log(`[ProactiveEngine] 学到的活跃时段: ${activeHours.map(h => `${h}:00`).join(', ')}`)
    }
  }

  // ── 🆕 机会感知 ──────────────────────────────────────

  /** 记录用户发送消息（供聊天面板调用，驱动机会感知） */
  noteUserMessage(): void {
    this.lastUserMessageTime = Date.now()
  }

  private startOpportunityCheck(): void {
    if (this.opportunityCheckTimer) return
    this.opportunityCheckTimer = setInterval(() => this.runOpportunityCheck(), 60000)
  }

  private stopOpportunityCheck(): void {
    if (this.opportunityCheckTimer) {
      clearInterval(this.opportunityCheckTimer)
      this.opportunityCheckTimer = null
    }
  }

  private runOpportunityCheck(): void {
    if (this.lastUserMessageTime === 0) return
    if (this.dailyCount >= this.config.maxDailyProactive) return

    const trigger = this.triggers.find(t => t.id === 'opportunity-after-chat')
    if (!trigger || !trigger.enabled) return

    const gapSeconds = Math.floor((Date.now() - this.lastUserMessageTime) / 1000)
    const thresholdMatch = trigger.condition.match(/^gap:(\d+)$/)
    const threshold = thresholdMatch ? parseInt(thresholdMatch[1]) : 120

    if (gapSeconds >= threshold && gapSeconds < threshold + 60) {
      // 用户聊天后停顿了一段时间，是搭话的好时机
      const messages = [
        '对了，刚才你提到的事情，有需要我帮忙的地方吗？',
        '想了一下，你刚才说的挺有意思的～展开聊聊？',
        '你还在吗？我一直在听你说呢 💭',
      ]
      const msg = messages[Math.floor(Math.random() * messages.length)]
      this.activateWithMessage(trigger, msg, true)
    }
  }

  /**
   * 获取触发器配置列表（含运行时状态）
   * @returns 所有触发器的当前状态快照
   */
  getTriggers(): ProactiveTrigger[] {
    return [...this.triggers]
  }

  /**
   * 更新指定触发器的属性（v2.14: 自动持久化）
   * @param id - 触发器唯一标识
   * @param updates - 要更新的字段（部分）
   * @returns 是否成功找到并更新了触发器
   */
  updateTrigger(id: string, updates: Partial<ProactiveTrigger>): boolean {
    const idx = this.triggers.findIndex(t => t.id === id)
    if (idx === -1) return false
    this.triggers[idx] = { ...this.triggers[idx], ...updates }
    this.saveTriggersToFile()
    // 如果切换了屏幕感知/热搜感知/Daily Paper，同步到 config 并热重启
    if (id === 'screen-watch' || id === 'hot-topic' || id === 'daily-paper') {
      if (id === 'screen-watch') this.config.screenWatchEnabled = !!updates.enabled
      if (id === 'hot-topic') this.config.hotTopicEnabled = !!updates.enabled
      if (id === 'daily-paper') this.config.dailyPaperEnabled = !!updates.enabled
      this.stop()
      this.start()
    }
    return true
  }

  /**
   * 动态添加新触发器
   * @param trigger - 完整的触发器定义（含 ID、类型、条件、模板等）
   */
  addTrigger(trigger: ProactiveTrigger): void {
    const existing = this.triggers.findIndex(t => t.id === trigger.id)
    if (existing >= 0) {
      this.triggers[existing] = { ...trigger }
    } else {
      this.triggers.push(trigger)
    }
  }

  // ── 活动跟踪 ─────────────────────────────────────────

  /**
   * 用户活动心跳 — 重置空闲计时器，由 IPC `proactive:heartbeat` 调用
   */
  heartbeat(): void {
    this.lastActivity = Date.now()
    // 记录活跃时间戳，供作息学习使用
    this.activityLog.push(Date.now())
    // 只保留最近 14 天
    const twoWeeksAgo = Date.now() - 14 * 86400000
    this.activityLog = this.activityLog.filter(t => t > twoWeeksAgo)
  }

  /** 🆕 v2.9: 强制激活指定触发器（供前端测试按钮使用，绕过冷却） */
  /**
   * 强制激活指定触发器（绕过冷却检查和条件判断）
   * @param id - 触发器 ID
   * @returns 是否找到并激活了触发器
   */
  forceActivate(id: string): boolean {
    const trigger = this.triggers.find(t => t.id === id)
    if (!trigger) return false
    const message = trigger.template || TIME_TEMPLATES[trigger.id] || `[测试] 触发器 ${trigger.id} 已激活`
    this.activateWithMessage(trigger, message, true)
    return true
  }

  /**
   * 获取用户空闲秒数（距上次心跳/消息的时间）
   * @returns 空闲秒数
   */
  getIdleSeconds(): number {
    return Math.floor((Date.now() - this.lastActivity) / 1000)
  }

  // ── 事件触发 ─────────────────────────────────────────

  /**
   * 触发指定事件类型的主动行为
   * @param eventType - 事件名（如 'app_start', 'long_session'）
   */
  fireEvent(eventType: string): void {
    const matching = this.triggers.filter(t =>
      t.enabled && t.type === 'event' && t.condition === eventType
    )
    for (const trigger of matching) {
      this.activate(trigger)
    }
  }

  // ── 获取当前屏幕上下文 (供外部查询) ──────────────────

  /**
   * 获取最近一次屏幕感知的上下文（VLM 分析结果）
   * @returns 屏幕上下文快照，或 null（尚未执行/无结果）
   */
  getLastScreenContext(): ScreenContext | null {
    return lastScreenContext
  }

  // ── 内部 ─────────────────────────────────────────────

  private checkTriggers(): void {
    if (this.dailyCount >= this.config.maxDailyProactive) return

    const now = Date.now()
    if (now - this.lastProactive < this.config.minIntervalSeconds * 1000) return

    for (const trigger of this.triggers) {
      if (!trigger.enabled) continue
      if (trigger.lastTriggered && now - trigger.lastTriggered < trigger.cooldown * 1000) continue

      switch (trigger.type) {
        case 'time':
          if (this.matchCron(trigger.condition)) {
            this.activate(trigger)
          }
          break
        case 'idle':
          if (this.getIdleSeconds() >= this.parseIdleSeconds(trigger.condition)) {
            this.activate(trigger)
          }
          break
        case 'personal_rhythm':
          // 作息触发由 runPersonalRhythm() 独立处理
          break
        case 'opportunity':
          // 机会触发由 runOpportunityCheck() 独立处理
          break
        case 'daily_paper':
          // Daily Paper 由 runDailyPaperCheck() 独立处理
          break
        // event / screen_watch / hot_topic 在外部触发
      }
    }
  }

  private activate(trigger: ProactiveTrigger): void {
    // 启动问候使用 LLM 动态生成（异步，先发回退后更新）
    if (trigger.id === 'startup-greeting') {
      const fallback = this.getStartupFallbackMessage()
      this.activateWithMessage(trigger, fallback)
      // 异步调 LLM 生成更个性化的问候，成功后替换
      this.polishStartupGreeting(trigger)
      return
    }
    // 优先使用 LLM 生成消息，回退到模板
    const message = trigger.template || TIME_TEMPLATES[trigger.id] || ''
    this.activateWithMessage(trigger, message)
  }

  /** 🔧 v2.12: 根据时间段生成不同的启动问候（不再千篇一律） */
  private getStartupFallbackMessage(): string {
    const hour = new Date().getHours()
    const dayOfWeek = new Date().getDay()
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6

    if (hour >= 0 && hour < 6) {
      return isWeekend ? '这么晚还没睡呀？🌙 我也陪你~' : '又熬夜了？💡 我在这陪着你'
    } else if (hour >= 6 && hour < 9) {
      return isWeekend ? '周末睡到自然醒~ ☀️ 今天打算干嘛呀？' : '早安！☀️ 新的一天，加油！'
    } else if (hour >= 9 && hour < 12) {
      return isWeekend ? '上午好~ 🌤️ 周末惬意呀' : '上午好~ 🌤️ 今天有什么计划？'
    } else if (hour >= 12 && hour < 14) {
      return '中午啦~ 🍚 记得吃饭哦'
    } else if (hour >= 14 && hour < 17) {
      return isWeekend ? '下午茶时间~ ☕ 要不要出去走走？' : '下午好~ ☕ 下午茶时间到'
    } else if (hour >= 17 && hour < 20) {
      return isWeekend ? '傍晚好~ 🌆 今天过得怎么样？' : '下班啦~ 🌆 辛苦了！'
    } else {
      return isWeekend ? '晚上好~ 🌙 周末晚上放松一下~' : '晚上好~ 🌙 今天辛苦了！'
    }
  }

  /** 🔧 v3.9: LLM 动态生成启动问候 */
  private async polishStartupGreeting(trigger: ProactiveTrigger): Promise<void> {
    try {
      const cfg = getLLMConfig()
      if (!cfg || !cfg.apiKey) return

      // 🚫 如果配置的是 LM Studio 本地服务，跳过动态生成，避免触发模型加载
      if (cfg.baseUrl.includes('127.0.0.1:1234') || cfg.baseUrl.includes('localhost:1234') || cfg.baseUrl.includes('lmstudio')) {
        console.log('[polishStartupGreeting] LM Studio 本地服务，跳过 POST 请求，防止自动加载模型')
        return
      }

      const hour = new Date().getHours()
      const timeOfDay = hour < 6 ? '凌晨' : hour < 12 ? '上午' : hour < 14 ? '中午' : hour < 18 ? '下午' : '晚上'
      const dayOfWeek = ['日', '一', '二', '三', '四', '五', '六'][new Date().getDay()]

      const prompt = `你是 Lumina，用户的 AI 桌面宠物助手。现在应用刚启动，请用一句自然温暖的问候语。
要求：
- 考虑现在是${timeOfDay}，周${dayOfWeek}
- 语气像朋友一样自然，像人类发朋友圈一样随意、有个性
- 15-30字，带1个emoji
- 可以聊天气、心情、小趣事，不要每次都重复"已就绪""欢迎回来"
- 如果周末可以轻松一点，工作日可以鼓励一下
- 随机从这些风格里选一种：分享心情、聊天气、说个小观察、问用户近况
- 直接输出问候语，不要加引号`

      const url = new URL(cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions')
      const isHttps = url.protocol === 'https:'
      const transport = isHttps ? https : http

      const body = JSON.stringify({
        model: process.env.LLM_SMALL_MODEL || cfg.model,
        messages: [
          { role: 'system', content: '你是 Lumina，一个温暖可爱的 AI 助手。说话风格像朋友发朋友圈一样自然随意。' },
          { role: 'user', content: prompt },
        ],
        max_tokens: 100,
        temperature: 0.9,
      })

      await new Promise<void>((resolve) => {
        const req = transport.request({
          hostname: url.hostname,
          port: url.port || (isHttps ? 443 : 80),
          path: url.pathname,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${cfg.apiKey}`,
            'Content-Length': Buffer.byteLength(body).toString(),
          },
          timeout: 8000,
        }, (res) => {
          let data = ''
          res.on('data', (c) => (data += c))
          res.on('end', () => {
            try {
              const json = JSON.parse(data)
              const greeting = json.choices?.[0]?.message?.content?.trim()
              if (greeting && greeting.length > 2) {
                // 更新已在历史中的消息内容
                const lastEvent = this.history[this.history.length - 1]
                if (lastEvent && lastEvent.trigger.id === trigger.id) {
                  lastEvent.message = greeting
                }
                // 🔔 发送更新后的问候到渲染进程
                globalEventBus.emit(BusEvents.PROACTIVE_MESSAGE, {
                  triggerId: trigger.id,
                  message: greeting,
                  type: trigger.type,
                })
              }
            } catch { /* fallback already sent */ }
            resolve()
          })
        })
        req.on('error', () => resolve())
        req.on('timeout', () => { req.destroy(); resolve() })
        req.write(body)
        req.end()
      })
    } catch { /* fallback already sent */ }
  }

  private activateWithMessage(trigger: ProactiveTrigger, message: string, skipCooldown = false): void {
    if (!message) return

    const now = Date.now()
    if (!skipCooldown && trigger.lastTriggered && now - trigger.lastTriggered < trigger.cooldown * 1000) return

    trigger.lastTriggered = now
    this.lastProactive = now
    this.dailyCount++

    // 记录主动推送
    getUsageStats().recordProactive(trigger.id, message)

    const proactiveEvent: ProactiveEvent = {
      trigger,
      message,
      timestamp: now,
      delivered: true,
    }
    this.history.push(proactiveEvent)

    globalEventBus.emit(BusEvents.PROACTIVE_MESSAGE, {
      triggerId: trigger.id,
      message,
      type: trigger.type,
    })

    // 自动发朋友圈 — 每次主动触发都记录（移除技术前缀）
    try {
      const agentId = 'lumina'
      const agentName = 'Lumina'
      const content = message.slice(0, 200)

      // 🔧 v2.12: 启动问候每天只发一次朋友圈，避免刷屏
      if (trigger.id === 'startup-greeting') {
        if (hasTodayMomentWithKeyword(agentId, '欢迎回来') || hasTodayMomentWithKeyword(agentId, '已就绪')) {
          console.log('[ProactiveEngine] 启动问候今日已发过朋友圈，跳过')
        } else {
          postThought(agentId, agentName, content)
        }
      } else if (trigger.type === 'screen_watch' || trigger.type === 'hot_topic') {
        postObservation(agentId, agentName, content, '👀')
      } else if (trigger.type === 'daily_paper') {
        postThought(agentId, agentName, content)
      } else {
        postThought(agentId, agentName, content)
      }
    } catch { /* moments store may not be ready */ }

    // ── 🔧 v3.9.1/v6.x: Windows 系统通知（兼容层，失败不阻塞引擎） ──
    try {
      if (!this.config.notificationsEnabled) return // 静默跳过
      const iconPath = path.join(__dirname, '..', 'assets', 'icon.png')
      safeNotify('💡 Lumina 有话要说', message.slice(0, 120), iconPath)
    } catch {
      // 静默降级 — 通知失败不影响引擎核心功能
    }

    this.emit('proactive', proactiveEvent)
    console.log(`[ProactiveEngine] 触发: ${trigger.id} → "${message.slice(0, 60)}..."`)
  }

  // ── Cron 解析 ────────────────────────────────────────

  private matchCron(cron: string): boolean {
    const now = new Date()
    const parts = cron.split(' ')
    if (parts.length !== 5) return false

    const [minute, hour, day, month, weekday] = parts
    const matches = (field: string, value: number): boolean => {
      if (field === '*') return true
      if (field === String(value)) return true
      return false
    }

    return (
      matches(minute, now.getMinutes()) &&
      matches(hour, now.getHours()) &&
      matches(day, now.getDate()) &&
      matches(month, now.getMonth() + 1) &&
      matches(weekday, now.getDay())
    )
  }

  private parseIdleSeconds(condition: string): number {
    const match = condition.match(/^idle:(\d+)$/)
    return match ? parseInt(match[1]) : 600
  }

  private msUntilMidnight(): number {
    const now = new Date()
    const midnight = new Date(now)
    midnight.setHours(24, 0, 0, 0)
    return midnight.getTime() - now.getTime()
  }

  // ── 统计 ─────────────────────────────────────────────

  /**
   * 获取引擎完整运行状态（供 ProactiveSidebar 面板消费）
   * @returns 运行标志、触发器列表、配置、计数等完整快照
   */
  getStatus() {
    const idleSeconds = this.getIdleSeconds()
    // 检测 Windows 系统空闲时间（用户无键鼠操作）
    // 使用 -EncodedCommand 同步执行，杜绝编码乱码
    let systemIdleSeconds = 0
    try {
      const psScript = [
        '$ProgressPreference="SilentlyContinue";',
        '$ErrorActionPreference="SilentlyContinue";',
        'Add-Type @"',
        'using System;',
        'using System.Runtime.InteropServices;',
        '[StructLayout(LayoutKind.Sequential)]',
        'public struct LI {',
        '  public uint cbSize;',
        '  public uint dwTime;',
        '}',
        'public class LK {',
        '  [DllImport("user32.dll")]',
        '  public static extern bool GetLastInputInfo(ref LI p);',
        '}',
        '"@ 2>&1 | Out-Null;',
        '$l=New-Object LI;$l.cbSize=8;',
        '[LK]::GetLastInputInfo([ref]$l)|Out-Null;',
        '$t=[Environment]::TickCount-$l.dwTime;',
        'Write-Output $t;',
      ].join('\n')
      const b64 = Buffer.from(psScript, 'utf16le').toString('base64')
      const result = cp.execFileSync('powershell', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass',
        '-EncodedCommand', b64,
      ], { timeout: 3000, windowsHide: true, encoding: 'utf-8' }).trim()
      systemIdleSeconds = Math.floor((parseInt(result) || 0) / 1000)
    } catch { /* 非 Windows 环境，忽略 */ }

    return {
      running: this.checkTimer !== null || this.screenWatchTimer !== null || this.hotTopicTimer !== null || this.dailyPaperTimer !== null,
      triggers: this.triggers.map(t => ({
        id: t.id,
        type: t.type,
        condition: t.condition,
        template: t.template,
        enabled: t.enabled,
        cooldown: t.cooldown,
        lastTriggered: t.lastTriggered,
        priority: t.priority,
      })),
      config: {
        enabled: this.config.enabled,
        minIdleSeconds: this.config.minIdleSeconds,
        minIntervalSeconds: this.config.minIntervalSeconds,
        maxDailyProactive: this.config.maxDailyProactive,
        useLlmPolish: this.config.useLlmPolish,
        screenWatchIntervalSeconds: this.config.screenWatchIntervalSeconds,
        hotTopicIntervalSeconds: this.config.hotTopicIntervalSeconds,
        dailyPaperIntervalSeconds: this.config.dailyPaperIntervalSeconds,
        screenWatchEnabled: this.config.screenWatchEnabled,
        hotTopicEnabled: this.config.hotTopicEnabled,
        dailyPaperEnabled: this.config.dailyPaperEnabled,
        notificationsEnabled: this.config.notificationsEnabled,
      },
      dailyCount: this.dailyCount,
      // 🔧 修复：使用真实用户活动时间，非上次触发时间
      lastActivity: this.lastActivity,
      idleSeconds: idleSeconds,
      systemIdleSeconds: systemIdleSeconds,
      lastProactiveTime: this.lastProactive > 0 ? this.lastProactive : undefined,
    }
  }

  /**
   * 🔧 v2.16: 设置是否开启通知
   */
  setNotify(enabled: boolean): void {
    this.config.notificationsEnabled = enabled
    this.saveTriggersToFile()
  }

  /**
   * 🔧 v6.x: 设置是否开启 Daily Paper
   */
  setDailyPaperEnabled(enabled: boolean): void {
    this.config.dailyPaperEnabled = enabled
    const t = this.triggers.find(t => t.id === 'daily-paper')
    if (t) t.enabled = enabled
    this.saveTriggersToFile()
    this.stop()
    this.start()
  }

  /**
   * 🔧 v2.16: 获取屏幕上下文（占位，实际由渲染进程实现）
   */
  getScreenContext(): { context: string; timestamp?: number } | null {
    // 屏感知上下文由渲染进程通过 LLM 分析后提供
    return null
  }

  /**
   * 🔧 v2.16: 用户发送消息时调用，用于学习交互节奏
   */
  onUserMessage(): void {
    this.lastUserMessageTime = Date.now()
    this.lastActivity = Date.now()
    this.activityLog.push(Date.now())
  }
}

// ═══════════════════════════════════════════════════════════
// 单例
// ═══════════════════════════════════════════════════════════

let _instance: ProactiveEngine | null = null

export function getProactiveEngine(): ProactiveEngine {
  if (!_instance) {
    _instance = new ProactiveEngine()
  }
  return _instance
}

export function initProactiveEngine(config?: Partial<ProactiveConfig>): ProactiveEngine {
  if (_instance) _instance.stop()
  _instance = new ProactiveEngine(config)
  return _instance
}
