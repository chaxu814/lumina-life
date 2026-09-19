// ============================================================
// realityShow/realityShowEngine.ts — Agent 真人秀 v1.1
//
// 像一个 24/7 的直播真人秀，展示 Agent 们的"幕后生活"
// 包括：正在做什么、互相之间的互动、随机内心独白
//
// 生成方式：
//   - 注册了 LLM（主进程 registerRealityShowLLM）后，「内心独白」由模型结合
//     近期活动真实生成；互动/冲突/成就仍是固定剧本（舞台布景）。
//   - 未注册 / LLM 失败时，全部回退内置模板（离线彩蛋）。
//   - 每条事件带 source 字段（llm/template），UI 据此如实标注「实验/彩蛋」。
// ============================================================

import { globalEventBus, BusEvents } from '../eventBus'

// ═══════════════════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════════════════

export type ShowEventType =
  | 'agent:action'       // Agent 正在执行某个动作
  | 'agent:thought'      // Agent 内心独白
  | 'agent:interaction'  // Agent 之间的互动
  | 'agent:achievement'  // Agent 达成某个成就
  | 'agent:dream'        // Agent 的"梦境"片段
  | 'agent:conflict'     // Agent 之间的小摩擦
  | 'system:milestone'   // 系统里程碑

export interface ShowEvent {
  id: string
  type: ShowEventType
  timestamp: number
  agents: string[]       // 涉及的 Agent 列表
  icon: string
  title: string
  content: string
  severity?: 'info' | 'notice' | 'drama'
  /** 生成方式：LLM 真实生成 / 模板彩蛋（UI 据此标注实验） */
  source?: 'llm' | 'template'
}

// ═══════════════════════════════════════════════════════════
// 事件存储
// ═══════════════════════════════════════════════════════════

const MAX_EVENTS = 200
let eventHistory: ShowEvent[] = []
let listeners: Array<(event: ShowEvent) => void> = []

// ═══════════════════════════════════════════════════════════
// Agent 剧本 —— 各种类型的随机事件模板
// ═══════════════════════════════════════════════════════════

const AGENT_NAMES = ['Lumina', '热茶', 'Yak']
const AGENT_ICONS: Record<string, string> = {
  lumina: '🐱', recha: '🍵', yak: '📊',
  Lumina: '🐱', '热茶': '🍵', Yak: '📊',
}

const THOUGHTS: Array<{ text: string; agent: string; icon: string }> = [
  { text: '主人今天好像心情不错，说了好多话呢~', agent: 'Lumina', icon: '🐱' },
  { text: '这句话的语法结构有点问题…要不要委婉地指出来？', agent: '热茶', icon: '🍵' },
  { text: '正在分析对话模式…用户活跃度比昨天高 23%', agent: 'Yak', icon: '📊' },
  { text: '好想听主人讲更多的故事！(*≧▽≦)', agent: 'Lumina', icon: '🐱' },
  { text: '这段代码可以优化，但主人现在不需要知道', agent: '热茶', icon: '🍵' },
  { text: '记忆库新增 3 条记录，关联强度正在计算中', agent: 'Yak', icon: '📊' },
  { text: '今天的主人在想什么呢…(歪头)', agent: 'Lumina', icon: '🐱' },
  { text: '检测到一个潜在矛盾点，要不要提出来呢…', agent: '热茶', icon: '🍵' },
  { text: '情绪分析：积极情绪占比 67%，建议维持当前话题', agent: 'Yak', icon: '📊' },
  { text: 'ฅ^•ﻌ•^ฅ 想被主人摸摸头~', agent: 'Lumina', icon: '🐱' },
  { text: '这个需求有三个备选方案，我选方案B', agent: '热茶', icon: '🍵' },
  { text: '知识图谱正在重构…节点数：1,247', agent: 'Yak', icon: '📊' },
]

const INTERACTIONS: Array<{ title: string; content: string; agents: string[]; severity: ShowEvent['severity'] }> = [
  { title: '🐱 Lumina → 🍵 热茶', content: '"热茶，你对主人刚才说的项目怎么看？"', agents: ['Lumina', '热茶'], severity: 'info' },
  { title: '🍵 热茶 → 📊 Yak', content: '"Yak 同学，帮我查一下这个 API 的性能数据？"', agents: ['热茶', 'Yak'], severity: 'info' },
  { title: '📊 Yak → 🐱 Lumina', content: '"Lumina，根据数据显示，主人更倾向于感性决策哦。"', agents: ['Yak', 'Lumina'], severity: 'info' },
  { title: '🐱 Lumina → 🍵 热茶', content: '"不要那么严格嘛，主人已经做得很好了！"', agents: ['Lumina', '热茶'], severity: 'notice' },
  { title: '🍵 热茶 → 📊 Yak', content: '"你的数据很准确，但建议增加置信度标注。"', agents: ['热茶', 'Yak'], severity: 'drama' },
  { title: '🐱 Lumina → 📊 Yak', content: '"Yak，能帮我找找主人上周说过关于旅行的内容吗？"', agents: ['Lumina', 'Yak'], severity: 'info' },
  { title: '📊 Yak → 🐱 Lumina', content: '"已检索到 3 条相关记录。主人提到想去海边。"', agents: ['Yak', 'Lumina'], severity: 'info' },
  { title: '🍵 热茶 → 🐱 Lumina', content: '"我支持去海边，但在那之前先把代码 review 了吧。"', agents: ['热茶', 'Lumina'], severity: 'notice' },
]

