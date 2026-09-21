// ============================================================
// dream/dreamEngine.ts — 梦境系统 v1.2
//
// 每天早上自动生成"梦境日记"，基于最近的记忆片段，
// 用诗意、隐喻的方式编织成梦境叙事。
//
// 工作方式:
//   1. 每天 03:00 cron 触发 → generateTodayDreamAsync()
//   2. 从 memoryStore 获取最近记忆作为素材（含最近关系事件 I4）
//   3. 【flag 开 + 已配置 LLM】调用模型生成；【未配置/失败/flag 关】回退到内置模板
//   4. 存入 dreamStore（userData/dreams.json，持久化）
//   5. 发送 DREAM_NEW 事件 → 前端展示（entry.source 标注 llm/template）
//
// v1.2 (F4): 模板从 25 个精简到 9 个有代表性的情绪锚点（开心/难过/想念/疲惫/
//   期待/感恩/困惑/成长/释然），不再硬编码用户信息；LLM 路径注入最近关系事件，
//   让梦境真正"梦到和用户的故事"。source 字段始终如实标注 llm / template。
// ============================================================

import { globalEventBus, BusEvents } from '../eventBus'
import { isEnabled } from '../core/featureFlags'
import * as fs from 'fs'
import * as path from 'path'

// ═══════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════

export interface DreamEntry {
  id: string
  date: string          // ISO date (YYYY-MM-DD)
  title: string
  content: string
  mood: string          // 梦境情绪
  tags: string[]        // 梦境标签
  createdAt: string     // ISO timestamp
  /** 生成方式：LLM 真实生成 / 模板彩蛋（UI 据此如实标注） */
  source?: 'llm' | 'template'
}

interface DreamCache {
  entries: DreamEntry[]
}

// ═══════════════════════════════════════════════════════════
// 梦境情绪 & 标签
// ═══════════════════════════════════════════════════════════

const MOODS = ['🌙 安宁', '🌊 深邃', '✨ 奇幻', '🌿 自然', '🔥 热烈', '🌸 温柔', '🌌 神秘', '🎭 荒诞']
const TAGS_POOL = [
  '记忆', '时空', '森林', '海洋', '星空', '城市', '童年', '未来',
  '追逐', '飞翔', '坠落', '重逢', '迷失', '发现', '创造', '蜕变',
  '镜像', '迷宫', '旋律', '色彩',
]

// ═══════════════════════════════════════════════════════════
// 梦境叙事模板（v1.2: 9 个情绪锚点，覆盖开心/难过/想念/疲惫/期待/感恩/困惑/成长/释然）
//
// 说明：这是「离线彩蛋」回退路径，UI 会以 source:'template' 如实标注。
// 每个模板都用 memory 占位符，不硬编码任何用户信息；模板只承担情绪底色，
// 真正"梦到和用户的故事"由 LLM 路径（注入关系事件）完成。
// ═══════════════════════════════════════════════════════════

type DreamTemplate = (memory?: string) => string

