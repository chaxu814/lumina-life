// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// electron/gaming/profiles/types.ts — 通用多游戏 Profile 框架类型
//
// 每个游戏（Minecraft / Factorio / ...）对应一个 GameProfile，
// 描述窗口/进程匹配、动作映射、安全规则、VLM 提示词等。
// profiles/registry.ts 负责注册与自动探测。
// ============================================================

/** 一条动作映射：动作名 → 键鼠序列描述（visual 路线用） */
export interface ProfileAction {
  /** 按键序列（如 ['w'] 持续按住，['e'] 点按） */
  keys?: string[]
  /** 鼠标动作 */
  mouse?: 'left_click' | 'right_click' | 'mouse_delta'
  /** 是否需要持续按住（移动类） */
  hold?: boolean
  /** 默认持续时间 ms */
  defaultDurationMs?: number
  /** 打开聊天框后输入文本（chat 专用） */
  opensChat?: boolean
  /** 备注（不支持的动作在此说明） */
  note?: string
}

/** 该游戏的专属安全规则 */
export interface ProfileSecurity {
  /** 危险聊天命令正则（命中即拒绝） */
  dangerousChatCommands: RegExp[]
  /** 安全聊天命令白名单 */
  safeChatCommands: RegExp[]
  /** 中风险动作（需审批） */
  mediumRiskActions: string[]
  /** 该游戏是否支持多人（影响安全提示） */
  hasMultiplayer: boolean
}

/** 一个游戏 Profile 的完整描述 */
export interface GameProfile {
  /** 唯一 id：'minecraft' | 'factorio' | ... */
  id: string
  /** 展示名：'Minecraft' | 'Factorio' */
  displayName: string
  /** 窗口标题匹配规则（用于自动探测） */
  windowMatch: { includes?: string[]; regex?: string[] }
  /** 进程名匹配（不含扩展名，小写） */
  processMatch: string[]
  /** 该游戏支持的路线 */
  supportedRoutes: Array<'visual' | 'bot'>
  /** 动作映射：动作名 → 键鼠序列描述 */
  actionMap: Record<string, ProfileAction>
  /** 专属安全规则 */
  security: ProfileSecurity
  /** VLM 提示词片段（拼入系统提示词） */
  vlmPrompt: string
  /** 动作冷却（毫秒），避免过快输入 */
  actionCooldownMs: number
  /** 游戏简介（给 Agent 看） */
  description: string
}
