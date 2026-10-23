# 代码签名与发布指南

本文说明如何为 Lumina Life 配置 Windows / macOS / Linux 三平台的代码签名，
以及未签名时用户侧的体验。CI 侧的工作流见 `.github/workflows/release.yml`。

> 当前 `package.json` 中 `build.win.forceCodeSigning: false`，即「没配证书也能出包」，
> 签名通过环境变量 / CI Secrets 注入，不需要写死在配置里。

---

## 一、Windows：Authenticode 签名

### 1.1 为什么需要

不签名的 exe 在 Windows 上首次运行会弹 **SmartScreen「Windows 已保护你的电脑」**
蓝色警告（因为安装包没有信誉积累），用户必须点「更多信息」→「仍要运行」。
这会显著拉高流失率。

### 1.2 证书类型

| 类型 | 特点 | 价格区间（年） |
|---|---|---|
| **OV**（组织验证） | 需企业/组织身份；签名后仍需 1~3 个月信誉积累才会去掉 SmartScreen 警告 | 约 $200~600 |
| **EV**（扩展验证） | 物理 USB 令牌或云 HSM；**签名即获 SmartScreen 即时信誉**；还能签内核驱动 | 约 $400~800 |

个人开发者没有企业主体时，OV/EV 都需要挂靠：可选择国内证书服务商（DigiCert /
Sectigo 的代理商、卷展云、瑞智鹏等），或使用 OV 个人类型证书。

> 提示：2023 年起全行业证书迁移到 CAB/FBR 要求，私钥必须在硬件 token / HSM 上，
> 普通 pfx 导出受限——云 HSM（如 SSL.com / DigiCert 托管）可以直接下载 pfx 用于 CI。

### 1.3 导出为 PFX（本地签名用）

有了 .pfx 文件后，本地签名最省事：

```powershell
# 把 pfx 转成 base64（存 GitHub Secret 用）
[Convert]::ToBase64String([IO.File]::ReadAllBytes('cert.pfx')) | Set-Content cert.b64
```

### 1.4 本地签名命令

electron-builder 读标准环境变量：

```powershell
# PowerShell
$env:CSC_LINK = (Resolve-Path cert.pfx).Path     # 或 base64 字符串
$env:CSC_KEY_PASSWORD = '你的pfx密码'
npm run pack:win
```

```bash
# macOS / Linux
CSC_LINK=cert.pfx CSC_KEY_PASSWORD=xxx npm run pack:win
```

### 1.5 CI 签名（GitHub Secrets）

在仓库 **Settings → Secrets and variables → Actions** 配置：

| Secret | 内容 |
|---|---|
| `WINDOWS_CSC_LINK` | pfx 文件的 **base64** 字符串（上面 `cert.b64` 内容） |
| `WINDOWS_CSC_KEY_PASSWORD` | pfx 导出密码 |

`release.yml` 会自动把 base64 解码回 `cert.pfx` 并设好 `CSC_LINK`。**不填则跳过签名**，
产出未签名安装包，CI 不会失败。

### 1.6 未签名时用户怎么绕过

1. 双击 exe → SmartScreen 蓝框 → **「更多信息」** → **「仍要运行」**。
2. 企业环境被组策略拦截时，可让管理员把 publisher 加入白名单。

---

## 二、macOS：Developer ID 签名 + 公证（Notarization）

### 2.1 为什么需要

不签名的 dmg 在 macOS 上首次打开会弹 **「无法打开，因为无法验证开发者」**
（Gatekeeper）。用户必须右键 → 打开，或终端执行 `xattr -cr` 移除隔离属性。

### 2.2 前置：Apple Developer 账号

- 加入 **Apple Developer Program**：**$99/年**。
- 申请 **Developer ID Application** 证书（钥匙串访问 → 证书助理 →
  从证书颁发机构机构申请；或在 Apple Developer 后台下载）。

### 2.3 electron-builder 必需配置（package.json 建议项）

> ⚠️ 这些字段建议加在 `build.mac` 里（由另一条构建配置工作线落地，本任务不改 package.json）：

```jsonc
"mac": {
  "hardenedRuntime": true,
  "gatekeeperAssess": false,
  "entitlements": "build/entitlements.mac.plist",
  "entitlementsInherit": "build/entitlements.mac.plist"
}
```

hardenedRuntime 是 Apple 公证的硬性要求。

### 2.4 公证方式 A：Apple ID + 应用专用密码（简单）

在 Apple ID 后台 → 登录与安全 → 应用专用密码，生成一个。GitHub Secrets：

| Secret | 内容 |
|---|---|
| `MAC_CERTIFICATE_BASE64` | Developer ID .p12 的 base64（同 Windows 套路） |
| `MAC_CERTIFICATE_PASSWORD` | .p12 导出密码 |
| `MAC_KEYCHAIN_PASSWORD` | 临时 keychain 密码（自拟随机串） |
| `APPLE_ID` | 开发者 Apple ID 邮箱 |
| `APPLE_APP_SPECIFIC_PASSWORD` | 上面生成的应用专用密码 |
| `APPLE_TEAM_ID` | 10 位 Team ID（developer.apple.com 后台右上角） |

electron-builder 打包时自动调用 `notarytool` 上传公证，无需手动跑命令。

### 2.5 公证方式 B：App Store Connect API Key（无头 CI 更稳）

适合团队/自动化：在 App Store Connect → 用户和访问 → 集成 → 生成 API Key，
下载 `AuthKey_XXXX.p8`。Secrets：

| Secret | 内容 |
|---|---|
| `APPLE_API_KEY` | .p8 文件内容（或 base64） |
| `APPLE_API_KEY_ID` | Key ID（10 位） |
| `APPLE_API_ISSUER_ID` | Issuer ID（UUID） |

（二选一，不要同时配 A、B。）

### 2.6 本地签名命令

```bash
# 先把 Developer ID 证书导入登录钥匙串，然后：
npm run pack:mac
# 公证：electron-builder 在 notarize 开关打开后自动执行；
# 手动跑可用：xcrun notarytool submit Lumina.dmg --apple-id ... --team-id ... --password ...
```

### 2.7 未签名时用户怎么绕过

- **右键 → 打开**（第一次绕过 Gatekeeper，之后正常双击）。
- 或终端：`xattr -cr /Applications/Lumina\ Life.app`

---

## 三、Linux

- **AppImage**：不需要签名，`chmod +x *.AppImage && ./AppImage` 直接跑。
- **deb 包**：可选 GPG 签名（供 APT 仓库用）。单文件分发不需要。
  如需：`gpg --detach-sign Lumina.deb` 产 `.deb.sig`。

---

## 四、发布前检查清单

- [ ] `git tag v0.x.0` 推到 GitHub（触发 Release workflow），或手动 Run。
- [ ] Windows：已配 `WINDOWS_CSC_LINK` + `WINDOWS_CSC_KEY_PASSWORD`？
- [ ] macOS：已配 `MAC_CERTIFICATE_BASE64` 组 + 公证三件套？
- [ ] 三平台产物在 Release 草稿里齐全（exe / dmg / AppImage / deb）。
- [ ] 未签名包在 Release 说明里写清楚首次运行的绕过方法。
- [ ] CHANGELOG 已更新。
- [ ] 草稿 Release 人工确认后再 Publish。
