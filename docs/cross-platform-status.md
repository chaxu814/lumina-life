# Lumina 跨平台状态报告（Computer Use · 部署 · 原生依赖）

> 分支：`feature/crossplatform-gaming-onboarding` · 生成日期：2026-09-23
> 适配层位置：`electron/core/platform/`（PlatformAdapter 接口 + Windows/Mac/Linux 实现 + 工厂 DI + 能力矩阵）。
> 本文记录各平台 Computer Use 实际能力、原生依赖编译状态、以及**尚未在真机验证**的路径清单。

---

## 一、Computer Use 能力矩阵

图例：✅ 开箱可用 · ⚠️ 可用但有前提/降级 · ❌ 不可用（平台限制）。

| 能力 | Windows (x64) | macOS (Intel/ARM) | Linux (X11) | Linux (Wayland) |
|------|---------------|-------------------|-------------|-----------------|
| 鼠标移动/点击/右键/双击 | ✅ user32.dll | ⚠️ AppleScript，需辅助功能授权 | ✅ xdotool，需安装 | ❌ 合成器禁止全局注入 |
| 悬停/长按/拖拽 | ✅ user32.dll | ⚠️ 长按/拖拽建议 `brew install cliclick` | ✅ xdotool | ❌ 同上 |
| 滚轮 | ✅ | ⚠️ AppleScript 方向键 | ✅ xdotool button | ❌ |
| 键盘输入文本 | ✅ 剪贴板粘贴（支持中文） | ⚠️ osascript keystroke，需辅助功能 | ⚠️ xdotool type（中文支持有限） | ❌ |
| 单键/组合键 | ✅ SendKeys 全表 | ⚠️ key code 表需映射验证（见下） | ⚠️ xdotool key，键名映射需验证 | ❌ |
| 截屏 | ✅ screenshot-desktop + PowerShell 虚拟桌面/隐私遮罩 | ⚠️ screencapture，需屏幕录制授权 | ✅ scrot/gnome-screenshot/import 降级链 | ⚠️ grim |
| 前台窗口信息 | ✅ | ⚠️ 进程名/标题（bounds 暂为 0） | ⚠️ 仅标题（xdotool） | ❌ |
| UIA 可访问性元素树 | ✅（cuUia.ts，自门控非 win32 返回空） | ❌ 无对应技术 | ❌ | ❌ |
| 打开应用 | ✅ cmd start | ✅ open -a | ✅ xdg-open | ✅ |
| 枚举已装应用 | ✅ 开始菜单快捷方式 | ⚠️ ls /Applications | ❌ 未实现 | ❌ |
| 隐私遮罩（非前台窗口涂黑） | ✅ user32 EnumWindows | ❌ 不适用（直接返回原图） | ❌ 不适用 | ❌ |
| 多显示器虚拟桌面 | ✅ PowerShell VirtualScreen | ⚠️ 未实机验证 | ⚠️ 未实机验证 | ⚠️ 未实机验证 |

### 关键前提（用户侧）
- **macOS：** 必须在「系统设置 → 隐私与安全性」授予 **辅助功能** + **屏幕录制**，重启 App 后键鼠/截屏才生效。未授权时 `osascript`/`screencapture` 会失败，错误串原样回传。
- **Linux X11：** 需 `sudo apt install xdotool`；缺它时适配层在构造时即把鼠标/键盘置为禁用并给出安装提示（单测覆盖）。
- **Linux Wayland：** 全局键鼠注入被合成器安全模型禁止，属平台限制；仅截屏(grim)+打开应用可用，需切到 X11 会话才能完整 Computer Use。

---

## 二、原生依赖编译状态

| 原生模块 | 类型 | 预编译 | asarUnpack | 状态 |
|----------|------|--------|-----------|------|
| `better-sqlite3` | C++ (node-gyp) | 有 prebuilds，少数平台/架构回退编译 | ✅ 已配 | ⚠️ 主要编译痛点；postinstall 已给分平台工具链指引，CI 由 `electron-builder install-app-deps` 对齐 |
| `sharp` | 原生 + libvips | ✅ 多数有 prebuilt | ✅ 已配 | 一般无编译问题 |
| `onnxruntime-node` / `@xenova/transformers` | NAPI/ONNX | ✅ ABI 无关 | ✅ 已配 | 不受 Electron ABI 影响 |
| `screenshot-desktop` | 原生 | ✅ 有 prebuilt | （由 cuCore 在 Windows 主路径使用，mac/Linux 走适配器） | 一般无问题 |
| `@img/*`（sharp 子依赖） | 原生 | ✅ | ✅ 已配 | — |

