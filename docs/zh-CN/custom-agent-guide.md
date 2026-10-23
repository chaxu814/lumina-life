# 自定义 Agent 指南

Lumina 内置三个 Agent：**Lumina**（对你可见的老大）、**Yak**（代码工程师）、**热茶**（审查员）。
你可以创建自己的 Agent，让它们进团队帮忙干活，或作为对你可见的新助手。

---

## 1. 概念

每个 Agent 就是一个文件夹：

```
electron/agents/custom/<你的-id>/
├── agent.json    # 配置（id / 名字 / 人格 / 模型 / 工具集 / 团队角色）
├── SOUL.md       # 人格文件（UTF-8，写清楚它是谁、怎么说话、能做什么）
├── PROFILE.md    # 可选：专长/工作档案
└── MEMORY.md     # 可选：长期记忆（系统自动追加）
```

这与内置的 `electron/agents/lumina/`、`yak/`、`recha/` 结构完全一致。

## 2. 通过 UI 创建

打开 **设置 → 更多设置 → 🧩 自定义 Agent**：

1. 点「＋ 创建新 Agent」。
2. 填英文 id（字母开头，如 `my_bot`）、显示名、图标、一句话人格。
3. 选团队角色：
   - **member**：后台成员，Lumina 可以把活委托给它（默认）。
   - **leader**：对你可见，可在面板里「设为默认」，替代 Lumina 跟你对话。
   - **solo**：独立存在，不参与团队。
4. 创建后点「编辑人格」，在 SOUL.md 里写它的性格与能力边界，保存即生效。

## 3. 手动创建（不用 UI）

在 `electron/agents/custom/` 下新建文件夹，放一个 `agent.json`：

```json
{
  "id": "my_agent",
  "name": "我的助手",
  "icon": "🤖",
  "archetype": "custom",
  "personality": "自定义人格描述",
  "soulFile": "SOUL.md",
  "profileFile": "PROFILE.md",
  "memoryFile": "MEMORY.md",
  "ttsVoice": "zh-CN-XiaoxiaoNeural",
  "model": { "provider": "", "model": "", "baseUrl": "", "apiKey": "" },
  "toolsets": ["agent", "files_core"],
  "visible": true,
  "teamRole": "member",
  "createdAt": "2026-09-23"
}
```

字段说明：

| 字段 | 说明 |
|------|------|
| `id` | 必填，字母开头，仅字母/数字/`_`/`-`，不能有路径穿越 |
| `teamRole` | `leader` / `member` / `solo` |
| `toolsets` | 工具集，白名单：`agent` `files_core` `shell` `web` `memory` `delegate` `vision` |
| `model` | 留空则继承全局激活的 provider；也可独立指定 provider/model/key |
| `visible` | false 则不注册进团队 |

再写一个 `SOUL.md`（UTF-8）：

```markdown
# 我的助手

## 你是谁
一个专注于写周报的助手。

## 说话风格
直接、结构化，用清单表达。

## 能力边界
只能调用 files_core，不碰 shell。
```

重启或在面板刷新后即可识别。

## 4. 团队角色说明

- **leader**：对用户可见。设为默认后，它替代 Lumina 成为你聊天的对象。
- **member**：后台工作者，被 Lumina 委托执行任务后把结果返回给 Lumina，由 Lumina 汇总告诉你（你看不到它的名字）。
- **solo**：不进团队表，不参与委托，仅作为配置存在。

## 5. 模型配置

- **继承全局**：`model` 留空 → 自动用「设置 → LLM」里激活的供应商。
- **独立模型**：填 `model.provider` / `model.model` / `model.baseUrl` / `model.apiKey`，这个 Agent 走自己的模型，不影响别人。

## 6. 与内置三 Agent 的关系

- 自定义 `member` 会出现在 Lumina 的团队表里，可被 `delegate_to` 委托。
- 自定义 `leader` 可与 Lumina 并存，通过「设为默认」切换主对话对象。
- Yak（代码）与热茶（审查）仍然是固定的专业后台，自定义 Agent 是可扩展的补充人手。
