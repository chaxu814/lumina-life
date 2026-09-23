# 🎮 Minecraft 游戏集成模块

> 📖 多游戏总览见 [gaming-overview.md](./gaming-overview.md) · 🛡️ 安全说明见 [game-safety.md](./game-safety.md)

Lumina 的游戏集成模块让 Agent 能**感知并操作 Minecraft**，基于 Lumina 既有的 Computer Use + VLM 架构，提供**视觉**与**程序化**双路线。

> v2 起，Minecraft 逻辑已提取为一个 GameProfile（`electron/gaming/profiles/minecraft.ts`），行为与重构前完全一致；新增游戏见 [game-profiles-guide.md](./game-profiles-guide.md)。

## 功能概览

| 能力 | 视觉路线 (visual) | 程序化路线 (bot) |
|------|------------------|------------------|
| 感知游戏状态 | 截图 → VLM 识别 | Mineflayer API 直读 |
| 移动 / 跳跃 / 潜行 | 键鼠按键 | `setControlState` |
| 攻击 / 使用 / 放置 | 鼠标左右键 | `attack` / `activateItem` |
| 视角转动 | 相对鼠标移动 | `bot.look(yaw, pitch)` |
| 聊天 | T 键 + 输入 + 回车 | `bot.chat()` |
| 合成 | ❌ 需 VLM 定位 | ✅ `bot.craft()` |
| 延迟 | 高（每次截图+VLM） | 低（直接协议） |
| 依赖 | VLM（零额外配置） | 自建/指定 MC 服务器 |

## 双路线设计

### 路线 1：视觉路线（零配置，默认）

复用 Lumina 既有的 Computer Use 管线：

- `electron/tools/impl/cuCore.ts` 提供 `captureScreen()` / `callVisionModel()` / `cuPressKey()` / `executeCuAction()`
- 模块 `electron/gaming/visualRoute.ts` 在其上封装游戏语义：
  - `game_see`：截图 → VLM 按游戏专用提示词输出 JSON → 解析为结构化 `GameState`（生命/饥饿/快捷栏/坐标）
  - `game_act`：动作映射到键鼠原语（W/A/S/D 持续按住、E 开包、左键攻击、右键使用、数字键切槽位）

游戏特有的两个原语（**持续按键移动**、**相对鼠标视角**）隔离在 `visualRoute.ts` 内，不改动通用 cuCore 与平台适配器接口。

### 路线 2：程序化路线（可选，Mineflayer）

- 通过 `await import('mineflayer')` **动态加载**（optionalDependency，未安装时优雅降级）
- `electron/gaming/botRoute.ts` 封装 bot 连接与动作
- 仅走 `auth: 'offline'` 离线模式，**不处理正版 session token**
- 未配置服务器或 mineflayer 不可用时，`resolveRoute()` 自动回退视觉路线

## 配置方法

编辑 `.env`（参考 `.env.example`）：

```bash
# 总开关（默认关闭）
LUMINA_GAME_ENABLED=true
# auto | visual | bot
LUMINA_GAME_ROUTE=auto
LUMINA_GAME_WINDOW_TITLE=Minecraft

# 程序化路线（可选，配置后 auto 自动走 bot）
LUMINA_MINECRAFT_HOST=127.0.0.1
LUMINA_MINECRAFT_PORT=25565
LUMINA_MINECRAFT_USERNAME=lumina_bot
LUMINA_MINECRAFT_VERSION=1.20.4
```

> 视觉路线只需 `LUMINA_GAME_ENABLED=true` 与可用的 VLM（`LUMINA_VLM_*`），无需服务器。

## 工具列表

注册到 `tools/registry.ts` 的 `gaming` toolset：

| 工具 | 说明 | 关键参数 |
|------|------|----------|
| `game_status` | 获取当前游戏状态 | `window_title`（可选） |
| `game_action` | 执行游戏动作 | `action`（移动/跳跃/攻击/使用/放置/切槽位等）、`duration_ms`、`slot` |
| `game_look` | 调整视角 | `yaw`/`pitch` 绝对角，或 `delta_x`/`delta_y` 相对偏移 |
| `game_chat` | 发送聊天 | `message` |

