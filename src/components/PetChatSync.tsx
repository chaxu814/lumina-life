// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
/**
 * PetChatSync — 桌宠聊天 ↔ Lumina Agent 主聊天双向同步
 *
 * - 固定一个 "🐾 Live2D 桌宠" 对话（ID: conv-pet-live2d）
 * - 桌宠发消息 → 注入该对话 → 触发 Agent（串行排队 + 失败退避重试）→ 回复同步回桌宠
 * - 用户在该对话（主窗）发消息 → 同步到桌宠
 * - Agent 在该对话回复 → 同步到桌宠
 *
 * 真正的"串行队列 / 失败重试 / 退避"逻辑抽到 src/lib/petChatOrchestrator.ts
 * （纯函数、可单测）；本组件只负责把 zustand store 与 IPC 适配进编排器。
 */
import { useEffect, useRef } from 'react'
import { useStore, getDisabledToolNames } from '../stores/appStore'
import {
  useTaskWorkspace,
  deriveConversationArtifacts,
  deriveRecentFiles,
  deriveUsedSkills,
  detectArtifactKind,
} from '../stores/taskWorkspaceStore'
import {
  PetChatOrchestrator,
  messagesToForward,
  deriveLocalIntent,
  type PetSceneContext,
} from '../lib/petChatOrchestrator'
import { planPetConvDelete } from '../lib/petConversationDelete'

const PET_CONV_ID = 'conv-pet-live2d'
const PET_CONV_NAME = '🐾 Live2D 桌宠'

/** 推理流合并发送的最小间隔 —— 每个 token 都过一次 IPC 会把主进程压满 */
const TRACE_THROTTLE_MS = 180

/** 工具参数摘要：只挑一个最能说明「在干什么」的短字符串 */
function summarizeToolArgs(args: any): string {
  if (!args || typeof args !== 'object') {return ''}
  const preferred = ['query', 'q', 'url', 'path', 'file_path', 'command', 'cmd', 'pattern', 'name', 'title', 'text']
  for (const k of preferred) {
    const v = (args as any)[k]
    if (typeof v === 'string' && v.trim()) {return v.trim().replace(/\s+/g, ' ').slice(0, 60)}
  }
  for (const v of Object.values(args)) {
    if (typeof v === 'string' && v.trim()) {return v.trim().replace(/\s+/g, ' ').slice(0, 60)}
  }
  return ''
}

/**
 * 把 Live2D 卡片带来的屏幕上下文编成 systemPrompt 附加段。
 *
 * 【解决什么】卡片选项是"接着当前场景说的话"：「让我帮你整理**这部剧**的资料吧」。
 *   旧实现点完只发选项文本，窗口标题被丢掉 → 模型不知道"这部剧"是哪部 →
 *   只能反问「你指的是哪部剧？」，用户感知就是「点了它什么都不会」。
 *
 * 【为什么走 systemPrompt 而不是拼进用户消息】
 *   `agentRunner.sendMessage` 的去重条件是「history 末条 user 与本次 text
 *   逐字相同」。拼前缀会让两者不相等 → 去重失效 → 模型看到用户的话说两遍。
 *   走 systemPrompt 会被追加成「## 自定义指令」，不参与那次比较。
 */
function buildScenePrompt(scene?: PetSceneContext | null): string | undefined {
  if (!scene) {return undefined}
  const title = (scene.title || '').trim()
  const proc = (scene.process || '').trim()
  const files = Array.isArray(scene.files) ? scene.files.filter((f) => f && f.path) : []
  if (!title && !proc && !files.length) {return undefined}
  const what = title || proc
  const who = title && proc ? `（${proc}）` : ''
  const lines: string[] = [
    // agentRunner 会把这段追加在「## 自定义指令」之下，所以这里用三级标题做子节，
    // 否则会出现两个并排的 ## 标题。
    '### 🖥️ 屏幕上下文',
  ]
  if (what) {
    lines.push(
      `用户点这句话时正在看：**${what}**${who}。`,
      '用户话里的「这个 / 这个页面 / 这部剧 / 这段代码 / 这份文档 / 这里」等指代，指的就是它。',
      '能直接动手就动手（搜索、读取、整理），不要反过来问用户"你指的是哪个"——',
      '信息已经在这里了。只有确实还缺关键信息（比如要具体集数）时才问一句。',
    )
  }
  if (files.length) {
    lines.push(
      '',
      '### 📎 本轮附件',
      '用户这条消息附带了下面的文件，路径真实可读：',
      ...files.map((f) => `- \`${f.path}\`（${f.name || '附件'}）`),
      '需要内容就直接读这些路径（读文件 / 读图工具都行），不要问用户"文件在哪"。',
    )
  }
  lines.push('⚠️ 不要把这段上下文本身说出来，也不要提到「上下文」「屏幕」这类词。')
  return lines.join('\n')
}

