// ============================================================
// ipc/agentIpc.ts — Agent + Skill + MCP + Orchestrator + Task IPC
// v2.5 重构: 从 main.ts (1065行) 提取
// ============================================================

import { ipcMain, BrowserWindow, dialog } from 'electron'
import { AgentRunner } from '../agentRunner'
import { taskManager } from '../asyncTaskManager'
import {
  installSkillFromZip, listInstalledSkills, uninstallSkill,
  readSkillDoc, runSkillTool, listSkillTools,
} from '../skillInstaller'
import { mcpManager } from '../tools/impl/mcp'
// v6.0: MultiAgentOrchestrator 已删除，使用独立 Agent 配置 + 委托管理器
import { getAgentConfig, type AgentId } from '../agentConfig'
import { getDelegationManager } from '../delegationManager'
import { getMails, markRead, markAllRead, deleteMail, getUnreadCount, getTotalCount, onMailChange, getArchivedMails, restoreMail, purgeArchivedMail } from '../mailStore'
import { initTeamSocialEngine } from './teamIpc'
import { fetchWithRetry } from '../llmRetry'
import type { AgentRunConfig, AgentEvent } from '../tools/types'
import { getCommandRouter, CommandRouter } from '../chatCommands'
import { setActiveAgentRef, registerCommandHandlers } from './commandIpc'
import { notifyAgentReply } from '../agentNotify'
import { llmCoordinator } from '../llmCoordinator'
// 静态导入 gamification 模块（打包后动态 require 路径解析不到）
import { xpManager, XP_RULES } from '../gamification/levels'
import { achievementManager } from '../gamification/achievements'
import * as emotionBridge from '../gamification/emotionBridge'
import { probeEndpoint, buildUnreachableGuidance } from '../onboarding/llmReachability'
import { isLocalEndpoint } from '../core/modelCompat'

// ═══════════════════════════════════════════════════════════
// LLM API 响应类型
// ═══════════════════════════════════════════════════════════

interface ModelItem { id: string }
interface ModelsResponse { data?: ModelItem[]; models?: ModelItem[] }
interface ChatChoice { message?: { content?: string } }
interface ChatCompletionResponse { choices?: ChatChoice[] }

let activeAgent: AgentRunner | null = null
let activeAgentRunning = false  // 🆕 v5.4: 追踪当前 agent 是否仍在执行
let lastConfigSig: string = ''  // 🔧 v2.10.x: 检测配置变化，防止串台
let teamSocialInitialized = false  // 🆕 v2.6
let agentIpcHandlersRegistered = false  // 🔧 v6.4: 防止 IPC handler 重复注册

/**
 * 🔧 2026-08-11: 多模态 text 归一化
 * 前端群聊在带图片附件时会把 text 传成 OpenAI content 数组（v10.9 视觉支持），
 * 但 AgentRunner.sendMessage 内部大量使用 text.trim()/text.slice()，只接受 string。
 * 数组直接传入会在命令检测或预处理时抛 "input.trimStart is not a function"。
 * 这里提取纯文本，图片转为描述占位，保证 LLM 至少"知道"用户发了图，
 * 且不会让整个 agent:chat 调用崩溃。
 */
function normalizeAgentText(text: unknown): string {
  if (typeof text === 'string') {return text}
  if (Array.isArray(text)) {
    const parts: string[] = []
    let imgCount = 0
    for (const block of text) {
      if (block && typeof block === 'object') {
        const b = block as { type?: string; text?: unknown }
        if (b.type === 'text' && typeof b.text === 'string') {
          parts.push(b.text)
        } else if (b.type === 'image_url') {
          imgCount++
        }
      }
    }
    if (imgCount > 0) {parts.push(`[用户上传了 ${imgCount} 张图片附件，当前会话暂不支持直接查看图片]`)}
    const merged = parts.join('\n').trim()
    return merged || '[用户发送了附件消息]'
  }
  if (text == null) {return ''}
  return String(text)
}

/**
 * 注册 Agent 相关 IPC handler（只注册一次）
 */
