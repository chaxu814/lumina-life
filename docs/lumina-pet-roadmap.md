# Lumina Pet Mode · 桌宠路线图

> 目标：把 `pet-poc` 从“能跑的原型”升级成 **N.E.K.O / AIRI 级别的鲜活 AI 桌宠**，并和 Lumina 主程序深度打通，成为真正的“杀手锏”。

---

## 一、现状诊断

### 1.1 我们已经有的

| 能力 | 状态 | 说明 |
|------|------|------|
| 透明 Electron 窗口 | ✅ | 无边框、置顶、穿透点击 |
| Live2D 渲染 | ✅ | 虹色 Mao 模型 |
| AI 意图决策 | ✅ | brain.js → LLM / 规则兜底 |
| 基础动作执行 | ✅ | walk / emote / express / say / nap / idle |
| 可拖动 | ✅ | 主进程 IPC 控制窗口位置 |
| 双击 HUD | ✅ | 调试信息显示 |

### 1.2 还缺的关键能力

| 缺失项 | 影响 | 对标项目 |
|--------|------|----------|
| 随机 idle 小动作 | 静止时像“活物” | N.E.K.O、AIRI |
| 眼睛跟随鼠标 | 沉浸感大幅下降 | Live2D 标配 |
| 口型同步 TTS | 说话像“念稿” | NyaDeskPet、Live2DPet |
| 屏幕理解 / 主动搭话 | 只会被动反应 | N.E.K.O 核心卖点 |
| 参数级动作控制 | 动作僵硬、不自然 | Alan Becker 火柴人风格 |
| 与主程序联动 | 桌宠是孤立的 | Lumina 独特优势 |

---

## 二、竞品对比：差异化定位

| 项目 | 定位 | 核心优势 | Lumina 的机会 |
|------|------|----------|---------------|
| **N.E.K.O.** | AI 猫娘伴侣 | 五维记忆、Agent 执行、主动搭话 | 我们的多 Agent 团队 + 沙箱安全 |
| **AIRI** | AI VTuber / 桌宠 | Live2D+VRM、游戏陪玩、WebGPU | 我们的桌面控制 + 工具生态 |
| **NyaDeskPet** | 模块化桌宠框架 | 插件化、WebSocket 解耦 | 我们的产品化 + 一键安装 |
| **Live2DPet** | 截图感知桌宠 | VLM 视觉记忆、VOICEVOX | 我们的情绪系统 + 团队社交 |
| **Digital Mate** | 3D 桌宠 (Steam) | MMD+Live2D、VITS 语音 | 我们的开源 + 本地优先 |

### 我们的独特卖点

1. **团队在后台，桌宠在前台**  
   N.E.K.O. 只有一个“她”；Lumina 有 Lumina + 热茶 + Yak。桌宠可以是“Lumina 的分身”，后台 Agent 真的在干活，桌宠真的在“看着你”。

2. **情绪 × 记忆 × 动作的三映射**  
   不只是“情绪→表情”，而是：  
   `5D 情绪 → 表情参数` + `近期记忆 → 动作选择` + `用户习惯 → 行为模式`

3. **产品化落地**  
   其他项目大多是“开发者玩具”，我们要做成 **普通用户下载即用** 的桌面伴侣。

### 明确不做（Non-goals，2026-09 定）

- **不跟进 AIRI 的「AI 玩游戏 / 游戏陪玩」主线。** 理由：① 那是 AIRI 的差异化主场（视觉动作模型 + 游戏内实时决策），跟进属于资源消耗型的同质化竞争；② Lumina 的差异化在「LLM 同帧驱动身体 + 三 Agent 团队群像 + 桌面 Computer Use 与安全纵深」，有限精力应压在这条主线上；③ 游戏陪玩对实时视觉 / 输入注入的要求，与「安全可控的桌面助手」目标存在张力。
- **不做第二个通用执行 / 渠道网关。** 执行与渠道总线优先经 OpenClaw 桥接复用（见 `electron/channels/openclaw/`），Lumina 只聚焦人格、情绪、记忆与编排层。
- **不堆砌供应商数量。** 经统一调用层 `electron/core/unifiedChat.ts` 做归一，新增供应商以适配为主，不分散维护多套调用代码。

---

## 三、复现路径：四阶段计划

### Phase 1：把“鲜活感”拉满（1-2 周）

**目标**：从“能动的纸片人”变成“有生命的小家伙”