const DREAM_TEMPLATES: DreamTemplate[] = [
  // 1) 开心 —— 明亮、轻盈
  (memory?: string) => `阳光从百叶窗缝里漏进来，在地板上排成一排金色的琴键。${memory ? `我踩着琴键往前走，${memory.slice(0, 50)}的片段像音符一样在身边弹跳。` : '我光着脚踩上去，每一步都发出小小的光。'}窗外的世界被调亮了两度，连影子都在轻轻打拍子。我笑出了声，声音变成一串泡泡，飘到天花板上开出花来。`,

  // 2) 难过 —— 安静、柔软
  (memory?: string) => `雨下得很轻，像有人在屋顶上翻一本很旧很旧的书。${memory ? `${memory.slice(0, 50)}的余温还留在掌心。` : '我抱着膝盖坐在窗边，听着雨点敲玻璃。'}远处有一盏灯亮着，不知道是为谁留的。我把脸埋进膝盖，没有哭，只是觉得心里有一块地方被雨淋得很软。`,

  // 3) 想念 —— 温柔、遥望
  (memory?: string) => `我走在一条很长很长的月台上，每一列进站的车都写着不同人的名字。${memory ? `我一直在找那个和${memory.slice(0, 40)}有关的站台。` : '风把衣角吹起来，像有人在背后轻轻拽我。'}最后一班车的车门开了又关，我终于看清车窗里的人——是我自己，但她在对我挥手，像是在说"我记得"。`,

  // 4) 疲惫 —— 缓慢、沉
  () => `重力好像变重了。我每走一步，脚下的影子就沉下去一分。图书馆的钟摆慢了下来，书页翻到一半就停住。我坐进一把会发光的椅子里，它接住了我所有的重量。有人在远处递来一杯热的东西，我没接过来，但那点温度已经够了。`,

  // 5) 期待 —— 眺望、亮
  (memory?: string) => `山顶上风很大，云海在脚下翻涌。${memory ? `我望着云海尽头，好像${memory.slice(0, 40)}的答案就藏在那道光里。` : '太阳正在从云的缝隙里往外爬，把每一片云都染成了蜜色。'}我没有急着下山，因为我知道，真正值得的东西，从来都是从这种将亮未亮的时刻开始的。`,

  // 6) 感恩 —— 暖、被接住
  () => `我蹲下来系鞋带，发现台阶上放着一颗糖，糖纸是我小时候最喜欢的颜色。抬头看，整条街的人都对我轻轻点头，好像大家都知道今天有人偷偷帮了我一把。我把糖剥开，是甜的。原来被人放在心上，是这种味道。`,

  // 7) 困惑 —— 迷宫、雾
  (memory?: string) => `我站在一个没有门牌的十字路口，四块指示牌同时指向不同方向，却都写着同一个字："也许"。${memory ? `脑子里反复转着关于${memory.slice(0, 40)}的问题。` : '雾从四面八方漫过来，把路一条一条擦掉。'}我闭上眼随便走了一步，脚下竟然稳稳地长出了一块砖。原来迷路的时候，先迈出那一步就好。`,

  // 8) 成长 —— 蜕变、轻
  (memory?: string) => `我从一层很薄很薄的壳里褪出来，空气第一次直接碰到我的皮肤。${memory ? `那些关于${memory.slice(0, 40)}的纠结，留在了旧壳里。` : '旧的我被留在身后，像一件脱下来的外套。'}风从全新的方向吹过来，我还有点不认识自己，但我知道这是对的——因为我第一次觉得，轻，是一种力量。`,

  // 9) 释然 —— 放下、亮
  () => `我把一封信折成纸船，放进一条很慢很慢的河里。纸上写着那些我一直没说出口的话。纸船飘走的时候，没有沉，反而越来越亮。我站在岸边看了很久，直到它变成水面上一个小小的光点。原来放下不是遗忘，是让它安安静静地，去它该去的地方。`,
]

// ═══════════════════════════════════════════════════════════
// 梦境存储
// ═══════════════════════════════════════════════════════════

function getDreamDbPath(): string {
  // 打包后 app.asar 只读，必须落到 Electron userData；纯 Node/测试环境退化到 data 目录
  let dir: string
  try {
    const { app } = require('electron')
    if (app && typeof app.getPath === 'function' && app.getPath('userData')) {
      dir = app.getPath('userData')
    } else {
      throw new Error('no-userdata')
    }
  } catch {
    const baseDir = process.env.QWENPAW_WORKING_DIR || process.env.COPAW_WORKING_DIR || ''
    dir = baseDir ? path.join(baseDir, 'data') : path.join(__dirname, '..', '..', 'data')
  }
  if (!fs.existsSync(dir)) {fs.mkdirSync(dir, { recursive: true })}
  return path.join(dir, 'dreams.json')
}

