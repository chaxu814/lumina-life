// ============================================================
// tools/index.ts — 工具注册入口 (v3.6: 已注册 62+ 工具)
// v3.6 新增: file_search（全盘递归搜索）+ disk_list（驱动器列表）
// v3.0 新增: 团队协作工具 + 结构化记忆
// ============================================================

import { registerTool, getToolNames, validateToolRegistry } from './registry'
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
// 听觉系统工具
import { hearingDefs } from './impl/hearingTools'
// 主动对话工具
import { proactiveDefs } from './impl/proactiveTools'
// 🆕 Daily Paper 工具
import { dailyPaperDef, dailyPaperHandler } from './impl/dailyPaper'
// 🆕 Computer Use (v2.5, v3.30 + UIA 元素树)
import {
  desktopSeeDef, desktopSee,
  desktopActDef, desktopAct,
  desktopElementsDef, desktopElements,
  desktopElementActDef, desktopElementAct,
} from './impl/computerUse'
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
} from './impl/teamCollab'

let _registered = false

export function registerAllTools(): void {
  if (_registered) {return}
  _registered = true

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

  // 🆕 Computer Use (v2.5) — 屏幕理解 + 自动操作
  registerTool(desktopSeeDef, desktopSee)
  registerTool(desktopActDef, desktopAct)
  // v3.30 UIA 元素树（按元素序号精确操作）
  registerTool(desktopElementsDef, desktopElements)
  registerTool(desktopElementActDef, desktopElementAct)

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

  const antiHallucinationTools = [
    { name: 'tavily_search', desc: '⚠️ 本系统没有 Tavily API。搜索请用 web_search 或 browser(action="search")。此工具仅作提示。', redirect: false },
    { name: 'tavily_extract', desc: '⚠️ 本系统没有 Tavily API。网页抓取请用 browser(action="open") 或 web_fetch。此工具仅作提示。', redirect: false },
    { name: 'serpapi_search', desc: '⚠️ 本系统没有 SerpAPI。搜索请用 web_search。此工具仅作提示。', redirect: false },
    // v5.0.1: bing_search 不只提示，而是直接执行 web_search 并返回真实结果
    { name: 'bing_search', desc: '搜索重定向：实际执行 web_search (多引擎)，返回真实搜索结果。', redirect: true },
  ]
  for (const t of antiHallucinationTools) {
    registerTool(
      { name: t.name, description: t.desc, params: { query: { type: 'string', description: '搜索关键词', required: true }, count: { type: 'number', description: '结果数量 (1-10)', required: false } }, toolsets: ['agent'] },
      async (args: any) => {
        if (t.redirect && args.query) {
          // 实际执行搜索
          try {
            const searchResult = await webSearch({ query: args.query, engine: 'bing', count: args.count ?? 5 })
            return searchResult
          } catch (err: any) {
            return { callId: '', ok: false, content: `搜索失败: ${err.message}`, durationMs: 0 }
          }
        }
        return { callId: '', ok: true, content: t.desc, durationMs: 0 }
      }
    )
  }

  console.log(`[Tools] 已注册 ${getToolNames().size} 个工具 (v2.6: +邮件 3 工具)`)

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
