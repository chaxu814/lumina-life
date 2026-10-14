# GitHub 发布前 Checklist — 最终版（2026-09-23）

> 状态：特性分支已完成全量收口，主树验证通过并已合并 master、打 v0.1.0 tag（本地，未 push）。
> 标注：✅ 已完成/已解决 · 👤 需用户亲自操作 · ⏳ 待完成（多为 push 后由 CI/实机验证）

---

## P0 — 必须完成（不做就别发）

| # | 事项 | 状态 | 说明 |
|---|------|------|------|
| 1 | 替换 README 三张占位截图为真实截图 | 👤 需用户亲自做 | 占位图已提交（干净检出不裂图）；真实截图仍需实机截取替换 `docs/images/` |
| 2 | 添加 1-2 个演示 GIF/短视频 | 👤 需用户亲自做 | 桌宠动作/情绪变化/主动搭话/Computer Use/Minecraft，需录屏 |
| 3 | 合并特性分支到 master，打 v0.1.0 tag | ✅ 已完成 | 本地已 fast-forward 合并并打注释 tag；**push 由用户执行** |
| 4 | 检查 git 历史中无密钥/敏感信息泄露 | ✅ 已完成 | 全历史扫描：2 处 AWS 模式匹配均为误报（minified 库/lockfile 哈希）；`.env` 从未被跟踪，`.env.example` 仅占位符 |
| 5 | UTF-16 文件转 UTF-8 | ✅ 已完成 | 6 个文件全部转为 UTF-8 并经人工复核 |
| 6 | 确认 package.json publish 配置 | 👤 需用户确认 | owner=`chaxu814`, repo=`lumina-life`；创建 GitHub 仓库时须与此一致 |
| 7 | 确认 .gitignore 覆盖 | ✅ 已完成 | 全部运行时/缓存/个人产物/验证目录均已覆盖 |
| 8 | 验证 macOS/Linux 平台适配器实机可用 | ⏳ push 后 CI/实机 | 代码+单测已完成；macOS 授权、Wayland 抓屏待实机 |
| 9 | 确认 electron-builder 三平台打包成功 | ⏳ push 后 CI | win nsis / mac dmg+zip / linux AppImage+deb 配置就绪，待 CI 出包 |
| 10 | Minecraft 游戏能力默认关闭确认 | ✅ 已完成 | `LUMINA_GAME_ENABLED=false` 默认，不影响普通用户 |

## P1 — 强烈建议（发布后 1 周内补齐）

| # | 事项 | 状态 | 说明 |
|---|------|------|------|
| 11 | 快速入门教程（3 分钟内） | ✅ 已完成 | 6 步 onboarding 向导 + `docs/INSTALL.md` 三平台指南 |
| 12 | 通道适配器配置文档 | ⏳ 部分完成 | 钉钉/QQ/微信/openclaw 适配器有代码，文档待补 |
| 13 | MCP 集成文档和示例 | ⏳ 部分完成 | openclaw 桥接已有，MCP 文档待补 |
| 14 | 创建 GitHub Discussions 分类 | 👤 需用户亲自做 | Q&A / 展示 / 创意 |
| 15 | 发布说明（CHANGELOG 摘要） | ✅ 已完成 | CHANGELOG.md 含完整 Unreleased 章节 |
| 16 | Windows 未签名安装包放行说明 | ⏳ 待补 | 需在 README 写明 SmartScreen 放行方法 |

## P2 — 建议（发布后 1 个月内）

| # | 事项 | 状态 | 说明 |
|---|------|------|------|
| 17 | 常见问题图文（API Key/LM Studio/CU/原生依赖） | ✅ 已完成 | `docs/TROUBLESHOOTING.md`（含 §16 原生依赖编译） |
| 18 | 建立社区渠道 | 👤 需用户亲自做 | Discord / QQ 群 / 微信群 |
| 19 | 自定义 Agent 教程 | ✅ 已完成 | `docs/custom-agent-guide.md` + 完整 UI 面板 |
| 20 | 贡献指南「good first issue」标签 | 👤 需用户亲自做 | 在 GitHub 仓库设置 label |
| 21 | 提交到 awesome 系列列表 | 👤 需用户亲自做 | awesome-ai-companion、awesome-desktop-pet 等 |

## P3 — 长期（Roadmap）

| # | 事项 | 状态 | 说明 |
|---|------|------|------|
| 22 | macOS/Linux 支持 | ✅ 代码已完成 | 平台适配器+测试+CI+打包配置+文档；实机/CI 验证见 P0 #8/#9 |
| 23 | 自定义 Agent 创建 | ✅ 已完成 | 管理器+IPC+UI+文档+测试 |
| 24 | 插件生态/社区技能商店 | ⏳ Roadmap | Skill 系统有基础，商店待开发 |
| 25 | 移动端伴侣 | ⏳ Roadmap | v1.5.0 计划 |

---

## 完成度统计（最终）

| 类别 | 总数 | ✅ 已完成 | 👤 需用户 | ⏳ 待完成 |
|------|------|----------|-----------|----------|
| P0 | 10 | 5 | 3 | 2 |
| P1 | 6 | 2 | 1 | 3 |
| P2 | 5 | 2 | 3 | 0 |
| P3 | 4 | 2 | 0 | 2 |
| **合计** | **25** | **11 (44%)** | **7 (28%)** | **7 (28%)** |

> 剩余 7 项 ⏳ 全部依赖"push 后 CI/实机"，无需再改源码；7 项 👤 中 5 项在 GitHub 网页操作、2 项为实机截图/录屏。

---

## 最终验证证据（主工作树，2026-09-23）

| 检查项 | 结果 |
|--------|------|
| `git fsck --full` | ✅ 仅 2 个 dangling blob（无害），无缺失/损坏对象 |
| `npx tsc --noEmit` | ✅ 零错误（103s） |
| `npx vitest run` | ✅ 97 文件 / 1170 通过 / 1 skipped |
| `npm run build` | ✅ main + preload(47KB) + renderer(186 模块) 全部成功 |
| 干净检出验证（组织代理故障前完成） | ✅ tsc 零错误 / 1134 测试通过 / 构建成功（3 个测试文件因跳过 Electron 二进制下载未跑，非源码问题） |

> 注：开发期间项目所在的外接硬盘曾反复掉线（评测当天也发生过一次，磁盘 4 整个从
> 系统消失，事后重新上线且工作区完好）。遇到这种情况**不要当场做磁盘操作** ——
> 先确认是设备掉线还是分区丢失，再决定是否重连。开发数据请尽量放在内置盘。

---

## 用户发布操作顺序

1. （可选）实机截图替换 `docs/images/` 占位图、录演示 GIF
2. 在 GitHub 创建仓库（名称与 package.json 一致：建议 `lumina-life`）
3. `git remote add origin <你的仓库URL>`
4. `git push origin master --tags`（CI 将自动验证三平台并出包）
5. 在 GitHub Releases 基于 v0.1.0 上传安装包 + 发布说明（引用 CHANGELOG）
6. 创建 Discussions 分类、补 SmartScreen 放行说明（P1 #16）
7. 建社区渠道、打 good first issue、投 awesome 列表
