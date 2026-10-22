// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// orchestration/theater.ts — 团队可见性剧场（创新功能 2）
//
// 【要解决的问题】
// 同类项目有 Agent Teams 工作台和「依赖泳道画布」——
// 本质是一个**流程图**：谁在等谁、谁先谁后、卡在哪个节点。
// 这很准确，但也很冷。用户看到的是一张甘特图，不是「发生了什么」。
//
// Lumina 手里有同类项目没有的东西：
//   · 三个有名字、有性格、有情绪的角色（Lumina / 热茶 / Yak）
//   · 真实演化的亲密度与关系状态
//   · 每个角色**当下的情绪**（来自 emotionCore 的统一换算）
//
// 这三样东西合起来，能讲出一个流程图讲不了的故事：
// 「Lumina 把任务交给 Yak → Yak 写了 40 分钟 → 热茶挑出 3 个问题 →
//  Yak 返工 → Lumina 收尾，因为她担心你会等太久而有点焦虑」。
//
// 这就是「剧场」：**过程可见 + 带情绪 + 有角色弧光**。
//
// 【与已有能力的关系（重要：不重复造轮子）】
// 项目里已有三块相关设施，本模块**只做编排，不重写它们**：
//   · llmTrace.ts     → 提供任务级 start/end/耗时/成败的原始数据
//   · internPool.ts   → 提供 hire/assign/complete/fail 生命周期事件
//   · SubagentCards  → 已消费 subagent:event 做四态卡片
// theater 做的是把它们**按时间轴串成一条可回放的叙事**，
// 并为每一步补上「谁在做 + 他此刻什么心情」。
//
// 【为什么做成纯函数状态机】
// 1. 可单测——不绑 Electron、不绑主窗口、不绑 IPC
// 2. 跨进程可传输——纯数据在主进程算好，渲染进程只负责画
// 3. 可回放——只要喂同一串事件就得到同一串剧本，时间戳由外部传入
//
// 【关于「戏剧性」的边界】
// 本模块**不生成任何虚构内容**。
// 情绪是真实读来的，台词是 agent 实际说的话，耗时是真实测量的。
// 如果某个 agent 这次没说话，剧本里就是没有那句话——
// 宁可剧本平淡，也不编台词。虚假的戏剧性比平淡更伤信任。
// ============================================================

import { frontendThreeToCore, anxietyFrom, type FrontendThree } from '../pet/life/emotionCore'

// ═══════════════════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════════════════

/** 剧场里出现过的角色 */
export type TheaterRole = 'lumina' | 'yak' | 'recha' | 'intern' | 'system'

/** 一幕的种类 */
export type TheaterBeatKind =
  | 'scene_open'      // 开场：任务开始
  | 'delegate'        // 老大派活
  | 'worker_start'    // 工人开工
  | 'speech'          // 角色说了一句话（真实台词）
  | 'review'          // 审查意见
  | 'revision'        // 返工
  | 'worker_done'     // 工人收工
  | 'scene_close'     // 收场：任务完成
  | 'incident'        // 意外（失败/超时/被拦）

/** 情绪在剧情中的投影——不是数值，是「观众能看懂的说法」 */
export type EmotionBeat =
  | 'calm'        // 平静
  | 'confident'   // 有把握
  | 'focused'     // 专注
  | 'anxious'     // 焦虑
  | 'weary'       // 疲惫
  | 'pleased'     // 开心
  | 'upset'       // 不爽

export interface TheaterBeat {
  /** 幕内自增序号，渲染层做 key */
  seq: number
  /** 事件发生时刻（由外部传入，保证可回放） */
  at: number
  kind: TheaterBeatKind
  /** 谁在做 */
  role: TheaterRole
  /** 显示名 */
  actor: string
  /** 这一幕说了什么 / 做了什么（真实内容，不编造） */
  text: string
  /** 该角色此刻的情绪投影 */
  emotion: EmotionBeat
  /** 数值化情绪，供 UI 渲染颜色（-1~1） */
  valence: number
  /** 可选细节：耗时 ms、产出摘要等 */
  detail?: string
  /** 关联的任务标识（把一幕归到某个任务下） */
  taskId?: string
}

