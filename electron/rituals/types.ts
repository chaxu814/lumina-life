// ============================================================
// rituals/types.ts — 仪式感闭环（睡前复盘 + 晨间简报）类型定义
//
// 设计原则与 dream/dreamEngine.ts 一致：
//   - 核心逻辑全部可注入依赖，node 环境单测零 Electron 依赖
//   - LLM 不可用/失败时回退模板，source 字段如实标注 llm | template
//   - Day Replay 由并行功能开发，这里只依赖结构类型 DailyReplayLike，
//     不 import 它的具体实现
// ============================================================

export type RitualKind = 'night' | 'morning'
export type UtteranceSource = 'llm' | 'template'

/**
 * Day Replay 时间线（结构类型，由并行功能在集成阶段注入实现）。
 * 不要 import electron/dayreplay——它可能还不存在。
 */
export interface DailyReplayLike {
  /** YYYY-MM-DD */
  date: string
  items: Array<{
    ts: number
    kind: string
    title: string
    detail?: string
    actor?: string
    filesChanged?: string[]
  }>
  stats: {
    commands: number
    filesChanged: number
    turns: number
    delegates: number
    llmCalls: number
    costYuan: number
    promptTokens: number
    completionTokens: number
    byAgent: Record<string, number>
    byPurpose: Record<string, number>
  }
}

/** 仪式引擎对外依赖接口（集成阶段注入；生产适配器见 productionAdapter.ts） */
export interface RitualDeps {
  /** 构建当天 Day Replay（生产：getDayReplay().buildDailyReplay） */
  buildDailyReplay: () => DailyReplayLike
  /** LLM 口播生成；未配置/失败时抛错或返回空，引擎回退模板 */
  llmGenerate?: (prompt: string, opts?: { maxTokens?: number }) => Promise<{ text: string; source: 'llm' | 'template' }>
  /** TTS 播报；失败返回 ok:false 并带 detail（不吞 detail） */
  ttsSpeak?: (text: string) => Promise<{ ok: boolean; detail?: string }>
  /** 文字气泡降级通道 */
  showBubble?: (text: string, source: 'llm' | 'template') => void
  /** 桌宠动作（睡前安静动作/晨间招呼动作） */
  petAction?: (motion: string, expression?: string) => void
  /** 预算守卫：95%/100% 档暂停非必要调用（生产：getBudgetGuardian().isNonEssentialCallAllowed()） */
  budgetAllows?: () => boolean
  /** 可注入时钟（测试用） */
  now?: () => number
}

/** 一条口播产物 */
export interface RitualUtterance {
  kind: RitualKind
  text: string
  source: UtteranceSource
  /** 降级说明（如「天气暂不可用」），面板里诚实展示 */
  notes: string[]
  createdAt: number
}

/** 一次运行记录（持久化到状态文件，面板展示） */
export interface RitualRunRecord {
  kind: RitualKind
  at: number
  /** llm / template / skipped（跳过） */
  source: UtteranceSource | 'skipped'
  text?: string
  /** 跳过原因（预算超限等）；正常运行时为空 */
  reason?: string
  /** 呈现方式：TTS 播报 / 文字气泡 / 无通道 */
  delivered: 'tts' | 'bubble' | 'none'
  /** 手动触发（IPC rituals:runNight/runMorning）还是定时触发 */
  manual?: boolean
}

/** 用户可配：两个仪式的时间（HH:MM）。开关走 feature flag（rituals.nightReview / rituals.morningBriefing） */
export interface RitualConfig {
  /** 默认 "23:00" */
  nightTime: string
  /** 默认 "08:00" */
  morningTime: string
}

export const DEFAULT_RITUAL_CONFIG: RitualConfig = {
  nightTime: '23:00',
  morningTime: '08:00',
}

/** 状态文件内容 */
export interface RitualState {
  night?: RitualRunRecord
  morning?: RitualRunRecord
  /** 最近若干条运行记录（新→旧） */
  history: RitualRunRecord[]
}

/** 面板读取的完整状态 */
export interface RitualStatus {
  config: RitualConfig
  nightEnabled: boolean
  morningEnabled: boolean
  night?: RitualRunRecord
  morning?: RitualRunRecord
  history: RitualRunRecord[]
}
