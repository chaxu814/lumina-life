// ============================================================
// impl/socialEngine.ts — 🎭 社交引擎 Skill (Phase C)
//
// 把 Agent 社交引擎（多 Agent 闲聊、日常仪式、朋友圈发布）
// 封装为可配置的 Skill，LLM 可通过 name="social_engine" 调用。
// ============================================================

import { registerSkill } from '../skillSystem'
import { getOrchestrator } from '../../core/agentOrchestrator'

// ═══════════════════════════════════════════════════════════
// 注册社交引擎 Skill
// ═══════════════════════════════════════════════════════════

export function registerSocialEngineSkill(): void {
  registerSkill({
    name: 'social_engine',
    description: '🎭 社交引擎 — 触发 Agent 团队间的自发闲聊、日常仪式（早安/晚安/午后闲聊）、话题讨论。Agent 们会在朋友圈中互动，不会打扰用户。需要团队模式且有至少 2 个配置了 LLM 的 Agent。',
    params: {
      action: {
        type: 'string',
        description: '操作: "trigger" (手动触发一次社交对话) | "status" (查看社交引擎状态和最近活动) | "configure" (配置是否开启)',
        required: true,
      },
      topic: {
        type: 'string',
        description: '可选的话题提示，如 "聊聊最近的 AI 新闻"。仅 action=trigger 时有效',
        required: false,
      },
      enabled: {
        type: 'boolean',
        description: '启用/禁用社交引擎。仅 action=configure 时有效',
        required: false,
      },
    },
    toolsets: ['agent', 'social'],
    requiresTools: ['web_search', 'memory_save', 'memory_search'],

    execute: async (args, callId) => {
      const action = args.action || 'status'

      try {
        const orch = getOrchestrator()
        const socialEngine = orch?.socialEngine

        switch (action) {
          case 'trigger': {
            if (!socialEngine) {
              return {
                callId, ok: false, content: '', error: '社交引擎未初始化。需要团队模式且至少 2 个 Agent 配置了 LLM',
              }
            }
            const topic = args.topic || undefined
            // 尝试调用社交引擎的触发方法 — 兼容不同版本的方法名
            const engine = socialEngine as any
            if (typeof engine.triggerConversation === 'function') {
              await engine.triggerConversation(topic)
              return {
                callId, ok: true,
                content: topic
                  ? `🎭 社交对话已触发，话题: "${topic}"。Agent 们将在朋友圈中互动。`
                  : '🎭 社交对话已触发。Agent 们将自主选择话题在朋友圈中互动。',
              }
            } else if (typeof engine.startSocialChat === 'function') {
              await engine.startSocialChat(topic)
              return { callId, ok: true, content: '🎭 社交对话已触发。' }
            } else {
              // 广播事件
              const { globalEventBus, BusEvents } = await import('../../eventBus')
              globalEventBus.emit(BusEvents.SOCIAL_TRIGGER, { topic, source: 'skill' })
              return { callId, ok: true, content: '🎭 社交引擎触发事件已广播。' }
            }
          }

          case 'status': {
            const socialState = socialEngine
              ? (socialEngine as any).state || 'active'
              : 'uninitialized'
            return {
              callId, ok: true,
              content: [
                `🎭 社交引擎状态: ${socialState}`,
                socialEngine ? '✅ 引擎已初始化' : '❌ 引擎未初始化（需团队模式）',
                '模式: Agent 朋友圈对话（不打扰用户）',
                '触发方式: 自动（空闲时） / 手动（trigger action）',
              ].join('\n'),
            }
          }

          case 'configure': {
            if (args.enabled === undefined) {
              return { callId, ok: false, content: '', error: '请提供 enabled: true/false' }
            }
            // 持久化配置
            const fs = await import('fs')
            const path = await import('path')
            const os = await import('os')
            const configDir = process.env.LUMINA_CONFIG_DIR || path.default.join(os.default.homedir(), '.lumina')
            const configPath = path.default.join(configDir, 'social_config.json')
            const config = { enabled: args.enabled, updatedAt: new Date().toISOString() }
            fs.default.mkdirSync(path.default.dirname(configPath), { recursive: true })
            fs.default.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')

            // 如果引擎有 setEnabled 方法
            if (socialEngine && typeof (socialEngine as any).setEnabled === 'function') {
              (socialEngine as any).setEnabled(args.enabled)
            }

            return {
              callId, ok: true,
              content: args.enabled
                ? '🎭 社交引擎已启用。Agent 们将在空闲时自主社交。'
                : '🎭 社交引擎已禁用。',
            }
          }

          default:
            return { callId, ok: false, content: '', error: `未知操作: ${action}。支持: trigger, status, configure` }
        }
      } catch (err: any) {
        return { callId, ok: false, content: '', error: `社交引擎操作失败: ${err.message || err}` }
      }
    },
  })

  console.log('[SocialEngine] ✅ 社交引擎 Skill 已注册')
}