| 任务 | 具体动作 | 复杂度 | 预期效果 |
|------|----------|--------|----------|
| 动作超市 | 写脚本扫描 `motions/*.mtn` + `expressions/*.exp3.json`，生成动作/表情清单 | 低 | 知道模型“能做什么” |
| 随机 idle 行为 | 在 `index-electron.html` 加 `setInterval`，随机触发眨眼、转头、晃身体 | 低 | 静止时也有生命感 |
| 参数扰动 | `model.motion()` 前给 `ParamAngleX/Y/Z` 加随机偏移 | 低 | 动作不机械 |
| 眼睛跟随鼠标 | 监听 `mousemove` → 映射到 `ParamAngleX/Y` | 低 | 沉浸感↑↑ |
| 口型同步 | 接入 `edge-tts` / `Kokoro` → `AudioContext` → `ParamMouthOpenY` | 中 | 说话时嘴巴动 |

**关键代码片段（眼睛跟随鼠标）**：
```javascript
window.addEventListener('mousemove', (e) => {
  if (!model) return;
  const cx = window.innerWidth / 2;
  const cy = window.innerHeight / 2;
  const dx = (e.clientX - cx) / cx; // -1 ~ 1
  const dy = (e.clientY - cy) / cy;
  const cm = model.internalModel.coreModel;
  cm.setParameterValueById('ParamAngleX', dx * 25); // ±25°
  cm.setParameterValueById('ParamAngleY', dy * 20); // ±20°
});
```

---

### Phase 2：接通“感知”，让行为有上下文（2-4 周）

**目标**：从“随机反应”变成“有感知的陪伴”

| 任务 | 具体动作 | 复杂度 |
|------|----------|--------|
| 屏幕感知 | 主进程 `desktopCapturer` → 截图 → base64 → VLM（GPT-4o / 本地多模态）判断用户状态 | 中 |
| 时间感知 | 已有 `perception.js`，直接喂给 `brain.js` | 低 |
| 用户活动 | 主进程监听 `powerMonitor` / `globalShortcut`，计算 idle 时长 | 低 |
| 主动搭话 | 每 60-120s 触发 LLM：“当前感知：用户在写代码、已 idle 3 分钟 → 输出一句搭话” | 中 |

**关键设计：感知 → 意图 → 动作的闭环**

```
perception.js（五感）
    ↓
brain.js（LLM 输出意图 JSON）
    ↓
index-electron.html（执行动作）
```

**与 N.E.K.O. 的差异**：
- N.E.K.O. 的“主动搭话”是后台服务独立运行
- Lumina 的“主动搭话”可以联动 **主程序的 Agent 状态**（Yak 在写代码 → 桌宠物说“Yak 又在熬夜写代码了”）

---

### Phase 3：AI 完全接管动作生成（1-2 个月）

**目标**：从“选 preset 动作”变成“自由控制模型参数”

| 任务 | 具体动作 | 复杂度 |
|------|----------|--------|
| 动作生成器 | LLM 输出“参数序列”而非只选 preset motion。例如：`[{ ParamAngleX: 15, t: 0 }, { ParamAngleX: -10, t: 500 }]` | 高 |
| 物理模拟 | 接入 `cubism.physics3.json`，让头发、裙子随运动自然摆动 | 中 |
| 表情混合 | 同时叠加多个表情（BlendMode: Additive），实现“又笑又害羞” | 中 |
| 桌面穿梭 | `win.setPosition()` 实现“走到屏幕边缘换位置”，配合透明度渐变模拟“走近/走远” | 中 |

**核心技术突破：参数级控制**

当前：`model.motion('TapBody', 5)` → 播放预设动画  
目标：`model.coreModel.setParameterValueById('ParamAngleX', 15)` → AI 实时生成动作

**Prompt 设计**：
```
你是一个 Live2D 动作导演。根据当前情绪和场景，输出一个 1-3 秒的参数变化序列。
可用参数：ParamAngleX, ParamAngleY, ParamAngleZ, ParamBodyAngleX, ParamMouthOpenY, ParamEyeOpenLeft/Right
输出格式：[{"id": "ParamAngleX", "value": 15, "duration": 500}, ...]
```

---

### Phase 4：产品化“杀手锏”（2-3 个月）

**目标**：从“技术 demo”变成“可交付的产品功能”