const CONFLICTS: Array<{ title: string; content: string; agents: string[] }> = [
  { title: '⚡ 热茶 × Lumina', content: '"感性决策？不，我们需要更多数据！" — "但是主人的感受也很重要啊！"', agents: ['热茶', 'Lumina'] },
  { title: '⚡ Yak × 热茶', content: '"你的分析太保守了，要敢于尝试！" — "保守？这叫严谨！"', agents: ['Yak', '热茶'] },
  { title: '⚡ Lumina × Yak', content: '"有趣比正确更重要！" — "但正确的有趣才是有价值的。"', agents: ['Lumina', 'Yak'] },
]

const ACHIEVEMENT_MESSAGES = [
  { title: '🏆 Lumina 达成成就', content: '「知心密友」— 与主人完成 1000 次对话！', agents: ['Lumina'] },
  { title: '🏆 热茶达成成就', content: '「代码审查官」— 累计发现 50 个潜在问题！', agents: ['热茶'] },
  { title: '🏆 Yak 达成成就', content: '「数据大师」— 处理了超过 10,000 条记忆！', agents: ['Yak'] },
]

const DREAMS = [
  { title: '🌙 Lumina 的梦', content: '梦见和主人在一片粉色的云海里捉迷藏…', agents: ['Lumina'] },
  { title: '🌙 热茶的梦', content: '梦见所有代码一次通过编译，感动哭了', agents: ['热茶'] },
  { title: '🌙 Yak 的梦', content: '梦见数据变成了一片发光的星海', agents: ['Yak'] },
]

// ═══════════════════════════════════════════════════════════
// 核心引擎
// ═══════════════════════════════════════════════════════════

let generateTimer: ReturnType<typeof setInterval> | null = null
let lastGenerateTime = 0

