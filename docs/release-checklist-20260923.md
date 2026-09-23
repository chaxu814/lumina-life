# GitHub 发布前 Checklist — 更新版（2026-09-23）

> 基于 feature/crossplatform-gaming-onboarding 分支改造后的状态更新。
> 标注：✅ 已完成 / 🔧 本次改造已解决 / 👤 需用户亲自操作 / ⏳ 仍待完成

---

## P0 — 必须完成（不做就别发）

| # | 事项 | 状态 | 说明 |
|---|------|------|------|
| 1 | 替换 README 三张占位截图为真实截图 | 👤 需用户亲自做 | `docs/images/chat-panel.png` / `pet-live2d.png` / `moments.png` 目录已建，需实机截图替换 |
| 2 | 添加 1-2 个演示 GIF/短视频 | 👤 需用户亲自做 | 桌宠动作/情绪变化/主动搭话/Computer Use，需录屏 |
| 3 | 合并特性分支到 master/main，打 v0.1.0 tag | 👤 需用户亲自做 | 当前分支 `feature/crossplatform-gaming-onboarding` 含 16 commits；合并前确认无冲突 |
| 4 | 检查 git 历史中无密钥/敏感信息泄露 | ⏳ 需运行检查 | `.env` 和 `agents/` 已在 .gitignore；建议运行 `git log --all --full-history -- .env` 和 `gitleaks` 扫描 |
| 5 | UTF-16 文件转 UTF-8 | 🔧 本次已解决 | 6 个文件全部转为 UTF-8（AGENTS/MEMORY/PROFILE/SOUL_LUMINA/SOUL_RECHA/SOUL_YAK） |
| 6 | 确认 package.json publish 配置 | ⏳ 需确认 | owner=`chaxu814`, repo=`lumina-life`；需与实际 GitHub 仓库名一致 |
| 7 | 确认 .gitignore 覆盖 | ✅ 已覆盖 | userData/、shots/、_shots/、collected/、coverage/、.cache/、out/、dist/、.env、agents/ 均已忽略 |

### P0 新增（本次改造引入）

| # | 事项 | 状态 | 说明 |
|---|------|------|------|
| 8 | 验证 macOS/Linux 平台适配器实机可用 | ⏳ 需 CI/实机 | 代码+测试已完成，但 macOS 授权流程、Linux Wayland 抓屏未经实机验证 |
| 9 | 确认 electron-builder 三平台打包成功 | ⏳ 需 CI | 配置已就绪（win nsis / mac dmg+zip / linux AppImage+deb），需 CI 验证打包 |
| 10 | Minecraft 游戏能力默认关闭确认 | ✅ 已确认 | `LUMINA_GAME_ENABLED=false` 默认，不影响普通用户 |

---

## P1 — 强烈建议（发布后 1 周内补齐）

| # | 事项 | 状态 | 说明 |
|---|------|------|------|
| 8 | 快速入门教程（3 分钟内） | 🔧 本次已解决 | 6 步 onboarding 向导 + `docs/INSTALL.md` 三平台安装指南 |
| 9 | 通道适配器配置文档 | ⏳ 部分完成 | 钉钉/QQ/微信适配器已有代码，文档待补充 |
| 10 | MCP 集成文档和示例 | ⏳ 部分完成 | openclaw 桥接已有，MCP 文档待补充 |
| 11 | 创建 GitHub Discussions 分类 | 👤 需用户亲自做 | Q&A / 展示 / 创意，需在 GitHub 仓库设置中创建 |
| 12 | 发布说明（CHANGELOG 摘要） | 🔧 本次已解决 | CHANGELOG.md 已新增 Unreleased 章节，含完整改造说明 |
| 13 | Windows 安装包签名/放行说明 | ⏳ 需确认 | 未签名包需在 README 中明确告知 SmartScreen 放行方法 |

---

## P2 — 建议（发布后 1 个月内）

| # | 事项 | 状态 | 说明 |
|---|------|------|------|
| 14 | 常见问题图文（API Key/LM Studio/CU） | 🔧 本次已解决 | `docs/TROUBLESHOOTING.md` 已增强（含 §16 原生依赖编译） |
| 15 | 建立社区渠道 | 👤 需用户亲自做 | Discord / QQ 群 / 微信群 |
| 16 | 自定义 Agent 教程 | 🔧 本次已解决 | `docs/custom-agent-guide.md` + 完整 UI 面板 |
| 17 | 贡献指南「好第一个 issue」标签 | 👤 需用户亲自做 | 需在 GitHub 上设置 label |
| 18 | 提交到 awesome 系列列表 | 👤 需用户亲自做 | awesome-ai-companion、awesome-desktop-pet 等 |

---

## P3 — 长期（Roadmap）

| # | 事项 | 状态 | 说明 |
|---|------|------|------|
| 19 | macOS/Linux 支持 | 🔧 本次大幅提前 | 平台适配器+测试+CI+打包配置+文档已完成；实机验证待 CI |
| 20 | 自定义 Agent 创建 | 🔧 本次已提前 | 管理器+IPC+UI+文档+测试全部完成 |
| 21 | 插件生态/社区技能商店 | ⏳ Roadmap | Skill 系统已有基础，商店待开发 |
| 22 | 移动端伴侣 | ⏳ Roadmap | v1.5.0 计划 |

---

## 本次改造完成度统计

| 类别 | 总数 | 已完成/已解决 | 需用户操作 | 待完成 |
|------|------|--------------|-----------|--------|
| P0 | 10 | 3 | 3 | 4 |
| P1 | 6 | 2 | 1 | 3 |
| P2 | 5 | 2 | 3 | 0 |
| P3 | 4 | 2 | 0 | 2 |
| **合计** | **25** | **9 (36%)** | **7 (28%)** | **9 (36%)** |

---

## 发布前最后检查（用户操作清单）

1. 👤 实机截图 3 张替换 `docs/images/` 占位
2. 👤 录制演示 GIF/视频
3. 👤 运行 `gitleaks detect` 或手动检查 git 历史无密钥
4. 👤 确认 GitHub 仓库名与 package.json publish 配置一致
5. 👤 合并分支：`git checkout master && git merge feature/crossplatform-gaming-onboarding`
6. 👤 打 tag：`git tag -a v0.1.0 -m "v0.1.0 首个公开预览版"`
7. 👤 推送：`git push origin master --tags`
8. 👤 在 GitHub Releases 中上传安装包 + 填写发布说明（引用 CHANGELOG）
9. 👤 创建 GitHub Discussions 分类
10. 👤 确认 README 顶部演示 GIF 已嵌入
