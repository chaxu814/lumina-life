# Lumina Installation Guide (Cross-Platform)

> Supports Windows 10/11 (x64), macOS 12+ (Intel/Apple Silicon), and Linux (x64, X11).
> Pick one of the install paths below: download a prebuilt installer (recommended for most users) or run from source (for developers).

---

## General Requirements

- **Node.js 18+** (20 or 22 LTS recommended) — only needed for source installs.
- **Python 3.10+** (optional) — only needed when compiling native modules locally; not needed for prebuilt installers.
- Using Computer Use (desktop control / looking at the screen and clicking the mouse) for the first time requires a VLM configuration; see the README.

---

## ⚡ Up and Running in 3 Minutes (pick the row for your OS)

| OS | The only thing to do after install | Computer Use out of the box? |
|------|------------------------|---------------------|
| **Windows 10/11** | Works right after install, no authorization needed | ✅ Out of the box |
| **macOS** | After install, open **System Settings → Privacy & Security** and enable **Accessibility** + **Screen Recording**, then restart the app | ⚠️ Works after authorization |
| **Linux** | Log in with an **X11 session**, and `sudo apt install xdotool` (screenshot tools are usually bundled) | ⚠️ Works on X11; cannot move/click on Wayland |

> Detailed per-platform steps follow below.

---

## Windows

### Option 1: Download the installer (recommended)
1. Download `Lumina-Life-Setup-<version>-win-x64.exe` from GitHub Releases.
2. Double-click to run; you can choose the install directory and create desktop / Start menu shortcuts.
3. If SmartScreen pops up on first launch, click "More info → Run anyway" (the app is not code-signed yet, which is expected).

### Option 2: Developer mode
```powershell
git clone <repo>
cd "Lumina AI"
npm install        # automatically aligns better-sqlite3 to the Electron ABI
npm run dev        # launches the dev build
```
> If `npm install` fails with a node-gyp error on better-sqlite3, see docs/TROUBLESHOOTING.md §16.

> 🇨🇳 **Note for networks in China**: `npm install` downloads the Electron binary from GitHub,
> and restricted networks often fail with TLS / certificate errors. Set the mirror first:
> ```powershell
> $env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
> npm install
> ```

On Windows, Computer Use (mouse / keyboard / screenshots / UIA element tree) works out of the box with no extra authorization.

---

## macOS

### Option 1: Download the installer (recommended)
1. Download the `.dmg` from Releases (x64 for Intel, arm64 for Apple Silicon).
2. Drag Lumina Life into Applications.
3. **First launch:** because the app is not notarized, **do not double-click** — right-click the app → "Open" → confirm. After that you can double-click normally.
4. **Authorization (required for Computer Use):** open **System Settings → Privacy & Security**:
   - **Accessibility**: enable Lumina Life (needed to control the mouse/keyboard).
   - **Screen Recording**: enable Lumina Life (needed to take screenshots / look at the screen).
   - After authorizing, fully quit and restart the app for it to take effect.

### Option 2: Developer mode
```bash
git clone <repo> && cd lumina-life
npm install
npm run dev
```
The first time desktop control is used, the app will pop up and request the two permissions above.

> If long-press / drag occasionally fails, `brew install cliclick` can improve reliability (optional).
> macOS has no UIA element tree like Windows; Computer Use works mainly through "screenshot + coordinates".

---

## Linux

### Option 1: Download the installer (recommended)
1. Download the `.AppImage` or `.deb` from Releases.
2. AppImage: `chmod +x Lumina-Life-*.AppImage && ./Lumina-Life-*.AppImage`
3. deb: `sudo apt install ./Lumina-Life-*.deb`

### Option 2: Developer mode
```bash
git clone <repo> && cd lumina-life
sudo apt install build-essential python3   # to compile native modules
npm install
npm run dev
```

### Computer Use dependencies (X11 session)
- Global mouse/keyboard injection requires **xdotool**:
  ```bash
  sudo apt install xdotool        # Debian/Ubuntu
  sudo dnf install xdotool        # Fedora
  ```
- Screenshots are tried in order: `gnome-screenshot → scrot → import (ImageMagick)`; distros usually ship one of them.
- Optional enhancement: `sudo apt install cliclick` does not apply on Linux; long-press duration and drag are handled directly by xdotool.

### Notes for Wayland users
- Wayland's security model **forbids arbitrary apps from injecting mouse/keyboard events globally**, so Lumina automatically disables desktop control and tells you why.
- If you really need Computer Use, log out and choose **"Ubuntu on Xorg" / an X11 session** from the gear icon on the login screen.
- Under Wayland, screenshots still work (via `grim`, `sudo apt install grim`; GNOME can use `gnome-screenshot`) — you just can't move/click.
- If you must stay on Wayland, you can evaluate **ydotool** (injects via `/dev/uinput`, requires adding your user to the input group), but compatibility varies by compositor and it is not an officially supported path.

---

## FAQ

- Native module compilation failed → see [TROUBLESHOOTING.md §16](TROUBLESHOOTING.md).
- Real-world Computer Use capabilities across platforms → see [cross-platform-status.md](cross-platform-status.md).
