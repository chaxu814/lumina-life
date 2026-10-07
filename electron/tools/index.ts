// ============================================================
// tools/index.ts — 工具注册入口 (v3.6: 已注册 62+ 工具)
// v3.6 新增: file_search（全盘递归搜索）+ disk_list（驱动器列表）
// v3.0 新增: 团队协作工具 + 结构化记忆
// ============================================================

import { registerTool, getToolNames, validateToolRegistry, resolveToolset, TOOLSETS } from './registry'
import { claimToolsRegistration } from './registrationFlag'
import { skillToToolDef, executeSkill, BUILTIN_SKILLS, getSkill } from './skillSystem'
// 语音工具 (Whisper + ONNX + TTS)
import {
  toolVoiceTranscribe,
  toolVoiceRecord,
  toolVoiceStatus,
  toolVoiceSpeak,
} from './impl/whisper'

// Shell
import { shellExecDef, shellExec } from './impl/shell'
// File
import { fileReadDef, fileRead } from './impl/fileRead'
import { fileWriteDef, fileWrite } from './impl/fileWrite'
import { fileEditDef, fileEdit } from './impl/fileEdit'
import { fileListDef, fileList } from './impl/fileList'
// 全盘文件搜索 + 驱动器列表
import { fileSearchDef, fileSearch } from './impl/fileSearch'
import { diskListDef, diskList } from './impl/diskList'
// 桌面程序扫描
import { desktopScanDef, desktopScan } from './impl/desktopScan'
// 桌面整理三件套（扫描/方案/执行）—— 导出名与 desktopScan.ts 撞车，故用别名
import {
  desktopScanDef as desktopTidyScanDef, desktopScan as desktopTidyScan,
  desktopPlanDef, desktopPlan,
  desktopTidyDef, desktopTidy,
} from './impl/desktopTidy'
// Search
import { webSearchDef, webSearch } from './impl/search'
// Time
import { datetimeDef, datetime } from './impl/datetime'
// Memory (v2.4: 三层 + 向量检索)
import {
  memorySaveDef, memorySave,
  memoryGetDef, memoryGet,
  memoryAllDef, memoryAll,
  memorySummarizeDef, memorySummarize,
  memorySearchDef, memorySearch,
} from './impl/memory_v2'
// Todo
import { todoDef, todo } from './impl/todo'
// 本地日历（ICS 文件，不动系统日历）
import {
  calendarListDef, calendarList,
  calendarAddDef, calendarAdd,
  calendarRemoveDef, calendarRemove,
  calendarFreeDef, calendarFree,
} from './impl/calendar'
import {
  skillSearchDef, skillSearch,
  skillInstallDef, skillInstall,
} from './impl/skillInstall'
// Cron
import { cronDef, cronSchedule, cronListDef, cronList, cronCancelDef, cronCancel } from './impl/cron'
// Browser
import { browserDef, browserHandler } from './impl/browser'
import { browserCDPDef, browserCDPHandler } from './impl/browser_cdp'
// Git
import { gitStatusDef, gitStatus, gitCommitDef, gitCommit, gitLogDef, gitLog, gitDiffDef, gitDiff } from './impl/git'
import { devCompanionCheckDef, devCompanionCheck } from './impl/devCompanion'
// System / Image
import { screenshotDef, screenshot, clipboardGetDef, clipboardGet, clipboardSetDef, clipboardSet, imageGenerateDef, imageGenerate } from './impl/image'
import { systemInfoDef, systemInfo, processListDef, processList, notificationDef, notification, openFileDef, openFile } from './impl/system'
// OCR / Desktop (v2.3)
import {
  ocrDef, ocr,
  desktopClickDef, desktopClick,
  desktopTypeDef, desktopType,
  desktopKeyDef, desktopKey,
  desktopScreenSizeDef, desktopScreenSize,
  desktopMouseMoveDef, desktopMouseMove,
} from './impl/ocr'
// LSP 代码智能
import { astSearchDef, astSearchHandler, lspSymbolsDef, lspSymbolsHandler, lspReferencesDef, lspReferencesHandler } from './impl/lsp'
// Oath / Appointment (v2.3)
import {
  oathMakeDef, oathMake,
  oathListDef, oathList,
  oathFulfillDef, oathFulfill,
  appointmentSetDef, appointmentSet,
  appointmentListDef, appointmentList,
} from './impl/oath'
// MCP (v2.4)
import {
  mcpListServersDef, mcpListServers,
  mcpConnectDef, mcpConnect,
  mcpListToolsDef, mcpListTools,
  mcpCallToolDef, mcpCallTool,
} from './impl/mcp'
// Skill 执行 (v2.4.1)
import { createSkillRunDef, skillRunHandler, useSkillDef, useSkillHandler } from './impl/skillRun'

