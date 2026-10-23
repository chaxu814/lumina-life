# Lumina 跨平台状态报告（Computer Use · 部署 · 原生依赖）

> 适配层位置：`electron/core/platform/`（PlatformAdapter 接口 + Windows/Mac/Linux 实现 + 工厂 DI + 能力矩阵）。
> 本次更新：**2026-10-02 · macOS 适配层完成**（含 3 个真实缺陷修复）。
>
> ⚠️ **验证状态总声明（请先读这段）**
>
> - **Windows 10/11 x64：已实机验证**（唯一）。
> - **macOS x64/arm64：代码已实现，但 ⚠️ 未经任何实机验证。**
>   开发机是 Windows，无法运行或验证任何 macOS 代码。单测覆盖的是命令构造、
>   坐标换算、降级判定等**平台无关纯逻辑**；所有真实系统行为
>   （坐标是否点得准、授权弹窗、AppleScript 实际响应）**一条都没验证过**。
> - **Linux：初步适配**；Wayland 下键鼠注入被合成器安全模型禁止，属平台限制。

---

## 一、Computer Use 能力矩阵

图例：✅ 已实机验证 · 🟡 代码已实现、未实机验证 · ⚠️ 有前提/降级 · ❌ 不可用。

| 能力 | Windows (x64) | macOS (Intel/ARM) | Linux (X11) | Linux (Wayland) |
|------|---------------|-------------------|-------------|-----------------|
| 鼠标移动/点击/右键/双击 | ✅ user32.dll | 🟡 cliclick / AppleScript，需辅助功能授权 | 🟡 xdotool，需安装 | ❌ 合成器禁止全局注入 |
| 悬停/长按/拖拽 | ✅ user32.dll | 🟡 长按与按下-抬起需 `brew install cliclick` | 🟡 xdotool | ❌ 同上 |
| 滚轮 | ✅ mouse_event | ⚠️ 用 ctrl+↓ 逐格翻页近似，**大页滚动会被截断到一页** | 🟡 xdotool button | ❌ |
| 键盘输入文本 | ✅ 剪贴板粘贴（支持中文） | 🟡 osascript keystroke，需辅助功能；**长中文未验证** | ⚠️ xdotool type（CJK 支持有限） | ❌ |
| 单键/组合键 | ✅ SendKeys 全表 | 🟡 AppleScript `key code` 数字键码表 | 🟡 xdotool key | ❌ |
| 截屏 | ✅ screenshot-desktop + PowerShell 虚拟桌面/隐私遮罩 | 🟡 `screencapture -x`，需屏幕录制授权 | 🟡 gnome/scrot/import 降级链 | 🟡 grim |
| **坐标换算（Retina / 多屏）** | ✅ 归一化坐标免疫 DPI | 🟡 **像素↔point 换算已实现并有单测**；混合缩放多屏仍取单一比例 | ⚠️ 未实机验证 | ⚠️ 未实机验证 |
| 前台窗口信息 | ✅ EnumWindows | 🟡 System Events，已返回 position/size | ⚠️ 仅标题 | ❌ |
| 可访问性元素树（UIA / AX） | ✅ cuUia.ts（UIA） | 🟡 **AX via AppleScript（本次新增）** | ❌ | ❌ |
| **权限门分区**（浏览器只读 / 终端只点） | ✅ 前台探测生效 | 🟡 **本次修复**，此前在 macOS 完全失效 | ❌ 探测不到 → fail-open | ❌ |
| 真人接管守卫（ForegroundLease） | ✅ 低级钩子 + 注入事件过滤 | ❌ **未实现**（需 CGEventTap 原生 helper），已登记为不支持 | ❌ | ❌ |
| 打开应用 | ✅ cmd start | ✅ open -a | ✅ xdg-open | ✅ |
| 枚举已装应用 | ✅ 开始菜单 | ✅ ls /Applications | ❌ 未实现 | ❌ |
| 隐私遮罩（非前台窗口涂黑） | ✅ EnumWindows | ❌ 不适用（返回原图） | ❌ 不适用 | ❌ |
| 多显示器虚拟桌面 | ✅ PowerShell VirtualScreen | ⚠️ 单比例换算，见上 | ⚠️ 未实机验证 | ⚠️ 未实机验证 |
| 托盘 / Dock | ✅ 任务栏托盘 | 🟡 模板图 + Dock 可选隐藏（本次新增） | 🟡 | 🟡 |

### 关键前提（用户侧）

- **macOS**：必须在「系统设置 → 隐私与安全性」授予 **辅助功能** + **屏幕与系统音频录制**，
  之后**完全退出并重启** App（⌘Q，不是关窗口）。未授权时应用会明确提示去哪个面板开，而不是静默失败。