export default function PetChatSync() {
  const orchestratorRef = useRef<PetChatOrchestrator | null>(null)
  // 注入期标志：我们自己 addMessage 时置 true（zustand subscribe 同步触发，
  // 据此区分"桌宠侧注入"与"主窗 UI 新增"，避免把桌宠自己发的消息回声回推）
  const injectingRef = useRef(false)
  const lastMsgCount = useRef(0)

  useEffect(() => {
    const api = (window as any).luminaAPI
    if (!api?.onPetSyncMessage) {return}

    // ── 确保固定对话存在 ──
    const ensurePetConv = () => {
      const store = useStore.getState()
      let conv = store.conversations.find((c: any) => c.id === PET_CONV_ID)
      if (!conv) {
        const newConv = {
          id: PET_CONV_ID,
          name: PET_CONV_NAME,
          messages: [],
          createdAt: Date.now(),
          pinned: true,
        }
        useStore.setState((s: any) => ({
          conversations: [newConv, ...s.conversations],
        }))
        conv = newConv
      }
      return conv
    }

    ensurePetConv()

    // ── 把一条消息写进固定对话；置注入标志，避免同步订阅把它当"主窗新消息"回推 ──
    const addMessageTracked = (role: 'user' | 'assistant', content: string): string => {
      injectingRef.current = true
      try {
        useStore.getState().addMessage(PET_CONV_ID, role, content)
      } finally {
        injectingRef.current = false
      }
      const conv = useStore.getState().conversations.find((c: any) => c.id === PET_CONV_ID)
      return conv?.messages?.[conv.messages.length - 1]?.id || ''
    }

    // ── 组装编排器依赖 ──
    // 🆕 2026-10-17：给每次桌宠请求打上 requestId。
    //   ① 主进程会把它原样回显在每条 `agent:event` 上 —— 桌宠窗的推理过程
    //      靠它区分「本次请求的事件」与其它面板/后台任务的噪音。
    //   ② 顺带修掉一个既有串台：此前桌宠请求**不带** requestId，而
    //      ChatPanel / GroupChatView 的过滤条件是「有 requestId 才比对」，
    //      于是桌宠的 thinking / tool_* 会漏进主聊天面板的思考区。
    let petReqSeq = 0
    let activeReqId = ''
    /** 「更多 → 思考」的临时覆盖（null = 用默认开） */
    let thinkingOverride: boolean | null = null

    const orchestrator = new PetChatOrchestrator({
      getHistory: () => {
        const conv = useStore.getState().conversations.find((c: any) => c.id === PET_CONV_ID)
        return (conv?.messages || [])
          .filter((m: any) => m.role !== 'system')
          .map((m: any) => ({ role: m.role, content: m.content }))
      },
      addMessage: addMessageTracked,
      agentChat: async (text, history, scene) => {
        const state = useStore.getState()
        const llmConfig = state.llmConfig
        const conv = state.conversations.find((c: any) => c.id === PET_CONV_ID)
        const reqId = `pet-${Date.now()}-${++petReqSeq}`
        activeReqId = reqId
        const config = {
          // 🔧 2026-10-18：从 'chat' 改成 'agent'。
          //
          // 旧配置是「陪伴对话」的思路：mode:'chat'（工具只有 11 个，**没有写文件、
          // 没有执行命令**）+ noAutoSearch:true + maxToolCalls:4。结果就是用户点
          // 「让我帮你整理这部剧的资料吧」，模型只能说「告诉我剧名」—— 它手里
          // 没有能"真的去做"的工具，看起来就是「什么都不会」。
          //
          // 现在走 agent 档：完整工具链 + 按需路由（routeTools 会依据本轮原话把
          // 67 个工具裁到十来个，不会一股脑塞给模型）。桌宠仍然是陪伴语气，
          // 只是真的能把事做完。
          mode: 'agent' as const,
          model: llmConfig.model,
          baseUrl: llmConfig.baseUrl,
          apiKey: llmConfig.apiKey,
          temperature: llmConfig.temperature,
          maxTokens: llmConfig.maxTokens,
          // 🔧 2026-10-18：8 → 20，与主聊天面板（ChatPanel.tsx 的 maxToolCalls）对齐。
          //   用户问的是"这里会不会和本体一样的 agent 质量"，那工具预算就不该更少：
          //   「读文件 → 改 → 跑命令 → 验证」这种闭环，8 次经常在验证之前就被迫收尾。
          //   agentRunner 里有重复工具封禁门，调高是安全的。
          maxToolCalls: 20,
          // 桌宠里说「帮我查一下」就该真的查 —— 不再跳过自动搜索预处理
          noAutoSearch: false,
          // 用户在设置里关掉的工具，桌宠同样不能用（主面板会传 disabledTools，
          // 桌宠以前漏了 → 会出现"主面板禁用了联网，桌宠照样联网"的不一致）
          disabledTools: getDisabledToolNames(state.skillConfig),
          // 人格跟主面板走，不再硬编码 'lumina'
          personaId: state.activePersona || 'lumina',
          contextWindow: llmConfig.contextWindow || 0,
          requestId: reqId,            // ← 事件归属（见上方注释）
          // 🧠 与主聊天面板的默认一致（ChatPanel 的 thinkingMode 默认开启）：
          //   打开推理流，桌宠聊天窗才能显示模型真实的想法，而不是只看到工具调用。
          //   不支持 reasoning_content 的模型不会有任何额外输出，零副作用。
          trackReasoning: thinkingOverride !== false,
          // 🖥️ 屏幕上下文 —— 通过 systemPrompt 附加，**不能拼进 text**。
          //
          // 为什么不能拼进 text：`agentRunner.sendMessage` 的去重逻辑是
          // 「history 末条 user 与本次 text 逐字相同才去掉重复」。若把上下文
          // 前缀拼进 text，而 history 里存的是原文，两者不相等 → 去重失效 →
          // 模型会看到用户的话说了两遍。
          // 走 systemPrompt 则被追加成「## 自定义指令」，不参与去重比较。
          systemPrompt: buildScenePrompt(scene),
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result: any = await api.agentChat({
          text,
          config,
          sessionId: PET_CONV_ID,
          compactedContext: conv?.compactedContext,
          conversationHistory: history,
        })
        return result as { content?: string; error?: string; success?: boolean }
      },
      sendToPet: (text, role) => {
        try { api.petSyncReply?.(text, role) } catch { /* 桌宠窗未开 */ }
      },
      // 回复成功后，由文本本地派生动作/表情（走 pet:test-intent，不再打第二次 LLM）
      dispatchLocalIntent: (replyText) => {
        try { api.petTestIntent?.(deriveLocalIntent(replyText)) } catch { /* 桌宠窗未开 */ }
      },
    })
    orchestratorRef.current = orchestrator

    // ── 推理过程中转：agent:event（主窗）→ pet:chat-trace（桌宠聊天窗）──
    //   `agent:event` 只发给发起请求的窗口，也就是本窗口；桌宠窗收不到。
    //   这里按 requestId 过滤后转发，桌宠聊天窗就能显示 💭 思考 / 🔧 工具调用，
    //   而不是只有一个"三个点"。
    let thinkBuf = ''
    let lastTraceAt = 0
    let thinkTimer: ReturnType<typeof setTimeout> | null = null

    const pushTrace = (payload: Record<string, unknown>) => {
      try { api.petSyncTrace?.(payload as any) } catch { /* 桌宠窗未开 */ }
    }

    const flushThinking = (stream: boolean) => {
      // 先摘掉挂起的定时器：否则 isLast 已 flush 完，遗留的定时器还会再发一次，
      // 而那时流式行已被 tool_start/traceFinish 断开 → 同一段推理被画成两行。
      if (thinkTimer) { clearTimeout(thinkTimer); thinkTimer = null }
      if (!thinkBuf) {return}
      lastTraceAt = Date.now()
      pushTrace({ kind: 'thinking', text: thinkBuf.slice(-800), stream })
      // 定稿后清缓冲；节流快照不能清，否则每次都只剩尾巴一小段
      if (!stream) {thinkBuf = ''}
    }

    const unsubAgentEvents = api.onAgentEvent?.((ev: any) => {
      if (!activeReqId || ev?.requestId !== activeReqId) {return}
      switch (ev.type) {
        case 'thinking':
          if (ev.text) {
            // 非流式思考：清掉流式缓冲，避免两段文字粘在一起
            thinkBuf = ''
            pushTrace({ kind: 'thinking', text: String(ev.text) })
          }
          break
        case 'thinking_stream': {
          if (ev.isFirst) {thinkBuf = ''}
          else if (ev.text) {thinkBuf += String(ev.text)}
          if (ev.isLast) { flushThinking(false); break }
          const now = Date.now()
          if (now - lastTraceAt >= TRACE_THROTTLE_MS) { flushThinking(true) }
          else if (!thinkTimer) { thinkTimer = setTimeout(() => flushThinking(true), TRACE_THROTTLE_MS) }
          break
        }
        case 'tool_start':
          thinkBuf = ''
          pushTrace({ kind: 'tool_start', tool: String(ev.tool || '工具'), detail: summarizeToolArgs(ev.args) })
          break
        case 'tool_end':
          pushTrace({ kind: 'tool_end', tool: String(ev.tool || '工具'), ok: ev.result?.success !== false })
          break
        case 'error':
          if (ev.error) {pushTrace({ kind: 'error', text: String(ev.error).slice(0, 120) })}
          break
        default:
          break
      }
    })

    // 初始化 lastMsgCount，避免挂载瞬间把已有历史当成"新消息"回推给桌宠
    {
      const conv = useStore.getState().conversations.find((c: any) => c.id === PET_CONV_ID)
      lastMsgCount.current = conv?.messages?.length || 0
    }

    // ── 桌宠 → 主聊天（注入 + 串行跑 Agent，失败退避重试由编排器负责）──
    const unsubPetMsg = api.onPetSyncMessage((data: { text: string; from: string; scene?: PetSceneContext; attachments?: Array<{ name: string; path: string }>; thinking?: boolean }) => {
      if (!data?.text) {return}
      ensurePetConv()
      // 📎 附件合并进本轮上下文（见 PetSceneContext.files 的注释）
      const files = Array.isArray(data.attachments) ? data.attachments.filter((f) => f && f.path) : []
      const scene: PetSceneContext | null = files.length
        ? { ...(data.scene || {}), files }
        : (data.scene || null)
      // 🧠 「更多 → 思考」的开关随消息带过来（桌宠窗没有自己的 store）
      thinkingOverride = typeof data.thinking === 'boolean' ? data.thinking : null
      orchestrator.handlePetMessage(data.text, scene)
    })

    // ── 桌宠请求历史记录 → 返回固定对话的消息 ──
    const unsubHistoryReq = api.onPetHistoryRequest?.(() => {
      const store = useStore.getState()
      const conv = store.conversations.find((c: any) => c.id === PET_CONV_ID)
      if (conv?.messages?.length) {
        const history = conv.messages
          .filter((m: any) => m.role !== 'system')
          .slice(-50)
          .map((m: any) => ({ role: m.role, content: m.content }))
        try { api.petSendHistory?.(history) } catch {}
      } else {
        try { api.petSendHistory?.([]) } catch {}
      }
    })

    // ── 🗑 会话删除（桌宠窗的垃圾桶）────────────────────────────
    //
    // 会话住在**本窗口**的 store 里，桌宠窗够不到，所以由这里执行删除。
    // 三种口径：
    //   current → 只清空 conv-pet-live2d 的消息，保留会话本身（桌宠窗最常用）
    //   select  → 删掉用户勾选的那几个会话
    //   all     → 全删；store 的 deleteConversation 会兜底留一个空会话
    const unsubConvListReq = api.onPetConvListRequest?.(() => {
      const convs = (useStore.getState().conversations || []).map((c: any) => ({
        id: c.id,
        name: c.name || '未命名对话',
        count: (c.messages || []).length,
        isPet: c.id === PET_CONV_ID,
      }))
      try { api.petSendConvList?.(convs) } catch { /* 桌宠窗未开 */ }
    })

    const clearConvMessages = (convId: string) => {
      // 直接 setState 而不是新增 store action：这是桌宠窗专用的窄操作，
      // 主界面没有对应入口，加进 store 接口反而会让「谁能清空消息」变模糊。
      useStore.setState((s: any) => ({
        conversations: s.conversations.map((c: any) =>
          c.id === convId ? { ...c, messages: [] } : c,
        ),
      }))
    }

    const unsubConvDelete = api.onPetConvDelete?.((payload: { scope: 'current' | 'select' | 'all'; ids?: string[] }) => {
      const scope = payload?.scope || 'current'
      try {
        // 先确保桌宠会话存在 —— planPetConvDelete 的前提是"宿主已在列表里"，
        // 否则 'all' 会连壳一起删，store 自动补兜底会话 → 用户看到"还剩一条"。
        ensurePetConv()
        const plan = planPetConvDelete(
          useStore.getState().conversations || [],
          scope,
          payload?.ids,
          PET_CONV_ID,
        )
        // 逐个删而不是批量 setState：deleteConversation 内部要维护
        // activeConversationId，批量覆盖会绕过它。
        for (const id of plan.deleteIds) {
          useStore.getState().deleteConversation(id)
        }
        for (const id of plan.clearIds) {
          clearConvMessages(id)
        }
        ensurePetConv()
      } catch (e) {
        console.warn('[PetChatSync] 删除会话失败:', e)
      }
      // 重置计数，避免下一次订阅把"删除造成的长度变化"当成新消息推给桌宠
      const after = useStore.getState().conversations.find((c: any) => c.id === PET_CONV_ID)
      lastMsgCount.current = after?.messages?.length || 0
      try { api.petNotifyConvChanged?.() } catch { /* 桌宠窗未开 */ }
    })

    // ── 🪟 任务列表 / 动作中转（2026-10-18）──────────────────────
    //
    // 会话产物、技能、最近文件都住在**主窗口**的 taskWorkspaceStore 里；
    // 实时语音、AI 操作电脑、Lucky 预设这些能力也只有主窗口的 luminaAPI 有。
    // 桌宠窗统一发意图过来，这里执行完把结果回过去。
    const unsubTaskListReq = api.onPetUiTaskListRequest?.(() => {
      try {
        const tw = useTaskWorkspace.getState()
        const all = (tw.artifacts || []) as any[]
        const artifacts = deriveConversationArtifacts(all).map((a) => ({
          id: a.id,
          filename: a.filename,
          kind: a.kind || detectArtifactKind(a.filename, (a as any).content),
        }))
        const recentFiles = deriveRecentFiles(all).map((a) => ({
          id: a.id,
          filename: a.filename,
          filePath: (a as any).filePath,
        }))
        const skills = deriveUsedSkills((tw.toolCalls || []) as any[])
        api.petSendTaskList?.({ artifacts, skills, recentFiles })
      } catch (e) {
        console.warn('[PetChatSync] 任务列表生成失败:', e)
        try { api.petSendTaskList?.({ artifacts: [], skills: [], recentFiles: [] }) } catch { /* 忽略 */ }
      }
    })

    const unsubUiAction = api.onPetUiAction?.((payload: { kind: string; [k: string]: unknown }) => {
      const kind = String(payload?.kind || '')
      const reply = (ok: boolean, message?: string) => {
        try { api.petUiActionResult?.({ kind, ok, message }) } catch { /* 桌宠窗未开 */ }
      }
      void (async () => {
        try {
          switch (kind) {
            case 'open-artifact': {
              const id = String(payload.id || '')
              if (!id) {return reply(false, '缺少产物 id')}
              useTaskWorkspace.getState().setActiveArtifact(id)
              return reply(true, '已打开')
            }
            case 'voice': {
              const on = payload.on === true
              const r: any = on
                ? await (window as any).luminaAPI?.agentStartRealtimeVoice?.()
                : await (window as any).luminaAPI?.agentStopRealtimeVoice?.()
              return reply(r?.success !== false, r?.message || r?.error)
            }
            case 'computer-use': {
              const on = payload.on === true
              const r: any = on
                ? await (window as any).luminaAPI?.agentStartComputerUse?.()
                : await (window as any).luminaAPI?.agentStopComputerUse?.()
              return reply(r?.success !== false, r?.message || r?.error)
            }
            case 'lucky-preset': {
              const preset = String(payload.preset || 'off')
              const r: any = await (window as any).luminaAPI?.luckyModeSetPreset?.(preset)
              return reply(r?.success !== false, preset)
            }
            case 'lucky-get': {
              const cfg: any = await (window as any).luminaAPI?.luckyModeGetConfig?.()
              return reply(true, String(cfg?.preset || 'off'))
            }
            case 'navigate': {
              const panel = String(payload.panel || 'chat')
              useStore.setState({ activePanel: panel } as any)
              return reply(true)
            }
            // ✨ 「更多 → 增强提示词」：把桌宠输入框的草稿改写成更清晰的指令。
            //
            // 走的是主进程既有的 `llm:enhance-prompt`（与群聊输入框同一个通道），
            // 而不是 agentChat —— 增强只是"改写一段文字"，不需要工具链、不该占用
            // 桌宠对话的串行队列，更不该在 conv-pet-live2d 里留下两条消息。
            case 'enhance': {
              const draft = String(payload.text || '').trim()
              if (!draft) { return reply(false, '输入框是空的，先写点内容再增强') }
              const enhanceApi = (window as any).luminaAPI?.llmEnhancePrompt
              if (!enhanceApi) { return reply(false, '当前版本不支持提示词增强') }
              const cfg = useStore.getState().llmConfig
              if (!cfg?.baseUrl || !cfg?.model) {
                return reply(false, '先在模型选择器里配置 Endpoint 和 Model')
              }
              const r: any = await enhanceApi({
                baseUrl: cfg.baseUrl,
                apiKey: cfg.apiKey || '',
                model: cfg.model,
                text: draft,
              })
              if (r?.error) { return reply(false, String(r.error)) }
              const enhanced = String(r?.content || '').trim()
              if (!enhanced) { return reply(false, '模型没有返回增强结果') }
              return reply(true, enhanced)
            }
            default:
              return reply(false, `未知动作：${kind}`)
          }
        } catch (e: any) {
          reply(false, String(e?.message || e))
        }
      })()
    })

    // 「在主窗口中打开」：切到桌宠这条对话，并把焦点交给主窗口
    const unsubOpenMain = api.onPetUiOpenMain?.(() => {
      try {
        useStore.getState().switchConversation(PET_CONV_ID)
        useStore.setState({ activePanel: 'chat' } as any)
      } catch { /* 忽略 */ }
    })

    // ── 主聊天 → 桌宠（订阅 store，监听固定对话的新消息）──
    //    zustand subscribe 在 set() 时同步触发：我们注入桌宠消息时 injectingRef=true，
    //    这批新消息不回推（已由 sendToPet 直接发过）；只有主窗 UI 新增的才推给桌宠。
    const unsubStore = useStore.subscribe((state: any) => {
      const conv = state.conversations.find((c: any) => c.id === PET_CONV_ID)
      if (!conv) {return}
      const messages = conv.messages || []
      if (messages.length <= lastMsgCount.current) {return}
      const newMsgs = messages.slice(lastMsgCount.current)
      lastMsgCount.current = messages.length
      const toForward = messagesToForward(newMsgs, injectingRef.current)
      for (const msg of toForward) {
        try { api.petSyncReply?.(msg.content, msg.role) } catch { /* 桌宠窗未开 */ }
      }
    })

    return () => {
      unsubPetMsg?.()
      unsubStore?.()
      unsubHistoryReq?.()
      unsubAgentEvents?.()
      unsubConvListReq?.()
      unsubConvDelete?.()
      unsubTaskListReq?.()
      unsubUiAction?.()
      unsubOpenMain?.()
      if (thinkTimer) {clearTimeout(thinkTimer)}
    }
  }, [])

  return null
}
