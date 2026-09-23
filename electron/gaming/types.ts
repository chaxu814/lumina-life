// ============================================================
// electron/gaming/types.ts — Minecraft 游戏集成模块类型定义
//
// 双路线设计：
//   - visual: 视觉路线（截图 + VLM 识别 + cuCore 键鼠操作），零配置
//   - bot:    程序化路线（Mineflayer bot API），需自建服务器
// ============================================================

/** 路线选择 */
export type GameRoute = 'auto' | 'visual' | 'bot'

/** 运行时实际生效的路线 */
export type ResolvedRoute = 'visual' | 'bot'

/** 物品栏格（hotbar 1-9 或背包槽） */
export interface GameItemStack {
  /** 槽位编号（hotbar 为 1-9） */
  slot: number
  /** 物品名（VLM 识别或 bot 读取，可能为空） */
  name?: string
  /** 数量 */
  count?: number
}

/** 坐标 */
export interface GamePosition {
  x: number
  y: number
  z: number
  dimension?: string
}

/** 结构化游戏状态 */
export interface GameState {
  /** 是否成功识别到游戏画面 */
  detected: boolean
  /** 命中的窗口标题（窗口级截图时） */
  windowTitle?: string
  /** 生命值 0-20 */
  health?: number
  maxHealth?: number
  /** 饥饿值 0-20 */
  food?: number
  /** 经验等级 */
  xpLevel?: number
  /** 视角水平角（yaw，度） */
  yaw?: number
  /** 视角垂直角（pitch，度） */
  pitch?: number
  /** 玩家坐标 */
  position?: GamePosition
  /** 游戏模式 */
  gamemode?: 'survival' | 'creative' | 'adventure' | 'spectator' | string
  /** 快捷栏 */
  hotbar: GameItemStack[]
  /** 附近实体（VLM 识别，可能为空） */
  nearEntities?: string[]
  /** VLM 原始描述（调试用） */
  raw?: string
}

/** 支持的游戏动作 */
export type GameActionType =
  | 'move_forward'
  | 'move_back'
  | 'move_left'
  | 'move_right'
  | 'jump'
  | 'sneak'
  | 'attack'
  | 'use'
  | 'place'
  | 'inventory'
  | 'chat'
  | 'craft'
  | 'look_at'
  | 'select_slot'

/** 动作请求（统一参数，由 gameActions 分发到具体路线） */
export interface GameActionRequest {
  action: GameActionType
  /** 移动/按键持续时间（毫秒），默认 500 */
  durationMs?: number
  /** chat 内容 / 其它文本 */
  text?: string
  /** 物品栏槽位 1-9（select_slot） */
  slot?: number
  /** 合成物品名（craft） */
  itemName?: string
  /** 绝对视角角（look_at） */
  yaw?: number
  pitch?: number
  /** 相对视角偏移（像素感鼠标移动） */
  deltaX?: number
  deltaY?: number
}

/** 程序化路线（Mineflayer）连接参数 */
export interface BotConfig {
  host: string
  port: number
  username: string
  version: string
  /** 是否启用 bot 路线（由 host 配置是否齐全决定） */
  enabled: boolean
}

/** 模块配置（来自 env / 应用设置） */
export interface GameConfig {
  /** 模块总开关 */
  enabled: boolean
  route: GameRoute
  /** 目标窗口标题片段（用于窗口级截图聚焦） */
  windowTitle: string
  bot: BotConfig
}

/** 动作执行结果 */
export interface GameActionResult {
  ok: boolean
  content: string
  error?: string
  /** 实际执行的路线 */
  route?: ResolvedRoute
}

/** 安全审查结果 */
export interface GameGuardResult {
  allowed: boolean
  reason?: string
  /** 是否需要用户审批（中风险） */
  needsApproval?: boolean
}