- **macOS 可选依赖**：`brew install cliclick` 才能用长按 / 按下-抬起拖拽；
  未装时相关原语直接返回安装指引，不执行注定失败的命令。
- **Linux X11**：需 `sudo apt install xdotool`。
- **Linux Wayland**：属平台限制，非适配问题。

---

## 二、本次（macOS 适配）修复的三个真实缺陷

这三个不是「补功能」，是**改造前就存在、会真实影响用户**的问题：

### ① Retina 坐标错位（P0 · 所有点击偏一半）

`screencapture` 产出的是**背衬像素**（Retina 上 2×），
而 `cliclick` / AppleScript `click at` / `set mousePosition` 用的是**逻辑点（point）**。
改造前两者直接混用 —— **Retina 机器上每一次点击都落在目标左上方向一半处**。

修复：`electron/core/platform/macCoordinate.ts`

- 换算集中在 `pixelToPoint` / `pointToPixel` / `pointRectToPixel`。
- **缩放比采用实测反推**（`截图像素 ÷ 虚拟桌面 point`），**不硬编码 2×**。
  若某机 / 某 macOS 版本实际输出 1×，实测比例自然为 1，无需改代码；
  反过来硬编码 2 会在非 Retina 机器上把坐标放大一倍。
- 注入前统一经 `toInjectablePoint()` 换算并夹取到有效桌面内。
- ⚠️ 混合缩放多显示器（Retina 主屏 + 1× 副屏）只能取单一比例，**属已知限制**。

> 写这套换算时，单测抓到了实现自身的两个 bug（均已修复）：
> ① 副屏在左时原点符号写反（`px/scale - origin` 应为 `origin + px/scale`），
> 症状是「点右边的东西点到了左边」；
> ② AX 元素矩形只换算了原点、宽高仍留在 point 空间，导致中心点偏移半个控件。

### ② 权限门在 macOS 完全失效（P0 · 安全）

`cuPermissions.getForegroundApp()` 改造前对非 win32 **直接 `return null`**，
于是 `decideCuGate` 拿到 `proc=''` → 分区恒为 `'other'`。后果：

**「浏览器只读」「终端/IDE 只点不敲」两条安全策略在 macOS 上一条都不生效。**
Agent 可以在前台浏览器里点击、在终端里打字 —— 而终端里一条命令就是一次真实执行。

修复：新增 darwin 分支（osascript System Events），并补 macOS 进程名
（Safari / Google Chrome / Terminal / iTerm / Xcode…）与 Command 系系统键黑名单
（`cmd_space` Spotlight、`cmd_q` 强杀前台、`ctrl_cmd_q` 强制退出、`cmd_l` 锁屏…）。
**Windows 分支一行未改。**

### ③ 沙箱在 macOS 退化为「无保护」（P0 · 安全）

多条 BLOCK/HIGH 规则是 `platform: 'win32'` 专用，在 darwin 上一条都不生效。
实测后果：`rm -rf ~/Documents` 在 macOS 上**命中 0 条规则**（严重度 SAFE），
而意图完全等价的 Windows 命令 `Remove-Item -Recurse -Force` 是 CRITICAL ——
**同一意图在两平台防护等级相差 5 级**。

修复：新增 6 条 POSIX 规则，用对照表在 `tests/sandboxRules.mac.test.ts` 锁死：

| 场景 | 改造前 (macOS) | 改造后 |
|------|---------------|--------|
| `rm -rf ~/Documents` | SAFE | **CRITICAL** |
| `rm -rf /Applications/Safari.app` | SAFE | **BLOCK** |
| `rm -rf /System/Library/...` | SAFE | **BLOCK** |
| `rm -rf /Users/alice` | HIGH | **BLOCK** |
| `rm -f file` | MEDIUM | **HIGH** |
| `diskutil eraseDisk` / `csrutil disable` / `security dump-keychain` | SAFE | **HIGH** |

---

## 三、macOS 各能力的实现方式与权限要求

| 能力 | 实现 | 需要的系统授权 |
|------|------|---------------|
| 截屏 | `screencapture -x -t png` | 屏幕与系统音频录制 |
| 鼠标 | `cliclick`（优先）/ AppleScript `System Events` | 辅助功能 |
| 键盘 | AppleScript `key code`（数字键码表）/ `keystroke` | 辅助功能 |
| 元素树 | AppleScript `System Events` 遍历 AX（深度 3 / 上限 200） | 辅助功能 |
| 前台窗口 | AppleScript `System Events` | 辅助功能 |
| 打开应用 | `open -a` | — |
| 已装应用 | `ls /Applications` | — |
| 托盘 | Electron `Tray` + 模板图；Dock 可选隐藏 | — |

