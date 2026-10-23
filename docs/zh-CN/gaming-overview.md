# 🎮 Lumina 多游戏集成总览

Lumina 的游戏能力不再局限于 Minecraft——通过 **GameProfile 框架**，任何游戏都可以以「Profile」的形式接入。当前已支持：

| 游戏 | 视觉路线 | 程序化路线 | 状态 |
|------|----------|------------|------|
| **Minecraft** | ✅ 截图 + VLM + 键鼠 | ✅ Mineflayer bot（可选） | 已落地待验证 |
| **Factorio** | ✅ 截图 + VLM + 键鼠 | ❌（无公开 bot API） | 已落地待验证 |

> 📖 Minecraft 专属细节见 [gaming-minecraft.md](./gaming-minecraft.md)。
> 🛡️ 安全与合规说明见 [game-safety.md](./game-safety.md)。
> 🧩 如何为新游戏编写 Profile 见 [game-profiles-guide.md](./game-profiles-guide.md)。

## Profile 架构

```
electron/gaming/
├── profiles/               # 多游戏 Profile 框架
│   ├── types.ts            # GameProfile / ProfileAction / ProfileSecurity
│   ├── minecraft.ts        # Minecraft Profile（从原硬编码逻辑提取）
│   ├── factorio.ts         # Factorio Profile（新）
│   ├── registry.ts         # PROFILES 注册表 + 自动探测
│   └── index.ts
├── autoPlay.ts             # 自主游玩闭环（感知→决策→审查→执行）
├── safetyPrompt.ts         # 首次开启/自动游玩的温馨安全提示
├── types.ts / gameConfig.ts / gameState.ts / security.ts
├── visualRoute.ts          # 视觉路线（动作映射读 profile.actionMap）
├── botRoute.ts             # 程序化路线（仅 Minecraft）
└── gameActions.ts          # 统一分发（解析 Profile → 选路线 → 审查 → 执行）
```

每个 Profile 描述：
- **窗口/进程匹配规则**（自动探测当前在玩哪款游戏）
- **动作映射**（动作名 → 键鼠序列，visual 路线用）
- **专属安全规则**（危险聊天命令、中风险动作）
- **VLM 提示词片段**（该游戏的读屏要点）
- **动作冷却**（避免过快输入）

## 如何切换游戏

### 方式一：自动探测（推荐）

不设置 `LUMINA_GAME_PROFILE`，Lumina 会根据前台窗口标题 / 进程名自动判断：
- 窗口标题含 `Minecraft` → Minecraft
- 窗口标题含 `Factorio` → Factorio

### 方式二：显式指定

在 `.env` 中设置：

```bash
LUMINA_GAME_PROFILE=factorio   # minecraft | factorio | auto
```

或在工具调用时传 `profile_id` 参数：

```
game_action(action="shoot", profile_id="factorio")
```

### 方式三：启用游戏白名单

```bash
LUMINA_GAME_ENABLED_GAMES=minecraft,factorio
```

## 工具列表（gaming toolset）

| 工具 | 说明 |
|------|------|
| `game_status` | 获取当前游戏状态（生命/快捷栏/附近实体） |
| `game_action` | 执行游戏动作（移动/攻击/建造/切槽位等） |
| `game_look` | 调整视角 |
| `game_chat` | 发送聊天（斜杠命令过安全审查） |
| `game_auto` | 自主游玩闭环（AI 自己看画面、决策、执行，限时停止） |

## 自主游玩（game_auto）

`runAutoPlay()` 实现了一个闭环：

1. **感知**：截图 → VLM 识别当前游戏状态
2. **决策**：把状态交给 VLM，让它输出下一步动作 JSON
3. **审查**：危险命令/动作被安全护栏拦下
4. **执行**：通过 visual 路线操作键鼠
5. **间隔**：每轮最小间隔（默认 800ms）

停止条件：达到最大轮数 / 超时 / 外部停止信号 / VLM 自己决定停 / 连续 3 轮危险动作被拦。

> ⚠️ 自主游玩未经真实游戏验证，VLM 的识别准确率和决策质量未知。**请人在旁边照看。**

## 温馨安全提示

首次开启游戏能力、首次进入自动游玩时，会展示友好的安全提醒（见 `safetyPrompt.ts`），确认后持久化。核心信息：

- 只在单机/合作/官方允许场景使用
- 不要用于带反作弊（BattlEye/EAC/VAC）的竞技网游
- 多人游戏不影响其他玩家
- AI 反应有限，重要操作先确认

详见 [game-safety.md](./game-safety.md)。