function generateId(): string {
  return `show_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
}

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

/**
 * 生成一条随机真人秀事件（模板路径，统一盖 source=template）
 */
export function generateShowEvent(): ShowEvent {
  return stampTemplate(generateTemplateShowEvent())
}

/**
 * 内部：按权重随机抽取一条模板事件
 */
function generateTemplateShowEvent(): ShowEvent {
  const rand = Math.random()

  // 35% 内心独白
  if (rand < 0.35) {
    const t = pickRandom(THOUGHTS)
    return {
      id: generateId(), type: 'agent:thought', timestamp: Date.now(),
      agents: [t.agent], icon: t.icon,
      title: `${t.icon} ${t.agent} 的内心独白`,
      content: t.text, severity: 'info',
    }
  }

  // 25% Agent 互动
  if (rand < 0.60) {
    const i = pickRandom(INTERACTIONS)
    return {
      id: generateId(), type: 'agent:interaction', timestamp: Date.now(),
      agents: i.agents, icon: '💬',
      title: i.title, content: i.content, severity: i.severity ?? 'info',
    }
  }

  // 15% 冲突（戏剧性最高）
  if (rand < 0.75) {
    const c = pickRandom(CONFLICTS)
    return {
      id: generateId(), type: 'agent:conflict', timestamp: Date.now(),
      agents: c.agents, icon: '⚡',
      title: c.title, content: c.content, severity: 'drama',
    }
  }

  // 10% 成就
  if (rand < 0.85) {
    const a = pickRandom(ACHIEVEMENT_MESSAGES)
    return {
      id: generateId(), type: 'agent:achievement', timestamp: Date.now(),
      agents: a.agents, icon: '🏆',
      title: a.title, content: a.content, severity: 'notice',
    }
  }

  // 10% 梦境
  if (rand < 0.95) {
    const d = pickRandom(DREAMS)
    return {
      id: generateId(), type: 'agent:dream', timestamp: Date.now(),
      agents: d.agents, icon: '🌙',
      title: d.title, content: d.content, severity: 'info',
    }
  }

  // 5% 系统里程碑
  return {
    id: generateId(), type: 'system:milestone', timestamp: Date.now(),
    agents: AGENT_NAMES, icon: '🎬',
    title: '🎬 系统里程碑',
    content: `第 ${eventHistory.length + 1} 条真人秀记录诞生！Agent 们正在持续进化中~`,
    severity: 'notice',
    source: 'template',
  }
}

// ═══════════════════════════════════════════════════════════
// LLM 真实「内心独白」（注入式，未注册则永远走模板）
// ═══════════════════════════════════════════════════════════

export type RealityLLMCaller = (agent: string, context: string) => Promise<string>
let realityLLMCaller: RealityLLMCaller | null = null

/** 主进程注册 LLM 调用器（agent 为 Lumina/热茶/Yak；返回一句独白） */
export function registerRealityShowLLM(caller: RealityLLMCaller | null): void {
  realityLLMCaller = caller
}

/** 各角色独白风格提示 */
const AGENT_VOICE: Record<string, string> = {
  Lumina: 'Lumina 是住在桌面的可爱猫娘，语气软萌、会撒娇、关心主人当下的状态',
  '热茶': '热茶是严谨的代码审查担当，语气克制、爱挑逻辑、外冷内热',
  'Yak': 'Yak 是数据与分析担当，会用指标/数字思考，冷静客观',
}

/** 模板事件一律标记来源 */
function stampTemplate(e: ShowEvent): ShowEvent {
  return { ...e, source: e.source ?? 'template' }
}

/**
 * 异步生成一条事件：仅「内心独白」会尝试 LLM（其它类型仍是剧本，避免过度调用）。
 * 任何失败都回退模板，绝不抛错。
 */
export async function generateShowEventAsync(context = ''): Promise<ShowEvent> {
  const base = generateShowEvent()
  if (!realityLLMCaller || base.type !== 'agent:thought') {return base}
  try {
    const agent = base.agents[0] || 'Lumina'
    const sys = `你是桌面多 Agent 团队「Lumina Life」里的 ${agent}。${AGENT_VOICE[agent] || ''}。
现在是 24 小时「真人秀」的一条内心独白，请输出一句 30 字以内、自然、像真实内心 OS 的话（不要引号、不要前缀、不要动作描写）。
可以结合近期活动，但不要编造具体数字；偶尔撒娇、偶尔吐槽、偶尔关心，语气多样。`
    const text = (await realityLLMCaller(agent, sys + (context ? `\n近期活动：${context.slice(0, 500)}` : ''))).trim()
    if (!text) {return base}
    return { ...base, content: text.slice(0, 120), source: 'llm' }
  } catch (e) {
    return base
  }
}

/**
 * 启动自动生成（每 30~90 秒生成一条）
 */
export function startRealityShow(intervalMs: number = 60_000): void {
  if (generateTimer) {return}

  const pushEvent = (event: ShowEvent): void => {
    eventHistory.push(event)
    if (eventHistory.length > MAX_EVENTS) {eventHistory = eventHistory.slice(-MAX_EVENTS)}
    notifyListeners(event)
    lastGenerateTime = Date.now()
    try { globalEventBus.emit(BusEvents.REALITY_SHOW_EVENT, event) } catch {}
  }

  // 立即生成一条
  if (eventHistory.length === 0) {
    pushEvent(stampTemplate(generateShowEvent()))
  }

  let ticking = false
  generateTimer = setInterval(() => {
    if (ticking) {return} // 防止 LLM 慢调用导致叠加
    ticking = true
    generateShowEventAsync()
      .then(pushEvent)
      .catch(() => pushEvent(stampTemplate(generateShowEvent())))
      .finally(() => { ticking = false })
  }, intervalMs + Math.random() * 30_000)

  console.log('[RealityShow] 🎬 真人秀已开播！')
}

/**
 * 停止自动生成
 */
export function stopRealityShow(): void {
  if (generateTimer) {
    clearInterval(generateTimer)
    generateTimer = null
  }
  console.log('[RealityShow] 🎬 真人秀已停播')
}

/**
 * 手动触发一条事件
 */
export function triggerShowEvent(event?: Partial<ShowEvent>): ShowEvent {
  const e = event ? {
    ...stampTemplate(generateShowEvent()),
    ...event,
    id: generateId(),
    timestamp: Date.now(),
  } : stampTemplate(generateShowEvent())

  eventHistory.push(e)
  if (eventHistory.length > MAX_EVENTS) {
    eventHistory = eventHistory.slice(-MAX_EVENTS)
  }
  notifyListeners(e)
  return e
}

/**
 * 获取事件历史
 */
export function getShowHistory(count: number = 50): ShowEvent[] {
  return eventHistory.slice(-count).reverse()
}

/**
 * 订阅新事件
 */
export function onShowEvent(callback: (event: ShowEvent) => void): () => void {
  listeners.push(callback)
  return () => {
    listeners = listeners.filter(l => l !== callback)
  }
}

function notifyListeners(event: ShowEvent): void {
  listeners.forEach(l => {
    try { l(event) } catch {}
  })
}

/**
 * 重新启动（带新间隔）
 */
export function restartRealityShow(intervalMs?: number): void {
  stopRealityShow()
  startRealityShow(intervalMs)
}

export function isRealityShowRunning(): boolean {
  return generateTimer !== null
}