**结构化降级**：新增 `electron/core/platform/platformStatus.ts`。
适配器失败时登记 `ready` / `unsupported` / `needs_permission` 三态
（携带所需权限键 + 系统设置路径），上层据此提示用户，
**而不是抛裸异常或静默失败**。
Windows 不调用这些 API，状态恒为 `ready`，行为**完全不变**。

---

## 四、⚠️ 实机验证清单（必须在真实 Mac 上逐条跑）

> 开发机是 Windows，以下**全部未执行**。每条写明「怎么做 / 看什么 / 可能出什么错」。

### A. 打包与授权（前置，失败则后面全测不了）

1. `npm run pack:mac`，确认 dmg 能装、能启动（未签名需右键打开；或自行签名公证）。
2. 「系统设置 → 隐私与安全性 → 辅助功能」勾选 Lumina Life。
   ⚠️ **列表里可能根本没有该 App** → 点 `+` 手动添加。这是最常见的卡点。
3. 同上打开「屏幕与系统音频录制」。
4. **完全退出 App（⌘Q，不是关窗口）再重开**，否则授权不生效。
5. `brew install cliclick`，重开 App。
   - 看什么：Lumina 是否出现在两个授权列表里、开关为开。

### B. 截屏与坐标换算（**最高优先级**）

6. 让模型点屏幕**正中**，看光标是否落在正中间。
   - 可能错：落在左上 / 右下 → 缩放比反推有误，检查 `screencapture` 实际输出尺寸。
7. 让模型点**右下角**的按钮（最易暴露边界问题）。
8. 手动核对：执行 `screencapture -x /tmp/s.png` 与 `sips -g pixelWidth /tmp/s.png`，
   和「系统设置 → 显示器」里的分辨率对比，确认是否 2×。
   - 关键：若输出是 **point 尺寸**（非 2×），实测比例会自动算成 1，**应当仍然点得准**。
     若此时点不准，说明问题不在比例而在别处。
9. 多显示器：主屏 Retina + 副屏 1×，两侧各点一次。
   - 预期：**副屏可能整体偏移**（已知限制：混合缩放只能取单一比例）。

### C. 键鼠

10. 左键 / 右键 / 双击 / 拖拽 / 长按 / 悬停，在 Finder 与浏览器里逐个试。
11. 组合键：`cmd_c` `cmd_v` `enter` `esc` `tab` 方向键。
12. 中文长文本输入（`keyboardType` 走 keystroke，未走剪贴板）。
    - 预期风险：长中文可能丢字或乱序。**已知未验证。**

### D. 权限门（安全，务必验）

13. 让 agent 尝试在前台 Safari 里点击 → 预期被拒（提示「浏览器只读」）。
    - 若**没有被拒** → 前台探测失败（多半是辅助功能没给），
      这是一条**安全回归**，不是体验问题。
14. 同上试 Terminal → 预期打字被拒、只允许点击。
15. 让 agent 试 `cmd_space` / `cmd_q` → 预期被系统键黑名单拦截。

### E. 元素树

16. 在 Safari（系统控件多）里触发元素树扫描，看是否列出按钮 / 输入框。
    - 可能空：Safari 部分界面是自绘，可能扫不到 —— 属正常，需换原生 App 对照。
17. 在「备忘录」或「系统设置」里扫，对照元素名与实际界面。
    - 可能慢：深度 3 的 Apple 遍历在大窗口可能明显卡顿，**需评估是否可接受**。

### F. 沙箱

18. 触发一次 `rm -rf ~/Documents`，确认被 CRITICAL 拦截并要求审批。
19. 触发 `rm -rf /Applications/Safari.app`，确认被 BLOCK。

### G. 托盘 / Dock

20. 菜单栏图标在**浅色与深色**外观下都清晰可见（模板图是否生效）。
    - 可能错：深色模式下图标几乎看不见 → 模板图未生效。
21. 左键 / 右键图标都应弹出自定义菜单；双击应显示主窗口。
    - 注意：macOS 菜单栏**双击不可靠**，这条可能不灵，属可接受差异。

### H. 明确未实现 / 预期会失败

22. 真人接管守卫：macOS 上手动碰鼠标**不会**中止自动操作
    （需 CGEventTap 原生 helper，本次未做；设置页应显示为不支持）。
23. 隐私遮罩：macOS 返回原图（未实现）。
24. `set_value` 控件级赋值：macOS 走「点击 + 全选 + 输入」回退，不走 AXValuePattern。

