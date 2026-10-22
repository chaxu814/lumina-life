// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// electron/gaming/profiles/civilization6.ts — 文明6 Profile
//
// 回合制 4X 策略游戏，无实时操作压力，节奏极慢。
// 无程序化 bot API，仅视觉路线。
// 动作：鼠标点击/移动、方向键平移视角、Enter 结束回合、ESC 菜单、F1-F10 面板。
// ============================================================

import type { GameProfile } from './types'

const CIV6_VLM_PROMPT = `你是《文明6》回合制 4X 策略游戏的视觉分析助手。请观察游戏截图，只输出 JSON：
{
  "detected": true/false,            // 是否确实在玩文明6
  "window_title": "窗口标题（若可见）",
  "turn": 数字,                       // 当前回合数（右上角）
  "civ_name": "当前文明领袖名",
  "gold": 数字,                       // 金币
  "science": 数字,                    // 科技每回合产出
  "culture": 数字,                    // 文化每回合产出
  "faith": 数字,                      // 信仰
  "city_count": 数字,                 // 城市数量
  "selected_unit": "当前所选单位名（若有）",
  "pending_notification": "是否有需要处理的弹窗/通知（如单位升级、新科技完成）",
  "summary": "一句话描述当前局面（如：等待结束回合/有单位待命令/城市在建奇观）"
}
读屏要点：右上角是回合数、金币、科技/文化/信仰产出；底部是所选单位的动作按钮；左上角是城市管理。
节奏：回合制，无需实时反应。通常流程是——处理弹窗通知 → 给单位下命令 → 管理城市建造 → 回车结束回合。慢下来，每步看清楚再点。`

export const civilization6Profile: GameProfile = {
  id: 'civilization-vi',
  displayName: 'Sid Meier’s Civilization VI（文明6）',
  windowMatch: { includes: ['Civilization VI', 'Sid Meier'], regex: ['civilization\\s*vi'] },
  processMatch: ['civilizationvi'],
  supportedRoutes: ['visual'],

  actionMap: {
    click: { mouse: 'left_click', note: '鼠标左键点选/选择/确认（点屏幕中心附近的目标）' },
    right_click: { mouse: 'right_click', note: '鼠标右键：移动单位到目标格 / 取消选择' },
    pan_up: { keys: ['up'], hold: true, defaultDurationMs: 200, note: '方向键上：地图视角北移' },
    pan_down: { keys: ['down'], hold: true, defaultDurationMs: 200, note: '方向键下：地图视角南移' },
    pan_left: { keys: ['left'], hold: true, defaultDurationMs: 200, note: '方向键左：地图视角西移' },
    pan_right: { keys: ['right'], hold: true, defaultDurationMs: 200, note: '方向键右：地图视角东移' },
    end_turn: { keys: ['enter'], note: '结束当前回合（回车）' },
    menu: { keys: ['esc'], note: '打开系统菜单 / 取消当前选择' },
    panel_civics: { keys: ['f1'], note: '打开 civic 面板（部分版本映射不同）' },
    panel_science: { keys: ['f2'], note: '打开科技树面板' },
    panel_religion: { keys: ['f7'], note: '打开宗教面板' },
    mouse_pan: { mouse: 'mouse_delta', note: '相对鼠标移动平移视角' },
    wait: { note: '原地等待/读弹窗，不操作' },
  },

  security: {
    dangerousChatCommands: [],
    safeChatCommands: [],
    mediumRiskActions: [],
    hasMultiplayer: true,
  },

  vlmPrompt: CIV6_VLM_PROMPT,
  actionCooldownMs: 500,
  description:
    '文明6回合制4X策略。仅视觉路线：鼠标点选/右键移动单位，方向键平移地图，回车结束回合，ESC 菜单，F 系列打开面板。回合制无实时压力，节奏很慢。',
}