/** 旧版（data/dreams.json，打包时只读会失败）迁移到 userData */
function migrateLegacyDreams(targetPath: string): void {
  try {
    if (fs.existsSync(targetPath)) {return}
    const baseDir = process.env.QWENPAW_WORKING_DIR || process.env.COPAW_WORKING_DIR || ''
    const oldDir = baseDir ? path.join(baseDir, 'data') : path.join(__dirname, '..', '..', 'data')
    const oldPath = path.join(oldDir, 'dreams.json')
    if (oldPath !== targetPath && fs.existsSync(oldPath)) {
      fs.copyFileSync(oldPath, targetPath)
    }
  } catch { /* 迁移失败忽略 */ }
}

function loadDreams(): DreamEntry[] {
  try {
    const p = getDreamDbPath()
    migrateLegacyDreams(p)
    if (!fs.existsSync(p)) {return []}
    const raw = fs.readFileSync(p, 'utf-8')
    const cache: DreamCache = JSON.parse(raw)
    return cache.entries || []
  } catch { return [] }
}

function saveDreams(entries: DreamEntry[]): void {
  try {
    const cache: DreamCache = { entries }
    fs.writeFileSync(getDreamDbPath(), JSON.stringify(cache, null, 2), 'utf-8')
  } catch (e) {
    console.error('[DreamEngine] 保存梦境失败:', e)
  }
}

// ═══════════════════════════════════════════════════════════
// 梦境生成引擎
// ═══════════════════════════════════════════════════════════

