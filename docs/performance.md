# Lumina Life 性能与资源占用

> 本文档记录 Lumina Life 的进程内存 / CPU 占用基准、各模块资源分析，以及降低资源占用的配置建议。
> 所有标注「实测」的数据均来自 `scripts/benchmark/` 在本机的真实采样；未实测的项目明确标注「待测量」。

---

## 一、测量环境（本次实测硬件）

| 项目 | 值 |
|------|----|
| 操作系统 | Windows 11 家庭版 中文版（build 26200，x64） |
| CPU | 12th Gen Intel Core i5-12490F（6 物理核 / 12 逻辑核，基频 3.0GHz） |
| 内存 | 47.8 GB |
| GPU | NVIDIA GeForce RTX 5060 Ti |
| Node.js | v22.23.2 |
| Electron | 40.x（`devDependencies: electron ^40.10.1`） |
| 构建产物 | `out/main/index.js`（`electron-vite build` 产物） |

> 不同硬件下绝对数值会有差异，但**进程数量级与占比关系**可作为参考。

---

## 二、性能基准表

### 2.1 已实测场景

| 场景 | RSS 内存 | Heap 内存 | CPU 使用率 | 测量条件 | 备注 |
|------|---------|-----------|-----------|---------|------|
| **纯 Node 脚本 idle**（实测） | **27.6 MB** | 4.38 MB | ~0%（整机） | `node benchmark.js`，无 Electron | 仅基准脚本自身进程开销 |
| **纯 Node + ONNX 运行时**（实测） | **59.6 MB** | 11.4 MB | ~0%（整机） | require `@xenova/transformers` 后，未加载模型 | 运行时本身开销约 **+32 MB**；加载具体模型后另计 |
| **Electron 应用 idle**（实测） | **合计 ~775 MB**（5 进程） | — | **~4%（整机）** | 启动 `electron out/main/index.js`，稳定 30s 后采样；Live2D 桌宠窗口运行中 | 见下方进程拆解 |

### 2.2 Electron idle 进程拆解（实测）

| 进程角色 | RSS | CPU（占整机） | 说明 |
|---------|-----|--------------|------|
| 主进程（main） | ~200 MB | ~0.7% | Electron 运行时 + better-sqlite3 + Agent 编排器 + 已注册工具 |
| 渲染/GPU 进程 A（桌宠/UI） | ~189 MB | ~1.5% | Live2D 桌宠窗口动画（呼吸/眨眼） |
| 渲染/GPU 进程 B（桌宠/UI） | ~196 MB | ~1.8% | 主 UI / 第二个渲染窗口 |
| 工具/辅助进程 | ~116 MB | ~0.03% | 工具或辅助渲染进程 |
| GPU/工具进程 | ~55 MB | ~0% | GPU 进程或空闲工具进程 |
| **合计** | **~755–796 MB** | **~4%** | 单次启动采样，存在 ±50MB 波动 |

> ⚠️ 这里的「idle」并非绝对静止：Live2D 桌宠动画仍在运行，因此渲染进程有持续 CPU。若关闭桌宠窗口，CPU 会进一步下降。

### 2.3 待测量场景（需真实负载，未在本次采集）

| 场景 | 状态 | 测量方法 |
|------|------|---------|
| `chat` 对话中 | 待测量 | 配置 LLM 后 `npm run api`，`POST /api/chat` 持续对话，同时用 `Get-Process` 采样 |
| `live2d` 高负载渲染 | 待测量 | 固定桌宠窗口前台、提高帧率后采样；idle 已含基础 Live2D 开销 |
| `onnx-loaded` 加载模型后 | 待测量 | 下载本地 ONNX 模型并加载，运行时已实测（+32MB），模型本身另计 |
| `computer-use` 截图+VLM 循环 | 待测量 | 配置 VLM 后运行截图→理解循环；未配置 Key 时只测截图开销 |

---

## 三、各模块资源占用分析

| 模块 | 内存量级 | 说明 |
|------|---------|------|
| **Electron 基础开销** | ~150–250 MB（主进程 RSS） | Electron 应用基线。本次实测主进程 ~200MB，与该区间一致。多进程模型下整机合计通常 500–900MB |
| **better-sqlite3** | ~10–20 MB | 原生模块，轻量；长期记忆数据库按需读写 |
| **@xenova/transformers + onnxruntime-node** | 运行时 ~+32MB（实测）；**加载模型后 +200MB–1GB** | 运行时（ONNX runtime 绑定）实测约 32MB；真正吃内存的是加载进内存的模型权重，取决于模型大小。默认不加载本地模型时开销较小 |
| **sharp** | ~30–50 MB | 图像处理原生模块，按需加载，不常驻 |
| **three.js + VRM 渲染** | GPU 显存 ~100–300 MB（VRM 启用时） | VRM 为 beta，默认关闭；启用后 GPU 显存增加，CPU 增加 |
| **Live2D 渲染** | 见渲染进程 ~190MB | CPU/GPU 占用取决于模型复杂度与 FPS，默认 30 FPS |
| **screenshot-desktop** | 按需 | Computer Use 截图时瞬时占用，不常驻 |

---

## 四、降低资源占用的配置建议

按「效果大 → 效果小」排序：

