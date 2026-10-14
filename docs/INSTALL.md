# Lumina 安装指南（跨平台）

> 支持 Windows 10/11 (x64)、macOS 12+ (Intel/Apple Silicon)、Linux (x64, x11)。
> 三种安装方式任选其一：下载现成安装包（推荐普通用户）或从源码运行（开发者）。

---

## 通用要求

- **Node.js 18+**（推荐 20 或 22 LTS）——仅源码安装需要。
- **Python 3.10+**（可选）——仅本机编译原生模块时需要；下载现成安装包不需要。
- 首次使用 Computer Use（桌面操控/看屏点鼠标）需要 VLM 配置，详见 README。

---

## ⚡ 3 分钟上手（按你的系统选一条）

| 系统 | 安装后要做的唯一一件事 | Computer Use 开箱？ |
|------|------------------------|---------------------|
| **Windows 10/11** | 装完即用，无需任何授权 | ✅ 开箱即用 |
| **macOS** | 装完后去「系统设置 → 隐私与安全性」勾 **辅助功能** + **屏幕录制**，重启 App | ⚠️ 授权后可用 |
| **Linux** | 登录用 **X11 会话**，`sudo apt install xdotool`（截屏工具一般已带） | ⚠️ X11 可用；Wayland 不能移动/点击 |

> 下面是分平台的详细步骤。

---

## Windows

### 方式一：下载安装包（推荐）
1. 从 GitHub Releases 下载 `Lumina-Life-Setup-<version>-win-x64.exe`。
2. 双击运行，可自定义安装目录，勾选桌面/开始菜单快捷方式。
3. 首次启动如出现 SmartScreen 提示，点「更多信息 → 仍要运行」（当前未做代码签名，属正常）。

### 方式二：开发者模式
```powershell
git clone <repo>
cd "Lumina AI"
npm install        # 会自动把 better-sqlite3 对齐到 Electron ABI
npm run dev        # 启动开发版
```
> 若 `npm install` 在 better-sqlite3 处报 node-gyp 错误，见 docs/TROUBLESHOOTING.md §16。

> 🇨🇳 **国内网络提示**：`npm install` 会从 GitHub 下载 Electron 二进制，网络受限时
> 会报 TLS / 证书类错误。先设镜像再装：
> ```powershell
> $env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
> npm install
> ```

Windows 上 Computer Use（鼠标/键盘/截屏/UIA 元素树）开箱即用，无需额外授权。

---

## macOS

### 方式一：下载安装包（推荐）
1. 从 Releases 下载 `.dmg`（Intel 选 x64，Apple Silicon 选 arm64）。
2. 把 Lumina Life 拖进「应用程序」。
3. **首次打开：** 因为未公证，**不要双击**——右键点 App →「打开」→ 确认。之后可正常双击。
4. **授权（Computer Use 必需）：** 打开「系统设置 → 隐私与安全性」：
   - **辅助功能**（Accessibility）：勾选 Lumina Life（用于控制鼠标/键盘）。
   - **屏幕录制**（Screen Recording）：勾选 Lumina Life（用于截屏/看屏）。
   - 授权后需完全退出并重启 App 才生效。

### 方式二：开发者模式
```bash
git clone <repo> && cd lumina-life
npm install
npm run dev
```
首次桌面操控会弹窗请求上述两项权限。

> 长按/拖拽如偶发失败，可 `brew install cliclick` 提升可靠性（可选）。
> macOS 没有 Windows 那样的 UIA 元素树，Computer Use 以「截屏 + 坐标」为主。

---

## Linux

### 方式一：下载安装包（推荐）
1. 从 Releases 下载 `.AppImage` 或 `.deb`。
2. AppImage：`chmod +x Lumina-Life-*.AppImage && ./Lumina-Life-*.AppImage`
3. deb：`sudo apt install ./Lumina-Life-*.deb`

### 方式二：开发者模式
```bash
git clone <repo> && cd lumina-life
sudo apt install build-essential python3   # 编译原生模块
npm install
npm run dev
```

### Computer Use 依赖（X11 会话）
- 全局鼠标/键盘注入需要 **xdotool**：
  ```bash
  sudo apt install xdotool        # Debian/Ubuntu
  sudo dnf install xdotool        # Fedora
  ```
- 截屏会自动按顺序尝试 `gnome-screenshot → scrot → import(ImageMagick)`，发行版一般已带其一。
- 可选增强：`sudo apt install cliclick` 不适用 Linux；长按时长/拖拽由 xdotool 直接完成。

### Wayland 用户注意
- Wayland 出于安全模型**禁止任意应用全局注入鼠标/键盘**，Lumina 会自动禁用桌面操控并提示。
- 如确需 Computer Use，请在登录界面的齿轮处选择 **「Ubuntu on Xorg」/ X11 会话**后重新登录。
- Wayland 下截屏仍可用（走 `grim`，需 `sudo apt install grim`；GNOME 可用 `gnome-screenshot`），只是不能移动/点击。
- 实在要留在 Wayland，可评估 **ydotool**（通过 `/dev/uinput` 注入，需把用户加入 input 组），但兼容性因合成器而异，非官方支持路径。

---

## 常见问题

- 原生模块编译失败 → 见 [TROUBLESHOOTING.md §16](TROUBLESHOOTING.md)。
- 各平台 Computer Use 实际能力差异 → 见 [internal/cross-platform-status.md](internal/cross-platform-status.md)。
