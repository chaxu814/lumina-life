/**
 * PetChatSync — 桌宠聊天 ↔ Lumina Agent 主聊天双向同步
 *
 * - 固定一个 "🐾 Live2D 桌宠" 对话（ID: conv-pet-live2d）
 * - 桌宠发消息 → 注入该对话 → 触发 Agent → 回复同步回桌宠
 * - 用户在该对话发消息 → 同步到桌宠
 * - Agent 在该对话回复 → 同步到桌宠
 */
import { useEffect, useRef } from 'react'
import { useStore } from '../stores/appStore'

const PET_CONV_ID = 'conv-pet-live2d'
const PET_CONV_NAME = '🐾 Live2D 桌宠'

export default function PetChatSync() {
  const processingRef = useRef(false)
  const syncedTimestamps = useRef<Set<number>>(new Set())
  const lastMsgCount = useRef(0)
  const initialized = useRef(false)

  useEffect(() => {
    const api = (window as any).luminaAPI
    if (!api?.onPetSyncMessage) return

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
    initialized.current = true

    // ── 桌宠 → 主聊天 ──
    const unsubPetMsg = api.onPetSyncMessage(async (data: { text: string; from: string }) => {
      if (processingRef.current) return
      if (!data?.text) return

      const store = useStore.getState()
      let conv = store.conversations.find((c: any) => c.id === PET_CONV_ID)
      if (!conv) conv = ensurePetConv()

      const ts = Date.now()
      syncedTimestamps.current.add(ts)
      useStore.getState().addMessage(PET_CONV_ID, 'user', data.text)
      lastMsgCount.current = useStore.getState().conversations.find((c: any) => c.id === PET_CONV_ID)?.messages.length || 0

      processingRef.current = true
      try {
        const latestConv = useStore.getState().conversations.find((c: any) => c.id === PET_CONV_ID)
        const history = latestConv?.messages
          .filter((m: any) => m.role !== 'system')
          .map((m: any) => ({ role: m.role, content: m.content })) || []

        const llmConfig = useStore.getState().llmConfig
        const config = {
          mode: 'chat' as const,        // 桌宠是陪伴对话：用轻量 Chat 工具集，不给完整 Agent 重工具链
          model: llmConfig.model,
          baseUrl: llmConfig.baseUrl,
          apiKey: llmConfig.apiKey,
          temperature: llmConfig.temperature,
          maxTokens: llmConfig.maxTokens,
          maxToolCalls: 4,
          noAutoSearch: true,          // 关键：身份/闲聊不自动联网（模型真需要时仍可自己调 web_search）
          personaId: 'lumina',
          contextWindow: llmConfig.contextWindow || 0,
        }

        const result = await api.agentChat({
          text: data.text,
          config,
          sessionId: PET_CONV_ID,
          compactedContext: latestConv?.compactedContext,
          conversationHistory: history,
        })

        const replyText = result?.content || ''
        if (replyText) {
          const replyTs = Date.now()
          syncedTimestamps.current.add(replyTs)
          useStore.getState().addMessage(PET_CONV_ID, 'assistant', replyText)
          try { api.petSyncReply?.(replyText, 'assistant') } catch {}
        } else if (result?.error) {
          const errMsg = result.content || `出错了: ${String(result.error).slice(0, 100)}`
          useStore.getState().addMessage(PET_CONV_ID, 'assistant', errMsg)
          try { api.petSyncReply?.(errMsg, 'assistant') } catch {}
        }
      } catch (err: any) {
        const errMsg = `喵…连接不上大脑了（${err?.message || '未知错误'}）`
        useStore.getState().addMessage(PET_CONV_ID, 'assistant', errMsg)
        try { api.petSyncReply?.(errMsg, 'assistant') } catch {}
      } finally {
        processingRef.current = false
        lastMsgCount.current = useStore.getState().conversations.find((c: any) => c.id === PET_CONV_ID)?.messages.length || 0
      }
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
    const unsubStore = useStore.subscribe((state: any) => {
      const conv = state.conversations.find((c: any) => c.id === PET_CONV_ID)
      if (!conv) return

      const count = conv.messages.length
      if (count > lastMsgCount.current) {
        const newMsgs = conv.messages.slice(lastMsgCount.current)
        for (const msg of newMsgs) {
          if (msg.role === 'system') continue
          // 跳过刚从桌宠同步过来的消息
          if (syncedTimestamps.current.has(msg.timestamp)) {
            syncedTimestamps.current.delete(msg.timestamp)
            continue
          }
          try { api.petSyncReply?.(msg.content, msg.role) } catch {}
        }
      }
      lastMsgCount.current = count
    })

    return () => { unsubPetMsg?.(); unsubStore?.(); unsubHistoryReq?.() }
  }, [])

  return null
}