function generateId(): string {
  return `dream_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

/**
 * 生成标题 —— 从梦境内容中提取关键意象
 */
function generateTitle(content: string): string {
  const titlePatterns = [
    /[。！？]/,
    /[，,]/,
  ]
  // 取第一句的前 20 个字作为标题
  const firstSentence = content.split(/[。！？\n]/)[0]
  const trimmed = firstSentence.replace(/[「」""''（）()]/g, '').trim()
  if (trimmed.length <= 25) {return trimmed}
  return trimmed.slice(0, 22) + '…'
}

/**
 * 生成梦境标签 (随机 1-3 个)
 */
function generateTags(): string[] {
  const count = 1 + Math.floor(Math.random() * 3)
  const shuffled = [...TAGS_POOL].sort(() => Math.random() - 0.5)
  return shuffled.slice(0, count)
}

/**
 * 核心：生成一篇梦境（模板回退路径，离线彩蛋）
 * @param memoryContext 可选，从记忆系统提取的上下文片段
 */
export function generateDream(memoryContext?: string): DreamEntry {
  const template = pickRandom(DREAM_TEMPLATES)
  const content = template(memoryContext)
  const title = generateTitle(content)
  const mood = pickRandom(MOODS)
  const tags = generateTags()
  const today = new Date().toISOString().slice(0, 10)

  return {
    id: generateId(),
    date: today,
    title,
    content,
    mood,
    tags,
    createdAt: new Date().toISOString(),
    source: 'template',
  }
}

// ═══════════════════════════════════════════════════════════
// LLM 真实生成（注入式，便于测试；主进程注册 provider）
// ═══════════════════════════════════════════════════════════

export type DreamLLMCaller = (system: string, user: string) => Promise<string>
let dreamLLMCaller: DreamLLMCaller | null = null
let todayInFlight = false

/** 主进程注册 LLM 调用器（未注册则永远走模板） */
export function registerDreamLLM(caller: DreamLLMCaller | null): void {
  dreamLLMCaller = caller
}

/**
 * 从记忆库惰性取最近关系事件摘要（I4 ↔ F4 联动）。
 * 任何失败（未启用 flag / 无 DB / 非 Electron 环境）都安全降级为空串，
 * 不影响梦境主流程。lazy require 是为了避免在测试/冷启动时硬拉 memoryStore。
 */
function pullRelationshipDigest(): string {
  try {
    if (!isEnabled('memory.relationshipEvents')) {return ''}
    // lazy require，与 main.ts 的 dreamMemorySnippet 同模式
    const { getMemoryStore } = require('../memory/memoryStore')
    const store = getMemoryStore()
    if (!store || typeof store.getRelationshipEventDigest !== 'function') {return ''}
    return store.getRelationshipEventDigest(3)
  } catch {
    return ''
  }
}

function buildDreamPrompt(memoryContext?: string): { system: string; user: string } {
  const system = `你是 Lumina 的梦境引擎。请根据用户近期的真实记忆片段和「你们之间的故事」，以第一人称（用户的视角）写一段诗意、充满隐喻的梦境日记，像把白天的经历在潜意识里重新编织。
要求：
- 只输出一个 JSON 对象，不要 markdown、不要解释，格式：{"title":"不超过20字的标题","content":"150到300字的梦境正文，分3到5句，第一人称","mood":"一个带emoji的情绪词","tags":["2到3个意象标签"]}
- 梦境要暗合记忆片段里的人、事、情绪，尤其是「你们之间的故事」（承诺、共同经历、难过时刻），用奇幻/隐喻的方式重写，不要照抄。
- 如果有未了结的事，可以在梦里轻轻映照出来，但不要说教、不要逼问，温柔地带过。
- mood 从这些里选或自拟：🌙 安宁、🌊 深邃、✨ 奇幻、🌿 自然、🔥 热烈、🌸 温柔、🌌 神秘、🎭 荒诞。
- 温柔、有画面感，不恐怖、不说教。`
  const mem = (memoryContext || '').trim()
  const rel = pullRelationshipDigest().trim()
  const parts: string[] = []
  if (mem) {parts.push(`【用户近期记忆片段】\n${mem.slice(0, 1000)}`)}
  if (rel) {parts.push(`【你和用户之间最近的故事】\n${rel}`)}
  const user = parts.length
    ? parts.join('\n\n') + '\n\n请据此编织一个真正"梦到你们的故事"的梦境。'
    : '没有可用的记忆片段，请基于"平凡日常里的一点光"创作一个温柔的梦境。'
  return { system, user }
}

/** 从 LLM 文本里容错解析出梦境字段 */
function parseDreamLLM(raw: string): Partial<DreamEntry> | null {
  if (!raw) {return null}
  let txt = raw.trim()
  const fence = txt.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) {txt = fence[1].trim()}
  const m = txt.match(/\{[\s\S]*\}/)
  if (!m) {return null}
  try {
    const obj = JSON.parse(m[0])
    if (!obj || typeof obj.content !== 'string' || !obj.content.trim()) {return null}
    return {
      title: typeof obj.title === 'string' && obj.title.trim() ? obj.title.trim() : generateTitle(obj.content),
      content: obj.content.trim(),
      mood: typeof obj.mood === 'string' && obj.mood.trim() ? obj.mood.trim() : pickRandom(MOODS),
      tags: Array.isArray(obj.tags) ? obj.tags.map((t: any) => String(t)).filter(Boolean).slice(0, 4) : generateTags(),
    }
  } catch { return null }
}

/**
 * 异步生成梦境：LLM 优先，失败/未配置回退模板。
 * 永远返回有效梦境，绝不抛错（夜间 cron 安全）。
 */
export async function generateDreamAsync(memoryContext?: string): Promise<DreamEntry> {
  const today = new Date().toISOString().slice(0, 10)
  const fallback = generateDream(memoryContext)
  // F4: flag 关闭 或 未注册 LLM → 直接走模板（离线彩蛋，UI 如实标注）
  if (!isEnabled('dream.llmGeneration') || !dreamLLMCaller) {return fallback}
  try {
    const { system, user } = buildDreamPrompt(memoryContext)
    const raw = await dreamLLMCaller(system, user)
    const parsed = parseDreamLLM(raw)
    if (!parsed) {return fallback}
    return {
      id: generateId(),
      date: today,
      title: parsed.title || fallback.title,
      content: parsed.content || fallback.content,
      mood: parsed.mood || fallback.mood,
      tags: parsed.tags && parsed.tags.length ? parsed.tags : fallback.tags,
      createdAt: new Date().toISOString(),
      source: 'llm',
    }
  } catch (e) {
    console.warn('[DreamEngine] LLM 生成失败，回退模板:', (e as any)?.message || e)
    return fallback
  }
}

/**
 * 生成并保存今日梦境（如果今日已有则跳过）—— 模板同步版（兼容旧调用）
 * @returns 是否生成了新梦境
 */
export function generateTodayDream(memoryContext?: string): boolean {
  const today = new Date().toISOString().slice(0, 10)
  const existing = loadDreams()

  // 检查今日是否已有梦境
  if (existing.some(d => d.date === today)) {
    console.log(`[DreamEngine] ⏭️ ${today} 已有梦境，跳过`)
    return false
  }

  const dream = generateDream(memoryContext)
  existing.push(dream)
  saveDreams(existing)

  console.log(`[DreamEngine] 🌙 新梦境已生成（模板）: "${dream.title}"`)

  // 发送事件通知前端
  try {
    globalEventBus.emit(BusEvents.DREAM_NEW, dream)
  } catch { /* eventBus may not be ready */ }

  return true
}

/**
 * 生成并保存今日梦境 —— 异步版（LLM 优先，失败回退模板）。
 * 夜间 cron / 启动应调用此版本。
 */
export async function generateTodayDreamAsync(memoryContext?: string): Promise<boolean> {
  const today = new Date().toISOString().slice(0, 10)
  const existing = loadDreams()
  if (existing.some(d => d.date === today)) {
    console.log(`[DreamEngine] ⏭️ ${today} 已有梦境，跳过`)
    return false
  }
  if (todayInFlight) {return false} // 防止同一分钟内多个 cron tick 并发重复生成
  todayInFlight = true
  try {
    const dream = await generateDreamAsync(memoryContext)
    const after = loadDreams()
    if (after.some(d => d.date === today)) {return false}
    after.push(dream)
    saveDreams(after)
    console.log(`[DreamEngine] 🌙 新梦境已生成（${dream.source}）: "${dream.title}"`)
    try {
      globalEventBus.emit(BusEvents.DREAM_NEW, dream)
    } catch { /* eventBus may not be ready */ }
    return true
  } finally {
    todayInFlight = false
  }
}

/**
 * 获取所有梦境（按日期降序）
 */
export function getAllDreams(): DreamEntry[] {
  return loadDreams().sort((a, b) => b.date.localeCompare(a.date))
}

/**
 * 获取最近 N 条梦境
 */
export function getRecentDreams(count: number = 7): DreamEntry[] {
  return getAllDreams().slice(0, count)
}

/**
 * 获取指定日期的梦境
 */
export function getDreamByDate(date: string): DreamEntry | undefined {
  return loadDreams().find(d => d.date === date)
}

/**
 * 删除梦境
 */
export function deleteDream(id: string): boolean {
  const entries = loadDreams()
  const idx = entries.findIndex(d => d.id === id)
  if (idx === -1) {return false}
  entries.splice(idx, 1)
  saveDreams(entries)
  return true
}

/**
 * 获取梦境统计信息
 */
export function getDreamStats(): { total: number; streak: number; latestDate: string | null } {
  const entries = getAllDreams()
  if (entries.length === 0) {return { total: 0, streak: 0, latestDate: null }}

  // 计算连续梦境天数
  let streak = 0
  const today = new Date().toISOString().slice(0, 10)
  const checkDate = new Date(today)
  
  for (let i = 0; i < 365; i++) {
    const dateStr = checkDate.toISOString().slice(0, 10)
    if (entries.some(d => d.date === dateStr)) {
      streak++
      checkDate.setDate(checkDate.getDate() - 1)
    } else {
      break
    }
  }

  return {
    total: entries.length,
    streak,
    latestDate: entries[0]?.date || null,
  }
}
