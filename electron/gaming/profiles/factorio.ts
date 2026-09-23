// ============================================================
// electron/gaming/profiles/factorio.ts — Factorio Profile（新）
//
// Factorio 是工厂自动化游戏，无程序化 bot API，仅视觉路线。
// 危险命令以 /c（执行 Lua）为核心。
// ============================================================

import type { GameProfile } from './types'

/** Factorio 危险聊天/控制台命令 */
const DANGEROUS_CHAT_COMMANDS: RegExp[] = [
  /^\s*\/c\b/i,                 // 执行任意 Lua（最高危）
  /^\s*\/editor\b/i,
  /^\s*\/admins?\b/i,
  /^\s*\/(ban|unban)\b/i,
  /^\s*\/(kick|mute|unmute)\b/i,
  /^\s*\/(promote|demote)\b/i,
  /^\s*\/delete\b/i,
  /^\s*\/stop\b/i,
  /^\s*\/server-save\b/i,
  /^\s*\/scenario\b/i,
  /^\s*\/config\b/i,
]

/** Factorio 安全聊天/控制台命令白名单 */
const SAFE_CHAT_COMMANDS: RegExp[] = [
  /^\s*\/help\b/i,
  /^\s*\/players?\b/i,
  /^\s*\/time\b/i,
  /^\s*\/version\b/i,
  /^\s*\/evolution\b/i,
  /^\s*\/seed\b/i,
  /^\s*\/admin\b/i,            // 查看管理员列表
]

const FACTORIO_VLM_PROMPT = `你是 Factorio 工厂自动化游戏视觉分析助手。请观察游戏截图，输出一个 JSON 对象，描述玩家当前的工厂状态。
只输出 JSON，不要解释。字段如下：
{
  "detected": true/false,           // 是否确实在玩 Factorio
  "window_title": "窗口标题（若可见）",
  "health": 0-100 之间的数字,        // 玩家生命值（百分比，Factorio 默认 100）
  "max_health": 100,
  "food": null,                     // Factorio 无饥饿值
  "xp_level": null,                 // Factorio 无经验等级
  "yaw": 水平视角角(度, 估算),
  "pitch": 垂直视角角(度, 估算),
  "position": null,                 // Factorio 无 F3 坐标
  "gamemode": "normal|peaceful|unknown",
  "hotbar": [{"slot":1,"name":"物品名","count":1}],  // 快捷栏 1-5
  "near_entities": ["附近的：机械臂/组装机/传送带/敌人/资源点"],
  "summary": "一句话描述当前局面（如：正在采矿/传送带堵了/有敌人逼近）"
}
读屏要点：左上角是资源统计（铁/铜/石/煤/水），底部是快捷栏 1-5，中间可按 E 打开制作面板，右上角是小地图与科技进度。基础目标：采集资源 → 建造传送带与机械臂 → 组装机自动化生产 → 研究科技 → 抵御虫潮。`

export const factorioProfile: GameProfile = {
  id: 'factorio',
  displayName: 'Factorio',
  windowMatch: { includes: ['Factorio'] },
  processMatch: ['factorio'],
  supportedRoutes: ['visual'],
  actionMap: {
    move_forward: { keys: ['w'], hold: true, defaultDurationMs: 500 },
    move_back: { keys: ['s'], hold: true, defaultDurationMs: 500 },
    move_left: { keys: ['a'], hold: true, defaultDurationMs: 500 },
    move_right: { keys: ['d'], hold: true, defaultDurationMs: 500 },
    shoot: { mouse: 'left_click', hold: true, defaultDurationMs: 300, note: '朝准星方向开火/采矿/建造（按住可连射）' },
    attack: { mouse: 'left_click', hold: true, defaultDurationMs: 300, note: '同 shoot：左键' },
    use: { mouse: 'right_click', note: '放置实体/选择/拆除' },
    place: { mouse: 'right_click', note: '同 use：右键放置' },
    rotate: { keys: ['r'], note: '旋转正在放置的实体方向' },
    inventory: { keys: ['e'], note: '打开背包/制作面板' },
    select_slot: { keys: ['1'], note: '动态槽位 1-5，Factorio 快捷栏' },
    chat: { keys: ['`'], opensChat: true, note: '按 ` 打开聊天框（也可配置为 T）' },
    map: { keys: ['tab'], note: '查看全屏地图' },
    craft: { note: 'Factorio 合成通过 E 键制作面板，视觉路线需 VLM 定位按钮，不保证精确' },
    look_at: { mouse: 'mouse_delta', note: '相对鼠标移动平移视角' },
  },
  security: {
    dangerousChatCommands: DANGEROUS_CHAT_COMMANDS,
    safeChatCommands: SAFE_CHAT_COMMANDS,
    mediumRiskActions: ['shoot', 'attack', 'use', 'place', 'craft'],
    hasMultiplayer: true,
  },
  vlmPrompt: FACTORIO_VLM_PROMPT,
  actionCooldownMs: 150,
  description:
    'Factorio 工厂自动化游戏。仅视觉路线（无 bot API）：WASD 移动，左键采矿/建造/开火，右键放置/拆除，R 旋转实体，E 打开制作面板，数字键 1-5 切换快捷栏，` 聊天，Tab 看地图。',
}
