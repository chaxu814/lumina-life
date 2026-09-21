# Lumina Life v0.1 公开发布 Checklist

> 本清单给项目作者（发布负责人）用。带 ☐ 的是**待你手动完成**的外部依赖项——
> 代码侧已就绪，但它们依赖外部账号 / 签名 / 第三方平台，**不算代码已完成**。
> 最后更新：本次 v0.1 落地迭代（分片 E：隐私引导 + 精简模式 + feature flag UI）。

---

## 0. 发布前代码基线（发布负责人本地执行）

- ☐ `git status` 干净，全部分片改动已由集成方合并
- ☐ `npx tsc --noEmit --strict` 0 错误
- ☐ 跑测试：`npx vitest run` 全绿（沙箱/团队/记忆相关）
- ☐ 本地启动 `npm run dev`，确认主窗口 + 桌宠双开不崩
- ☐ 集成方确认 preload/main 已接线以下新 IPC（未接线时 UI 自动回退不崩，但功能不可用）：
  - `featureFlagsGetAll` / `featureFlagsSet`
  - `dataExportZip` / `dataImportZip` / `dataGetLocations`
  - 对应主进程 `electron/utils/dataExport.ts` 的导出/导入实现

## 1. 仓库与版本

- ☐ GitHub 仓库公开（当前为私有 / 404）：建 `lumina-life` 公开仓，推 `feature/proactive-neko` 主干
- ☐ `package.json` 版本号定为 `0.1.0`
- ☐ 打 tag：`git tag v0.1.0 && git push origin v0.1.0`（**本工作区不 push，由你执行**）
- ☐ 写 Release Notes：对照「v0.1 只露三件事」——有情绪会主动找你 / 真记得你 / 安全帮你干一件事

## 2. 精简模式打包开关（I7 核心）

- ☐ 公开版打包时设置环境变量打开精简模式：
  `LUMINA_FF_MODE_MINIMAL=1`
- ☐ 验证：打包产物启动后，侧边栏只剩「聊天」「设置」+「🧹 整理下载文件夹」
- ☐ 验证：`设置 → 隐私与开关` 里 `mode.minimal` 显示为开
- ☐ 内测版**不要**设该环境变量，保留全部高级项（梦境/团队/VRM/工具）

## 3. Windows 安装包（NSIS）

- ☐ `npm run build`（electron-builder）产出 NSIS 安装包
- ☐ 本机双击安装冒烟：能启动、能聊天、能记一条记忆、能触发一次沙箱审批
- ☐ **代码签名（待你手动）**：购买 Windows 代码签名证书，在 builder 配置接入 signtool
  （未签名会触发 SmartScreen 警告；v0.1 可接受，但需在 Release 说明里写明）

## 4. 外部平台（全部待你手动，依赖外部账号）

- ☐ **Steam 上架**：注册 Steamworks 合作伙伴、缴费、提交 Steam Direct 表单
  （流程以周计，不阻塞 v0.1 首发）
- ☐ **Docker 镜像**：写 `Dockerfile`（Linux 无显示环境跑核心/记忆层），推 `ghcr.io/<you>/lumina-life:0.1.0`
  （桌宠/VRM 依赖桌面，容器只跑后端服务，需在 README 说明）
- ☐ **移动端**：Electron 桌宠形态暂不支持；v0.1 不承诺，列入 roadmap

## 5. 隐私 / 自托管叙事核对（I6）

- ☐ 首次启动隐私页正常：展示本机数据目录、「记忆不上云」、双协议行
- ☐ `设置 → 隐私与开关 → 导出我的全部记忆` 产出 .zip，含 manifest.json / memory.md / data/*.json
- ☐ 把导出的 zip 在另一目录「从备份导入」，确认新 key 合并、旧数据不覆盖
- ☐ 诚实核对：README/文案不得写「完全离线」（云端模型推理仍联网）；
  已写为「记忆与人格文件只在本机；模型推理按你配置走」

## 6. 冒烟测试清单（每次 RC 必跑）

| # | 动作 | 预期 |
|---|------|------|
| 1 | 启动应用 | 主窗口 + 桌宠正常，无白屏 |
| 2 | 发一句话聊天 | Lumina 回复，情绪数值变化 |
| 3 | 让她记住一件事 | 重启后还记得（SQLite 持久化） |
| 4 | 触发一次危险命令 | 沙箱拦截/降级并弹审批 |
| 5 | 打开 设置 → 隐私与开关 | 看到本机路径、导出/导入、功能开关 |
| 6 | 打开精简模式并重启 | 侧边栏只剩 聊天/设置 + 整理按钮 |

---

## 状态图例
- 代码已落地：本仓 `electron/utils/dataExport.ts`、`src/services/featureFlagsClient.ts`、
  `src/panels/settings/SettingsPrivacyFlags.tsx`、`src/components/Sidebar.tsx`、
  `src/panels/SettingsPanel.tsx`、`electron/pet/onboarding.html`
- 待外部条件（上面 ☐）：仓库公开、签名、Steam、Docker、移动端