export interface TheaterState {
  /** 当前剧目 id */
  playId: string
  /** 原始任务描述 */
  title: string
  /** 幕序列 */
  beats: TheaterBeat[]
  /** 自增序号 */
  seq: number
  /** 开场时刻 */
  openedAt: number
  /** 是否已收场 */
  closed: boolean
}

export interface TheaterEvent {
  kind: TheaterBeatKind
  role: TheaterRole
  text: string
  /** 该角色此刻情绪（三维）。不传则视为中性 */
  emotion?: FrontendThree | null
  detail?: string
  taskId?: string
}

// ═══════════════════════════════════════════════════════════
// 情绪 → 情绪投影（观众能看懂的离散说法）
// ═══════════════════════════════════════════════════════════

/**
 * 把连续情绪压成 6 档「剧情标签」。
 *
 * 为什么要离散化：UI 真正能画的是 6 种颜色/表情，不是浮点数。
 * 而连续值直接进 UI 只会得到一片没有信息量的渐变。
 *
 * 阈值顺序有讲究——**先判极端，再判一般**：
 * 疲惫要优先于低落判（累 ≠ 难过），焦虑优先于开心判
 * （强唤醒的负效价是焦躁，不是失落）。
 */
export function projectEmotion(e: FrontendThree | null | undefined): {
  beat: EmotionBeat
  valence: number
} {
  if (!e || typeof e.mood !== 'number' || Number.isNaN(e.mood)) {
    return { beat: 'calm', valence: 0 }
  }
  const core = frontendThreeToCore(e)
  const v = core.valence
  // 焦虑用 emotionCore 的权威公式，与 emotionGating 共用同一函数——
  // 同一个情绪在两个功能里被判成不同结论，是 bug 不是特性。
  const anxiety = anxietyFrom(v, core.arousal)

  if (core.fatigue >= 0.8) {return { beat: 'weary', valence: v }}
  if (anxiety >= 0.35 && v < 0) {return { beat: 'anxious', valence: v }}
  if (v <= -0.5) {return { beat: 'upset', valence: v }}
  if (v <= -0.15) {return { beat: 'calm', valence: v }}
  if (v >= 0.6 && core.arousal >= 0.7) {return { beat: 'confident', valence: v }}
  if (v >= 0.3) {return { beat: 'pleased', valence: v }}
  return { beat: 'focused', valence: v }
}

// ═══════════════════════════════════════════════════════════
// 角色显示名
// ═══════════════════════════════════════════════════════════

const ACTOR_NAMES: Record<TheaterRole, string> = {
  lumina: 'Lumina 🐱',
  yak: 'Yak 💻',
  recha: '热茶 🍵',
  intern: '临时工',
  system: '系统',
}

export function actorName(role: TheaterRole): string {
  return ACTOR_NAMES[role] ?? role
}

// ═══════════════════════════════════════════════════════════
// 核心：纯函数状态机
// ═══════════════════════════════════════════════════════════

/** 开一场戏 */
export function openPlay(title: string, playId: string, now = Date.now()): TheaterState {
  return { playId, title, beats: [], seq: 0, openedAt: now, closed: false }
}

/**
 * 往剧目里加一幕。
 *
 * 不修改入参（纯函数），返回新 state——与其他 orchestration 模块保持一致。
 */
