# 🧩 如何为新游戏编写 GameProfile

本指南教你为 Lumina 接入一款新游戏。新增游戏只需：

1. 在 `electron/gaming/profiles/` 新建一个 `<game>.ts`
2. 导出一个 `GameProfile` 对象
3. 在 `profiles/registry.ts` 的 `PROFILES` 里注册
4. 写测试

## GameProfile 模板

```typescript
// electron/gaming/profiles/mygame.ts
import type { GameProfile } from './types'

export const mygameProfile: GameProfile = {
  id: 'mygame',
  displayName: 'My Game',

  // 窗口标题匹配（用于自动探测）
  windowMatch: {
    includes: ['My Game'],       // 窗口标题包含这些子串即命中
    // regex: [/My\s*Game/i],    // 也可用正则
  },

  // 进程名匹配（不含 .exe，小写）
  processMatch: ['mygame'],

  // 支持的路线：visual 必选；有 bot API 才加 'bot'
  supportedRoutes: ['visual'],

  // 动作映射：动作名 → 键鼠描述
  actionMap: {
    move_forward: { keys: ['w'], hold: true, defaultDurationMs: 500 },
    move_back:    { keys: ['s'], hold: true, defaultDurationMs: 500 },
    move_left:    { keys: ['a'], hold: true, defaultDurationMs: 500 },
    move_right:   { keys: ['d'], hold: true, defaultDurationMs: 500 },
    attack:       { mouse: 'left_click', hold: true, defaultDurationMs: 300 },
    use:          { mouse: 'right_click' },
    inventory:    { keys: ['e'] },
    select_slot:  { keys: ['1'], note: '动态槽位 1-N' },
    chat:         { keys: ['t'], opensChat: true },
    look_at:      { mouse: 'mouse_delta' },
    craft:        { note: '视觉路线不支持精确合成' },
  },

  // 专属安全规则
  security: {
    dangerousChatCommands: [
      /^\s*\/(admin|god|kill)\b/i,
    ],
    safeChatCommands: [
      /^\s*\/(help|players)\b/i,
    ],
    mediumRiskActions: ['attack', 'use', 'craft'],
    hasMultiplayer: true,
  },

  // VLM 读屏要点（拼进系统提示词）
  vlmPrompt: `你是 My Game 视觉分析助手。画面含主菜单/血条/小地图/技能栏...
读屏要点：左上角资源、底部快捷栏、中间主视野。
基础目标：...`,

  // 动作冷却（毫秒）
  actionCooldownMs: 120,

  description: 'My Game 是一款...',
}
```

## 注册

在 `profiles/registry.ts`：

```typescript
import { mygameProfile } from './mygame'

export const PROFILES: Record<string, GameProfile> = {
  [minecraftProfile.id]: minecraftProfile,
  [factorioProfile.id]: factorioProfile,
  [mygameProfile.id]: mygameProfile,   // ← 加这行
}
```

## ProfileAction 字段说明

| 字段 | 含义 |
|------|------|
| `keys` | 按键序列（第一个键会被按下/点按） |
| `mouse` | `left_click` / `right_click` / `mouse_delta` |
| `hold` | 是否持续按住（移动类动作） |
| `defaultDurationMs` | 未指定 durationMs 时的默认持续时间 |
| `opensChat` | 打开聊天框后输入文本再回车（chat 专用） |
| `note` | 备注；如果**只有 note、没有 keys/mouse**，视觉路线会返回「不支持」 |

### 按键名约定

- 方向：`w` `a` `s` `d`
- 跳跃/特殊：`space` `shift` `e` `t` `r` `tab` `` ` ``
- 数字：`1`-`9`（`select_slot` 时动态替换为槽位号）

> Windows 下持续按键走 `keybd_event`；非 Windows 退化为点按。相对鼠标视角仅 Windows 实现。

## 安全规则怎么写

- `dangerousChatCommands`：正则数组，命中即拒绝。管理员命令、执行脚本、封禁、删除世界等都放这里。
- `safeChatCommands`：白名单，普通玩家可用的只读命令（`/help` `/players` `/version`）。
- `mediumRiskActions`：需要用户审批的动作（攻击、放置、合成等有副作用的）。
- `hasMultiplayer`：是否影响多人游戏（影响安全提示文案）。

## 写测试

参考 `tests/gaming/profiles.test.ts`：

```typescript
it('新 Profile 动作映射完整', () => {
  const actions = Object.keys(mygameProfile.actionMap)
  expect(actions).toContain('move_forward')
})

it('危险命令被拦截', () => {
  expect(reviewChat('/admin', mygameProfile).allowed).toBe(false)
})
```

## 适合接入的游戏类型

- ✅ 单机沙盒（Minecraft、Factorio、Terraria）
- ✅ 单机 RPG / 模拟经营 / 策略
- ❌ 带反作弊的竞技网游（BattlEye/EAC/VAC）——封号风险，不建议

欢迎社区贡献新的 Profile！
