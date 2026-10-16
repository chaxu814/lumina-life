# Lumina Life — 死代码清理记录（2026-10-16）

> 本文档记录本轮死代码清理的范围、判定依据与恢复方式。
> 所有被删文件均在 git 历史中完整保留，可用文末命令一键恢复。

## 一、清理方法

判定依据为**完整 import 图分析**，而非简单的关键词搜索：

1. 遍历 `electron/`、`src/`、`tests/` 下全部 `.ts` / `.tsx`（排除 `.d.ts`、`node_modules`、`out`、`dist`、构建产物）。
2. 解析每处 `from '...'`、`require('...')`、`import('...')`、裸 `import '...'`、`export * from '...'`，按 Node 解析规则（`.ts` / `.tsx` / `/index.ts` / `/index.tsx`）建图。
3. 把以下**非 import 的运行时入口**显式标记为"已引用"，避免误判：
   - `electron/main.ts`、`electron/preload.ts`、`electron/cli-entry.ts`、`src/main.tsx`、`src/App.tsx`
   - esbuild 构建入口：`pet/life/runtime.ts`、`pet/lifeSpeech/voiceClient.ts`、`pet/mmd/mmdRenderer.ts`、`pet/vrm/vrmRenderer.ts`、`pet/pngtuber/pngtuberRenderer.ts`
   - 按路径加载的 preload：`pet/petPreload.ts`、`browser/browserPreload.ts`、`tray/trayMenuPreload.ts`
4. 对每个候选**再逐个人工核验**：
   - 是否有测试按路径读取其源码（如 `readSrc('electron/...')`）
   - 是否被 HTML `<script src>` 或配置文件按字符串路径引用
   - 导出符号是否在别处被真实调用（排除同名定义造成的假阳性）
   - 工具是否动态注册（已核实 `electron/tools/index.ts` 为**静态 import**，不存在 glob 动态加载）

## 二、被删除的文件（29 个，约 4,680 行）

### 1. Mission 模式（整套被 prompt 方案取代）

| 文件 | 行数 | 判定 |
|---|---|---|
| `electron/mission/handler.ts` | 196 | `/mission` 命令（`electron/ipc/commandIpc.ts`）实际直接调用 `agent.run()` 并注入 MISSION MODE 提示词，**从未 import 本模块** |
| `electron/mission/runner.ts` | 262 | 同上 |
| `electron/mission/state.ts` | 159 | 仅被同目录文件引用 |
| `electron/mission/types.ts` | 69 | 仅被同目录文件引用 |
| `electron/mission/prompts.ts` | 81 | 仅被同目录文件引用 |

### 2. 被新实现取代的重复模块

| 文件 | 行数 | 判定 |
|---|---|---|
| `electron/tools/impl/memory.ts` | 109 | 被 `tools/impl/memory_v2.ts` 取代（registry 只注册 v2） |
| `electron/skillMarketV2.ts` | 527 | 被 `electron/skillMarket.ts` 取代 |
| `electron/memory/unified.ts` | 274 | 自称"统一记忆入口"，但从未接线 |
| `electron/memory/base-memory-manager.ts` | 246 | 无任何 import；`federation.ts` 中 `MemoryEntry` 为其自身定义 |
| `src/services/platformCapabilitiesClient.ts` | 81 | 与 `electron/core/platform/platformCapabilities.ts` 重复，前端未使用 |

### 3. 未接线的功能模块

| 文件 | 行数 | 说明 |
|---|---|---|
| `src/components/ChatInputBar.tsx` | 429 | "统一输入框"，实际聊天面板未使用 |
| `electron/ipc/lmStudioIpc.ts` | 302 | `registerLMStudioIpc()` 从未被调用 |
| `src/components/CharacterCustomization.tsx` | 269 | 注释称"供 GroupChatView 复用"，实际未被引入 |
| `electron/realtimeClient.ts` | 264 | Realtime API 客户端，无调用方 |
| `src/components/MessageContextMenu.tsx` | 177 | 消息右键菜单，无调用方 |
| `electron/pluginSystem.ts` | 166 | Phase 3 插件系统，无调用方 |
| `src/components/TokenChart.tsx` | 154 | 无调用方 |
| `electron/mcp/mcpConfigLoader.ts` | 151 | 全部导出无引用（MCP 实际实现在 `mcp/mcpServer.ts`） |
| `electron/skillPipeline.ts` | 137 | 无调用方 |
| `electron/voice/voiceLoopWiring.ts` | 134 | 无调用方 |
| `electron/voice/wakeWord.ts` | 117 | 无调用方 |
| `src/stores/stateBridge.ts` | 82 | `initStateBridge` / `syncAll` 无调用方 |
| `electron/nativeScreenshot.ts` | 71 | 截图能力由 `computerUse.ts` 自带实现 |
| `electron/prompts/agent.ts` | 70 | 仅被已删除的 `mission/runner.ts` 引用；`src/` 中的 `buildAgentPrompt` 来自 `src/data/agentSouls.ts` |
| `electron/hooks/bootstrap.ts` | 61 | `createBootstrapHook` 无调用方 |
| `electron/moodstats/index.ts` | 37 | 空 barrel 文件（无导出） |
| `electron/tools/impl/search_probe.ts` | 29 | 一次性探针脚本 |
| `electron/tools/impl/search.test.ts` | 15 | 位于 `impl/` 下，不在 vitest include 范围内，从未被执行 |
| `electron/dream/index.ts` | 11 | 空 barrel 文件（无导出） |

### 4. 配套测试调整

`tests/scanRound2Findings.test.ts` 中有一例 `mission PRD 损坏有日志` 读取 `electron/mission/state.ts` 源码文本做断言。随 mission 模块一并移除该用例（其余用例不变）。

## 三、验证结果

| 检查 | 结果 |
|---|---|
| `tsc --noEmit --strict` | **0 错误** |
| `vitest run` | **298 文件 / 4367 通过 / 1 跳过 / 0 失败**（用例数 4368 → 4367，即移除的那一例） |
| 残留引用扫描 | 无代码级引用；仅剩若干注释中的历史文件名提及（不影响构建） |

## 四、恢复方式

被删文件均在 git 历史中，按需恢复：

```bash
# 恢复单个文件
git checkout HEAD -- electron/mission/runner.ts

# 恢复整个 mission 模块
git checkout HEAD -- electron/mission/

# 查看本轮清理的完整清单
git log --diff-filter=D --name-only -1
```

## 五、未清理项（保留待人工决策）

以下文件**看起来**孤立，但存在合理存疑，本轮**未删**：

- `electron/pet/life/*`、`electron/pet/whisper/*` 下的若干文件：由 esbuild 打包或按路径加载，静态 import 图无法完全覆盖，需结合运行时路径逐一确认。

> 如需继续清理，建议先跑一次真实启动 + 桌宠 + 语音链路，用运行日志确认无加载失败后再动手。
