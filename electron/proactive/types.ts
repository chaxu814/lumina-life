// ============================================================
// proactive/types.ts — 🧭 统一主动管线类型 (N.E.K.O 对齐 v6.1)
//
// 背景：Lumina 原本有两套割裂的主动系统——
//   A) intentDispatcher.petAutonomyTick：渲染页每 8s tick，LLM 直出 {action,mood,speech}；
//   B) proactiveEngine：主进程 7 类触发器，但 time/idle 触发器发的是硬编码模板，
//      且输出只走 toast + Windows 通知，不走桌宠表情。
// 本模块把两套系统统一成一条「事件 → 门控 → 思考 → 生成 → 表演」管线，
// 这里只定义跨模块共享的纯类型，零运行时依赖。
// ============================================================

/** 主动事件来源（触发器家族 + 管线内部事件） */
export type ProactiveEventSource =
  | 'cron'            // 定时话题（早安/午安/晚安等）
  | 'idle'            // 用户久未操作
  | 'screen'          // 屏幕场景感知（读 ScreenAwareness.scene）
  | 'hot_topic'       // 热搜
  | 'daily_paper'     // 每日论文
  | 'rhythm'          // 作息规律学习
  | 'opportunity'     // 聊天停顿后的机会窗口
  | 'drive_hard'      // 内驱力硬顶（social 积压太久）
  | 'unfinished_thread' // 上次她问了问题、用户还没答
  | 'startup'         // 应用启动重逢
  | 'external'        // 外部注入（IPC/其他模块主动喂事件）

/** 屏幕场景（与 pet/vision/screenAwareness 的 SceneKind 对齐） */
export type ProactiveScene =
  | 'game' | 'video' | 'code' | 'doc' | 'social' | 'idle' | 'other'

/** 一次进入管线的主动事件（触发器只负责「发生了什么」，不负责「说什么」） */
export interface ProactiveEvent {
  /** 事件来源 */
  source: ProactiveEventSource
  /** 对应旧触发器 id（cron 类触发器沿用，便于设置面板/统计回写） */
  triggerId?: string
  /** 当前屏幕场景（来自 ScreenAwareness.scene） */
  scene?: ProactiveScene
  /** 屏幕内容摘要（VLM/窗口标题给出的一句话，可选） */
  screenSummary?: string
  /** 外部话题素材（热搜/论文等） */
  externalTopics?: string[]
  /** 距上次互动/上次在线的分钟数（重逢语气分档用） */
  gapMinutes?: number
  /** 透传载荷（各触发器自定义） */
  payload?: any
}

/** 管线最终决策：说不说、做什么表情动作、台词是什么 */
export interface ProactiveDecision {
  /** 是否真的开口说话（false = 本轮沉默/只做事） */
  shouldSpeak: boolean
  /** 9 情绪标签之一（最终由 emotionCore 连续态决定，LLM 只建议） */
  mood?: string
  /** 动作标签（与 PetIntent.action 对齐） */
  action?: string
  /** 台词（20 字以内，带猫娘口癖） */
  speech?: string
  /** 高层表演指令（表情/视线/特效，出口前经 performanceDsl 白名单清洗） */
  performance?: any
  /** 决策理由（调试/门控日志用，不展示给用户） */
  reason: string
}
