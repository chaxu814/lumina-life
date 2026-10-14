# 8 创新提案落地状态矩阵

> 更新日期：2026-09-24
> 分支：feature/v02-comprehensive-upgrade
> 验证：tsc 0 错误 / 1410 测试通过 / build 成功

## 状态图例
- ✅ **本地可用**：客户端已实现，可直接使用
- 🧩 **需部署模板**：核心逻辑已做，云端/服务端需部署 Workers 模板
- 🔐 **需用户凭证/资质**：需用户提供 API Key、签名密钥、支付资质等
- 📋 **仅架构/接口**：仅设计文档与接口占位，未实现

---

## 提案 1：Live2D 配件商城

| 模块 | 状态 | 说明 |
|------|------|------|
| 本地模型库扫描 | ✅ | `electron/pet/modelLibrary.ts`，扫描用户目录 model3.json |
| 模型热切换 | ✅ | 复用现有 `pet:set-model` IPC |
| model3.json 校验 | ✅ | `modelValidator.ts`，Version/FileReferences/Moc 必填 |
| 恶意脚本扫描 | ✅ | 模型包出现 .js/.exe/.dll/.sh → block，.html → warn |
| 配件商店面板 | ✅ | `ModelStorePanel.tsx`，卡片列表+导入+离线模式提示 |
| 云端商店后端 | 🧩 | `docs/templates/live2d-store-worker.js`（Cloudflare Workers+R2） |
| 支付/购买 | 🔐 | `/api/purchase` 返回 501 占位，需支付资质 |
| 签名验证 | 🔐 | `signature.ts` RSA+SHA256，需替换占位公钥 |

**总结**：本地模型管理+安全扫描完整可用；在线商城需部署 Workers 模板；支付需资质。

---

## 提案 2：技能创作者分成

| 模块 | 状态 | 说明 |
|------|------|------|
| .lumina-skill 包格式 | ✅ | zip: skill.json + SKILL.md + index.js |
| vm 沙箱运行时 | ✅ | `skillRuntime.ts`，白名单 API，越权拦截，路径防穿越 |
| 技能安装/卸载 | ✅ | `skillManager.ts`，zip-slip 防护，审批流程 |
| 动态注册工具 | ✅ | 接入现有 tools registry |
| 示例技能 | ✅ | `docs/templates/example-skill/` 每日一言 |
| 静态扫描接入 | ✅ | 安装前过 staticScanner |
| 支付/分成计费 | 🔐 | skill.json 预留 pricing 字段，不做真实扣款 |

**总结**：技能包格式+沙箱运行时+安装审批完整可用；支付分成需公司主体+商户号+ICP。

---

## 提案 3：团队记忆共享 Federation

| 模块 | 状态 | 说明 |
|------|------|------|
| Level 1 手动导出/导入 | ✅ | `federation.ts`，JSON 打包，来源标签，可信度 0-1 |
| 冲突处理 | ✅ | 隔离写入 federated/<source>/，.conflict 副本 |
| 可信度调节 | ✅ | 自记忆 1.0，导入默认 0.7，可调整 |
| Level 2 公共记忆池 | 🧩 | `docs/templates/memory-pool-worker.js`（Workers+KV） |
| Level 3 E2EE/P2P | 📋 | `docs/federation-e2ee-design.md`，X3DH+libp2p 架构，未实现 |
| 设置 UI | ✅ | 记忆共享页：导出/导入/列表/可信度滑块 |

**总结**：手动导入导出完整可用；公共池需部署 Workers；E2EE/P2P 因隐私红线仅给架构。

---

## 提案 4：跨设备云同步

| 模块 | 状态 | 说明 |
|------|------|------|
| WebDAV 客户端 | ✅ | `webdavClient.ts`，纯 fetch 实现 PROPFIND/PUT/GET/DELETE/MKCOL |
| 增量同步 | ✅ | SHA-256 + mtime 对比，只传变化文件 |
| AES-256-GCM 加密 | ✅ | PBKDF2 派生密钥，云端只存密文，篡改检测 |
| SQLite 安全同步 | ✅ | 同步前 VACUUM INTO 备份，避免数据库锁 |
| 冲突检测与解决 | ✅ | 保留本机/云端/文本合并三选一 |
| 密码安全存储 | ✅ | Electron safeStorage 加密落盘 |
| 同步方向 | ✅ | 双向/仅上传/仅下载 |
| 设置 UI | ✅ | 云同步页：配置表单+连接测试+加密口令+冲突列表 |
| 官方云服务 | 🔐 | 预留 officialCloud 接口，需自建服务端 |

**总结**：WebDAV 全功能 MVP 完整可用（含端到端加密）；官方云需自建服务端。真实 WebDAV 服务器连接未实机验证。

---

## 提案 5：插件 Marketplace 治理

| 模块 | 状态 | 说明 |
|------|------|------|
| AST 静态扫描 | ✅ | `staticScanner.ts`，@babel/parser，6 类规则 |
| 规则覆盖 | ✅ | child_process/eval/electron.remote/敏感路径/可疑域名/typosquatting |
| 三级分级 | ✅ | block（拦截）/ warn（警告）/ pass（放行） |
| 签名校验 | ✅ | `signature.ts`，RSA+SHA256，未签名标"未验证" |
| 威胁情报 | ✅ | `threatIntel.ts`，离线黑名单+Levenshtein 仿冒检测 |
| 安装审批弹窗 | ✅ | 权限清单+扫描结果，用户确认才安装 |
| 接入技能/模型安装 | ✅ | 技能安装和模型导入都先过扫描 |