`action` 枚举：`move_forward` / `move_back` / `move_left` / `move_right` / `jump` / `sneak` / `attack` / `use` / `place` / `inventory` / `select_slot`。

## 安全限制

所有游戏操作经过两道护栏：

1. **游戏专属护栏**（`electron/gaming/security.ts`）：
   - 拦截危险聊天命令：`/op`、`/deop`、`/stop`、`/restart`、`/kill @e`、`/ban`、`/fill`、`/setblock` 等管理员/破坏命令
   - 其它斜杠命令（如 `/give`）标记为**中风险**，触发审批流
   - `select_slot` 限制 1-9；`look_at` 限制 yaw ∈ [-180,180]、pitch ∈ [-90,90]
   - 禁止连接认证服务器域名（xboxlive/microsoft/mojang）
2. **既有安全体系**：
   - 视觉路线键鼠操作走 `cuCore.executeCuAction`（权限门 + 高危硬拦截 + 动作后 dHash 验证）
   - `game_action` / `game_look` / `game_chat` 标记 `dangerous: true`，在 registry 层再过一次 `SecurityGuard.checkToolCall`

**禁止操作**：关闭游戏、修改系统设置、删除世界文件、输入 `/op` `/stop` 等管理员命令（除非用户显式走审批）。

## 模块结构

```
electron/gaming/
├── index.ts            # 模块入口，导出工具定义与 registerGamingTools()
├── types.ts            # GameState / GameActionRequest / GameConfig 等类型
├── gameConfig.ts       # env 配置解析 + resolveRoute() 路线决策
├── gameState.ts        # VLM 输出 → 结构化 GameState（纯函数）
├── security.ts         # 游戏专属安全护栏（纯函数）
├── visualRoute.ts      # 路线1：截图+VLM+cuCore 键鼠
├── botRoute.ts         # 路线2：Mineflayer（动态 import，可选）
├── gameActions.ts      # 统一分发层（安全审查 → 选路线 → 执行）
└── mineflayer.d.ts     # mineflayer 可选依赖的最小类型声明
```

## 已知限制

- **视觉路线依赖 VLM 准确率**：生命值/饥饿值/快捷栏识别取决于 VLM 对游戏 UI 的理解，低分辨率或复杂 UI 下可能误判；坐标只能在按 F3 显示调试信息时读到。
- **视觉路线合成不可靠**：合成需要在背包网格中精确定位，VLM 难以稳定完成；推荐程序化路线。
- **相对鼠标视角仅在 Windows 实现**：游戏相机需要 `mouse_event` 相对移动，macOS/Linux 下视角转动会降级为提示。
- **程序化路线需要服务器**：bot 需连接一个可加入的 Minecraft 服务器（本地单机需开 "开放到局域网"）；不支持正版账号自动登录。
- **move 持续时间**：视觉路线的 `duration_ms` 通过按住按键实现，超时后自动松开；过长动作受全局急停（Ctrl+Alt+X）保护。

## 与 AIRI 游戏能力对比

| 维度 | AIRI | Lumina |
|------|------|--------|
| 感知方式 | 视觉（VLM）为主 | 视觉 + 程序化双路线，可混用 |
| 操作底座 | 自有键鼠注入 | 复用 cuCore 跨平台适配器（Win/Mac/Linux） |
| 安全 | 应用级授权 | 复用既有 SecurityGuard + sandboxRules + CU 权限门 |
| 可维护性 | — | 纯函数模块（config/state/security）全覆盖单测 |
| 扩展性 | — | `gaming` toolset 独立，未来可接入更多游戏（Terraria/CS 等） |

## 测试

```bash
npx vitest run tests/gaming/
```

覆盖：配置解析与路线选择、VLM 状态解析、安全护栏（危险命令拦截/参数校验）、动作映射与分发。所有测试 mock cuCore / 平台适配器 / mineflayer，不实际连接游戏。
