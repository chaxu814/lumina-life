# 首个公开 Release 计划（战略项 ⑤）：精而小，先亮相

> 策略：**第一个公开版本不求功能全，求"装上就能在 3 分钟内看到生命体时刻"。**
> 建议首个公开版本号定为 **v0.1.0**（而不是沿用内部 1.0.0）——开源社区对 0.x 更宽容，也给后续迭代留空间；等"生命体 + 屏幕观察"被用户验证稳定后再发 1.0。

---

## 一、发布前打磨清单（按顺序勾）

### A. 必须修完（不做完不发布）

- [x] 桌宠对话乱回复（陪伴闲聊被误当搜索）——已修复
- [x] Live2D 纵向视线反向——已修复
- [x] 本地服务误填 API Key 导致 401、桌宠大脑整体哑火——已修复（本地端点 401 自动免密重试 + 全局供应商兜底 + 纯文本模型降级）
- [x] 设置页"最大输出"每次打开被重置为 8192——已修复（继承用户值并持久化）
- [x] 设置页 LLM 区域布局不齐——已修复（控件等高、弹性换行）
- [x] "立即搭话一次"无反馈——已修复（失败/未配置时给出可见提示）
- [ ] **真机冒烟**（在干净环境走一遍）：
      1. 全新用户数据目录启动 → 引导配置本地 LLM（不填 Key）→ 30 秒内桌宠能自主动一次
      2. 对桌宠说"你是谁/你是 coffee 吗" → 自然回应，不触发联网搜索式回答
      3. 开"屏幕观察/主动秘书" → 切到 VS Code/浏览器 → 30 秒内主动评价或关心
      4. 改"最大输出"为 4096 → 关闭设置再打开 → 仍是 4096
      5. Lumina 主 Agent 对话一次、Team Agent 派单一次（Yak 搜索/热茶审码）
- [ ] 主界面/桌宠里无英文报错、无红色错误条（截图自查 5 张）

### B. 对外门面（半天工作量，直接决定第一印象）

- [ ] `README.md` 首屏重写：第一屏 = 一句话定位（用 `docs/lumina-pitch-and-demo.md` 的主口径）+ 演示 GIF/视频 + 三张截图（生命体时刻、屏幕观察、多 Agent 团队）
- [ ] README 补"3 分钟快速开始"：环境要求 → 下载/安装 → 配本地模型（明确写：**LM Studio/Ollama 本地服务 API Key 留空**）→ 看到第一次主动搭话
- [ ] 截图统一用同一套桌面壁纸和同一人格，避免素材散乱
- [ ] LICENSE 确认（AGPL-3.0 OR Apache-2.0 双许可，README 里用普通人能懂的话解释一句）
- [ ] 仓库 About：一句话简介 + 主页链接 + 话题标签（`ai-companion` `live2d` `electron` `local-llm` `desktop-pet`）

### C. 安装包验证（1–2 小时）

- [ ] 本地跑 `npm run pack:win`，产出 NSIS 安装包
- [ ] 在**一台没有开发环境的 Windows 机器/全新 Windows 用户账户**安装并跑通 A 的冒烟流程
- [ ] 确认安装包不含 `pet-poc/`、`.cowork-temp/`、调试脚本、`.env`（已核查打包白名单，装机后再人工核对一次安装目录）
- [ ] 记录安装包体积；若 > 250MB，写进"后续优化"而不是首发硬卡
- [ ] 算出安装包 SHA256，发布时贴出

### D. 发布当天

- [ ] 演示视频先传 B 站/YouTube（不依赖 GitHub 加载），README 与 Release 都引用
- [ ] 先发一个 `v0.1.0` **草稿 Release**（CI 在打 tag 时会自动建草稿并上传安装包），自己下载安装包里外核对一遍再点 Publish
- [ ] 准备 3 个发布渠道的帖子文案（见 `docs/lumina-pitch-and-demo.md` 第三节）
- [ ] 准备好 issue 模板：Bug / 模型兼容（让用户贴 endpoint、模型名、日志，不要贴 Key）

---

## 二、版本号与 tag 操作（确认后由你执行，我不擅自打 tag/推送）

CI 已配置：推送 `v*` tag 即自动三系统打包并建**草稿** Release。

