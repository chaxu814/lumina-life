// ============================================================
// electron/gaming/profiles/stardewValley.ts — 星露谷物语 Profile
//
// 农场模拟 / 慢节奏经营，单机为主（可联机但默认单机）。
// 无程序化 bot API，仅视觉路线。
// 动作：WASD 移动、左键工具/互动、右键检查、E 背包、1-0 快捷栏、F 互动、Q 丢弃、ESC 菜单。
// ============================================================

import type { GameProfile } from './types'

const STARDEW_VLM_PROMPT = `你是《星露谷物语》农场模拟游戏的视觉分析助手。请观察游戏截图，只输出 JSON：
{
  "detected": true/false,            // 是否确实在玩星露谷物语
  "window_title": "窗口标题（若可见）",
  "health": null,                    // 星露谷无生命值
  "food": null,                      // 无饥饿值
  "stamina": 0-100,                  // 体力条（绿条，消耗工具会下降，睡觉/吃饭恢复）
  "gold": 数字,                      // 金币数（右上角）
  "season": "spring|summer|fall|winter",
  "day": 数字,                       // 当月第几天
  "time": "游戏内时间（如 08:30）",
  "location": "当前场景（农场/矿洞/城镇/沙滩…）",
  "hotbar": [{"slot":1,"name":"物品名","count":1}],  // 快捷栏 1-0
  "near_entities": ["附近的：NPC/动物/作物/怪物/宝箱"],
  "summary": "一句话描述当前局面（如：体力快用完了/在种地/矿洞探险中）"
}
读屏要点：顶部状态栏显示体力条、金币、季节日期、游戏内时间；底部是物品栏 1-0。
基础节奏：浇水/种地/钓鱼/采矿/和 NPC 对话，体力耗尽或太晚（凌晨）应回家睡觉。慢节奏，不要连续猛冲。`

export const stardewValleyProfile: GameProfile = {
  id: 'stardew-valley',
  displayName: 'Stardew Valley（星露谷物语）',
  windowMatch: { includes: ['Stardew Valley'] },
  processMatch: ['Stardew Valley'],
  supportedRoutes: ['visual'],

  actionMap: {
    move_up: { keys: ['w'], hold: true, defaultDurationMs: 400 },
    move_down: { keys: ['s'], hold: true, defaultDurationMs: 400 },
    move_left: { keys: ['a'], hold: true, defaultDurationMs: 400 },
    move_right: { keys: ['d'], hold: true, defaultDurationMs: 400 },
    tool_use: { mouse: 'left_click', note: '使用当前手持工具（锄头/镐/水壶/斧子），会消耗体力' },
    interact: { mouse: 'right_click', note: '检查/对话/打开箱子/收获作物' },
    inventory: { keys: ['e'], note: '打开背包菜单' },
    menu: { keys: ['esc'], note: '打开游戏菜单' },
    interact_f: { keys: ['f'], note: '部分版本 F 键互动/装备当前物品' },
    discard: { keys: ['q'], note: '丢弃当前手持物品到地上' },
    select_slot: { keys: ['1'], note: '数字键 1-0 切换快捷栏物品' },
    wait: { note: '原地等待片刻（看体力/时间变化）' },
  },

  security: {
    dangerousChatCommands: [],
    safeChatCommands: [],
    mediumRiskActions: ['tool_use'],
    hasMultiplayer: true,
  },

  vlmPrompt: STARDEW_VLM_PROMPT,
  actionCooldownMs: 350,
  description:
    '星露谷物语农场模拟。仅视觉路线：WASD 走路，左键用工具（耗体力），右键互动/收获/对话，E 背包，1-0 切物品，Q 丢弃，ESC 菜单。慢节奏，注意体力和时间。',
}