// ══════════════════════════════════════════════════════════
// v2.5 新增工具
// ══════════════════════════════════════════════════════════

// 键盘控制
import { keyboardPressDef, keyboardPress, keyboardTypeDef, keyboardType } from './impl/keyboard'
// 天气
import { weatherDef, weather } from './impl/weather'
// 网页抓取
import { webFetchDef, webFetch } from './impl/webFetch'
// 官方示例技能（冷启动）: B站热搜 / 天气简报 / 代码日报 / 番茄钟
import {
  bilibiliHotSearchDef, bilibiliHotSearch,
  bilibiliHotPushDef, bilibiliHotPush,
} from './impl/bilibiliHot'
import {
  weatherGetDef, weatherGet,
  weatherBriefDef, weatherBrief,
} from './impl/weatherBrief'
import {
  codeDailyGenerateDef, codeDailyGenerate,
  codeDailyWeeklyDef, codeDailyWeekly,
} from './impl/codeDaily'
import {
  pomodoroStartDef, pomodoroStart,
  pomodoroStatusDef, pomodoroStatus,
  pomodoroStopDef, pomodoroStop,
} from './impl/pomodoro'
// 听觉系统工具
import { hearingDefs } from './impl/hearingTools'
// 主动对话工具
import { proactiveDefs } from './impl/proactiveTools'
// 🆕 Daily Paper 工具
import { dailyPaperDef, dailyPaperHandler } from './impl/dailyPaper'

// 🆕 v1.0 决策征询：结构化选项 + 用户自由输入
import { askDecisionDef, askDecisionTool } from './impl/askDecision'
// 🆕 Computer Use (v2.5, v3.30 + UIA 元素树)
import {
  desktopSeeDef, desktopSee,
  desktopActDef, desktopAct,
  desktopElementsDef, desktopElements,
  desktopElementActDef, desktopElementAct,
} from './impl/computerUse'
// 🎮 Minecraft 游戏集成（双路线：视觉 VLM / Mineflayer 程序化）
import { registerGamingTools } from '../gaming'
// 🌐 应用内置浏览器（用户可见窗口，Agent 可驱动）
import { registerBrowserTools } from '../browser/browserTools'
// 🔬 Phase C: Deep Research 工具
import { deepResearchDef, deepResearch } from './impl/deepResearch'
// 📡 Phase C: 渠道消息工具
import { channelSendDef, channelSend, channelStatusDef, channelStatus } from './impl/channelMessage'
// 📬 Agent 邮件 (v2.6)
import {
  mailSendDef, mailSendHandler,
  mailListDef, mailListHandler,
  mailMarkReadDef, mailMarkReadHandler,
} from './impl/mailTools'
// 内容收集器
import { contentCollectorDef, contentCollector } from './impl/contentCollector'
// Creator 简化版 (Phase 3)
import {
  creatorOutlineDef, creatorOutlineHandler,
  creatorGenerateDef, creatorGenerateHandler,
  creatorExportDef, creatorExportHandler,
  creatorEnrichDef, creatorEnrichHandler,
} from './impl/creator'

// 回忆书对话
import { memoryChatSearchDef, memoryChatSearch } from './impl/memoryChatSearch'
// 时光胶囊
import { timeCapsuleDef, timeCapsule } from './impl/timeCapsule'

// ══════════════════════════════════════════════════════════
// v5.0 模式协作工具
// ══════════════════════════════════════════════════════════