- 对齐脚本：`scripts/electron-postinstall.cjs`（失败不阻断安装，打印 Windows VS Build Tools / macOS `xcode-select --install` / Linux `build-essential python3` 指引）。
- 手动重对齐：`npm run rebuild:electron`（electron-rebuild）/ `npm run rebuild:node`。
- 排障文档：`docs/TROUBLESHOOTING.md` §16。

---

## 三、打包/分发配置

- **Windows：** nsis x64，未签名（SmartScreen 提示用户「仍要运行」）。
- **macOS：** dmg + zip（x64/arm64），`hardenedRuntime: true`、`gatekeeperAssess: false`；新增 entitlements：`build/entitlements.mac.plist`、`build/entitlements.mac.inherit.plist`（allow-jit / disable-library-validation 等，供原生模块在 hardened runtime 下加载）。**未签名/未公证**，首次需右键打开。
- **Linux：** AppImage + deb x64，category=Utility，maintainer 已设。
- `asarUnpack` 已覆盖 onnxruntime-node / @xenova / sharp / better-sqlite3 / @img。
- 签名/公证走独立工作流 `.github/workflows/release.yml`（tag v* 或手动触发），本分支不改动。

---

## 四、尚未在真机验证的路径（Honest TODO）

以下路径在单元测试中均以 mock 覆盖命令构造与降级逻辑，但**未在真实对应 OS 上实机跑过**，需后续在真机回归：

1. **macOS 辅助功能 / 屏幕录制授权** 实际弹窗与授权后 osascript/screencapture 可用（测试只断言命令串，未真实控制鼠标/截屏）。
2. **macOS keyPress 键码映射**：`MacAdapter.keyPress` 当前把键名直接传给 `key code <name>`，而 AppleScript 的 `key code` 需要数字键码（如 enter=36）。组合键 `ctrl_c`/`alt_f4` 等的映射表尚未实现——当前为已知缺口，实机前需补一张 keyName→keyCode 映射（Windows 已有 `buildSendKeysToken` 可参照）。
3. **macOS 长按/拖拽** 依赖 `cliclick`，未安装时降级行为未实测。
4. **Linux Wayland 抓屏**（grim）与 X11 降级链（gnome-screenshot→scrot→import）仅用 mock 验证了尝试顺序，未在真实缺工具环境下验证报错文案。
5. **Linux Wayland 键鼠禁用** 的 UX 提示未在真实 GNOME/KDE Wayland 会话上看过实际弹窗。
6. **macOS dmg / Linux AppImage / deb 实际打包**：builder 配置已补 entitlements，但未在 macOS/Linux runner 上真正打出安装包（Windows 本机仅验证 electron-vite 主进程构建）。
7. **多显示器** 虚拟桌面边界（Windows 已实机路径外的 mac/Linux 坐标映射）未验证。
8. **Linux 中文输入**（xdotool type 对 CJK 的支持）未验证——Windows 走剪贴板粘贴可用，mac/Linux 直接 keystroke/type 对长中文文本可能不理想。

---

## 五、本次变更清单（对应 commit 拆分）

- **A1 审计修复**：`electron/tools/impl/cuCore.ts`——把 PS 截屏回退 `screenshotFallbackPS` 限定在 win32（非 Windows 适配器失败时抛明确错误，不再 exec 不存在的 `powershell`）；删除未使用的本地 `execCmd`。其余 `process.platform === 'win32'` 分支均为有意保留（隐私遮罩/虚拟桌面/UIA），已在代码注释标注。
- **A2 测试**：新增 `tests/platformMacAdapter.test.ts`（19 例）、`tests/platformLinuxAdapter.test.ts`（14 例），mock `execCmd`/`fs` 验证命令构造与三态降级。
- **A3 IPC**：`electron/preload.ts` 暴露 `platformGetFeatures`；新增 `src/services/platformCapabilitiesClient.ts`（主进程 `platform:get-features` handler 与 main.ts 注册此前已就绪）。
- **A4 CI**：`.github/workflows/test.yml` 新增「Print platform capability matrix」step；新增 `tests/platformMatrixLog.test.ts` 打印各 runner 能力矩阵。
- **B1 builder**：`package.json` mac 增加 entitlements 指向；新增 `build/entitlements.mac.plist`、`build/entitlements.mac.inherit.plist`。
- **B2 原生依赖**：`scripts/electron-postinstall.cjs` 失败时输出分平台工具链指引。
- **B3 文档**：新增 `docs/INSTALL.md`；`docs/TROUBLESHOOTING.md` 加 §16；`docs/performance.md` 加「跨平台性能与能力备注」。
