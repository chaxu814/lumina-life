// ============================================================
// conversationDynamics.ts — 群聊火花系统 (v2.8.3)
//
// Agent 像真人一样主动插话，而不是等待"呼叫"。
// 三种触发路径：
//   1. 不确定性接力 （旧机制，保留）
//   2. 火花触发       （概率性，Agent 主动想说话）
//   3. 点名触发       （回复中提到另一个 Agent）
// v2.8.3: 链式火花 — 火花触发后可能引发连锁反应
// ============================================================

import { emotionContext } from './agentEmotion'

// ── 火花类型 ──
export type SparkType =
  | '反驳'   // agent disagrees and offers alternative view
  | '补充'   // agent adds new info the first one missed
  | '吐槽'   // agent makes a witty/funny remark about previous reply
  | '关心'   // agent picks up emotional undertone first one missed
  | '冷幽默' // agent drops a deadpan joke (Yak special)

export interface SparkResult {
  triggered: true
  type: SparkType
  reason: string
  probability: number
  contextForLLM: string
  agentId: string
  agentName: string
  agentIcon: string
}

// ── Agent 配置 ──
const AGENTS = [
  { id: 'lumina', name: 'Lumina', icon: '🐱' },
  { id: 'recha', name: '热茶', icon: '🍵' },
  { id: 'yak', name: 'Yak', icon: '📊' },
]

// ── 火花类型权重 (每个 Agent 的倾向) ──
const SPARK_WEIGHTS: Record<string, Record<SparkType, number>> = {
  lumina: { '反驳': 0.05, '补充': 0.15, '吐槽': 0.20, '关心': 0.55, '冷幽默': 0.05 },
  recha:  { '反驳': 0.40, '补充': 0.30, '吐槽': 0.20, '关心': 0.05, '冷幽默': 0.05 },
  yak:    { '反驳': 0.25, '补充': 0.30, '吐槽': 0.05, '关心': 0.10, '冷幽默': 0.30 },
}

// ── 火花上下文提示 (v2.8.4: 重写为自然聊天语气) ──
const SPARK_CONTEXT: Record<SparkType, (firstAgent: string, firstReply: string) => string> = {
  '反驳': (a, r) =>
    `${a} 刚说「${r.slice(0, 100)}」——你听了觉得不对。不是恶意，就是你刚好知道更准确的信息。用你的方式纠正一下，像朋友聊天时随口说「诶其实不是那样的…」的感觉。`,

  '补充': (a, r) =>
    `${a} 刚说「${r.slice(0, 100)}」——你听着觉得还漏了点东西。不是 TA 说错了，是你刚好想到另一个角度。就像朋友聊天时突然想起来「哦对了还有…」那种自然补充。`,

  '吐槽': (a, r) =>
    `${a} 刚说「${r.slice(0, 100)}」——你忍不住想逗 TA 一下。不是攻击，是朋友之间的调侃。你知道 TA 不会真的生气，TA 也知道你这是亲近的表现。`,

  '关心': (a, r) =>
    `${a} 刚说了「${r.slice(0, 100)}」——你感觉对话里有些情绪没被接住。不是因为 TA 不好，是你刚好注意到了。就像朋友在你低落时多说一句「你还好吗」的自然关心。`,

  '冷幽默': (a, r) =>
    `${a} 刚说「${r.slice(0, 100)}」——你脑子里突然冒出一个冷幽默。不是为了表演，是你真的觉得这个角度很好笑。面无表情说出来，看看有没有人 get 到。`,
}

// ═══════════════════════════
// 核心：计算火花是否触发
// ═══════════════════════════
export function calculateSpark(params: {
  firstAgentId: string       // 刚回复的 Agent
  firstReply: string         // TA 的回复内容
  userText: string           // 用户原话
  recentTurnCount: number    // 最近几轮是否都是单 Agent（>3 则概率↑）
  agentCount: number         // 群里一共几个人(固定3)
}): SparkResult | null {
  const { firstAgentId, firstReply, userText, recentTurnCount } = params

  // ── 基础概率 12% ──
  let probability = 0.12

  // ── 情绪修正 ──
  const firstEmotion = emotionContext(firstAgentId)
  // 发言者情绪低迷 → 队友更可能接话
  if (firstEmotion.includes('心情低落')) probability += 0.12
  if (firstEmotion.includes('精力不足')) probability += 0.08

  // ── 上下文修正 ──
  // 用户问得长/复杂 → 更可能需要多人讨论
  if (userText.length > 80) probability += 0.08
  if (userText.length > 200) probability += 0.05

  // 回复较短 → 有更多补充空间
  if (firstReply.length < 60) probability += 0.10

  // 连续单 Agent 太久了 → 打破单调
  if (recentTurnCount >= 3) probability += 0.12
  if (recentTurnCount >= 5) probability += 0.08

  // 回复中提到其他 Agent → 高概率触发
  const mentionMatch = firstReply.match(/(热茶|Yak|Lumina)/gi)
  if (mentionMatch && mentionMatch.length > 0) probability += 0.20

  // 带了问号 → 可能是问另一个 Agent
  if (firstReply.includes('?') || firstReply.includes('?') || firstReply.includes('?') || firstReply.includes('？')) {
    probability += 0.10
  }

  // ── 上限 85%（不能太频繁）──
  probability = Math.min(probability, 0.85)

  // ── 掷骰子 ──
  const roll = Math.random()
  if (roll > probability) return null

  // ── 火花触发！选类型 + 选 Agent ──
  const otherAgents = AGENTS.filter(a => a.id !== firstAgentId)
  const speaker = otherAgents[Math.floor(Math.random() * otherAgents.length)]

  // 加权随机选火花类型
  const weights = SPARK_WEIGHTS[speaker.id]
  const types = Object.keys(weights) as SparkType[]
  const totalWt = types.reduce((s, t) => s + weights[t], 0)
  let pick = Math.random() * totalWt
  let sparkType: SparkType = types[0]
  for (const t of types) {
    pick -= weights[t]
    if (pick <= 0) { sparkType = t; break }
  }

  return {
    triggered: true,
    type: sparkType,
    reason: `roll=${roll.toFixed(2)} ≤ prob=${probability.toFixed(2)} | ${speaker.name} ${sparkType}`,
    probability,
    contextForLLM: SPARK_CONTEXT[sparkType](AGENTS.find(a => a.id === firstAgentId)?.name || firstAgentId, firstReply),
    agentId: speaker.id,
    agentName: speaker.name,
    agentIcon: speaker.icon,
  }
}