import {
  modeSwitchDef, modeSwitch,
  modeStatusDef, modeStatus,
  teamContextDef, teamContext,
  memorySearchDef as teamMemorySearchDef, memorySearch as teamMemorySearch,
  delegateToDef, delegateTo,      // 🆕 v8.0: 委托工具
  // 团队协作增强
  delegateChainDef, delegateChain,
  writeNoticeDef, writeNotice,
  readNoticesDef, readNotices,
  saveContextDef, saveContext,
  loadContextDef, loadContext,
} from './impl/team'

// 🆕 v3.0: 主动并行派生子智能体
import { runSubagentsDef, runSubagents } from './impl/runSubagents'

// 🆕 v3.20: 文件信箱 / 共享任务板 / 动态 worker / 对抗评审 / worktree 隔离（对标 cc-haha）
// 🆕 v3.30: plan_approval / 待命中转 / 工作流 DSL / Teach 录制回放 / Markdown 工种
import {
  teamMessageDef, teamMessage,
  teamMailboxDef, teamMailbox,
  teamTasksDef, teamTasks,
  hireWorkerDef, hireWorker,
  adversarialReviewDef, adversarialReview,
  gitWorktreeDef, gitWorktree as gitWorktreeHandler,
  teamRolesDef, teamRoles,
  workerControlDef, workerControl,
  workflowDef, workflow as workflowHandler,
  teachDef, teach,
  // v3.33: 绩效画像 / 自治自领取 / 团队日记 / 整轮检查点
  teamStatsDef, teamStats,
  teamAutonomyDef, teamAutonomy as teamAutonomyHandler,
  teamLogDef, teamLog as teamLogHandler,
  teamCheckpointDef, teamCheckpoint as teamCheckpointHandler,
  phaseGateDelegateDef, phaseGateDelegate as phaseGateDelegateHandler,
} from './impl/teamCollab'

