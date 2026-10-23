# 🛡️ 游戏能力安全与合规说明

Lumina 的游戏集成让 AI 能看画面、操作键鼠、发送聊天。能力越大，越要小心。这页说明风险边界与使用礼仪。

## 反作弊风险（最重要）

**不要把 Lumina 用在带反作弊的竞技网游里。**

- 常见反作弊：BattlEye、EasyAntiCheat（EAC）、VAC、PunkBuster、Faceit AC 等
- 自动化键鼠输入、截图识别、脚本移动都可能被判定为外挂
- 后果：账号永久封禁，申诉基本无效

代码层硬拦截见 `electron/gaming/antiCheat.ts`：`ANTI_CHEAT_GAMES` 黑名单按窗口标题匹配
（CS2 / Valorant / PUBG / Fortnite / Apex / CoD / R6 / Overwatch / Rust / Tarkov 等）。
自动游玩每轮读取前台窗口标题，命中即硬停（`stopReason=anti_cheat_detected`）并展示
`SAFETY_PROMPT_ANTI_CHEAT` 温馨提示。

### ✅ 适合（慢节奏单机 / 合作）
- Minecraft（单机 / 自己开的服务器）
- Factorio（单机）
- 星露谷物语 Stardew Valley
- 文明系列 Civilization（文明6）
- 模拟城市 / 城市天际线
- 单机 RPG、视觉小说、回合制策略
- Terraria

### ⚠️ 谨慎（带在线模式的单机）
- Elden Ring / 只狼等带联机入侵的单机（在线模式可能触发反作弊/被举报）
- 任何有"线上模式"的游戏：建议只在离线 / 单机档使用

### ❌ 不适合（带反作弊的竞技网游）
- CS2 / Call of Duty: Warzone / Valorant
- PUBG / Fortnite / Apex Legends
- Rainbow Six Siege / Overwatch 2
- Rust / DayZ / Escape from Tarkov / Destiny 2
- 任何带 BattlEye / EAC / VAC / Vanguard / Ricochet 的竞技网游

> 注：黑名单为窗口标题匹配，可能漏检（游戏窗口标题不含游戏名）也可能误报。
> 拿不准时，默认不要在该游戏上开自动游玩。

**安全的游戏：**
- 单机沙盒：Minecraft（单机/自己开的服务器）、Factorio（单机）、Terraria
- 单机 RPG、模拟经营、回合制策略
- 官方明确允许 mod/脚本的游戏

## 用户协议

- 遵守游戏的 EULA / 用户协议
- 多人服务器里遵守服务器规则，不要刷屏、不要恶意破坏
- 不要用 AI 自动发送垃圾聊天、恶意辱骂、广告
- 不要绕过付费墙、DRM、区域限制

## 多人游戏礼仪

Lumina 的 `hasMultiplayer: true` Profile（Minecraft/Factorio）会标记多人风险：

- 自动游玩时**不要连到别人的服务器**
- 聊天内容经过安全审查，但仍要对自己发的话负责
- 不要用 AI 自动 PvP、抢资源、屠新人生存
- 如果服务器规则禁止 mod/插件，就不要用

## 安全护栏怎么工作

所有游戏操作经过三道门：

1. **游戏专属护栏**（`electron/gaming/security.ts`，按 Profile 规则）
   - 危险聊天命令直接拦截（`/op` `/stop` `/c` `/ban` 等）
   - 中风险动作（攻击/放置/合成）标记需审批
   - `select_slot`、`look_at` 参数范围校验
2. **既有 SecurityGuard**：`game_action`/`game_look`/`game_chat`/`game_auto` 标记 `dangerous: true`，registry 层再过一次审批门
3. **cuCore 权限门**：键鼠操作走 `executeCuAction`，高危动作硬拦截

## 自主游玩的额外提醒

`game_auto` 让 AI 自己跑，风险更高：

- **人在旁边照看**，随时按急停
- 不要离开电脑去跑长时间自动游玩
- AI 可能误判画面、点错按钮、建造错东西
- 重要操作（删存档、大规模建造、交易）先确认
- 连续 3 轮危险动作被拦会自动停止

## 温馨提示入口

首次开启游戏能力、首次进入自动游玩时，`electron/gaming/safetyPrompt.ts` 会展示友好提示，用户确认后持久化到 localStorage。文案要点：

- 只在单机/合作/官方允许场景使用
- 反作弊游戏封号风险
- 多人游戏不影响他人
- AI 反应有限，人在旁边照看

> 诚实披露：安全提示的 UI 按钮（"我知道了"）在 Electron 运行时的实际渲染未验证；逻辑层已测试。
