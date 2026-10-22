// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// electron/gaming/profiles/generic.ts — 通用休闲 / 网页小游戏 Profile
//
// 用于慢节奏、以方向键 / 鼠标点按为主的休闲游戏：
// 2048、网页小游戏、回合制小游戏、菜单式游戏等。
// 这类游戏没有聊天命令与作弊接口，安全风险最低。
//
// 注意：该 Profile 无法可靠自动探测（浏览器标题多变），
// 需通过 LUMINA_GAME_PROFILE=generic 显式指定。
// ============================================================

import type { GameProfile } from './types'

export const genericProfile: GameProfile = {
  id: 'generic',
  displayName: '通用休闲游戏',
  windowMatch: { includes: ['2048', '小游戏', 'casual'] },
  processMatch: [],
  supportedRoutes: ['visual'],

  actionMap: {
    move_up: { keys: ['w'], hold: true, defaultDurationMs: 300, note: 'W 上移' },
    move_down: { keys: ['s'], hold: true, defaultDurationMs: 300, note: 'S 下移' },
    move_left: { keys: ['a'], hold: true, defaultDurationMs: 300, note: 'A 左移' },
    move_right: { keys: ['d'], hold: true, defaultDurationMs: 300, note: 'D 右移' },
    arrow_up: { keys: ['up'], note: '方向键上' },
    arrow_down: { keys: ['down'], note: '方向键下' },
    arrow_left: { keys: ['left'], note: '方向键左' },
    arrow_right: { keys: ['right'], note: '方向键右' },
    confirm: { keys: ['enter'], note: '回车确认' },
    back: { keys: ['esc'], note: 'Esc 返回/菜单' },
    click: { mouse: 'left_click', note: '鼠标左键点选' },
    right_click: { mouse: 'right_click', note: '鼠标右键' },
    wait: { note: '原地等待，观察画面变化' },
  },

  security: {
    dangerousChatCommands: [],
    safeChatCommands: [],
    mediumRiskActions: [],
    hasMultiplayer: false,
  },

  vlmPrompt: [
    '这是一个通用休闲 / 网页小游戏（可能是 2048、网页小游戏或菜单式游戏）。',
    '操作方式通常为方向键（上下左右）、回车确认、Esc 返回，或鼠标点击。',
    '读图要点：',
    '- 先识别这是什么游戏、当前分数 / 关卡 / 剩余步数；',
    '- 关注棋盘 / 菜单中的高亮、可点击按钮与提示文字；',
    '- 每次只做一个明确动作，动作后等待画面变化。',
    '若游戏已结束、卡住或需要用户介入，应建议停止。',
  ].join('\n'),

  actionCooldownMs: 400,
  description: '通用休闲游戏 Profile：方向键 / 鼠标点按类慢节奏小游戏。',
}