export function registerAllTools(): void {
  // 标志位放在零依赖的叶子模块里，避开 agentRunner 顶层调用造成的 TDZ（详见 registrationFlag.ts 注释）
  if (!claimToolsRegistration()) {return}

  // ── 基础工具 ─────────────────────────────────────────

  // Shell
  registerTool(shellExecDef, shellExec)

  // File
  registerTool(fileReadDef, fileRead)
  registerTool(fileWriteDef, fileWrite)
  registerTool(fileEditDef, fileEdit)
  registerTool(fileListDef, fileList)
  // 全盘搜索 + 驱动器列表 + 桌面扫描
  registerTool(fileSearchDef, fileSearch)
  registerTool(diskListDef, diskList)
  registerTool(desktopScanDef, desktopScan)
  // 桌面整理：desktop_tidy_scan / desktop_tidy_plan / desktop_tidy
  registerTool(desktopTidyScanDef, desktopTidyScan)
  registerTool(desktopPlanDef, desktopPlan)
  registerTool(desktopTidyDef, desktopTidy)

  // Search
  registerTool(webSearchDef, webSearch)

  // Time
  registerTool(datetimeDef, datetime)

  // Memory (v2.4)
  registerTool(memorySaveDef, memorySave)
  registerTool(memoryGetDef, memoryGet)
  registerTool(memoryAllDef, memoryAll)
  registerTool(memorySummarizeDef, memorySummarize)
  registerTool(memorySearchDef, memorySearch)

  // Task
  registerTool(todoDef, todo)

  // 本地日历（v1.0）
  registerTool(calendarListDef, calendarList)
  registerTool(calendarAddDef, calendarAdd)
  registerTool(calendarRemoveDef, calendarRemove)
  registerTool(calendarFreeDef, calendarFree)
  registerTool(skillSearchDef, skillSearch)
  registerTool(skillInstallDef, skillInstall)

  // Cron
  registerTool(cronDef, cronSchedule)
  registerTool(cronListDef, cronList)
  registerTool(cronCancelDef, cronCancel)

  // Browser
  registerTool(browserDef, browserHandler)
  // 🆕 CDP Browser Control (Phase 3)
  registerTool(browserCDPDef, browserCDPHandler)

  // Git
  registerTool(gitStatusDef, gitStatus)
  registerTool(devCompanionCheckDef, devCompanionCheck)
  registerTool(gitCommitDef, gitCommit)
  registerTool(gitLogDef, gitLog)
  registerTool(gitDiffDef, gitDiff)

  // System
  registerTool(systemInfoDef, systemInfo)
  registerTool(processListDef, processList)
  registerTool(notificationDef, notification)
  registerTool(openFileDef, openFile)

  // Image
  registerTool(screenshotDef, screenshot)
  registerTool(clipboardGetDef, clipboardGet)
  registerTool(clipboardSetDef, clipboardSet)
  // 🆕 Image Generation (Phase 3)
  registerTool(imageGenerateDef, imageGenerate)

  // OCR / Desktop (v2.3)
  registerTool(ocrDef, ocr)
  registerTool(desktopClickDef, desktopClick)
  registerTool(desktopTypeDef, desktopType)
  registerTool(desktopKeyDef, desktopKey)
  registerTool(desktopScreenSizeDef, desktopScreenSize)
  // desktopMouseMove 已弃用（极少单独使用，desktopAct 覆盖）

  // MCP 协议工具（取代了旧的 oath/appointment 系统）
  registerTool(mcpListServersDef, mcpListServers)
  registerTool(mcpConnectDef, mcpConnect)
  registerTool(mcpListToolsDef, mcpListTools)
  registerTool(mcpCallToolDef, mcpCallTool)

  // Skill 执行 (v2.4.1)
  registerTool(createSkillRunDef(), skillRunHandler)

  // 🔧 P1-fix: use_skill 工具 — 读取 SKILL.md 工作流
  registerTool(useSkillDef, useSkillHandler)

  // ── v2.5 新增工具 ────────────────────────────────────

  // keyboardPress / keyboardType 已合并到 desktopType / desktopKey
  registerTool(weatherDef, weather)

  // 网页抓取
  registerTool(webFetchDef, webFetch)
  // contentCollector 已合并到 webFetch

  // ── 官方示例技能（冷启动）──────────────────────────
  // B站热搜
  registerTool(bilibiliHotSearchDef, bilibiliHotSearch)
  registerTool(bilibiliHotPushDef, bilibiliHotPush)
  // 每日天气简报
  registerTool(weatherGetDef, weatherGet)
  registerTool(weatherBriefDef, weatherBrief)
  // 代码日报/周报
  registerTool(codeDailyGenerateDef, codeDailyGenerate)
  registerTool(codeDailyWeeklyDef, codeDailyWeekly)
  // 番茄钟
  registerTool(pomodoroStartDef, pomodoroStart)
  registerTool(pomodoroStatusDef, pomodoroStatus)
  registerTool(pomodoroStopDef, pomodoroStop)

  // 听觉系统 (4 工具)
  for (const def of hearingDefs) {
    registerTool(def.def, def.handler)
  }

  // 🆕 Voice Speak (Phase 3)
  registerTool(toolVoiceSpeak, async (args: any) => toolVoiceSpeak.handler!(args))

  // 主动对话 (2 工具)
  for (const def of proactiveDefs) {
    registerTool(def.def, def.handler)
  }

  // 🆕 Daily Paper (1 工具)
  registerTool(dailyPaperDef, dailyPaperHandler)

  // 🆕 v1.0 决策征询（1 工具）— agent 主动问用户「走哪条路」
  //   与 approval（问「我可以做 X 吗」）职责不同，不可合并：
  //   审批不答就拦下，决策不答就按推荐项继续。
  registerTool(askDecisionDef, askDecisionTool)

  // 🆕 Computer Use (v2.5) — 屏幕理解 + 自动操作
  registerTool(desktopSeeDef, desktopSee)
  registerTool(desktopActDef, desktopAct)
  // v3.30 UIA 元素树（按元素序号精确操作）
  registerTool(desktopElementsDef, desktopElements)
  registerTool(desktopElementActDef, desktopElementAct)

  // 🎮 Minecraft 游戏集成（视觉 + 程序化双路线）
  registerGamingTools()

  // 🌐 内置浏览器工具（browser_*）
  registerBrowserTools(registerTool)

  // 📬 Agent 邮件 (v2.6)
  registerTool(mailSendDef, mailSendHandler)
  registerTool(mailListDef, mailListHandler)
  registerTool(mailMarkReadDef, mailMarkReadHandler)

  // ── v5.0 模式协作工具 ──────────────────────────────────

  // 模式切换
  registerTool(modeSwitchDef, modeSwitch)
  registerTool(modeStatusDef, modeStatus)

  // 团队上下文（保留）
  registerTool(teamContextDef, teamContext)
  registerTool(teamMemorySearchDef, teamMemorySearch)

  // 委托工具
  registerTool(delegateToDef, delegateTo)
  // 🆕 v3.0: 主动并行派生子智能体
  registerTool(runSubagentsDef, runSubagents)

  // 团队协作增强工具
  registerTool(delegateChainDef, delegateChain)
  registerTool(writeNoticeDef, writeNotice)
  registerTool(readNoticesDef, readNotices)
  registerTool(saveContextDef, saveContext)
  registerTool(loadContextDef, loadContext)

  // 🆕 v3.20 团队协作升级（文件信箱 / 共享任务板 / 动态 worker / 对抗评审 / worktree）
  registerTool(teamMessageDef, teamMessage)
  registerTool(teamMailboxDef, teamMailbox)
  registerTool(teamTasksDef, teamTasks)
  registerTool(hireWorkerDef, hireWorker)
  registerTool(adversarialReviewDef, adversarialReview)
  registerTool(gitWorktreeDef, gitWorktreeHandler)
  // v3.30 团队深度改造
  registerTool(teamRolesDef, teamRoles)
  registerTool(workerControlDef, workerControl)
  registerTool(workflowDef, workflowHandler)
  registerTool(teachDef, teach)
  // v3.33 绩效画像 / 自治自领取 / 团队日记 / 整轮检查点
  registerTool(teamStatsDef, teamStats)
  registerTool(teamAutonomyDef, teamAutonomyHandler)
  registerTool(teamLogDef, teamLogHandler)
  registerTool(teamCheckpointDef, teamCheckpointHandler)

  // v3.34: 五阶段门控委托 —— phaseGatedDelegate() 在此之前 0 调用方，
  // 导致 Research→Plan→Execute→Verify→Review 整条链路从未被真正执行过。
  // 详见 impl/phaseGateDelegate.ts 顶部说明。
  registerTool(phaseGateDelegateDef, phaseGateDelegateHandler)

  // ── v2.5 Skill 系统 ──────────────────────────────────

  // 将每个内置 Skill 注册为一个标准工具，LLM 可直接调用
  for (const skillName of BUILTIN_SKILLS) {
    const skill = getSkill(skillName)
    if (!skill) {
      console.warn(`[Tools] Skill 未找到: ${skillName}`)
      continue
    }
    try {
      const def = skillToToolDef(skill)
      const handler = async (args: Record<string, any>) =>
        executeSkill(skillName, args, `skill_${skillName}_${Date.now()}`)
      registerTool(def, handler)
    } catch (err) {
      console.warn(`[Tools] Skill 注册失败: ${skillName}`, err)
    }
  }

    // LSP 代码智能工具
  registerTool(astSearchDef, astSearchHandler)
  registerTool(lspSymbolsDef, lspSymbolsHandler)
  registerTool(lspReferencesDef, lspReferencesHandler)

  // ── 🆕 v3.0 新功能工具 ──────────────────────────────

  // 回忆书对话 (④)
  registerTool(memoryChatSearchDef, memoryChatSearch)
  // 时光胶囊 (⑨)
  registerTool(timeCapsuleDef, timeCapsule)

  // 🆕 Creator 简化版 (Phase 3)
  registerTool(creatorOutlineDef, creatorOutlineHandler)
  registerTool(creatorGenerateDef, creatorGenerateHandler)
  registerTool(creatorExportDef, creatorExportHandler)
  registerTool(creatorEnrichDef, creatorEnrichHandler)

  // ── 反幻觉工具：注册 LLM 经常自创的工具名，返回重定向提示 (ok:true 防止无限重试) ──
  // Phase C: Deep Research 工具
  registerTool(deepResearchDef, deepResearch)
  // Phase C: 渠道消息工具
  registerTool(channelSendDef, channelSend)
  registerTool(channelStatusDef, channelStatus)

  // ── 🗑️ 已删除：4 个「反幻觉占位工具」（2026-10-07）──
  //
  // 曾经注册了 tavily_search / tavily_extract / serpapi_search / bing_search，
  // 目的是「模型自创这些名字时给一句提示，防止它继续幻觉」。
  //
  // 【为什么删掉】
  //   1. **它们什么都不做**。前三个的实现只有一行 `return { ok: true, content: desc }`，
  //      返回的还是那句「本系统没有 Tavily」—— 而这句话本该由提示词承担。
  //   2. **注册它们反而在诱导模型调用**。它们出现在 function list 里，
  //      等于告诉模型「这里有个叫 tavily_search 的工具」—— 与防幻觉的初衷相反。
  //   3. **占用每轮固定开销**：4 个 schema ≈ 340 tokens，每次调用模型都要重发一遍。
  //   4. **兜底早已更强**：`executeToolWithRetry()` 对任何未注册的工具名都会返回
  //      「工具不存在 + 可用搜索工具清单」，覆盖面是**任意幻觉名字**，
  //      远好于这里硬编码的 3 个；提示词（prompts/agent.ts）也早就写明了
  //      「本系统只有 web_search 和 browser 两种搜索工具，不存在 tavily_search…」。
  //   5. **实测从未触发**：本机 601 次真实工具调用里，这 4 个的调用次数都是 0。
  //
  // 【能力没有丢】搜索类幻觉名改由 registry 的**别名重定向**统一接管
  //   （见 registry.ts 的 TOOL_ALIASES）：bing_search / tavily_search /
  //   serpapi_search / google_search … 会自动改走真正的 web_search 并返回真实结果，
  //   而抓取类（tavily_extract / scrape_url …）改走 web_fetch。
  //   这比原来的实现**覆盖更广、且不占任何 token**。

  const registeredNames = [...getToolNames()]
  console.log(
    `[Tools] 已注册 ${registeredNames.length} 个工具 | 模式分档: ` +
    `chat=${resolveToolset('chat').length} ` +
    `agent=${resolveToolset('agent').length} ` +
    `developer=${resolveToolset('developer').length} ` +
    `full=${registeredNames.length}`,
  )
  // 注册了但任何**真实能力档**都到不了的工具 —— 属于「写了但用户用不上」。
  //
  // 🔧 v3.34-fix2: 原实现遍历 Object.keys(TOOLSETS)，而 TOOLSETS 里含 `full`，
  // `resolveToolset('full')` 直接返回全部已注册工具 —— 于是 `orphans` **数学上恒等于
  // []**，这条守卫永远不可能响。它是 v3.34 专门加来「防止工具再次静默沉底」的，
  // 结果因为一个全集把自己短路了，还被当作「当前 0 个」写进了 README。
  //
  // 教训（写在这里防止重犯）：**加了告警 ≠ 有了防护**。守卫必须先自证它能失败。
  const reachable = new Set<string>()
  for (const setName of Object.keys(TOOLSETS)) {
    if (setName === 'full') {continue}   // 全集不能用于判定「可达」
    for (const t of resolveToolset(setName)) {reachable.add(t)}
  }
  const orphans = registeredNames.filter(n => !reachable.has(n))
  if (orphans.length > 0) {
    console.warn(
      `[Tools] ⚠️ ${orphans.length} 个已注册工具不在任何能力档中（模型无法调用）: ` +
      `${orphans.join(', ')}\n` +
      `        修法二选一：给该工具的 ToolDef 加上正确的 toolsets 声明，` +
      `或把它列进对应的静态 TOOLSETS。`,
    )
  } else {
    console.log('[Tools] ✅ 无孤儿工具：每个已注册工具都能被至少一个能力档看到')
  }

  // 🔧 P0-fix: 工具注册表校验
  try {
    const result = validateToolRegistry()
    if (!result.ok) {
      if (result.missingDefs.length > 0) {
        console.warn(`[Tools] ⚠️ ${result.missingDefs.length} 个工具缺少定义: [${result.missingDefs.join(', ')}]`)
      }
      if (result.missingImpls.length > 0) {
        console.warn(`[Tools] ⚠️ ${result.missingImpls.length} 个工具缺少实现: [${result.missingImpls.join(', ')}]`)
      }
    } else {
      console.log(`[Tools] ✅ 全部 ${getToolNames().size} 个工具注册校验通过`)
    }
  } catch (err: any) {
    console.warn(`[Tools] 注册表校验失败: ${err.message}`)
  }
}

export * from './types'
export * from './registry'
