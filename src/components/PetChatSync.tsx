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
import { useStore } from '../stores/appStore'
import {
  PetChatOrchestrator,
  messagesToForward,
  deriveLocalIntent,
} from '../lib/petChatOrchestrator'

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

    const orchestrator = new PetChatOrchestrator({
      getHistory: () => {
        const conv = useStore.getState().conversations.find((c: any) => c.id === PET_CONV_ID)
        return (conv?.messages || [])
          .filter((m: any) => m.role !== 'system')
          .map((m: any) => ({ role: m.role, content: m.content }))
      },
      addMessage: addMessageTracked,
      agentChat: async (text, history) => {
        const llmConfig = useStore.getState().llmConfig
        const conv = useStore.getState().conversations.find((c: any) => c.id === PET_CONV_ID)
        const reqId = `pet-${Date.now()}-${++petReqSeq}`
        activeReqId = reqId
        const config = {
          mode: 'chat' as const,        // 桌宠是陪伴对话：轻量 Chat 工具集，不给完整 Agent 重工具链
          model: llmConfig.model,
          baseUrl: llmConfig.baseUrl,
          apiKey: llmConfig.apiKey,
          temperature: llmConfig.temperature,
          maxTokens: llmConfig.maxTokens,
          maxToolCalls: 4,
          noAutoSearch: true,          // 身份/闲聊不自动联网（模型真需要时仍可自己调 web_search）
          personaId: 'lumina',
          contextWindow: llmConfig.contextWindow || 0,
          requestId: reqId,            // ← 事件归属（见上方注释）
          // 🧠 与主聊天面板的默认一致（ChatPanel 的 thinkingMode 默认开启）：
          //   打开推理流，桌宠聊天窗才能显示模型真实的想法，而不是只看到工具调用。
          //   不支持 reasoning_content 的模型不会有任何额外输出，零副作用。
          trackReasoning: true,
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
    const unsubPetMsg = api.onPetSyncMessage((data: { text: string; from: string }) => {
      if (!data?.text) {return}
      ensurePetConv()
      orchestrator.handlePetMessage(data.text)
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
      if (thinkTimer) {clearTimeout(thinkTimer)}
    }
  }, [])

  return null
}