---

## 五、原生依赖编译状态

| 原生模块 | 类型 | 预编译 | asarUnpack | 状态 |
|----------|------|--------|-----------|------|
| `better-sqlite3` | C++ (node-gyp) | 有 prebuilds，少数平台/架构回退编译 | ✅ 已配 | ⚠️ 主要编译痛点；postinstall 已给分平台工具链指引，CI 由 `electron-builder install-app-deps` 对齐 |
| `sharp` | 原生 + libvips | ✅ 多数有 prebuilt | ✅ 已配 | 一般无编译问题 |
| `onnxruntime-node` / `@xenova/transformers` | NAPI/ONNX | ✅ ABI 无关 | ✅ 已配 | 不受 Electron ABI 影响 |
| `screenshot-desktop` | 原生 | ✅ 有 prebuild | （由 cuCore 在 Windows 主路径使用，mac/Linux 走适配器） | 一般无问题 |
| `@img/*`（sharp 子依赖） | 原生 | ✅ | ✅ 已配 | — |

- 对齐脚本：`scripts/electron-postinstall.cjs`（失败不阻断安装，打印 Windows VS Build Tools / macOS `xcode-select --install` / Linux `build-essential python3` 指引）。
- 手动重对齐：`npm run rebuild:electron`（electron-rebuild）/ `npm run rebuild:node`。
- 排障文档：`docs/TROUBLESHOOTING.md` §16。

---

## 六、打包/分发配置

- **Windows**：nsis x64，未签名（SmartScreen 提示用户「仍要运行」）。
- **macOS**：dmg + zip（x64/arm64），`hardenedRuntime: true`、`gatekeeperAssess: false`；
  entitlements：`build/entitlements.mac.plist`、`build/entitlements.mac.inherit.plist`。
  **未签名/未公证**，首次需右键打开。
  ⚠️ 未在 macOS runner 上真正打出过安装包。
- **Linux**：AppImage + deb x64，category=Utility，maintainer 已设。
- `asarUnpack` 已覆盖 onnxruntime-node / @xenova / sharp / better-sqlite3 / @img。
- 签名/公证走独立工作流 `.github/workflows/release.yml`。

---

## 七、本次变更清单

**新增（macOS 适配层）**

- `electron/core/platform/macCoordinate.ts` — Retina 像素↔point 换算（纯函数，实测比例）
- `electron/core/platform/macPermissions.ts` — macOS 错误串 → 授权诊断（纯函数）
- `electron/core/platform/macAccessibility.ts` — AX 元素树扫描脚本与解析（纯函数）
- `electron/core/platform/platformStatus.ts` — 结构化能力状态通道（ready/unsupported/needs_permission）
- `electron/tray/macDock.ts` — 托盘模板图惯例 + Dock 显示策略

**改造**

- `MacAdapter.ts` — 接入坐标换算、结构化状态、getCursorPos、mouseDown/Up、focusWindow、AX 扫描、窗口 bounds
- `cuUia.ts` — 新增 darwin 分支（AX → UIA 兼容结构），win32 分支未改
- `cuPermissions.ts` — 新增 macOS 前台应用探测；补 macOS 进程名与 Command 系系统键黑名单
- `cuInputGuard.ts` — macOS 诚实降级（登记不支持，不再静默）
- `sandboxRules.ts` — 新增 6 条 POSIX 规则（BLOCK-002P / BLOCK-006P / CRIT-005P / HIGH-001P / HIGH-006 / HIGH-007）
- `platformCapabilities.ts` / `platformFactory.ts` / `index.ts` — 能力矩阵与导出
- `main.ts` — 托盘/Dock 的 3 行接线

**测试（新增 5 文件）**

`tests/macCoordinate.test.ts`(21) · `tests/macPermissions.test.ts`(22) ·
`tests/macAccessibility.test.ts`(25) · `tests/sandboxRules.mac.test.ts`(38) ·
`tests/macDock.test.ts`(11)

**历史变更（2026-09-23）**

- **A1** `cuCore.ts` 把 PS 截屏回退限定在 win32。
- **A2** 新增 `tests/platformMacAdapter.test.ts` / `platformLinuxAdapter.test.ts`。
- **A3** IPC `platform:get-features` + 前端 client。
- **A4** CI 打印各平台能力矩阵。
- **B1** `package.json` mac entitlements。
- **B2** 原生依赖分平台工具链指引。
- **B3** 文档 `docs/INSTALL.md` / `TROUBLESHOOTING.md` §16 / `performance.md`。