// ═══════════════════════════
// 检测旧版"不确定性接力"
// ═══════════════════════════
export function detectUncertainty(reply: string): boolean {
  const signals = /我不太确定|我不知道|我不擅长|这个我不|建议(问|找)|还是(问|找|交给)|这个.*比较懂|这.*会|你问|你找|让.*来/gi
  return signals.test(reply)
}

// ═══════════════════════════
// 检测「点名」：回复中提到另一个 Agent
// ═══════════════════════════
export function detectMentionInReply(reply: string, firstAgentId: string): string | null {
  const mentionMap: Record<string, RegExp> = {
    lumina: /(Lumina|lumina|猫娘|🐱)/gi,
    recha:  /(热茶|recha)/gi,
    yak:    /(Yak|yak|分析师|📊)/gi,
  }
  for (const [agentId, pattern] of Object.entries(mentionMap)) {
    if (agentId !== firstAgentId && pattern.test(reply)) {
      return agentId
    }
  }
  return null
}

// ═══════════════════════════
// v2.8.3: 链式火花 — 火花后的连锁反应
//
// 衰减曲线: 25% → 15% → 8% → 0%
// 每轮只能让还没说过话的人接，避免同一个人连说两轮
// ═══════════════════════════
const CHAIN_PROBABILITIES = [0.15, 0.08, 0.04]  // 🔧 降低链式火花概率，避免「收到」套话连环刷屏

export function calculateChainSpark(params: {
  lastSpeakerId: string        // 刚说完话的 Agent
  lastReply: string            // TA 的回复
  alreadySpokenIds: string[]   // 本轮已经说过话的 Agent（不能再选）
}): SparkResult | null {
  const { lastSpeakerId, lastReply, alreadySpokenIds } = params
  const chainIndex = alreadySpokenIds.length - 1  // -1 去掉第一个发言者
  const baseProb = CHAIN_PROBABILITIES[chainIndex] ?? 0
  if (baseProb <= 0) return null

  let probability = baseProb

  // ── 修正因子 ──
  // 前一个人话很短 → 更容易接
  if (lastReply.length < 50) probability += 0.08
  // 带问号 → 更可能是抛话题
  if (/[?？？]/.test(lastReply)) probability += 0.10
  // 提到队友名字 → 点名概率直接翻倍
  if (/(热茶|Yak|Lumina)/gi.test(lastReply)) probability += 0.25
  // Yak 冷幽默 → 热茶可能想吐槽回来
  if (lastSpeakerId === 'yak' && /据.*统计|数据.*显示|概率|r=|p-value/i.test(lastReply)) {
    probability += 0.12  // Yak 甩数据 → 热茶可能怼回来
  }
  // Lumina 撒娇/颜文字 → 队友可能忍不住接话
  if (lastSpeakerId === 'lumina' && /喵|呢|｡|💦/u.test(lastReply)) {
    probability += 0.10
  }

  probability = Math.min(probability, 0.70)  // 链式上限更低，避免太吵

  const roll = Math.random()
  if (roll > probability) return null

  // ── 选还没说过话的 Agent ──
  const available = AGENTS.filter(a => !alreadySpokenIds.includes(a.id) && a.id !== lastSpeakerId)
  if (available.length === 0) return null
  const speaker = available[Math.floor(Math.random() * available.length)]

  const weights = SPARK_WEIGHTS[speaker.id]
  const types = Object.keys(weights) as SparkType[]
  const totalWt = types.reduce((s, t) => s + weights[t], 0)
  let pick = Math.random() * totalWt
  let sparkType: SparkType = types[0]
  for (const t of types) {
    pick -= weights[t]
    if (pick <= 0) { sparkType = t; break }
  }

  return {
    triggered: true,
    type: sparkType,
    reason: `链式#${chainIndex + 1}: roll=${roll.toFixed(2)} ≤ prob=${probability.toFixed(2)} | ${speaker.name} ${sparkType}`,
    probability,
    contextForLLM: SPARK_CONTEXT[sparkType](
      AGENTS.find(a => a.id === lastSpeakerId)?.name || lastSpeakerId,
      lastReply,
    ),
    agentId: speaker.id,
    agentName: speaker.name,
    agentIcon: speaker.icon,
  }
}