function registerAgentIpcHandlers(): void {
  if (agentIpcHandlersRegistered) {return}
  agentIpcHandlersRegistered = true

  // ─── v6.1: .env 供应商检测桥接 ────────────────────
  ipcMain.handle('agent:get-available-providers', async () => {
    const agentConfig = getAgentConfig()
    return { providers: agentConfig.getAvailableProviders() }
  })

  ipcMain.handle('agent:use-global-config', async (_event, params: {
    providerId: string; endpoint: string; model: string; apiKey: string
  }) => {
    try {
      const agentConfig = getAgentConfig()
      agentConfig.useGlobalConfig()
      agentConfig._save()
      return { success: true, message: `已同步到全部 3 个 Team Agent` }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  })

  ipcMain.handle('agent:force-auto-detect', async () => {
    try {
      const agentConfig = getAgentConfig()
      agentConfig.useGlobalConfig()
      const status = agentConfig.getAllStatus()
      const anyEnabled = Object.values(status).some((s: any) => s.enabled)
      if (!anyEnabled) {
        return { success: false, error: '.env 中未检测到任何已配置的 LLM 供应商' }
      }
      return { success: true, status }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  })
}

export function registerAgentIpc(mainWindow: BrowserWindow): void {
  // ─── v02: 后台任务事件 → 任务工作区（修复问题 E：之前无人转发，前端永远空白） ──
  taskManager.on('task:created', (task: any) => {
    try { mainWindow.webContents.send('task:created', task) } catch { /* 窗口已关 */ }
  })
  taskManager.on('task:progress', (ev: any) => {
    try { mainWindow.webContents.send('task:progress', ev) } catch { /* 窗口已关 */ }
  })
  taskManager.on('task:done', (task: any) => {
    try { mainWindow.webContents.send('task:done', task) } catch { /* 窗口已关 */ }
  })
  taskManager.on('task:error', (task: any) => {
    try { mainWindow.webContents.send('task:error', task) } catch { /* 窗口已关 */ }
  })
  // Worker 实时事件（tool_start/tool_end/thinking/error）→ 工具时间线
  taskManager.on('task:runner-event', (payload: any) => {
    try { mainWindow.webContents.send('task:runner-event', payload) } catch { /* 窗口已关 */ }
  })

  // ─── Agent ──────────────────────────────────────────

  ipcMain.handle('agent:chat', async (event, params: {
    text: string; config: AgentRunConfig; sessionId?: string; compactedContext?: string
    conversationHistory?: Array<{ role: string; content: string }>
  }) => {
    // 标记用户活跃，暂停后台 LLM 调用
    llmCoordinator.markUserActive()
    try {
      // 斜杠命令拦截 — 先检查是否为命令，路由到 CommandRouter
      // 🔧 2026-08-11: 防御 — 前端多模态附件会把 text 传成 OpenAI content 数组，
      //   直接调用 trimStart() 会抛 "input.trimStart is not a function"。
      //   只有纯字符串输入才做命令检测；数组输入归一化为纯文本。
      const rawText = params.text
      const safeText = normalizeAgentText(rawText)
      if (typeof rawText === 'string' && CommandRouter.isCommand(safeText)) {
        const router = getCommandRouter()
        const parsed = router.parse(safeText)

        if (!parsed) {
          return { success: false, message: `未知命令: ${safeText}\n输入 /help 查看可用命令` }
        }

        setActiveAgentRef(() => activeAgent)
        const result = await router.execute(parsed)
        event.sender.send('agent:command-result', result)
        return { success: result.success, message: result.message }
      }
      // fix: 只在 agent 真正活跃时才中止，避免链式协作中误伤已完成 agent
      //   问题：v2.11 无条件 abort → 链式 Phase 切换时误中止已完成 agent → "(已取消)"
      //   修复：加 isRunning 守卫 + 记录活跃状态
      if (activeAgent && activeAgentRunning) {
        console.log('[AgentIPC] ⏹ 中止正在运行的 Agent（新请求到达）')
        try { activeAgent.abort() } catch {}
      }
      activeAgentRunning = true  // 🆕 标记新 agent 开始运行

      // v6.0.5: 区分群聊模式 vs 普通模式
      const isGroupChat = !!params.config.isGroupChat
      let runConfig: AgentRunConfig
      // agentConfig 提升到 if 块外，后续 social engine 初始化需要引用
      const agentConfig = getAgentConfig()

      if (isGroupChat) {
        // ── Lumina Team：使用 Lumina 独立 LLM 配置 ──
        if (!agentConfig.isConfigured('lumina')) {
          const guideMsg = `嗨！我是 Lumina ✨

我注意到你还没有给我配置 LLM 大脑呢～没有它我就像没睡醒一样，说不出话来 😴

**🔧 三步让我活过来：**

1️⃣ 打开 **设置** 面板（右上角齿轮图标）
2️⃣ 找到 **「Lumina Team 供应商配置」** 卡片
3️⃣ 在我的（Lumina 💫）那一栏填上：
   • **Endpoint** — 比如 \`http://localhost:1234/v1\`（LM Studio）
   • **Model** — 比如 \`qwen2.5-32b-instruct\`
   • 点击 **💾 保存**

> 💡 如果你在用 LM Studio，Endpoint 在 LM Studio 的 Developer 标签里能看到。
> 💡 三个 Agent（我、Yak🔧、热茶🔍）各自独立配置，互不影响。
> 💡 只配我一个人就能开始聊天啦！Yak 和热茶是后台助手，不配也可以～`

          return {
            success: false,
            content: guideMsg,
            error: 'LUMINA_NOT_CONFIGURED',
          }
        }

        // 多模型多角色 — 根据 personaId 动态选取 Agent 的独立 LLM 配置
        //   前端通过 params.config.personaId 指定当前发言的 Agent
        //   若未指定则默认取 'lumina'（向后兼容）
        const personaId: AgentId = (params.config.personaId || 'lumina') as AgentId

        // 检查该 Agent 是否已配置 LLM；若未配置则尝试降级到 Lumina
        if (!agentConfig.isConfigured(personaId)) {
          // 尝试降级到 Lumina
          if (personaId !== 'lumina' && agentConfig.isConfigured('lumina')) {
            console.log(`[AgentIPC] ⚠️ "${personaId}" 未配置 LLM，降级使用 Lumina 的配置`)
            // 真·降级 — 之前只打了日志，下面 get(personaId) 还是空配置
            //   直接覆写该 agent 的 config 对象（修改引用，不落盘）
            const luminaCfg = agentConfig.get('lumina')
            const agentCfg = agentConfig.get(personaId)
            agentCfg.endpoint = luminaCfg.endpoint
            agentCfg.model = luminaCfg.model
            agentCfg.apiKey = luminaCfg.apiKey
            agentCfg.provider = luminaCfg.provider
            agentCfg.enabled = true
          } else {
            // 真·没配任何 LLM → 引导配置
            const nameMap: Record<string, string> = { lumina: '我（Lumina）', yak: 'Yak🔧', recha: '热茶🔍' }
            const guideMsg = `嗨！${nameMap[personaId] || personaId} 还没有配置 LLM 呢 🫣

**🔧 配置一下就好：**

1️⃣ 打开 **设置** 面板（右上角齿轮图标）
2️⃣ 找到 **「Lumina Team 供应商配置」** 卡片
3️⃣ 在 **${nameMap[personaId] || personaId}** 那一栏填上：
   • **Endpoint** — 比如 \`http://localhost:1234/v1\`
   • **Model** — 比如 \`qwen2.5-32b-instruct\`
   • 点击 **💾 保存**

> 💡 三个 Agent 各自独立配置，互不影响。
> 💡 只配 Lumina 一个人也能聊天，Yak 和热茶是后台助手～`

            return {
              success: false,
              content: guideMsg,
              error: `${personaId.toUpperCase()}_NOT_CONFIGURED`,
            }
          }
        }

        const agentLLM = agentConfig.get(personaId)
        runConfig = {
          ...params.config,
          mode: 'agent',
          personaId,
          socialMode: true,   // 🆕 v11.0-fix: 群聊模式标记 — 让 AgentRunner 注入群聊覆盖指令
          baseUrl: agentLLM.endpoint,
          model: agentLLM.model,
          apiKey: agentLLM.apiKey || '',
        }
      } else {
        // ── 普通模式：使用全局 LLM 配置（前端传入） ──
        if (!params.config.model || !params.config.baseUrl) {
          return {
            success: false,
            content: `唔…我还没连上 LLM 呢 🥺

看起来你还没有配置「LLM 供应商」哦～没有它我连最基础的聊天都做不到 😴

**⚡ 快速配置：**

1️⃣ 打开 **设置**（右上角齿轮）
2️⃣ 在 **「LLM 供应商」** 卡片里选一个供应商
   • 如果用 LM Studio → 选 LM Studio，自动填好
   • 如果用 OpenAI / DeepSeek → 填 API Key
3️⃣ 点击 **「测试连接」** 看看通不通

> 💡 这是给左侧普通模式用的配置（聊天/AI智能体/快速/修复）。
> 💡 群聊 Lumina Team 需要另外在「Lumina Team 供应商配置」里配。`,
            error: 'GLOBAL_LLM_NOT_CONFIGURED',
          }
        }
        runConfig = {
          ...params.config,
          // 前端显式指定 mode 时尊重之（桌宠陪伴会话传 'chat' 轻量工具集）；其余调用方默认 'agent'
          mode: params.config.mode || 'agent',
        }
      }

      // 🛰️ 运行时可达性预检：仅对本地端点（LM Studio/Ollama/局域网）探测，
      //   防止"本地模型没启动 → 静默空回复"。云端端点不加此预检以避免每条消息的延迟。
      if (runConfig.baseUrl && isLocalEndpoint(runConfig.baseUrl)) {
        const probe = await probeEndpoint(runConfig.baseUrl, runConfig.apiKey || undefined, 2000)
        if (!probe.reachable) {
          const kind = probe.errorKind || 'unknown'
          console.warn(`[agent:chat] LLM 端点不可达（${kind}）: ${runConfig.baseUrl} — ${probe.message || ''}`)
          activeAgentRunning = false
          return {
            success: false,
            content: buildUnreachableGuidance(runConfig.baseUrl, kind),
            error: 'LLM_ENDPOINT_UNREACHABLE',
            errorKind: kind,
          }
        }
      }

      // 🔍 诊断日志 — 记录实际使用的 LLM 配置（runConfig，反映后端覆盖后的值）
      console.log('[agent:chat]', JSON.stringify({
        isGroupChat,
        mode: runConfig.mode || 'agent',
        model: runConfig.model,
        baseUrl: runConfig.baseUrl,
        hasApiKey: !!runConfig.apiKey,
        personaId: runConfig.personaId,
        text: params.text?.slice(0, 40),
      }))

      activeAgent = new AgentRunner(runConfig, { sessionId: params.sessionId })
      lastConfigSig = JSON.stringify({
        model: runConfig.model,
        baseUrl: runConfig.baseUrl,
      })

      const agent = activeAgent
      // 同步传入的对话历史
      if (params.conversationHistory) {
        agent.setHistory(params.conversationHistory, params.compactedContext)
      }
      agent.setEventCallback((ev: AgentEvent) => {
        event.sender.send('agent:event', ev)
      })
      let result: string
      try {
        result = await agent.sendMessage(safeText)
      } finally {
        activeAgentRunning = false  // 🆕 v5.4: 确保无论成功或失败都重置状态
      }

      // 🔔 Agent 回复完成 → 后台 Windows 通知（前台不打扰，多条自动合并）
      notifyAgentReply(mainWindow, {
        personaId: isGroupChat ? (params.config.personaId as string) : undefined,
        isGroupChat,
        body: result,
      })

      // v6.0: 群聊模式下首次成功对话后，三 Agent 全配 LLM → 初始化社交引擎
      if (isGroupChat && !teamSocialInitialized) {
        const allConfigured = (['lumina', 'yak', 'recha'] as AgentId[])
          .every(id => agentConfig.isConfigured(id))
        if (allConfigured) {
          teamSocialInitialized = true
          try {
            initTeamSocialEngineWithConfig(agentConfig)
            console.log('[AgentIPC] 🎉 团队社交引擎已初始化（三 Agent 均独立配置 LLM）')
          } catch (err) {
            console.error('[AgentIPC] 社交引擎初始化失败:', err)
            teamSocialInitialized = false
          }
        }
      }

      // 对话获得 XP
      try {
        const xpResult = xpManager.addXp(XP_RULES.PER_MESSAGE, '对话')
        const currentStats = achievementManager.getStats()
        achievementManager.updateStats({
          totalChats: currentStats.totalChats + 1,
          totalMessages: currentStats.totalMessages + 1,
        })
        achievementManager.checkAchievements()
        console.log(`[Gamification] +${xpResult.baseXp} XP (${xpResult.multiplier}x) → total ${xpManager.totalXp} XP (Lv.${xpManager.level})`)
      } catch (e) {
        console.error('[Gamification] XP 累积失败:', e)
      }

      return { success: true, content: result, totalTokens: agent.getTotalTokens(), compactedContext: agent.getCompactedSummary(), contextWindow: (agent as any).config?.contextWindow || 0 }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('agent:abort', async () => { activeAgent?.abort(); return { success: true } })
  ipcMain.handle('agent:clear', async () => { activeAgent?.clearHistory(); return { success: true } })

  ipcMain.handle('agent:setMode', async (_event, mode: string) => {
    if (activeAgent) {activeAgent.setMode(mode as 'chat' | 'agent' | 'developer')}
    return { success: true }
  })

  // 从渲染进程设置情绪状态 → 注入 system prompt
  ipcMain.handle('agent:setEmotion', async (_event, emotion: {
    mood: number; energy: number; affinity: number; label?: string
  }) => {
    if (activeAgent && typeof emotion?.mood === 'number') {
      activeAgent.setEmotion(emotion)
    }
    return { success: true }
  })

  // 🆕 Phase 2: 读取当前情绪乘数（前端情绪加成展示用）
  ipcMain.handle('gamification:getEmotionXp', async () => {
    try {
      const { getEmotionXpMultiplier, getEmotionLabel, getCurrentEmotion } = emotionBridge
      return {
        success: true,
        multiplier: getEmotionXpMultiplier(),
        label: getEmotionLabel(),
        emotion: getCurrentEmotion(),
      }
    } catch (e: any) {
      return { success: false, multiplier: 1.0, label: '平静 😐', emotion: { mood: 0, energy: 0.5, affinity: 0.5 } }
    }
  })

  // LLM 配置变更时热重载 AgentPool
  ipcMain.handle('agent:reloadPool', async (_event, params: { config: AgentRunConfig }) => {
    try {
      // AgentPool 已重构 — 使用 AgentConfig 的热更新替代
      console.log('[AgentIPC] 🔄 AgentPool 热重载已触发（使用新的 agentConfig 热更新机制）')
      return { success: true }
    } catch (err: any) {
      console.error('[AgentIPC] AgentPool 热重载失败:', err)
      return { success: false, error: err.message }
    }
  })

  // ── 🔬 LLM 健康检测 (v2.10.2) ─────────────────────

  ipcMain.handle('agent:health', async (_event, params: { baseUrl: string; apiKey: string; model: string }) => {
    try {
      const startMs = Date.now()

      // 1. 尝试 /models 端点（LM Studio / Ollama 兼容）
      let modelsAvailable = false
      let modelLoaded = false
      let modelsList: string[] = []

      try {
        const modelsResp = await fetch(`${params.baseUrl}/models`, {
          headers: { 'Authorization': `Bearer ${params.apiKey}` },
          signal: AbortSignal.timeout(5000),
        })
        if (modelsResp.ok) {
          const data = await modelsResp.json() as ModelsResponse
          const items = data.data || data.models || []
          modelsList = items.map((m: ModelItem) => typeof m === 'string' ? m : m.id)
          modelsAvailable = modelsList.length > 0
          modelLoaded = modelsList.some(m => m === params.model)
        }
      } catch {
        // /models 端点不可用（云 API 通常没有此端点），继续
      }

      // 2. 尝试 chat/completions（轻量 ping）
      let chatOk = false
      let chatLatencyMs = 0
      let chatError = ''

      try {
        const pingStart = Date.now()
        const chatResp = await fetch(`${params.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${params.apiKey}`,
          },
          body: JSON.stringify({
            model: modelsAvailable && !modelLoaded ? modelsList[0] : params.model,
            messages: [{ role: 'user', content: 'ping' }],
            max_tokens: 1,
            temperature: 0,
          }),
          signal: AbortSignal.timeout(5000),
        })
        chatLatencyMs = Date.now() - pingStart

        if (chatResp.ok) {
          chatOk = true
        } else {
          const errText = await chatResp.text().catch(() => '')
          chatError = `${chatResp.status}: ${errText.slice(0, 100)}`

          // 特殊提示
          if (errText.includes('No models loaded')) {
            chatError = 'LM Studio 未加载模型，请在 LM Studio 中加载模型后重试'
          }
        }
      } catch (err: unknown) {
        chatError = err instanceof Error ? err.message : String(err)
        if (chatError.includes('fetch failed') || chatError.includes('ECONNREFUSED')) {
          chatError = '无法连接到 LLM 服务，请检查服务是否已启动'
        }
      }

      const totalMs = Date.now() - startMs

      return {
        ok: chatOk,
        latencyMs: chatLatencyMs,
        totalMs,
        modelsAvailable,
        modelLoaded,
        modelsCount: modelsList.length,
        error: chatError || null,
        verdict: chatOk ? 'healthy' : 'unhealthy',
        hint: chatOk ? undefined
          : chatError.includes('未加载模型') ? 'load_model'
          : chatError.includes('无法连接') ? 'service_down'
          : chatError.includes('401') ? 'auth_error'
          : chatError.includes('404') ? 'endpoint_error'
          : 'unknown',
      }
    } catch (err: unknown) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        verdict: 'unhealthy',
        hint: 'unknown',
      }
    }
  })

  ipcMain.handle('agent:updateAvatarState', async (_event, state: {
    currentExpression?: string; expressionMix?: Array<{ expression: string; weight: number }>
    params?: Record<string, number>
  }) => {
    try {
      // Update avatar expression via renderer
      mainWindow.webContents.send('agent:avatarState', state)
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // ─── Task ──────────────────────────────────────────

  ipcMain.handle('task:submit', async (event, params: {
    title: string; prompt: string; config: AgentRunConfig
  }) => {
    try {
      const taskId = taskManager.submit(params.prompt, params.config, { title: params.title })
      return { taskId }
    } catch (err: any) {
      return { error: err.message }
    }
  })

  ipcMain.handle('task:list', async () => taskManager.list())
  ipcMain.handle('task:cancel', async (_event, taskId: string) => ({ ok: taskManager.cancel(taskId) }))

  // ─── Skill ─────────────────────────────────────────

  ipcMain.handle('skill:install', async (_event, zipPath: string) => installSkillFromZip(zipPath))
  ipcMain.handle('skill:list', async () => ({ skills: listInstalledSkills() }))
  ipcMain.handle('skill:uninstall', async (_event, skillId: string) => uninstallSkill(skillId))
  ipcMain.handle('skill:read', async (_event, skillId: string) => ({ doc: readSkillDoc(skillId) }))

  ipcMain.handle('skill:run', async (_event, params: { skill_id: string; tool_name: string; args?: string }) =>
    runSkillTool(params.skill_id, params.tool_name, params.args || ''))

  ipcMain.handle('skill:listTools', async (_event, skillId: string) => ({ tools: listSkillTools(skillId) }))

  ipcMain.handle('skill:openDialog', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择 Skill 压缩包',
      filters: [{ name: 'Skill 压缩包', extensions: ['zip'] }, { name: '所有文件', extensions: ['*'] }],
      properties: ['openFile'],
    })
    if (result.canceled || result.filePaths.length === 0) {return { cancelled: true }}
    const zipPath = result.filePaths[0]
    return { cancelled: false, zipPath, ...(await installSkillFromZip(zipPath)) }
  })

  // ─── MCP ───────────────────────────────────────────

  ipcMain.handle('mcp:register-server', async (_event, config: {
    name: string; command: string; args: string[]; env?: Record<string, string>; cwd?: string
  }) => {
    try {
      await mcpManager.registerServer(config)
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: err.message }
    }
  })

  ipcMain.handle('mcp:call-tool', async (_event, params: {
    serverName: string; toolName: string; args: Record<string, any>
  }) => {
    try {
      const result = await mcpManager.callTool(params.serverName, params.toolName, params.args)
      return { ok: true, result }
    } catch (err: any) {
      return { ok: false, error: err.message }
    }
  })

  // MultiAgentOrchestrator 已删除，返回空角色列表
  ipcMain.handle('orchestrator:roles', async () => ({ roles: [] }))

  // ─── v6.0: Agent 独立 LLM 配置管理 ───────────────

  ipcMain.handle('agent:configure-llm', async (_event, params: {
    agentId: AgentId
    provider: string
    model: string
    endpoint: string
    apiKey?: string
    maxContextTokens?: number
    timeout?: number
  }) => {
    try {
      const config = getAgentConfig()
      const result = config.set(params.agentId, params)
      // 🐛 修复: per-agent 保存后必须持久化到磁盘
      config._save()
      console.log(`[AgentIPC] 🔧 ${params.agentId} LLM 已配置并持久化: ${params.model} @ ${params.endpoint}`)
      return { success: true, config: result }
    } catch (err: any) {
      console.error(`[AgentIPC] ❌ ${params.agentId} LLM 配置保存失败:`, err)
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('agent:get-llm-configs', async () => {
    const config = getAgentConfig()
    const lumina = config.get('lumina')
    const yak = config.get('yak')
    const recha = config.get('recha')
    return {
      success: true,
      agents: config.getAllStatus(),
      lumina,
      yak,
      recha,
      configs: { lumina, yak, recha },
    }
  })

  // Lumina 委托任务给后台 Agent
  ipcMain.handle('agent:delegate', async (_event, params: {
    to: 'yak' | 'recha'
    task: string
    taskType: string
    context?: string
  }) => {
    try {
      if (!activeAgent) {
        return { success: false, error: 'Active agent not found' }
      }
      const result = await activeAgent.delegate(
        params.to,
        params.task,
        params.taskType as any,
        params.context,
      )
      return result
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // ─── 📬 Agent 邮件 (v2.6) ──────────────────────────

  ipcMain.handle('mail:list', async (_event, filter?: string) => {
    return { mails: getMails(filter as 'unread' | 'all' | undefined), unread: getUnreadCount(), total: getTotalCount() }
  })

  ipcMain.handle('mail:mark-read', async (_event, mailId: string) => {
    if (mailId === 'all') {
      return { ok: true, count: markAllRead() }
    }
    return { ok: markRead(mailId) }
  })

  ipcMain.handle('mail:delete', async (_event, mailId: string) => {
    return { ok: deleteMail(mailId) }
  })

  // v2.8: 归档邮件 — 删除的邮件先进归档，可恢复
  ipcMain.handle('mail:archived-list', async () => {
    return { mails: getArchivedMails() }
  })

  ipcMain.handle('mail:restore', async (_event, mailId: string) => {
    return { ok: restoreMail(mailId) }
  })

  ipcMain.handle('mail:purge-archived', async (_event, mailId: string) => {
    return { ok: purgeArchivedMail(mailId) }
  })

  ipcMain.handle('mail:unread-count', async () => {
    return { count: getUnreadCount() }
  })

  // 邮件变更时推送给渲染进程
  onMailChange(() => {
    try {
      mainWindow.webContents.send('mail:changed', { unread: getUnreadCount(), total: getTotalCount() })
    } catch {}
  })
}

// ═══════════════════════════════════════════════════════════
// v6.0: 社交引擎初始化辅助函数
// ═══════════════════════════════════════════════════════════

/**
 * 用 AgentConfig 中各 Agent 的独立 LLM 初始化社交引擎。
 * 每个 Agent 使用自己配置的 endpoint/model/apiKey 进行 LLM 调用。
 */
function initTeamSocialEngineWithConfig(agentConfig: ReturnType<typeof getAgentConfig>): void {
  const llmCall = async (personaId: string, prompt: string, _context?: any) => {
    const config = agentConfig.get(personaId as AgentId)
    if (!config.enabled || !config.endpoint) {
      return `[${personaId} 未配置 LLM]`
    }

    const messages = [
      {
        role: 'system' as const,
        content: `你是 Lumina 团队的 Agent "${personaId}"。请用自然、清晰的语言回复（3-8句话）。`,
      },
      { role: 'user' as const, content: prompt },
    ]

    const resp = await fetchWithRetry(
      `${config.endpoint}/chat/completions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.apiKey || ''}`,
        },
        body: JSON.stringify({
          model: config.model,
          messages,
          temperature: 0.7,
          max_tokens: 1024,
        }),
      },
      {
        circuitId: 'social-engine',
        timeoutMs: 60000,
        onRetry: (attempt: number, err: unknown, delay: number) => {
          console.warn(`[AgentIPC] 社交引擎 LLM 重试 ${attempt}/3: ${err} (${delay}ms 后重试)`)
        },
      },
    )

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '')
      throw new Error(`SocialEngine LLM error: ${resp.status} - ${errText.slice(0, 200)}`)
    }

    const data = await resp.json()
    return data.choices?.[0]?.message?.content || ''
  }

  // IPC handler 移到外面，只注册一次，防止重复注册报错
  registerAgentIpcHandlers()

  initTeamSocialEngine(llmCall)
}