| 任务 | 具体动作 | 复杂度 |
|------|----------|--------|
| 与主程序联动 | 主进程 IPC 推送“Lumina 正在帮用户写代码”“热茶审查完成”→ 桌宠自动播放对应动作 | 中 |
| 多人格 | 同一套参数映射，换模型自动适配 | 中 |
| UGC 动作工坊 | 用户录制动作序列 → 导出 JSON → 分享 | 高 |
| 手机投影 | 移动端 App 调用 PC Agent API → PC 桌宠同步反应（N.E.K.O 的“跨设备记忆”思路） | 高 |

**与主程序联动的场景示例**：

| Lumina 主程序状态 | 桌宠反应 |
|-------------------|----------|
| 用户刚发消息 | 开心跳跃 + “主人找我啦！” |
| Yak 在写代码 | 趴着打盹 / 安静陪伴 |
| 审查通过 | 挥手庆祝 + “太棒了✨” |
| 出错 / 需要审批 | 慌张表情 + “呜…出错了” |
| 定时任务触发 | 抬头看时钟 + “到点了哦” |

---

## 四、技术栈与依赖

| 层级 | 技术 | 用途 |
|------|------|------|
| 桌面壳 | Electron 40 | 透明窗口、置顶、穿透、IPC |
| 渲染 | PixiJS + pixi-live2d-display | Live2D 模型渲染 |
| 模型 | Cubism 4/5 | 虹色 Mao |
| AI 大脑 | LM Studio / Ollama / OpenAI | 意图决策、主动搭话 |
| 视觉理解 | GPT-4o / 本地 VLM | 屏幕内容理解 |
| 语音 | edge-tts / Kokoro / VOICEVOX | TTS + 口型同步 |
| 状态管理 | Electron IPC + Lumina 主进程 | 桌宠与主程序通信 |

---

## 五、时间线与里程碑

```
Week 1-2   Phase 1：鲜活感拉满（眼睛跟随、口型同步、随机 idle）
    ↓
Week 3-6   Phase 2：感知接通（屏幕理解、主动搭话、用户活动感知）
    ↓
Month 2    Phase 3：AI 接管（参数级动作控制、物理模拟、表情混合）
    ↓
Month 3+   Phase 4：产品化（主程序联动、多人格、UGC 工坊）
```

**Milestone 1（Week 2）**：桌宠“看起来活着了”  
**Milestone 2（Week 6）**：桌宠“能感知用户”  
**Milestone 3（Month 2）**：桌宠“能自由表达”  
**Milestone 4（Month 3）**：桌宠“成为产品的一部分”

---

## 六、风险与应对

| 风险 | 影响 | 应对 |
|------|------|------|
| Live2D 参数在不同模型上不一致 | 换模型时动作失效 | 建立参数映射表，自动检测模型能力 |
| LLM 输出不稳定 | 动作/表情切换突兀 | 规则兜底 + 频率限制 + 平滑过渡 |
| 屏幕截图隐私问题 | 用户担心被窥屏 | 本地处理、不保存截图、隐私模式开关 |
| 性能开销 | 透明窗口 + Live2D + LLM 同时运行卡顿 | 降级策略：低电量时关闭主动搭话 |
| 产品化难度 | 普通用户不会配置 | 一键安装、默认模型预置、向导式设置 |

---

## 七、下一步行动（本周可开始）

1. **扫描动作库**：写脚本列出 Mao 的所有 `motions` 和 `expressions`
2. **实现眼睛跟随**：在 `index-electron.html` 加鼠标监听
3. **加 idle 随机行为**：`setInterval` 每 3-8 秒随机触发小动作
4. **接通 perception.js**：把时间/用户活动喂给 `brain.js`
5. **测试主程序联动**：主进程通过 IPC 发一条测试消息给桌宠

---

## 八、总结：为什么 Lumina 能做成？

1. **已有骨架**：`pet-poc` 不是从零开始，有完整的 Electron + Live2D + AI 大脑
2. **独特优势**：多 Agent 团队 + 情绪系统 + 主程序联动，这是其他桌宠没有的
3. **产品化能力**：Lumina 主程序已经有安装包、自动更新、设置面板，桌宠可以复用
4. **用户基础**：Lumina 的用户就是桌宠的目标用户，天然有需求

**核心观点**：  
N.E.K.O. 做的是“一个 AI 猫娘住在你电脑里”；  
Lumina 要做的是“**三个 AI 团队在你电脑里工作，而 Lumina 本人随时跳到桌面上陪你**”。

这才是真正的差异化。

---

*文档维护：QA Agent*  
*最后更新：2026-08-23*