1. **启用 `mode.minimal` 精简模式** —— 只露核心功能（会主动找你 · 真记得你 · 安全帮你干一件事），减少启动加载的工具与 Agent 后台任务。
2. **关闭 VRM，只用 Live2D** —— 省去 three.js / @pixiv/three-vrm 的 GPU 显存与渲染开销。
3. **降低 Live2D FPS** —— 设置中可调，30 → 15 可明显降低渲染进程的 CPU/GPU（idle 的 ~4% CPU 主要来自桌宠动画）。
4. **关闭全屏注视（`fullscreenTrack`）** —— 减少鼠标位置高频推送与相关 IPC。
5. **降低主动搭话频率** —— 减少后台 LLM 调用次数。
6. **关闭屏幕视觉 / Computer Use** —— 减少截图与 VLM 调用，这是 CPU/网络/内存的大头之一。
7. **不加载本地 ONNX 模型，改用云端 API** —— 省去 200MB–1GB 的模型权重内存。
8. **关闭不必要的技能** —— 减少工具注册数与常驻内存。

> 经验值：在 8GB 内存机器上，关闭 VRM + 降低 FPS + 不加载本地模型，Lumina 整机占用可控制在 ~500MB 量级；不做任何优化时建议预留 1GB 以上内存。

---

## 五、基准复现方法

### 5.1 纯 Node 自测量（任何机器，无需 GUI）

```powershell
cd "<项目目录>"
node scripts\benchmark\benchmark.js --scenario idle --samples 5
# 查看输出的 benchmark-results.json
```

### 5.2 一键启动脚本（自测量 + 附加测量正在运行的应用）

```powershell
powershell -ExecutionPolicy Bypass -File scripts\benchmark\run-benchmark.ps1 -Scenario idle
```

脚本会：检查 Node → 运行 `benchmark.js` → 用 `Get-Process` 附加测量正在运行的 electron/Lumina 进程 → 报告结果文件路径。

### 5.3 应用级 idle 测量（本次实测所用方法）

```powershell
# 1. 启动已构建的应用
node_modules\electron\dist\electron.exe --no-sandbox out/main/index.js

# 2. 等待 30 秒稳定后采样
Get-Process -Name electron | Select-Object Id, @{N='WS_MB';E={[math]::Round($_.WorkingSet64/1MB,1)}}, CPU

# 3. 以 10 秒窗口采两次，用 CPU 累计秒数差推算 CPU%
#    CPU% = (CPU_t1 - CPU_t0) / 10s / 逻辑核心数 × 100
```

### 5.4 在 Electron 主进程内测量（可选增强）

`benchmark.js` 已自动检测 `process.versions.electron`：若在 Electron 主进程内运行，会额外采集 `process.getProcessMemoryInfo()`（private/shared/resident 细分）与 `app.getAppMetrics()`（所有子进程聚合）。

> 当前 `electron/main.ts` 尚未内置 `--benchmark` flag。如需在应用内直接跑基准，可在 CLI 模式分支增加 `--benchmark` 入口调用本脚本；未添加前，用上面 5.2 / 5.3 的附加测量即可。

### 5.5 测量注意事项

- 测量前关闭其他大型应用，避免内存/CPU 污染读数。
- 启动后**等待至少 30 秒**再采样，让 V8 堆与渲染进程稳定。
- 多次采样取平均；内存读数有 ±50MB 波动属正常。
- CPU% 必须用「同一进程两次采样的累计 CPU 秒数差 ÷ 墙钟时间 ÷ 逻辑核心数」计算，单次快照无意义。

---

## 六、结果文件

| 文件 | 内容 |
|------|------|
| `scripts/benchmark/benchmark.js` | 基准脚本本体 |
| `scripts/benchmark/run-benchmark.ps1` | PowerShell 启动/附加测量脚本 |
| `scripts/benchmark/benchmark-types.ts` | TypeScript 类型定义 |
| `scripts/benchmark/benchmark-results.json` | 最近一次纯 Node 自测量原始数据 |
| `scripts/benchmark/benchmark-electron-idle.json` | 本次 Electron 应用 idle 实测原始数据 |

---

## 七、跨平台性能与能力备注

> 上表基准均在 Windows 11 实测；macOS / Linux 数值「待实测」，以下为架构层面的已知差异。

- **macOS：** 鼠标/键盘走 AppleScript(System Events)，单次注入的往返延迟略高于 Windows 的 user32 直调；截屏走 `screencapture`。需在「系统设置 → 隐私与安全性」授予辅助功能 + 屏幕录制权限后上述能力才可用，否则会在日志里看到 `osascript` / `screencapture` 权限错误。
- **Linux (X11)：** 键鼠走 `xdotool`，截屏走 `scrot/import/gnome-screenshot`，命令经 bash 子进程，延迟与 macOS 同量级。**Wayland 会话下全局键鼠注入被合成器安全模型禁用**，仅截屏（grim）与打开应用可用——这是平台限制，非性能问题。
- **原生模块内存：** `better-sqlite3` / `onnxruntime-node` / `sharp` 在三平台均以预编译或 NAPI 形式加载，内存开销与平台无关；未装预编译而回退源码编译时，首次启动会有短暂编译期 CPU 尖峰，之后无差异。
- 各平台 Computer Use 能力的完整矩阵见 [internal/cross-platform-status.md](internal/cross-platform-status.md)，安装与依赖准备见 [INSTALL.md](INSTALL.md)。
