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

    return () => { unsubPetMsg?.(); unsubStore?.(); unsubHistoryReq?.() }
  }, [])

  return null
}