```powershell
# 1) package.json 版本改为 0.1.0
npm version 0.1.0 --no-git-tag-version
# 2) 提交
git add package.json package-lock.json CHANGELOG.md
git commit -m "chore(release): v0.1.0 first public release"
# 3) 打 tag 并推送（推送后 Actions 自动构建+建草稿 Release）
git tag v0.1.0
git push origin main --tags
# 4) 去 GitHub Actions 看构建，完成后在 Releases 页核对草稿、补 SHA256、点 Publish
```

---

## 三、v0.1.0 Release Notes 草稿（可直接贴，中文在前英文在后）

### 中文

```markdown
## Lumina Life v0.1.0 —— 第一版公开见面 🐱

Lumina 是一只"活着"的 AI 桌宠：大模型每一次思考都会同时写下她的**动作、表情和台词**，
身体与意识由同一个大脑实时驱动；她还会看着你的屏幕，在合适的时候主动关心你。
本地模型可跑，数据在你自己电脑上，开源。

### ✨ 这个版本能体验到什么
- **模型驱动的生命体身体**：动作/表情/台词由 LLM 实时输出的 JSON 统一决定，没有两次反应完全一样
- **屏幕观察与主动搭话**：识别你正在写代码、看视频或熬夜，主动开口（可一键关闭，隐私模式不截屏）
- **三 Agent 小团队**：你只和 Lumina 对话，Yak 负责搜索研究、热茶负责代码，在后台背靠背协作
- **情绪与记忆**：五维情绪追踪、SQLite 持久化记忆，越用越懂你
- **本地优先**：支持 LM Studio / Ollama 等 OpenAI 兼容接口，API Key 可留空

### ⚠️ 早期版本说明
- 目前主要在 Windows x64 验证；macOS/Linux 可用但体验可能不完整
- 需要自备一个 OpenAI 兼容的模型服务（推荐本地 7B 以上模型，视觉相关能力需要多模态模型；纯文本模型会自动降级为"看窗口标题"模式）
- 遇到问题请提 Issue，附上你的模型名、endpoint 和日志（请勿贴 API Key）

### 下载
| 平台 | 文件 |
|---|---|
| Windows 10/11 x64 | `*win-x64-setup.exe` |

> macOS / Linux 包会在后续小版本补齐。
```

### English

```markdown
## Lumina Life v0.1.0 — first public preview 🐱

Lumina is a *living* AI desktop companion: every LLM thought writes her
**motion, expression and words together** as one JSON command — her body is
driven by the model in real time, not by canned animation. She watches your
screen and checks in on you. Local-first and open source.

### Highlights
- **LLM-driven body**: action / mood / speech decided together, in real time
- **Screen awareness**: notices coding, videos or late-night work and speaks up first (privacy mode available, no screenshots when off)
- **A small agent team behind one face**: Lumina talks; Yak researches, Recha reviews code
- **Mood & persistent memory** (SQLite, local embeddings)
- **Local-first**: any OpenAI-compatible endpoint (LM Studio / Ollama); API key optional for local servers

### Early-preview notes
- Primarily tested on Windows x64; macOS/Linux builds may be rough
- Bring your own OpenAI-compatible model (local 7B+ recommended; multimodal for screenshots, text-only models gracefully fall back to active-window awareness)
- Please file issues with model name / endpoint / logs (never your API key)
```

---

## 四、首个版本"明确不做"（防止范围蔓延）

- 不做 VRM/捏脸、不做模型聚合商城、不做移动端
- 不承诺 macOS/Linux 完整体验
- 不堆功能数量，Release Notes 只讲"生命体 + 屏幕观察 + 后台团队"三件事
- 不为了发版临时加新特性；冻结功能，只修 bug 和门面

---

## 五、发布后第一周看三个数

1. **激活成功率**：下载→装好→3 分钟内看到第一次主动搭话的比例（靠 issue 和社群反馈估）
2. **"生命体时刻"被自发提及的次数**：用户有没有主动说"她好像真的活着"——这是卖点成立与否的唯一信号
3. Star / Issue 比：Issue 里"模型连不上"类问题占比，用来反哺 README 的快速开始

*本计划不自动执行任何发布动作；tag、推送、Publish 均由你确认后操作。*