**总结**：静态扫描治理完整可用，是所有插件/技能/模型生态的安全前置网。正式发布需替换签名密钥。

---

## 提案 6：AI 主动推送（P0）

| 模块 | 状态 | 说明 |
|------|------|------|
| 三维状态模型 | ✅ | `pushState.ts`，fatigue/intimacy/luminaEnergy，衰减恢复曲线 |
| 推送决策引擎 | ✅ | `pushDecider.ts`，欲望值=亲密度35%+精力25%+抗疲劳25%+时段15% |
| 冷却与上限 | ✅ | 间隔≥30min，每日≤5次，可配置 |
| 未响应降频 | ✅ | 连续2次未响应，阈值提高50% |
| 静默时段 | ✅ | 可配置起止时间，跨午夜支持 |
| 推送执行 | ✅ | `pushExecutor.ts`，只走桌宠气泡+侧边栏，不弹系统通知 |
| 调度器 | ✅ | `pushScheduler.ts`，5分钟检查，用户活跃时暂停 |
| 设置 UI | ✅ | ProactiveSettingsPanel：开关/状态可视化/频率/时段/类型/立即触发 |
| IPC | ✅ | proactive:get-state/settings/update-settings/push-now/toggle/user-activity |
| LLM 个性化文案 | 📋 | 当前用模板文案，后续可接入 LLM 生成 |

**总结**：主动推送系统完整可用，三维状态+决策+调度+UI 全链路打通。文案目前模板化，可后续接 LLM 个性化。

---

## 提案 7：无障碍语音交互

| 模块 | 状态 | 说明 |
|------|------|------|
| 语音闭环状态机 | ✅ | `voiceLoop.ts`，idle→recording→recognizing→speaking，支持打断 |
| PTT 快捷键 | ✅ | `voiceShortcuts.ts`，默认 Ctrl+Space，冲突检测 |
| STT/TTS 复用 | ✅ | 接入现有 WhisperTranscriber + edge-tts |
| 打断逻辑 | ✅ | 播报中再按 PTT 立即取消并开新录音 |
| 唤醒词 | 📋 | `wakeWord.ts`，Porcupine 接入占位，未配 AccessKey 时降级 |
| ARIA 标签 | ✅ | TopBar/ChatInputBar 图标按钮补 aria-label |
| 焦点陷阱 | ✅ | MoreSettingsModal role=dialog，Tab 循环，Esc 关闭，焦点归还 |
| 高对比度主题 | ✅ | `a11y-high-contrast.css`，--a11y- 前缀，≥7:1 对比度 |
| 字号缩放 | ✅ | --font-scale，100/125/150% 三档，持久化 |
| 设置 UI | ✅ | SettingsA11y：PTT/语音/高对比/字号/唤醒词 |

**总结**：语音闭环+ARIA+键盘导航+高对比+字号全部可用。真实麦克风/STT/TTS 未实机验证（headless 环境）。

---

## 提案 8：主题皮肤生态

| 模块 | 状态 | 说明 |
|------|------|------|
| CSS 变量体系 | ✅ | `theme-vars.css`，bg/text/accent/border/shadow/bubble 全套语义变量 |
| .lumina-theme 格式 | ✅ | JSON: name/version/author/isDark/vars/preview，含校验 |
| 主题管理器 | ✅ | `themeManager.ts`，list/apply/import/export/delete，持久化 |
| 内置预设 | ✅ | 5 个：默认浅色/深色/暗夜紫/薄荷绿/暖橙 |
| 可视化编辑器 | ✅ | `ThemeEditorPanel.tsx`，分组变量+原生色盘+实时预览+保存导出 |
| 主题选择 UI | ✅ | AppearancePanel，卡片+四色预览+切换+导入+删除 |
| 桌宠气泡跟随 | ✅ | 气泡用 var(--bubble-*)，托盘强调色跟随 --accent-primary |
| IPC | ✅ | theme:list/apply/import/export/delete/save + changed 广播 |

**总结**：主题系统完整可用，编辑器+预设+导入导出全链路。部分边缘组件硬编码颜色未逐一迁移，后续可逐步替换。

---

## 全局验证

| 检查项 | 结果 |
|--------|------|
| npx tsc --noEmit | ✅ 0 错误 |
| npx vitest run | ✅ 121 文件 / 1410 测试通过（autoPlay 时序测试偶发波动，重跑通过） |
| npm run build | ✅ 成功，无 vite 告警 |
| 新增测试数 | ✅ 114 个（推送20 + 数据同步22 + 无障碍19 + 市场生态38 + 主题15） |
| 新增 commit | ✅ 约 20 个（按功能点切分） |

---

## 仍需用户本人完成的事项

1. **实机验证**：`npm run dev` 后逐一确认 8 个新面板的 UI 渲染和交互
2. **WebDAV 真实连接**：配置坚果云/Nextcloud 测试真实同步
3. **语音实机**：测试麦克风录音、STT 识别、TTS 播报
4. **部署 Workers 模板**：在线商城和记忆池的 Cloudflare Workers 部署
5. **签名密钥**：生成 RSA 密钥对，替换 signature.ts 中的占位公钥
6. **支付资质**：公司主体+微信/支付宝商户号+ICP 备案（技能分成和商城购买）
7. **合并 master + 打 v0.2.0 tag**（本次未动 master 和 v0.1.0）
8. **建远程仓库 / push / Releases / Discussions**（仍无 remote）
