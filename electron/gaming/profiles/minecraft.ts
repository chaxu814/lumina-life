// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// electron/gaming/profiles/minecraft.ts — Minecraft Profile
//
// 从原 electron/gaming/{security,gameState,visualRoute} 中
// 硬编码的 Minecraft 逻辑提取而来，行为与重构前保持一致。
// ============================================================

import type { GameProfile } from './types'

/** 危险聊天命令前缀（管理员/破坏性），命中即拒绝 */
const DANGEROUS_CHAT_COMMANDS: RegExp[] = [
  /^\s*\/(op|deop|stop|restart|save-all|save-off|save-on)\b/i,
  /^\s*\/(kill)\s+@(e|a|p|r)\b/i,
  /^\s*\/(execute|executeas)\b/i,
  /^\s*\/(gamemode|defaultgamemode)\b/i,
  /^\s*\/(whitelist|ban|ban-ip|pardon|kick)\b/i,
  /^\s*\/(op)\b/i,
  /^\s*\/(setblock|fill|clone)\b/i,
  /^\s*\/(tp|teleport)\s+@(e|a)\b/i,
]

/** 允许的安全聊天命令白名单（普通玩家可用） */
const SAFE_CHAT_COMMANDS: RegExp[] = [
  /^\s*\/(help|list|seed|spawn|home|sethome|msg|tell|w|r|me|credits|demo|question)\b/i,
]

const MINECRAFT_VLM_PROMPT = `你是 Minecraft 游戏视觉分析助手。请观察游戏截图，输出一个 JSON 对象，描述玩家当前的游戏状态。
只输出 JSON，不要解释。字段如下：
{
  "detected": true/false,           // 是否确实在玩 Minecraft
  "window_title": "窗口标题（若可见）",
  "health": 0-20 之间的数字,        // 当前生命值（半心=1）
  "max_health": 20,
  "food": 0-20 之间的数字,         // 饥饿值
  "xp_level": 整数,
  "yaw": 水平视角角(度, -180~180, 估算),
  "pitch": 垂直视角角(度, -90~90, 估算),
  "position": {"x":0,"y":0,"z":0},  // 若能看到 F3 坐标则填，否则 null
  "gamemode": "survival|creative|adventure|spectator|unknown",
  "hotbar": [{"slot":1,"name":"物品名","count":1}],  // 快捷栏 1-9
  "near_entities": ["附近的生物/玩家"],
  "summary": "一句话描述当前局面"
}`

export const minecraftProfile: GameProfile = {
  id: 'minecraft',
  displayName: 'Minecraft',
  windowMatch: { includes: ['Minecraft'] },
  processMatch: ['javaw', 'java', 'minecraft'],
  supportedRoutes: ['visual', 'bot'],
  actionMap: {
    move_forward: { keys: ['w'], hold: true, defaultDurationMs: 500 },
    move_back: { keys: ['s'], hold: true, defaultDurationMs: 500 },
    move_left: { keys: ['a'], hold: true, defaultDurationMs: 500 },
    move_right: { keys: ['d'], hold: true, defaultDurationMs: 500 },
    jump: { keys: ['space'], hold: true, defaultDurationMs: 200 },
    sneak: { keys: ['shift'], hold: true, defaultDurationMs: 500 },
    attack: { mouse: 'left_click', note: '攻击准星对准的实体' },
    use: { mouse: 'right_click', note: '使用物品' },
    place: { mouse: 'right_click', note: '放置方块' },
    inventory: { keys: ['e'], note: '打开/关闭背包' },
    select_slot: { keys: ['1'], note: '动态槽位 1-9，视觉路线按数字键切换' },
    chat: { keys: ['t'], opensChat: true, note: '按 T 打开聊天框后输入文本' },
    craft: { note: '视觉路线不支持精确合成，请配置 Mineflayer 程序化路线' },
    look_at: { mouse: 'mouse_delta', note: '相对鼠标移动转动视角' },
  },
  security: {
    dangerousChatCommands: DANGEROUS_CHAT_COMMANDS,
    safeChatCommands: SAFE_CHAT_COMMANDS,
    mediumRiskActions: ['attack', 'place', 'craft'],
    hasMultiplayer: true,
  },
  vlmPrompt: MINECRAFT_VLM_PROMPT,
  actionCooldownMs: 100,
  description:
    'Minecraft 沙盒游戏。视觉路线支持移动/跳跃/攻击/使用/背包/聊天/视角；程序化路线通过 Mineflayer 连接自建服务器可读取实体状态与可靠合成。',
}