export function addBeat(
  state: TheaterState,
  ev: TheaterEvent,
  now = Date.now(),
): { state: TheaterState; beat: TheaterBeat } {
  const { beat: emoBeat, valence } = projectEmotion(ev.emotion)
  const seq = state.seq + 1
  const beat: TheaterBeat = {
    seq,
    at: now,
    kind: ev.kind,
    role: ev.role,
    actor: actorName(ev.role),
    text: ev.text,
    emotion: emoBeat,
    valence,
    ...(ev.detail ? { detail: ev.detail } : {}),
    ...(ev.taskId ? { taskId: ev.taskId } : {}),
  }
  // 环形上限：剧场不是日志，超过 200 幕就该收幕了
  const beats = [...state.beats, beat]
  if (beats.length > 200) {beats.splice(0, beats.length - 200)}
  return {
    state: { ...state, beats, seq, closed: ev.kind === 'scene_close' ? true : state.closed },
    beat,
  }
}

/** 批量加一幕（同样不可变） */
export function addBeats(
  state: TheaterState,
  events: TheaterEvent[],
  now = Date.now(),
): TheaterState {
  return events.reduce((s, _ev) => addBeat(s, _ev, now).state, state)
}

// ═══════════════════════════════════════════════════════════
// 剧目摘要（UI 顶部一行概览）
// ═══════════════════════════════════════════════════════════

export interface TheaterSummary {
  playId: string
  title: string
  beatCount: number
  closed: boolean
  elapsedMs: number
  /** 各角色登场幕数 */
  appearances: Record<string, number>
  /** 出现过的事故数 */
  incidents: number
  /** 整体情绪走向（首尾效价差） */
  emotionalArc: number
  /** 最后一句——用于「她最后说了什么」 */
  lastLine: string
}

export function summarizePlay(state: TheaterState, now = Date.now()): TheaterSummary {
  const appearances: Record<string, number> = {}
  let incidents = 0
  for (const b of state.beats) {
    appearances[b.role] = (appearances[b.role] || 0) + 1
    if (b.kind === 'incident') {incidents++}
  }
  const first = state.beats[0]
  const last = state.beats[state.beats.length - 1]
  return {
    playId: state.playId,
    title: state.title,
    beatCount: state.beats.length,
    closed: state.closed,
    elapsedMs: (state.closed ? last?.at ?? now : now) - state.openedAt,
    appearances,
    incidents,
    // 情绪弧光：结尾比开场更正面则为正
    emotionalArc: (last?.valence ?? 0) - (first?.valence ?? 0),
    lastLine: last?.text ?? '',
  }
}

// ═══════════════════════════════════════════════════════════
// 剧本渲染（给 LLM / 日报 / 导出用）
// ═══════════════════════════════════════════════════

/**
 * 把剧目渲染成一段可读的剧本。
 *
 * 用于「任务结束后给用户回放」或写入日报。
 * **不做润色**——这是发生过的对话记录，不是小说。
 */
export function renderScript(state: TheaterState): string {
  if (state.beats.length === 0) {return ''}
  const lines = state.beats.map(b => {
    const em: Record<EmotionBeat, string> = {
      calm: '平静', confident: '有把握', focused: '专注', anxious: '焦虑',
      weary: '疲惫', pleased: '开心', upset: '不爽',
    }
    const detail = b.detail ? `（${b.detail}）` : ''
    return `${b.actor}·${em[b.emotion]}：${b.text}${detail}`
  })
  return [`【${state.title}】`, ...lines].join('\n')
}

/**
 * 生成一句「这次任务的幕后花絮」——给朋友圈/日报用。
 * 挑最戏剧性的那一幕，而不是第一幕或最后一幕。
 */
export function pickHighlight(state: TheaterState): string | null {
  const dramatic = state.beats.filter(b =>
    b.kind === 'incident' || b.emotion === 'anxious' || b.emotion === 'weary' || b.emotion === 'upset',
  )
  if (dramatic.length === 0) {return null}
  // 情绪最极端的那一幕
  const pick = dramatic.reduce((a, b) => (Math.abs(b.valence) > Math.abs(a.valence) ? b : a))
  return `${pick.actor} ${pick.text}`
}
