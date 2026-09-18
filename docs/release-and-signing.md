# 发布、签名与自动更新（Release & Code Signing）

> 目标：让 Lumina Life 的安装包在 Windows / macOS / Linux 上可被用户安全安装、能自动更新。
> 自动化流水线已在 `.github/workflows/test.yml` 铺好；**你只需要准备证书并在 GitHub Secrets 里填好**。
> 没有证书时，CI 也能产出「未签名」安装包（Windows 会弹 SmartScreen，macOS 需右键打开）。

## 0. 一键发布流程（先读这一段）

```bash
# 1. 本地确认全绿
npm run typecheck
npm test
npm run build

# 2. 改版本号（package.json version），写 CHANGELOG
git add -A && git commit -m "chore(release): v0.1.0"

# 3. 打 tag 并推送 —— 推送 tag 会触发 release 流水线
git tag v0.1.0
git push origin master --tags
```

推 tag 后，GitHub Actions 的 `release` 任务会在三台机器上构建
Windows `.exe`、macOS `.dmg/.zip`、Linux `.AppImage/.deb`，连同
`latest.yml / latest-mac.yml / latest-linux.yml` 一起上传为**草稿 Release**。
你去 GitHub Releases 检查草稿、写好说明、点 **Publish** 即可。

> 应用内的「自动更新」（electron-updater）只认**已发布** Release 里的 `latest-*.yml`。
> 草稿 Release 不会触发更新；发布后客户端才会收到新版本通知。

## 1. Windows 代码签名（消除 SmartScreen 警告）

需要：一张 **OV 代码签名证书**（EV 更佳，EV 立即获得 SmartScreen 信誉）。
推荐 DigiCert / Sectigo / GlobalSign，价格约 ¥1500–3000/年（OV）。

1. 拿到 `.pfx` 文件后，转 base64：
   ```bash
   openssl base64 -in cert.pfx -out cert.b64
   ```
2. GitHub 仓库 → Settings → Secrets and variables → Actions，添加：
   - `WINDOWS_CSC_LINK`：`cert.b64` 的**全部内容**
   - `WINDOWS_CSC_KEY_PASSWORD`：PFX 的私钥口令
3. CI 会自动把证书落盘并让 electron-builder 做 Authenticode 签名。
   （本地手动打包则用：`$env:CSC_LINK="C:\path\cert.pfx"; $env:CSC_KEY_PASSWORD="..."`）
4. 未设置这两个 Secret 时，CI 设 `CSC_IDENTITY_AUTO_DISCOVERY=false`，产出**未签名**包。

> 说明：即使签了名，OV 证书也需要累计一定下载量才能完全消除 SmartScreen 信誉提示；
> EV 证书 + 时间戳服务能显著加速。electron-builder 默认带时间戳（timestamp server）。

## 2. macOS 签名与公证（消除 Gatekeeper 拦截）

需要：**Apple Developer Program**（$99/年），并在 Keychain 里拥有
「Developer ID Application」证书，以及一个 App 专用密码。

1. 导出 Developer ID 证书为 `.p12`，转 base64：
   ```bash
   openssl base64 -in devid.p12 -out mac_cert.b64
   ```
2. 到 https://appleid.apple.com → 登录 → App 专用密码，生成一个密码。
3. 添加 GitHub Secrets：
   - `MAC_CERTIFICATE_BASE64`：`mac_cert.b64` 内容
   - `MAC_CERTIFICATE_PASSWORD`：导出 p12 时设置的口令
   - `MAC_KEYCHAIN_PASSWORD`：CI 临时钥匙串口令（随便填一个随机串即可）
   - `APPLE_ID`：你的 Apple ID 邮箱
   - `APPLE_APP_SPECIFIC_PASSWORD`：上一步生成的 App 专用密码
   - `APPLE_TEAM_ID`：10 位 Team ID（Apple Developer 后台 Membership 页查看）
4. CI 会导入证书、用 `codesign` 签名、用 `notarytool`（electron-builder 内置）自动公证。
5. 未配置时产出未签名 dmg，用户需 **右键 → 打开** 才能首次启动。

## 3. Linux

AppImage / deb 不强制签名。deb 可用 `dpkg-sig` 自签，AppImage 不签名也能跑。
首次运行 AppImage 若提示 FUSE，请安装：`sudo apt install libfuse2`。

## 4. 应用内自动更新（electron-updater）

- 配置已在 `package.json` 的 `build.publish`（GitHub Releases，owner=chaxu814，repo=lumina-life）。
- 客户端逻辑在 `electron/autoUpdater.ts`：每 4 小时检查一次，下载完成后提示重启安装。
- 前提：Release 里**必须包含**对应平台的 `latest-*.yml`（CI 已自动上传）。
- 私有仓库需要给客户端配置 `GH_TOKEN`；**公开仓库可匿名检查更新**，建议发布时设为 Public。

## 5. 本地手动打包（快速验证）

```bash
# 先确保原生模块按 Electron ABI 重建
npm run rebuild:electron
npm run build

# Windows（未签名）
$env:CSC_IDENTITY_AUTO_DISCOVERY="false"
$env:USE_HARDLINKS="false"
npm run pack:win
# 产物在 dist/，安装包如 Lumina Life Setup 0.1.0.exe（含 latest.yml）

# macOS / Linux（需对应系统）
npm run pack:mac
npm run pack:linux
```

## 6. 当前状态（诚实说明）

- ✅ 跨平台打包目标（win nsis / mac dmg+zip / linux AppImage+deb）、CI 三平台测试与覆盖率门禁、
  自动更新客户端、Release 草稿与 `latest-*.yml` 上传：**流程已就绪**。
- ⚠️ **未购买/未配置证书前，安装包是未签名的**，这是正常的——填入上述 Secrets 后无需改代码即自动签名。
- ⚠️ macOS / Linux 安装包尚未在真实设备上验收（透明窗、托盘、原生模块），发布前请在对应系统各跑一遍。
- 🔐 切勿把证书、私钥、App 专用密码写进代码或提交进仓库，只放 GitHub Secrets。
