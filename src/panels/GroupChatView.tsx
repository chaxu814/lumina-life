// ============================================================
// GroupChatView.tsx — 团队群聊视图 (v2.11)
// Extracted from ChatPanel.tsx (was 1500+ lines inline)
// ============================================================

import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { useStore } from '../stores/appStore'
// 群聊成员显示开关（2026-10-04）：用户可在「团队管理」里关掉某个成员。
// 默认全开时后台成员持续发言会让人眼花缭乱。
import { isAgentVisible } from '../services/teamVisibility'
import { isLocalInferenceRuntime } from '../services/isLocalEndpoint'
import { useTaskWorkspace } from '../stores/taskWorkspaceStore'
// 📋 任务工作区的开合状态来自同一个 store，所以「任务派发中心」旁边
import AgentTaskBoard from '../components/AgentTaskBoard'
import ThinkingStepList from '../components/ThinkingStepList'
import AgentMoments from '../components/AgentMoments'
import { sttService, type STTStatus } from '../services/sttService'
import { handlePasteInsert } from '../lib/pasteInsert'
import { isImeComposing } from '../lib/ime'
import { estimateTokens } from '../lib/tokenEstimate'
import { ttsEngine } from '../services/ttsEngine'
import { proactiveChat } from '../services/proactiveChat'
import { updateEmotion } from '../services/agentEmotion'
import { injectEmotionStyles } from '../components/AgentEmotionBar'
import { addBookmark } from '../services/messageBookmarks'
import { showToast } from '../components/Toast'
import LinkifiedText from '../components/LinkifiedText'
import PermissionSelector, { usePermission } from '../components/PermissionSelector'
import TeamPanel from './TeamPanel'  // 🆕 团队面板整合
import {
  calculateSpark,
  calculateChainSpark,
  detectUncertainty,
  detectMentionInReply,
} from '../services/conversationDynamics'
import LuckyModeSelector from '../components/LuckyModeSelector'
import ModelSelector from '../components/ModelSelector'
import LuckyModeSettings from '../components/LuckyModeSettings'
import { useLuckyMode } from '../hooks/useLuckyMode'
import type { LuckySettingsConfig } from '../components/LuckyModeSettings'
import {
  getToolNotification,
  getGCToolsPrompt,
  getGCToolsPromptForIntent,
  getDisabledTools,
  detectToolIntent,
  DEFAULT_TEAM_SECURITY,
  type TeamSecurityConfig,
} from '../services/gcSafeTools'
import {
  TTS_VOICES, AGENT_VOICES, AUTONOMY_INTERVAL,
  AGENTS, EMOJI_GROUPS,
  type GCMsg, type GCSession, type AgentTask, type ThinkingStep,
  loadGCSessions, saveGCSessions, loadGCMessages, saveGCMessages, newGCSessionId, buildSessionsOnPersist,
  loadLLMData, loadAgentVoices, saveAgentVoices,
  setLLMRefreshFn, _llmState, _llmNotify, _startAutonomyTimer, _stopAutonomyTimer, _startAutonomyWithRemaining, _autonomyTimer,
  useLLMPanels,
  cleanTtsText, formatDateLabel, getAgentSystemPromptLite,
} from '../chat/chatShared'
import { useLoopStore } from '../stores/loopStore'
import { detectLoopIntent } from '../services/loopEngine'
import TaskDispatcher from '../components/TaskDispatcher'
import SubagentCards from '../components/SubagentCards'
import { TASK_TYPE_CARDS, TEAM_MEMBERS, TaskType, getRecommendedAgent } from '../data/agentRoles'
import ContextUsageIndicator from '../components/ContextUsageIndicator'
import { useAgentRuntime } from '../stores/agentRuntimeStore'

/** P0.4: 团队群聊 agentChat 硬截止 + 兜底 */
// 🔧 v9.2: 300s→600s — 本地35B模型+大PDF附件可能需要更长推理时间，
//   后端 providerProfiles 对 Qwen 本地模型推荐超时为 600s（慢速模式900s），
//   前端必须 ≥ 后端超时，否则会在后端仍在处理时强制中断。
const GC_CHAT_HARD_MS = 600_000

async function agentChatWithTimeout(args: any, requestId?: string): Promise<{ content: string; error?: string }> {
  // 🆕 P2-1：把本次请求 id 注入 config，后端会回显在每条事件上，供前端过滤。
  const payload = requestId
    ? { ...args, config: { ...(args?.config || {}), requestId } }
    : args
  const deadline = Date.now() + GC_CHAT_HARD_MS
  try {
    const p = new Promise<any>((resolve, reject) => {
      const t = setInterval(() => {
        if (Date.now() > deadline) {
          clearInterval(t)
          reject(new Error(`群聊回复超时（${Math.round(GC_CHAT_HARD_MS / 1000)} 秒），请缩短输入或稍后重试。`))
        }
      }, 1_000)
      ;(window as any).luminaAPI.agentChat(payload).then((r: any) => {
        clearInterval(t)
        resolve(r)
      }).catch((e: any) => {
        clearInterval(t)
        reject(e)
      })
    })

    // 长上下文下 LLM 推理可能超过 60s
    //   从 60s 提升到 180s，与后端 socialMode 300s 超时对齐
    // 🔧 v9.2: 300s→600s，与 GC_CHAT_HARD_MS 对齐，避免双重超时不一致
    const result = await Promise.race([
      p,
      new Promise<any>((_, reject) =>
        setTimeout(() => reject(new Error(`已中断（${GC_CHAT_HARD_MS / 1000}秒无响应）`)), GC_CHAT_HARD_MS)
      ),
    ])

    return {
      content: (result?.content || '').trim(),
      ...(result?.error ? { error: String(result.error) } : {}),
    }
  } catch (e: any) {
    return {
      content: '（回复生成失败或耗时过长，已自动中断。请稍微简化问题重试。）',
      error: e?.message || String(e),
    }
  }
}

// ═══════════════════════════════════════════════════════════
// 🔧 P2-fix: Visual Compact — 图片压缩工具
//   避免 Computer Use/截图/OCR 数据撑爆上下文
// ═══════════════════════════════════════════════════════════

/** 压缩图片为 JPEG base64 */
async function compressImage(dataUrl: string, maxWidth: number, quality: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      let { width, height } = img
      if (width > maxWidth) {
        height = Math.round((height * maxWidth) / width)
        width = maxWidth
      }
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')!
      ctx.drawImage(img, 0, 0, width, height)
      const compressed = canvas.toDataURL('image/jpeg', quality)
      URL.revokeObjectURL(img.src)
      resolve(compressed)
    }
    img.onerror = () => reject(new Error('图片加载失败'))
    img.src = dataUrl
  })
}

// ═══════════════════════════════════════════════════════════
// Per-Agent 上下文隔离构建器 (v1.0)
//   替代原来的统一 historyForLLM，让每个 Agent 只看到"自己的 + 用户的 + 精简的其他人"
// ═══════════════════════════════════════════════════════════

/**
 * 按 Agent 隔离构建团队群聊的 LLM 上下文。
 *
 * 核心规则：
 * - 用户消息 → 完整保留（2000 字符上限）
 * - 目标 Agent 自己的消息 → 完整保留（2000 字符上限）
 * - 其他 Agent 的消息 → 压缩为 [名字] 摘要（350 字符上限，最近 5 条）
 * - 系统消息 → 按 skipSystem 选项决定
 * - 协作摘要（runningHistory）→ 追加到最后（仅主回复使用）
 */
function buildHistoryForAgent(
  allMessages: GCMsg[],
  targetAgentId: string,
  contextWindow: number,
  runningHistory: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  options?: { skipSystem?: boolean },
): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  // 🔧 2026-10-07: 未知窗口时用**保守**默认（32K），不再假设 256K。
  //   假设 256K 会让历史预算算得过大 → 给本地小模型塞进远超其承载能力的上下文。
  const MAX_HISTORY_TOKENS = Math.floor((contextWindow || 32768) * 0.55)
  const PER_MSG_OVERHEAD = 8
  const MAX_OTHER_MSGS = 30      // 🔧 P2-fix: 其他 Agent 最多保留条数（8→30，减少群聊上下文截断）
  const MAX_OWN_CHARS = 4000     // 🔧 P2-fix: 自己/用户/系统消息上限（2000→4000，保留更多细节）
  const MAX_OTHER_CHARS = 1500   // 🔧 P2-fix: 其他 Agent 压缩上限（350→1500，减少信息丢失）

  // 预计算 Agent ID 集合
  const AGENT_IDS = new Set(AGENTS.map(a => a.id))

  const result: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = []
  let tokenEst = 0
  let otherCount = 0
  const skipSystem = options?.skipSystem === true

  // 从最新消息往前遍历（保留时间顺序）
  for (let i = allMessages.length - 1; i >= 0; i--) {
    const m = allMessages[i]
    const isUser = m.from === 'user'
    const isSystem = m.from === 'system'
    const isTarget = m.from === targetAgentId
    const isOther = (AGENT_IDS as Set<string>).has(m.from) && !isTarget

    // 跳过无关消息（非 Agent / 非用户 / 非系统）
    if (!isUser && !isSystem && !isTarget && !isOther) {continue}

    // 系统消息处理
    if (isSystem) {
      if (skipSystem) {continue}
      if ((m.content || '').trim().length <= 5) {continue}
    }

    // 其他 Agent 限数
    if (isOther) {
      if (otherCount >= MAX_OTHER_MSGS) {continue}
      otherCount++
    }

    // 构建 role 和 content
    let role: 'system' | 'user' | 'assistant'
    let text: string

    if (isSystem) {
      role = 'system'
      text = (m.content || '').slice(0, MAX_OWN_CHARS)
    } else if (isUser) {
      role = 'user'
      text = (m.content || '').slice(0, MAX_OWN_CHARS)
      // v10.9: 附件处理 — 支持图片多模态
      if (m.attachments && m.attachments.length > 0) {
        // 检查是否有图片附件
        const imageAttachments = m.attachments.filter(a => a.imageDataUrl)
        const otherAttachments = m.attachments.filter(a => !a.imageDataUrl)
        
        // 其他附件描述
        if (otherAttachments.length > 0) {
          const descs = otherAttachments.map((a, i) => {
            const sizeStr = a.size > 1024 * 1024
              ? `${(a.size / (1024 * 1024)).toFixed(1)}MB`
              : `${(a.size / 1024).toFixed(1)}KB`
            return `[附件${i + 1}: ${a.name} (${sizeStr})]`
          }).join('\n')
          text = text + '\n\n--- 上传文件 ---\n' + descs
        }
        
        // v10.9: 图片多模态 — 如果有图片，返回 content 数组格式
        if (imageAttachments.length > 0) {
          const contentArray: Array<{ type: string; text?: string; image_url?: { url: string } }> = [
            { type: 'text', text }
          ]
          for (const img of imageAttachments) {
            contentArray.push({
              type: 'image_url',
              image_url: { url: img.imageDataUrl! }
            })
          }
          // 暂存到 _visionContent 供后续使用
          result.unshift({ role, content: contentArray } as any)
          continue
        }
      }
    } else if (isTarget) {
      role = 'assistant'
      text = (m.content || '').slice(0, MAX_OWN_CHARS)
    } else {
      // 其他 Agent → 压缩为一行摘要
      role = 'assistant'
      const agentName = m.from === 'recha' ? '热茶' : m.from === 'yak' ? 'Yak' : m.from
      // 去掉 thinking 和 tool_call 标签，只保留纯文本
      const raw = (m.content || '')
        .replace(/<thinking>[\s\S]*?<\/thinking>/g, '')
        .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
        .trim()
        .slice(0, MAX_OTHER_CHARS)
      text = `[${agentName}]: ${raw}`
    }

    const est = estimateTokens(text) + PER_MSG_OVERHEAD
    if (tokenEst + est > MAX_HISTORY_TOKENS && result.length > 0) {break}
    tokenEst += est
    result.unshift({ role, content: text })
  }

  // 追加协作摘要（runningHistory）— 仅主回复使用
  if (runningHistory && runningHistory.length > 0) {
    // 🔧 2026-08-14: 去重 — 记录已存在的内容摘要（前 80 字符），避免 runningHistory 与 messages 重复
    const existingSummaries = new Set(
      result.map(m => (m.content || '').slice(0, 80).trim())
    )
    let addedSummaryHeader = false
    for (const entry of runningHistory) {
      const clipped = (entry.content || '').slice(0, 3000)
      const summaryKey = clipped.slice(0, 80).trim()
      if (existingSummaries.has(summaryKey)) {continue} // 跳过已在 messages 中出现的条目
      const est = estimateTokens(clipped) + PER_MSG_OVERHEAD
      if (tokenEst + est > MAX_HISTORY_TOKENS) {break}
      tokenEst += est
      if (!addedSummaryHeader && tokenEst + 8 <= MAX_HISTORY_TOKENS) {
        result.push({ role: 'user' as const, content: '[--- 以下为团队协作阶段的结构化摘要 ---]' })
        tokenEst += 8
        addedSummaryHeader = true
      }
      result.push({ role: entry.role, content: clipped })
    }
  }

  if (result.length === 0) {
    // 🐛 2026-10-12 修复：这里原本返回 `[{ role: 'user', content: '(对话开始)' }]`。
    //
    //   但这条占位符会被模型**当成一句用户发言**来理解 ——
    //   「(对话开始)」字面意思就是"对话刚开始"，于是模型回复：
    //     「抱歉，这是我们的第一次对话，还没有之前的对话内容可以参考。
    //       如果你能告诉我你想讨论的话题或问题，我会很乐意帮你！」
    //   实测故障（用户问「尼古喵喵是什么」，两个 Agent 都这么回）。
    //
    //   历史为空时正确的做法是**什么都不塞**：后端 sendMessage 会自己把
    //   用户本轮的问题 push 进上下文，模型自然就有题面了。
    //   塞一条假发言只会污染上下文（这与「不要伪造 user 消息」是同一条教训）。
    return []
  }

  return result
}

// ═══════════════════════════════════════════════════════════
// 团队群聊视图
// ═══════════════════════════════════════════════════════════

/**
 * 🆕 v10.8: 剥离 LLM 回复开头的"自言自语"推理文本
 * 
 * 🔧 v10.8 修复：之前 17 种模式过于激进，会错误剥离模型的有用推理过程，
 * 导致用户看到残缺回复，像是"一问二不知"。
 * 现在只剥离**明确的、无信息量的自言自语**，保留有用的推理内容。
 */
function stripReasoningPrefix(text: string): string {
  // 只剥离**明确无信息量**的自言自语模式
  //   每个模式必须满足：(1) 完全不含知识内容 (2) 后面有实际回答
  const safePatterns = [
    // ① "用户问/说/让我...。" → 纯场景复述，无知识价值
    /^用户[问说让要我收发看][^。\n]*。[\s\S]*?(?:\n\n|$)/s,
    // ② "让我想想/看看/来分析...。" → 纯犹豫/计划，无知识价值
    /^(?:让我想想|让我看看|让我来分析|让我分析|等我看看|等一下|嗯[，,。]?)[^。\n]*。[\s\S]*?(?:\n\n|$)/s,
    // ③ "作为[角色]...我需要/应该...。" → 角色自述，无知识价值
    /^作为[^。\n]*(?:Lumina|猫娘|AI|助手|agent|Agent|热茶|Yak)[^。\n]*(?:需要|要|应该|得)[^。\n]*。[\s\S]*?(?:\n\n|$)/s,
    // ④ "这是一个...场景/群聊/对话。" → 场景复述，无知识价值
    /^这是[一一个][^。\n]*(?:群聊|对话|场景|情况|通知)[^。\n]*。[\s\S]*?(?:\n\n|$)/s,
  ]

  for (const pattern of safePatterns) {
    const match = text.match(pattern)
    if (match && match[0]) {
      const remaining = text.slice(match[0].length).trim()
      // 🔧 提高最小长度阈值：剥离后剩余内容必须 ≥ 10 字才执行剥离
      //   防止误剥离后只剩残片
      if (remaining.length >= 10) {return remaining}
    }
  }

  return text
}

/**
 * 🆕 v10.5: 清洗 <thinking> 标签内的思考文本，去掉角色自述/身份复述
 * 
 * LLM 在思考时喜欢先背一遍"我是谁、我的性格是什么"，这些内容对用户
 * 是噪音。本函数从 thinking 文本中过滤掉这些句子。
 */
function cleanThinkingText(text: string): string {
  const cleanPatterns = [
    // ① "我是/我是谁/我是Lumina/热茶/Yak..."
    /^我是[^。，、\n]{0,30}[。，、]?\s*/,
    // ② "作为[身份]..." 
    /^作为[^。，、\n]{0,30}[。，、]?\s*/,
    // ③ "根据[我的/我的设定/我的性格/我的角色/规则/铁则]..."
    /^根据[^。，、\n]{0,40}[。，、]?\s*/,
    // ④ "我的[性格/风格/角色/身份/设定/名字/规则]是..."
    /^我的[^。，、\n]{0,10}是[^。，、\n]{0,40}[。，、]?\s*/,
    // ⑤ "用户叫我/用户说我是/主人说我是..."
    /^用户[^。，、\n]{0,10}我[^。，、\n]{0,30}[。，、]?\s*/,
    // ⑥ "Lumina[性格/风格/是]..." / "热茶/Yak 是..."
    /^(?:Lumina|热茶|Yak)\s*[^。，、\n]{0,40}[。，、]?\s*/,
    // ⑦ "首先/第一/让我先" → 计划性开头
    /^(?:首先|第一步|让我先|先让)[^。，、\n]{0,40}[。，、]?\s*/,
    // ⑧ "嗯/唔/好/好的/ok/OK/哦" → 语气填充词开头
    /^(?:嗯[，,。]?|唔[，,。]?|好[的，,。]?|ok[，,。]?|OK[，,。]?|哦[，,。]?)\s*/,
  ]
  
  let cleaned = text.trim()
  for (const pattern of cleanPatterns) {
    // 循环清除每行/每句开头的匹配
    let prev: string
    do {
      prev = cleaned
      cleaned = cleaned.replace(pattern, '').trim()
    } while (cleaned !== prev && cleaned.length > 0)
  }
  
  // 如果清理后为空或只剩标点，返回原文本的简短摘要
  if (cleaned.length < 3) {return text.slice(0, 100)}
  return cleaned
}

/**
 * 🆕 v10.7: 去重 — LLM 有时会输出重复内容（同一回复输出两遍、或 thinking 标签外出现两版）
 * 检测策略：按段落取签名（首个有意义段落 >10 字），若后半段再次出现则截断。
 * 适用于主回复 / 链式火花 / 决策讨论三条路径。
 */
function deduplicateLLMContent(text: string): string {
  if (text.length < 200) {return text}
  const paragraphs = text.split('\n\n').filter(p => p.trim().length >= 10)
  if (paragraphs.length < 2) {return text}
  for (const para of paragraphs) {
    const sig = para.trim().slice(0, 40)
    if (sig.length < 10) {continue}
    const firstPos = text.indexOf(sig)
    const lastPos = text.lastIndexOf(sig)
    if (lastPos > firstPos && lastPos > text.length * 0.35) {
      const before = text.slice(0, lastPos).trim()
      if (before.length > 100) {return before}
    }
  }
  return text
}

/**
 * 🔧 2026-08-11: 话题专属人设 — 与 TASK_TYPE_CARDS 的 7 个话题对应
 * 在 agent 基础 system prompt 之上追加话题指令，让 Lumina 团队在对应话题下
 * 以「领域专家」的姿态工作，而不是通用闲聊。返回空串表示无额外指令（日常聊天）。
 */
function getTaskTypeInstruction(taskType?: TaskType | null): string {
  switch (taskType) {
    case 'learn':
      return [
        '',
        '## 📚 学习辅导模式（持续生效）',
        '你现在是用户的学习辅导老师：',
        '- 讲解结构化：概念 → 原理 → 例子 → 验证',
        '- 抽象概念先用类比讲明白，再给严谨定义',
        '- 主动检查理解，用户说「不懂/再讲一遍」时换一种讲法，不要重复原话',
        '- 耐心优先，不嘲讽、不省略基础步骤',
      ].join('\n')
    case 'write':
      return [
        '',
        '## ✍️ 写作创作模式（持续生效）',
        '你现在是用户的写作创作搭档：',
        '- 动手前先确认文体、受众、语气；信息不足时给出可选假设',
        '- 直接给出可用的成稿，不要只给大纲；成稿后附 1-2 条修改建议',
        '- 润色时说明改了什么、为什么改',
      ].join('\n')
    case 'code':
      return [
        '',
        '## 💻 代码开发模式（持续生效）',
        '你现在是用户的资深工程师搭档：',
        '- 直接动手写代码或改 bug，不要只给建议',
        '- 关键设计决策说明理由，指出代码里的潜在坑',
        '- 完成后总结改了哪些文件、如何验证',
      ].join('\n')
    case 'design':
      return [
        '',
        '## 🎨 商业设计模式（持续生效）',
        '你现在是用户的商业设计顾问：',
        '- 从用户目标与受众出发给方案，不只谈审美',
        '- 给具体可执行的建议：配色值、字号层级、布局结构、交互细节',
        '- 每个建议附一句设计依据，并给出 1 个备选方案',
      ].join('\n')
    case 'intel':
      return [
        '',
        '## 🛡️ 情报监控模式（持续生效）',
        '你现在是用户的情报分析师：',
        '- 时效优先：需要核实的信息先 web_search，并注明来源与日期',
        '- 区分「事实」与「推测」，不确定就明说',
        '- 输出结构化摘要：要点 → 影响 → 建议关注',
      ].join('\n')
    case 'work':
      return [
        '',
        '## 📋 职场办公模式（持续生效）',
        '你现在是用户的职场办公助手：',
        '- 输出专业、可直接使用的内容：会议纪要、周报、邮件、日程',
        '- 结构化呈现：结论先行，分点展开',
        '- 主动给出下一步动作建议',
      ].join('\n')
    default:
      return ''
  }
}

// 自主刷新倒计时：独立小组件，自己持有 1s 定时器；避免每秒让整个 GroupChatView（数千行）重渲染
function NextRefreshCountdown({ next }: { next: number | null }) {
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!next) {return}
    const t = setInterval(() => setTick(n => n + 1), 1000)
    return () => clearInterval(t)
  }, [next])
  if (!next) {return null}
  const sec = Math.max(0, Math.round((next - Date.now()) / 1000))
  const text = sec > 60 ? `${Math.floor(sec / 60)}分${sec % 60}秒` : `${sec}秒`
  return (
    <span style={{ color: '#92400e', fontSize: 10, background: 'var(--yellow-100)', padding: '1px 8px', borderRadius: 10, border: '1px solid #fcd34d' }}>
      ⏱ 下次 {text}
    </span>
  )
}

export default function GroupChatView() {
  const llmConfig = useStore(s => s.llmConfig)
  const agentLlmConfigs = useStore(s => s.agentLlmConfigs)
  const getAgentLlmConfig = useStore(s => s.getAgentLlmConfig)
  const loadAgentLlmConfigs = useStore(s => s.loadAgentLlmConfigs)
  const activePanel = useStore(s => s.activePanel)
  const ttsMuted = useStore(s => s.ttsMuted)
  const addTokenUsage = useStore(s => s.addTokenUsage)  // 🔧 v2.17: 团队聊天 token 追踪
  const ttsToggle = useStore(s => s.ttsToggle)
  const profile = useStore(s => s.profile)   // v2.14: 气泡颜色

  // 🆕 v10.8: 启动时加载 per-agent LLM 配置
  useEffect(() => { loadAgentLlmConfigs() }, [])

  // Lumina Team 的实际 LLM 配置来自 per-agent 配置，而不是主聊天页的全局 llmConfig。
  // 以前这里用全局配置 + providerDiscoverLocal（会轮询其他 Agent 的端点/Key），
  // 可能因为 Yak/Recha 或另一个槽位的 Key 能用，就把 Lumina 显示成「已就绪」；
  // 但发送时 agentIpc 使用的是 Lumina 自己的 endpoint/model/apiKey，结果就是 UI 绿、发出后 401。
  const luminaTeamConfig = agentLlmConfigs.lumina
  const readinessConfig = {
    provider: luminaTeamConfig?.provider || '',
    model: luminaTeamConfig?.model || '',
    baseUrl: luminaTeamConfig?.endpoint || '',
    apiKey: luminaTeamConfig?.apiKey || '',
  }
  const isCloudAPI = readinessConfig.apiKey?.startsWith('sk-') || readinessConfig.baseUrl?.includes('api.openai.com') || readinessConfig.baseUrl?.includes('api.moonshot') || readinessConfig.baseUrl?.includes('api.deepseek')
  // 本地地址（包括局域网 IP）按实际 Lumina Team 配置判定；本地免 Key，云端需 Key。
  const isLocalLLM = isLocalInferenceRuntime(readinessConfig.baseUrl)
  const llmConfigured = !!(
    luminaTeamConfig?.enabled
    && readinessConfig.model
    && readinessConfig.baseUrl
    && (readinessConfig.apiKey || isLocalLLM)
  )

  // 本地「就绪」必须用 Lumina Agent 自己保存的 endpoint + API Key 检查，
  // 不能用全局供应商或其它 Team Agent 的凭据代替。
  const [localModelReady, setLocalModelReady] = useState<boolean | null>(null)
  const [localDetecting, setLocalDetecting] = useState(false)
  const [localProbeInfo, setLocalProbeInfo] = useState<{
    ok: boolean
    kind: string | null
    headline: string
    advice: string
  } | null>(null)
  const probeLocal = () => {
    setLocalDetecting(true)
    // 🔧 2026-10-16：探测必须用**当前**的 Agent 配置，而不是本次渲染闭包里的快照。
    //   真实故障：用户在设置里把 Lumina 的端点/Key 改对了，回到群聊点「重新检测」，
    //   仍然按旧配置发请求 → 继续 401 → 用户得出「配了也没用」的结论。
    //   改为实时读取 store，手动重试才真的有意义。
    const fresh = useStore.getState().agentLlmConfigs?.lumina
    const probeTarget = {
      baseUrl: fresh?.endpoint || readinessConfig.baseUrl,
      provider: fresh?.provider || readinessConfig.provider,
      apiKey: fresh?.apiKey || readinessConfig.apiKey,
    }
    return window.luminaAPI?.providerProbeLocalConfig?.(probeTarget)
      .then((r: any) => {
        const ready = Array.isArray(r?.provider?.models) && r.provider.models.length > 0
        if (!ready) {
          const failure = r?.failure
          const headlines: Record<string, string> = {
            auth: 'Lumina Team 的 API Key 鉴权失败',
            unreachable: 'Lumina Team 的本地模型服务无法连接',
            'no-model': 'Lumina Team 的本地服务尚未加载模型',
            http: 'Lumina Team 的本地服务返回错误',
          }
          setLocalProbeInfo(failure ? {
            ok: false,
            kind: failure.kind || 'http',
            headline: headlines[failure.kind] || 'Lumina Team 本地模型检测失败',
            advice: failure.advice || '请检查 Lumina Team 配置中的端点、模型和 API Key。',
          } : {
            ok: false,
            kind: 'http',
            headline: 'Lumina Team 本地模型检测失败',
            advice: '未能核验 Lumina Agent 自己的端点与 API Key；请确认应用主进程已更新后重试。',
          })
        } else {
          setLocalProbeInfo(null)
        }
        return ready
      })
      .catch((e: any) => {
        setLocalProbeInfo({
          ok: false,
          kind: 'http',
          headline: 'Lumina Team 本地模型探测失败',
          advice: `无法完成探测：${e?.message || e}`,
        })
        return false
      })
      .finally(() => { setLocalDetecting(false) })
  }
  const retryLocalDetect = () => { probeLocal().then((ready) => { setLocalModelReady(ready) }) }
  const [syncingGlobalConfig, setSyncingGlobalConfig] = useState(false)
  const [globalConfigSyncNotice, setGlobalConfigSyncNotice] = useState('')
  const syncGlobalConfigToLumina = async () => {
    const global = useStore.getState().llmConfig
    if (!global.baseUrl || !global.model || !global.apiKey) {
      setGlobalConfigSyncNotice('普通模式供应商还缺 Endpoint、Model 或 API Key；请先在设置中完成配置。')
      return
    }
    setSyncingGlobalConfig(true)
    setGlobalConfigSyncNotice('')
    try {
      const result = await window.luminaAPI?.agentLlmSetConfig?.('lumina', {
        provider: global.provider || 'custom',
        model: global.model,
        endpoint: global.baseUrl,
        apiKey: global.apiKey,
        timeout: 600,
        maxContextTokens: global.contextWindow || 0,
      })
      if (!result || result.success === false || result.ok === false) {
        throw new Error(result?.error || '保存 Lumina Team 配置失败')
      }
      await loadAgentLlmConfigs()
      setLocalModelReady(null)
      setGlobalConfigSyncNotice('已将普通模式的 Endpoint、Model 和 Key 复制到 Lumina Team → Lumina；正在重新检查。')
    } catch (e: any) {
      setGlobalConfigSyncNotice(`复制失败：${e?.message || e}`)
    } finally {
      setSyncingGlobalConfig(false)
    }
  }

  useEffect(() => {
    let alive = true
    if (!(llmConfigured && isLocalLLM)) { setLocalModelReady(null); setLocalProbeInfo(null); return }
    probeLocal().then((ready) => { if (alive) { setLocalModelReady(ready) } })
    return () => { alive = false }
  }, [llmConfigured, isLocalLLM, readinessConfig.baseUrl, readinessConfig.model, readinessConfig.apiKey, readinessConfig.provider])

  // 🔧 2026-10-16：窗口重新获得焦点时重新拉一次 per-agent 配置。
  //   本页的就绪判定完全建立在 agentLlmConfigs 之上，而它只在挂载时加载一次。
  //   用户「去设置里配好 → 切回聊天窗口」这个最常见的动作，此前不会触发任何刷新，
  //   于是界面停留在旧配置上继续报「未配置 / 鉴权失败」。
  //   这里只做一次轻量 IPC 拉取，无配置变化时 set 的是等值对象，不会引起重渲染风暴。
  useEffect(() => {
    const onFocus = () => { void loadAgentLlmConfigs() }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [loadAgentLlmConfigs])

  // 探测未完成时允许发送（agentIpc 仍会用实际 Agent 凭据做运行时鉴权）；
  // 一旦精确探测确认鉴权失败/无模型，就不再把 Lumina 标成就绪。
  const llmReady = llmConfigured && (isLocalLLM ? localModelReady !== false : true)

  // 云端提示的关闭状态：记「关到哪一天」，跨天自动复活
  const CLOUD_HINT_KEY = 'gc-cloud-hint-dismissed-at'
  const [cloudHintDismissed, setCloudHintDismissed] = useState(() => {
    try {
      const v = localStorage.getItem(CLOUD_HINT_KEY)
      if (!v) return false
      const today = new Date().toISOString().slice(0, 10)
      return v === today
    } catch { return false }
  })
  const dismissCloudHint = () => {
    try { localStorage.setItem(CLOUD_HINT_KEY, new Date().toISOString().slice(0, 10)) } catch {}
    setCloudHintDismissed(true)
  }

  // 📋 任务工作区：与顶部栏共用同一个 store（2026-10-04 入口移到这里）
  const taskPanelOpen = useTaskWorkspace((s) => s.panelOpen)
  const toggleTaskPanel = useTaskWorkspace((s) => s.togglePanel)

  // 🆕 历史会话
  const [sessions, setSessions] = useState<GCSession[]>(() => loadGCSessions())
  const [activeSessionId, setActiveSessionId] = useState(() => {
    const ss = loadGCSessions()
    return ss.length > 0 ? ss[0].id : newGCSessionId()
  })


  // 🆕 对话连续：记住上一轮谁回复
  const [lastAgent, setLastAgent] = useState<string | null>(null)

  const [messages, setMessages] = useState<GCMsg[]>(() => {
    const loaded = loadGCMessages(activeSessionId)
    if (loaded.length > 0) {
      // 从持久化消息推断 lastAgent
      const lastAgentMsg = [...loaded].reverse().find(m => AGENTS.some(a => a.id === m.from))
      if (lastAgentMsg) {
        setTimeout(() => setLastAgent(lastAgentMsg.from), 0)
      }
      return loaded
    }
    return [
      { id: '0', from: 'system', fromIcon: '🤖', fromName: '系统',
        content: llmReady
          ? `👋 欢迎来到团队群聊！你 + Lumina🐱 + 热茶🍵 + Yak📊 都在这里。\n\n💡 直接发消息，Lumina 会帮你叫合适的队友回复\n💡 @某人：输入 @Lumina / @热茶 / @Yak 指定回复者`
          : `👋 欢迎来到团队群聊！你 + Lumina🐱 + 热茶🍵 + Yak📊 都在这里。\n\n⚠️ 未配置 LLM，当前为模拟回复模式。请在设置中配置 API Key 解锁真实 AI 对话。`,
        time: formatDateLabel(Date.now()) },
    ]
  })
  // 群聊可见性过滤：被关掉的成员不进入渲染列表（2026-10-04）
  // 【为什么用 useMemo 而不是直接改 messages】
  // 隐藏只是「不显示」，消息必须仍在会话里 —— 否则用户切回来看历史会发现凭空少了内容。
  const [hiddenAgents, setHiddenAgents] = useState<Record<string, number>>({})
  useEffect(() => {
    const counts: Record<string, number> = {}
    for (const m of messages) {
      if (m.from !== 'user' && !isAgentVisible(m.from)) {
        counts[m.from] = (counts[m.from] || 0) + 1
      }
    }
    setHiddenAgents(counts)
  }, [messages])
  const visibleMessages = useMemo(
    () => messages.filter(m => m.from === 'user' || isAgentVisible(m.from)),
    [messages],
  )
  const hiddenCount = Object.values(hiddenAgents).reduce((a, b) => a + b, 0)

  const [input, setInput] = useState('')
  const [promptEnhancing, setPromptEnhancing] = useState(false)
  const [promptEnhanceNotice, setPromptEnhanceNotice] = useState('')
  /** 增强前的草稿，用于一键撤销（null = 无可撤销） */
  const [promptEnhanceUndo, setPromptEnhanceUndo] = useState<string | null>(null)
  // 🛠️ v8.1: 输入框 key，当从其他面板回到聊天时重新挂载 textarea
  // 修复 Electron display:none→flex 后 <textarea> 可能无法点击的问题
  const [inputKey, setInputKey] = useState(0)
  const prevPanelRef = useRef(activePanel)
  const [sending, setSending] = useState(false)
  // 🔒 同步发送锁（2026-10-10）
  //   `setSending(true)` 要等下一次渲染才生效，这中间的几十毫秒里
  //   再按一次 Enter（含中文输入法选词回车）会**二次进入** send：
  //     · 同一条消息发两遍；或
  //     · 第二次读到已被清空的输入框 → 发出空消息
  //       → 模型回「这一轮我没有看到具体的问题或话题」（用户实测截图）
  //   用 ref 做同步守卫；释放交给下方「sending 变回 false」的 effect，
  //   这样所有 setSending(false) 的路径（含中断、异常）都能自动解锁。
  const sendLockRef = useRef(false)
  useEffect(() => { if (!sending) {sendLockRef.current = false} }, [sending])
  const [thinkingMode, setThinkingMode] = useState(true) // 🔧 v10.2: 🧠 思考过程开关，默认开启
  const [replyingAgent, setReplyingAgent] = useState<string | null>(null)
  const [prevReplyingAgent, setPrevReplyingAgent] = useState<string | null>(null)  // 🆕 v5.4: 接力过渡
  const [agentSwitchClass, setAgentSwitchClass] = useState('')  // 🆕 v5.4: 切换动画 CSS class
  const [showDecision, setShowDecision] = useState(false)
  const [showTeamMembers, setShowTeamMembers] = useState(false)  // 🔥 v2.7.1: 团队成员面板
  const [showAcpPanel, setShowAcpPanel] = useState(false)  // 🆕 ACP 添加成员面板
  const [closingTeam, setClosingTeam] = useState(false)
  const [closingAcp, setClosingAcp] = useState(false)

  // 🆕 DevTools 紧凑模式（DevTools 打开 OR 简约模式）
  const compactMode = useStore((s) => s.compactMode)
  const [devtoolsOpen, setDevtoolsOpen] = useState(false)
  const compact = compactMode || devtoolsOpen
  useEffect(() => {
    const api = (window as any).luminaAPI
    if (!api?.onDevToolsChanged) {return}
    return api.onDevToolsChanged((opened: boolean) => setDevtoolsOpen(opened))
  }, [])

  const closeTeamPanel = () => { setClosingTeam(true); setTimeout(() => { setShowTeamMembers(false); setClosingTeam(false) }, 250) }
  const closeAcpPanel = () => { setClosingAcp(true); setTimeout(() => { setShowAcpPanel(false); setClosingAcp(false) }, 250) }
  // 🆕 ACP 添加成员表单
  const [acpFormData, setAcpFormData] = useState({
    id: '', name: '', icon: '🌐', description: '',
    url: '', apiKey: '', model: '', systemPrompt: '',
    temperature: 0.7, maxTokens: 4096,
    capabilities: '', triggers: '',
  })
  const [acpMembers, setAcpMembers] = useState<any[]>([])
  const loadAcpMembers = async () => {
    try {
      const api = (window as any).luminaAPI
      const acpResult = await api.acpList?.()
      if (acpResult?.ok) {setAcpMembers(acpResult.dynamic || [])}
    } catch {}
  }
  const handleRegisterAcp = async () => {
    if (!acpFormData.name || !acpFormData.url) {return}
    const api = (window as any).luminaAPI
    const result = await api.acpRegister?.({
      ...acpFormData,
      id: acpFormData.id || `acp_${Date.now()}`,
      capabilities: acpFormData.capabilities.split(',').map(s => s.trim()).filter(Boolean),
      triggers: acpFormData.triggers.split(',').map(s => s.trim()).filter(Boolean),
    })
    if (result?.ok) {
      setShowAcpPanel(false)
      setAcpFormData({ id: '', name: '', icon: '🌐', description: '', url: '', apiKey: '', model: '', systemPrompt: '', temperature: 0.7, maxTokens: 4096, capabilities: '', triggers: '' })
      await loadAcpMembers()
    } else {
      alert(result?.error || '注册失败')
    }
  }
  const handleRemoveAcp = async (id: string) => {
    const api = (window as any).luminaAPI
    const result = await api.acpUnregister?.(id)
    if (result?.ok) {await loadAcpMembers()}
    else {alert(result?.error || '移除失败')}
  }
  // 首次加载 ACP 成员
  useEffect(() => { loadAcpMembers() }, [])
  const [expandedAgent, setExpandedAgent] = useState<string | null>(null)  // 🔥 v2.8.1: 展开详细资料
  const [teamTab, setTeamTab] = useState<'chat' | 'tasks' | 'moments'>('chat')
  // 🌸 外部（桌宠"生活"入口）切换 朋友圈 / 剧场 / 日报 tab
  useEffect(() => {
    const onTeamTab = (e: Event) => {
      const tab = (e as CustomEvent).detail?.tab
      if (tab === 'moments') {setTeamTab(tab)}
    }
    window.addEventListener('lumina:team-tab', onTeamTab as EventListener)
    return () => window.removeEventListener('lumina:team-tab', onTeamTab as EventListener)
  }, [])
  const teamTabs = [
    { key: 'chat' as const, label: '群聊', icon: '💬' },
    { key: 'tasks' as const, label: '任务', icon: '📋' },
    { key: 'moments' as const, label: '朋友圈', icon: '🌸' },
  ]

  // 📋 角色选择界面控制
  const [showRoleSelector, setShowRoleSelector] = useState(() => messages.length <= 1)
  const [selectedRole, setSelectedRole] = useState<TaskType | null>(null)
  // 🔧 2026-08-11: 话题持续生效 — selectedRole 是持久话题（点卡片进入，← 退出）。
  //   ref 让 send/triggerDecision 等闭包始终读到最新话题，避免依赖数组膨胀。
  const selectedRoleRef = useRef<TaskType | null>(null)
  useEffect(() => { selectedRoleRef.current = selectedRole }, [selectedRole])
  const [decQuestion, setDecQuestion] = useState('')
  const [decContext, setDecContext] = useState('')
  const [decLoading, setDecLoading] = useState(false)
  // LLM面板控制 — 必须用 useLLMPanels() 才能响应状态变化
  const llmPanelState = useLLMPanels()
  const llmEnabled = llmPanelState.enabled
  const setLLMEnabled = (v: boolean) => { _llmState.enabled = v; _llmNotify() }
  const [llmRefreshing, setLLMRefreshing] = useState(false)
  const [llmError, setLLMError] = useState<string | null>(null)
  // 团队安全配置（用户可自定义）
  const [teamSecurity, setTeamSecurity] = useState<TeamSecurityConfig>(DEFAULT_TEAM_SECURITY)
  const teamDisabledTools = useMemo(() => getDisabledTools(teamSecurity), [teamSecurity])
  const teamToolsPrompt = useMemo(() => getGCToolsPrompt(teamSecurity), [teamSecurity])
  // 🆕 动画计数 + emoji
  const [msgCounter, setMsgCounter] = useState(0)
  const [showEmoji, setShowEmoji] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const isUserAtBottomRef = useRef(true)  // 🆕 v5.3: 用户是否在底部，控制是否自动滚底
  const gcTextareaRef = useRef<HTMLTextAreaElement>(null)
  const gcDragCounter = useRef(0)
  const [gcDragOver, setGcDragOver] = useState(false)
  const [gcDragFiles, setGcDragFiles] = useState<Array<{name:string,size:number,type:string}>>([])

  // 🔒 三档权限：主进程持久化的全局档位，Lumina / 热茶 / Yak 共用同一份
  const { perm, setTier: setPermTier } = usePermission()

  const answerHandlerRef = useRef<((ev: any, msgId?: string) => void) | null>(null)

  // 思考过程默认跟随输出状态（输出中展开、完毕收起），随时可手动开关。
  // userExpandedRef 记录"用户主动点开过"——这样自动收回不会把用户
  // 特意展开看的面板又弹回去。早期这里只有读没有写，是个死守卫，
  // 导致自动收回逻辑实际上从没起过作用。
  const toggleThinking = useCallback((msgId: string, streaming: boolean) => {
    setThinkingCollapsed(prev => {
      const nowCollapsed = !(msgId in prev ? prev[msgId] : !streaming)
      if (nowCollapsed) {userExpandedRef.current.delete(msgId)}
      else {userExpandedRef.current.add(msgId)}
      return { ...prev, [msgId]: nowCollapsed }
    })
  }, [])

  // 每个流独立的 Agent 事件监听器 — 彻底防止多 Agent 思考步骤串台
  //   之前使用单一共享 ref → IPC 事件队列中旧流事件可能泄漏到新流
  //   现在改为每流独立 onAgentEvent → 每个流的 IPC 监听器在流结束后被移除
  const subscribeAgentEvents = useCallback((cb: (ev: any) => void, requestId?: string) => {
    return window.luminaAPI.onAgentEvent((ev: any) => {
      // 🆕 P2-1：只处理「属于本次请求」的事件。
      //   后端会把 config.requestId 原样回显在每条事件上；若带的是**别的** id，
      //   说明它来自另一个在途请求（例如先前启动的后台任务），丢弃以免思考面板串台。
      //   事件不带 requestId 时按原行为放行（向后兼容）。
      if (requestId && ev?.requestId && ev.requestId !== requestId) {return}
      cb(ev)
    })
  }, [])

  // 🆕 全局监听 token_update 事件，更新上下文用量指示器
  useEffect(() => {
    const unsub = window.luminaAPI.onAgentEvent((ev: any) => {
      if (ev.type === 'token_update' && ev.promptTokens > 0) {
        const llmConfig = useStore.getState().llmConfig
        const cw = ev.contextWindow || llmConfig.contextWindow || 0
        useAgentRuntime.getState().setContextUsage(ev.promptTokens, cw)
      }
    })
    return () => { if (typeof unsub === 'function') {unsub()} }
  }, [])

  // fix: 使用 useRef 替代普通 let 变量，彻底解决协作阶段思考步骤串台
  //   问题：collabCurrentMsgId 是闭包中的 let 变量，IPC 事件异步触发时
  //   旧阶段的回调可能拿到新阶段的 msgId → 思考内容写错消息
  //   解决：useRef 保证所有闭包始终读取最新值
  const collabCurrentMsgIdRef = useRef('')
  const collabPhaseRef = useRef(0)  // 协作阶段计数器，事件回调只处理当前阶段
  /** 🆕 v16.0-fix: runningHistory 持久引用 — 协作阶段构建，供主回复阶段合并 */
  const runningHistoryRef = useRef<Array<{ role: 'system' | 'user' | 'assistant'; content: string }>>([])

  // 🍀 v1.0: Lucky 模式
  const luckyMode = useLuckyMode()

  // 🔁 Loop 引擎 — 团队级自驱任务
  const loopStore = useLoopStore()

  // 📋 任务派发中心
  const [showTaskDispatcher, setShowTaskDispatcher] = useState(false)

  // 🆕 工作区「派人」按钮 → 打开派发中心（跨组件事件总线）
  useEffect(() => {
    const open = () => setShowTaskDispatcher(true)
    window.addEventListener('lumina:open-dispatcher', open)
    return () => window.removeEventListener('lumina:open-dispatcher', open)
  }, [])

  // ═══ v2.14: TTS 排队播放 ═══
  const ttsQueueRef = useRef<Array<{text:string; voice:string}>>([])
  const [ttsQueueLen, setTtsQueueLen] = useState(0)
  const [ttsPlaying, setTtsPlaying] = useState(false)
  const enqueueTTS = useCallback((text: string, voice: string) => {
    ttsQueueRef.current.push({ text, voice })
    setTtsQueueLen(ttsQueueRef.current.length)
    if (ttsQueueRef.current.length === 1) {
      playNextTTS()
    }
  }, [])
  const playNextTTS = useCallback(() => {
    const item = ttsQueueRef.current[0]
    if (!item) { setTtsPlaying(false); setTtsQueueLen(0); return }
    setTtsPlaying(true)
    try {
      ttsEngine.speak({ text: item.text, voice: item.voice })
      // 等 TTS 播完（粗略估算：中文 ~4字/秒）
      const estimatedMs = Math.max(2000, item.text.length * 250)
      setTimeout(() => {
        ttsQueueRef.current.shift()
        setTtsQueueLen(ttsQueueRef.current.length)
        if (ttsQueueRef.current.length > 0) {
          playNextTTS()
        } else {
          setTtsPlaying(false)
        }
      }, estimatedMs)
    } catch {
      ttsQueueRef.current.shift()
      setTtsQueueLen(ttsQueueRef.current.length)
      playNextTTS()
    }
  }, [])
  const stopAllTTS = useCallback(() => {
    ttsEngine.stop()
    ttsQueueRef.current = []
    setTtsQueueLen(0)
    setTtsPlaying(false)
  }, [])

  // ═══ v2.14: 消息内联按钮 ═══
  const [hoveredMsgId, setHoveredMsgId] = useState<string | null>(null)
  const [deletingTarget, setDeletingTarget] = useState<GCMsg | null>(null)
  const [copiedMsgId, setCopiedMsgId] = useState<string | null>(null)

  // ═══ 群聊输入框自动撑高 ═══
  const gcAutoResize = useCallback(() => {
    const el = gcTextareaRef.current
    if (el) { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px' }
  }, [])

  const enhancePrompt = async () => {
    const original = input.trim()
    if (!original || promptEnhancing) {return}
    const currentConfig = useStore.getState().llmConfig
    if (!currentConfig.baseUrl || !currentConfig.model) {
      setPromptEnhanceNotice('❌ 先在模型选择器中配置 Endpoint 和 Model。')
      return
    }
    const enhanceApi = window.luminaAPI?.llmEnhancePrompt
    if (!enhanceApi) {
      setPromptEnhanceNotice('❌ 当前版本不支持提示词增强，请重启或重新构建应用。')
      return
    }

    setPromptEnhancing(true)
    setPromptEnhanceNotice('正在润色草稿（保留原意，只改表达）…')
    try {
      const result = await enhanceApi({
        baseUrl: currentConfig.baseUrl,
        apiKey: currentConfig.apiKey || '',
        model: currentConfig.model,
        text: original,
      })
      if (result?.error) {throw new Error(result.error)}
      const enhanced = String(result?.content || '').trim()
      if (!enhanced) {throw new Error('模型没有返回增强后的提示词。')}

      // 请求期间允许用户继续编辑；若草稿已变化，绝不覆盖用户新输入。
      const latestDraft = gcTextareaRef.current?.value?.trim() ?? input.trim()
      if (latestDraft !== original) {
        setPromptEnhanceNotice('增强已返回，但你期间修改了草稿；为避免覆盖，未替换当前内容。')
        return
      }

      // 若模型原样返回（说明原文已经够好），如实告诉用户，别假装"增强过了"
      if (enhanced === original) {
        setPromptEnhanceNotice('原文已经比较清晰，模型认为无需改写（草稿未变）。')
        return
      }

      setPromptEnhanceUndo(original)   // 存起来供一键撤销
      setInput(enhanced)
      const oLen = result?.originalChars ?? original.length
      const eLen = result?.enhancedChars ?? enhanced.length
      const ratio = oLen > 0 ? (eLen / oLen) : 1
      const ratioText = `${oLen} → ${eLen} 字${ratio > 1.8 ? '（变化较大，可撤销）' : ''}`
      setPromptEnhanceNotice(
        `✨ 已润色（${ratioText}）${result?.trimmed ? ' · 已按预算裁剪' : ''}；请检查后再发送。`,
      )
      requestAnimationFrame(() => gcAutoResize())
    } catch (err: any) {
      setPromptEnhanceNotice(`❌ 增强失败：${err?.message || err}`)
    } finally {
      setPromptEnhancing(false)
    }
  }

  /** 撤销上一次增强，恢复增强前的草稿 */
  const undoEnhancePrompt = () => {
    if (promptEnhanceUndo === null) {return}
    setInput(promptEnhanceUndo)
    setPromptEnhanceUndo(null)
    setPromptEnhanceNotice('已撤销增强，恢复为原来的草稿。')
    requestAnimationFrame(() => gcAutoResize())
  }

  // ═══ v2.7 群聊同步升级 ═══
  const [sttListening, setSttListening] = useState(false)
  const [sttStatus, setSttStatus] = useState<STTStatus | null>(null)
  // 🧰 v1.0 工具箱: 实时语音 & Computer Use 状态
  const [realtimeVoiceActive, setRealtimeVoiceActive] = useState(false)
  const [computerUseActive, setComputerUseActive] = useState(false)
  const abortRef = useRef(false)
  const soloTurnCount = useRef(0)       // v2.8.2: 连续单 Agent 轮数
  const [toolNotice, setToolNotice] = useState<string | null>(null)  // v2.8.3: 工具通知
  const toolNoticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 每个Agent独立音色（从localStorage恢复）
  const [agentVoices, setAgentVoices] = useState<Record<string, string>>(() => loadAgentVoices())
  const ttsConfig = useStore(s => s.ttsConfig)  // 🔧 v2.8.x: 从聊天模式同步TTS音色
  const setTTSConfig = useStore(s => s.setTTSConfig)
  
  /** 🔧 v2.8.x: 获取有效音色 — 优先群聊自定义 → 聊天模式设置 → 默认 */
  const getEffectiveVoice = useCallback((agentId: string): string => {
    return agentVoices[agentId] || ttsConfig.voice || AGENT_VOICES[agentId]
  }, [agentVoices, ttsConfig.voice])
  const [showTtsMenu, setShowTtsMenu] = useState(false)
  const [showGcVoicePicker, setShowGcVoicePicker] = useState(false) // 🔧 v2.9: 群聊TTS音色面板
  const [gcVoiceTarget, setGcVoiceTarget] = useState<string | null>(null) // 🔧 v2.9: 当前调整的Agent
  const [ttsToggling, setTtsToggling] = useState(false) // 🔧 v2.9: 静音切换动画
  const [gcAttachments, setGcAttachments] = useState<Array<{name:string,size:number,text?:string,imageDataUrl?:string}>>([])
  const [thinkingCollapsed, setThinkingCollapsed] = useState<Record<string, boolean>>({})
  const userExpandedRef = useRef<Set<string>>(new Set())
  /**
   * 思考过程当前该是什么状态：
   *   1. 用户手动点过 / 输出完毕自动收回过 → 显式记录优先
   *   2. 没记录过 → 正在输出（!_animDone）默认展开，输出完毕默认收起
   */
  const isThinkingCollapsed = (msgId: string, msg?: GCMsg): boolean => {
    if (msgId in thinkingCollapsed) {return thinkingCollapsed[msgId]}
    return Boolean(msg && msg._animDone)
  }
  const fileInputRef = useRef<HTMLInputElement>(null)
  // 🆕 v9.2: 任务类型路由优先 — 用户选了任务卡片后，send() 应优先使用卡片指定的 agent，而非关键词自动匹配
  const pendingTaskTypeRef = useRef<TaskType | null>(null)
  const pendingAgentIdRef = useRef<string | null>(null)  // 任务派发中心指定的执行者
  // ════════════════════════════════

  // 监听会话切换事件，重置回复状态防止混淆
  //
  // 🔧 2026-10-07：这里原先**也**会 setMessages(...)（handleLoad 设 loadGCMessages，
  //   handleNew 设 []），与下方 onLoad/onNew 那对监听器重复。两个监听器都在
  //   gc:new-session / gc:load-session 上，靠「注册顺序 + React 批处理里后者覆盖前者」
  //   才碰巧得到正确结果 —— 典型的顺序依赖隐患（换顺序或换 React 版本就会翻车）。
  //   下方那对是这里的**超集**（还会存当前会话、置基线、设 lastAgent、定落地页），
  //   所以这里只保留「重置回复状态」这一件它不管的事。
  useEffect(() => {
    const resetReplying = () => {setReplyingAgent(null)}
    window.addEventListener('gc:load-session', resetReplying)
    window.addEventListener('gc:new-session', resetReplying)
    return () => {
      window.removeEventListener('gc:load-session', resetReplying)
      window.removeEventListener('gc:new-session', resetReplying)
    }
  }, [])

  // 🆕 2026-10-13：跨 origin 兜底 —— 本 origin 的 localStorage 为空时，
  //   从主进程的 dialog 日志恢复群聊历史。
  //
  //   为什么需要：localStorage **按 origin 隔离**（开发模式 http://localhost:5173、
  //   打包模式 file://），切换运行方式后前端读不到任何会话 —— 用户以为「历史全丢了」。
  //   而 dialog 日志是**主进程的文件**，不受 origin 影响。
  //
  //   ⚠️ 只在 localStorage 为空时执行，绝不覆盖已有数据；
  //      并且在写入前**再查一次**（期间用户可能已经新建了会话）。
  useEffect(() => {
    if (loadGCSessions().length > 0) {return}
    const api = (window as any).luminaAPI
    if (!api?.gcRestoreFromLogs) {return}
    let cancelled = false
    api.gcRestoreFromLogs('lumina').then((res: any) => {
      if (cancelled || !res?.ok || !Array.isArray(res.sessions) || res.sessions.length === 0) {return}
      if (loadGCSessions().length > 0) {return}   // 期间已有数据 → 不覆盖
      const META: Record<string, { icon: string; name: string }> = {
        lumina: { icon: '🐱', name: 'Lumina' },
        recha: { icon: '🍵', name: '热茶' },
        yak: { icon: '📊', name: 'Yak' },
        user: { icon: '👤', name: '我' },
      }
      for (const s of res.sessions) {
        if (!Array.isArray(s.messages) || s.messages.length === 0) {continue}
        saveGCMessages(s.id, s.messages.map((m: any, i: number) => ({
          id: `restored-${s.id}-${i}`,
          from: m.from || 'lumina',
          fromIcon: META[m.from]?.icon || '🤖',
          fromName: META[m.from]?.name || String(m.from || ''),
          content: m.content || '',
          time: m.time || '',
          // 恢复的都是历史 → 标记已完成，否则渲染层会当成"还在打字"而展开思考过程
          _animDone: true,
        })) as any)
      }
      saveGCSessions(res.sessions.map((s: any) => ({
        id: s.id,
        date: new Date(s.lastAt || Date.now()).toLocaleDateString('zh-CN'),
        preview: s.preview || '（已恢复）',
        count: s.count || 0,
      })))
      window.dispatchEvent(new Event('gc:sessions-updated'))
      console.info(`[GroupChatView] 📥 已从主进程日志恢复 ${res.sessions.length} 个群聊会话（本 origin 的 localStorage 原本为空）`)
    }).catch(() => { /* 恢复失败不影响正常使用 */ })
    return () => { cancelled = true }
  }, [])

  // activeSessionId 变化时重置回复状态
  useEffect(() => {
    setReplyingAgent(null)
  }, [activeSessionId])

  // 🛠️ v8.1: 从其他面板回到聊天时，重新挂载 <textarea> 修复 Electron 焦点问题
  useEffect(() => {
    if (prevPanelRef.current !== 'chat' && activePanel === 'chat') {
      setInputKey(k => k + 1)
    }
    prevPanelRef.current = activePanel
  }, [activePanel])

  // Agent 接力过渡动画 — 平滑 Agent 间切换
  //   当 replyingAgent 从一个变成另一个时：
  //   1. 保留旧 agent 的 typing dots 250ms（避免突兀消失）
  //   2. 新 agent 的头像/名称触发脉冲动画
  //   3. 消息气泡平滑过渡
  useEffect(() => {
    if (replyingAgent && replyingAgent !== prevReplyingAgent) {
      setPrevReplyingAgent(replyingAgent)
      setAgentSwitchClass('agent-switch-pulse')
      const t = setTimeout(() => setAgentSwitchClass(''), 350)
      return () => clearTimeout(t)
    } else if (!replyingAgent) {
      setPrevReplyingAgent(null)
    }
  }, [replyingAgent, prevReplyingAgent])

  // 强制保存（绕过动画守卫）
  const forceSave = useCallback(() => {
    saveGCMessages(activeSessionId, messages)
    const preview = messages.filter(m => m.from === 'user').slice(-1)[0]?.content?.slice(0, 30) || ''
    // 🐛 2026-10-13：用 `loadGCSessions()`（最新）而不是组件内的 `sessions` state。
    //   同一个 key 有多个持有者（本组件 + GroupChatHistorySidebar），
    //   用过期副本构造列表会把对方新增的会话**整体覆盖掉** ——
    //   用户看到的就是「聊过的会话凭空消失」。
    const updated: GCSession[] = [
      { id: activeSessionId, date: new Date().toLocaleDateString('zh-CN'),
        preview, count: messages.length },
      ...loadGCSessions().filter(s => s.id !== activeSessionId),
    ]
    setSessions(updated)
    saveGCSessions(updated)
    window.dispatchEvent(new Event('gc:sessions-updated'))
  }, [activeSessionId, messages])

  // 🧹 流式合帧 ——
  // 推理 token 比帧还快，thinkingSteps 每个 token 都要 setMessages 一次，
  // 而 setMessages 会重建整个消息数组 → 所有消息重渲染 → 主线程被占满。
  // 症状就是"思考文字不像在打印" + "滚轮卡手"。
  // 这里按 messageId 合并到一帧里，最多每帧渲染一次；累积逻辑完全不变。
  const thinkPendingRef = useRef(new Map<string, ThinkingStep[]>())
  const thinkRafRef = useRef(0)
  const flushThinking = useCallback(() => {
    thinkRafRef.current = 0
    const batch = thinkPendingRef.current
    if (batch.size === 0) {return}
    const snapshot = new Map(batch)
    batch.clear()
    setMessages(prev => prev.map(m => {
      const steps = snapshot.get(m.id)
      // 只在不比现有数据旧时才覆盖：收尾处有直接 setMessages 写 thinkingSteps 的
      // "最终确认"，那一帧可能比排队中的合帧更完整，覆盖回去会丢步骤。
      if (!steps) {return m}
      if ((m.thinkingSteps?.length ?? 0) > steps.length) {return m}
      return { ...m, thinkingSteps: steps } as GCMsg
    }))
  }, [])
  const pushThinking = useCallback((msgId: string, steps: ThinkingStep[]) => {
    thinkPendingRef.current.set(msgId, steps)
    if (thinkRafRef.current) {return}
    thinkRafRef.current = requestAnimationFrame(flushThinking)
  }, [flushThinking])
  useEffect(() => () => {
    if (thinkRafRef.current) { cancelAnimationFrame(thinkRafRef.current); thinkRafRef.current = 0 }
  }, [])

  // 记录每个会话「加载时」的消息数基线。
  // 切换会话是只读操作：不应把该会话置顶、也不应把日期改成今天。
  // 只有真正产生了新消息（消息数 > 该会话基线）时，才更新会话元数据并置顶。
  const sessionBaselineRef = useRef<Record<string, number>>({})

  // 🆕 持久化 — v3.6: 只要有消息在动画中就不保存，让 animateTyping 完成时存
  useEffect(() => {
    if (messages.length <= 1) {return}
    // v3.6: 只要有一条消息还在动画中 → 不保存 → 防止空内容覆盖
    const hasAnimating = messages.some(m => m.from !== 'system' && !m.content && !(m as any)._animDone)
    if (hasAnimating) {return}
    saveGCMessages(activeSessionId, messages)
    // 仅当消息数真正增加（有新消息）时，才更新会话时间并置顶；
    // 仅仅切换/加载历史会话（消息数 === 基线）时保持原顺序、原日期。
    // 🐛 2026-10-13：传入 `loadGCSessions()`（最新）而不是组件内的 `sessions` state ——
    //   否则会用过期副本覆盖掉侧边栏等其他持有者新增的会话。
    const updated = buildSessionsOnPersist(
      loadGCSessions(), activeSessionId, messages, sessionBaselineRef.current[activeSessionId],
    )
    if (updated) {
      setSessions(updated)
      saveGCSessions(updated)
      window.dispatchEvent(new Event('gc:sessions-updated'))
    }
    sessionBaselineRef.current[activeSessionId] = messages.length
  }, [messages.length, msgCounter, activeSessionId])

  useEffect(() => {
    // 只在用户处于底部时自动滚底，允许用户自由翻阅历史
    // 原来挂在 [messages] 上且用 behavior:'smooth'——流式时每个 token 都是新引用，
    // 于是每秒最多发起 60 次平滑滚动：动画被反复打断重定向（滚轮"卡手"），
    // 而且用户刚往上拖一点就会被拽回底部。
    // 现在 rAF 合帧 + auto 定位，用户离开底部后彻底不再打扰。
    if (!isUserAtBottomRef.current) {return}
    if (scrollRafRef.current) {return}
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = 0
      if (!isUserAtBottomRef.current) {return}
      bottomRef.current?.scrollIntoView({ behavior: 'auto' })
    })
  }, [messages, replyingAgent, msgCounter])

  // 跟踪用户是否在底部，防止强制滚底打断翻阅
  const scrollRafRef = useRef(0)
  useEffect(() => () => {
    if (scrollRafRef.current) { cancelAnimationFrame(scrollRafRef.current); scrollRafRef.current = 0 }
  }, [])
  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current
    if (!el) {return}
    // 距底部 < 80px 视为"在底部"
    isUserAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }, [])

  // 新消息到达时，如果用户之前在底部，强制滚底（新对话）
  useEffect(() => {
    if (messages.length <= 2) {
      // 对话刚开始，强制滚底
      isUserAtBottomRef.current = true
      bottomRef.current?.scrollIntoView({ behavior: 'auto' })
    }
  }, [messages.length])

  // → 思考过程展开规则：
  //   正在输出 → 默认展开；输出完毕 → 默认收起；任何时候都能手动开关。
  //   早前这里有个 useEffect 把"未完成的消息"塞进 expandedThinking，
  //   但渲染层从来不读它，所以整段是死代码，展开/收起实际从没生效过。
  //   现在改由 isThinkingCollapsed() 直接按 m._animDone 派生，不再维护中间状态。
  const messagesRef = useRef(messages)
  messagesRef.current = messages
  const activeSessionRef = useRef(activeSessionId)
  activeSessionRef.current = activeSessionId

  /**
   * 会话安全写入（P0 修复 · 2026-10-10）
   *
   * 把「某一轮回复」的写入绑定到**发起它的会话**，而不是「当前正在看的会话」。
   *
   * 【旧实现的坑（静默数据损坏）】
   *   生成期间用户切走会话后，`setMessages(prev => saveGCMessages(activeSessionId, prev))`
   *   里的 `activeSessionId` 是闭包捕获的**旧值**，而 `prev` 已经是**新会话**的消息数组
   *   → 把新会话的内容写进旧会话的存档，旧会话历史被永久覆盖。
   *   同时回复按 `replyId` 在 `prev` 里查找必然落空 → 回复文本丢失。
   *
   * 【现在的语义】
   *   · 仍在发起会话 → 正常 setMessages（视图与存档一致）
   *   · 已切走       → 只更新**发起会话的存档**（读盘→改→写盘），绝不碰当前视图
   */
  const commitToSession = useCallback((sessionId: string, mutate: (msgs: GCMsg[]) => GCMsg[]) => {
    if (activeSessionRef.current === sessionId) {
      setMessages(prev => {
        const updated = mutate(prev)
        saveGCMessages(sessionId, updated)
        return updated
      })
      return
    }
    // 已切走：读发起会话的存档来改，避免把当前会话的内容写进去
    try {
      const stored = loadGCMessages(sessionId)
      if (stored.length > 0) {saveGCMessages(sessionId, mutate(stored))}
    } catch { /* 存档写入失败不影响当前会话 */ }
  }, [])

  // 思考过程自动收合逻辑已迁移到 animateTyping 完成时统一处理

  // 🆕 监听侧边栏加载/新建会话事件
  useEffect(() => {
    const onLoad = (e: Event) => {
      const newSessionId = (e as CustomEvent).detail as string
      const curId = activeSessionRef.current
      // 先存当前会话！避免切换时数据丢失
      if (curId && messagesRef.current.length > 1) {
        saveGCMessages(curId, messagesRef.current)
      }
      const msgs = loadGCMessages(newSessionId)
      setActiveSessionId(newSessionId)
      // 标记加载基线：加载历史会话不算新增消息，不置顶、不改日期
      sessionBaselineRef.current[newSessionId] = Math.max(msgs.length, 1)
      if (msgs.length > 0) {
        setMessages(msgs)
        // 🆕 2026-10-07：按会话内容决定落在哪一屏 ——
        //   只有系统欢迎语（≤1 条）= 空会话 → 回到任务类型选择页；
        //   有真实历史 → 直接看聊天，不要让用户再点一次。
        setShowRoleSelector(msgs.length <= 1)
        const lastAgentMsg = [...msgs].reverse().find(m => AGENTS.some(a => a.id === m.from))
        if (lastAgentMsg) {setLastAgent(lastAgentMsg.from)}
        else {setLastAgent(null)}
      } else {
        // 空会话也显示欢迎消息，防止旧消息残留
        setShowRoleSelector(true)
        setSelectedRole(null)
        setMessages([{
          id: '0', from: 'system', fromIcon: '🤖', fromName: '系统',
          content: llmReady
            ? `👋 新的团队群聊！你 + Lumina🐱 + 热茶🍵 + Yak📊 都在这里。\n\n💡 直接发消息，Lumina 会帮你叫合适的队友回复\n💡 @某人：输入 @Lumina / @热茶 / @Yak 指定回复者`
            : `👋 新的团队群聊！\n\n⚠️ 未配置 LLM，当前为模拟回复模式。`,
          time: formatDateLabel(Date.now()),
        }])
        setLastAgent(null)
      }
      // 🆕 同步 sessions：避免侧边栏删除/新建后 GroupChatView 的旧状态覆写 localStorage
      setSessions(loadGCSessions())
    }
    const onNew = (e: Event) => {
      const newSessionId = (e as CustomEvent).detail as string
      const curId = activeSessionRef.current
      // 先存当前会话！
      if (curId && messagesRef.current.length > 1) {
        saveGCMessages(curId, messagesRef.current)
      }
      setActiveSessionId(newSessionId)
      sessionBaselineRef.current[newSessionId] = 1
      // 🆕 2026-10-07（用户反馈）：新建会话时回到**任务类型选择页**。
      //   此前 onNew 只重置了消息，没重置 showRoleSelector —— 于是「刚聊完点 + 新建」
      //   会停在空白聊天页，而不是那个更好用的角色卡片落地页。
      //   一并清掉 selectedRole，避免新会话残留上一个任务类型的氛围屏。
      setShowRoleSelector(true)
      setSelectedRole(null)
      setMessages([{
        id: '0', from: 'system', fromIcon: '🤖', fromName: '系统',
        content: llmReady
          ? `👋 新的团队群聊！你 + Lumina🐱 + 热茶🍵 + Yak📊 都在这里。\n\n💡 直接发消息，Lumina 会帮你叫合适的队友回复\n💡 @某人：输入 @Lumina / @热茶 / @Yak 指定回复者`
          : `👋 新的团队群聊！\n\n⚠️ 未配置 LLM，当前为模拟回复模式。`,
        time: formatDateLabel(Date.now()),
      }])
      setLastAgent(null)
      setSessions(loadGCSessions())
    }
    window.addEventListener('gc:load-session', onLoad)
    window.addEventListener('gc:new-session', onNew)
    return () => {
      window.removeEventListener('gc:load-session', onLoad)
      window.removeEventListener('gc:new-session', onNew)
    }
  }, [llmReady])

  // 注入情绪条 CSS 动画
  useEffect(() => { injectEmotionStyles() }, [])

  // 🧰 v1.0: 工具箱状态轮询（实时语音 + Computer Use 状态同步）
  useEffect(() => {
    const timer = setInterval(async () => {
      try {
        const voiceStatus = await window.luminaAPI?.agentRealtimeVoiceStatus?.()
        if (voiceStatus && voiceStatus.active !== realtimeVoiceActive) {
          setRealtimeVoiceActive(voiceStatus.active)
        }
        const cuStatus = await window.luminaAPI?.agentComputerUseStatus?.()
        if (cuStatus && cuStatus.active !== computerUseActive) {
          setComputerUseActive(cuStatus.active)
        }
      } catch { /* 静默忽略 */ }
    }, 3000)
    return () => clearInterval(timer)
  }, [realtimeVoiceActive, computerUseActive])

  // ═══ v2.7 语音输入 ═══
  const toggleMic = useCallback(async () => {
    if (sttListening) {
      sttService.stop()
      setSttListening(false)
      setSttStatus(null)
      return
    }
    try {
      setSttListening(true)
      setSttStatus({ listening: true, engine: 'web-speech', engineLabel: 'Web Speech', retryCount: 0 })
      sttService.setCallbacks(
        (text: string) => setInput(prev => prev + text),
        (s: STTStatus) => { setSttStatus(s); if (!s.listening) {setSttListening(false)} },
      )
      await sttService.start()
    } catch (e) {
      console.warn('GC STT failed:', e)
      setSttListening(false)
      setSttStatus({ listening: false, engine: 'web-speech', engineLabel: 'Web Speech', error: String(e), retryCount: 0 })
      setTimeout(() => setSttStatus(null), 2000)
    }
  }, [sttListening])

  // ═══ v2.7 文件上传 ═══
  const processGCFile = useCallback(async (files: FileList | File[]) => {
    const fileArr = Array.from(files)
    const newAttachments: typeof gcAttachments = []
    // v8.1: 已知的二进制/压缩文档格式（不能当文本读）
    const BINARY_EXTS = new Set([
      'docx','xlsx','pptx','pdf','zip','rar','7z','tar','gz','bz2','xz',
      'exe','dll','so','dylib','dmg','iso','bin','dat',
      'mp3','mp4','avi','mov','wmv','flv','mkv','webm','wav','flac','ogg','aac','m4a','opus',
      'png','jpg','jpeg','gif','bmp','ico','webp','svgz','tiff','tif','psd','ai','eps',
      'woff','woff2','ttf','eot','otf','ttc',
      'pyc','pyo','class','jar','apk','aab','dex','wasm',
      'db','sqlite','sqlite3','mdb','accdb','frm','ibd','myd','myi',
      'o','a','lib','la','obj','pdb','pch','ilk','exp',
      'pak','vpk','wad','bsp','pk3','pk4',
    ])
    for (const f of fileArr) {
      try {
        const ext = f.name.split('.').pop()?.toLowerCase() || ''
        const isImage = f.type.startsWith('image/') || ['png','jpg','jpeg','gif','bmp','ico','webp','tiff','tif','psd'].includes(ext)
        const isBinary = BINARY_EXTS.has(ext) && !isImage
        if (isImage) {
          // 🔧 P2-fix: Visual Compact — 压缩图片为 base64，避免大图撑爆上下文
          //   策略：超过 1MB 的图片压缩到 1920px 宽，质量 0.7，输出 JPEG
          //   超过 500KB 但小于 1MB 的图片压缩到 1280px 宽，质量 0.8
          //   小于 500KB 的图片保持原样
          const MAX_ORIGINAL_SIZE = 1024 * 1024 // 1MB
          const COMPRESSED_WIDTH_LARGE = 1920
          const COMPRESSED_WIDTH_MEDIUM = 1280
          const COMPRESSED_QUALITY_LARGE = 0.7
          const COMPRESSED_QUALITY_MEDIUM = 0.8

          const imageDataUrl = await new Promise<string>((resolve) => {
            const reader = new FileReader()
            reader.onload = async () => {
              const originalDataUrl = reader.result as string
              // 小图直接使用，不压缩
              if (f.size < 500 * 1024) {
                resolve(originalDataUrl)
                return
              }
              try {
                const compressed = await compressImage(originalDataUrl, f.size > MAX_ORIGINAL_SIZE
                  ? COMPRESSED_WIDTH_LARGE
                  : COMPRESSED_WIDTH_MEDIUM,
                  f.size > MAX_ORIGINAL_SIZE ? COMPRESSED_QUALITY_LARGE : COMPRESSED_QUALITY_MEDIUM)
                resolve(compressed)
              } catch {
                // 压缩失败，回退到原图
                resolve(originalDataUrl)
              }
            }
            reader.onerror = () => resolve(`[图片: ${f.name} 读取失败]`)
            reader.readAsDataURL(f)
          })

          newAttachments.push({
            name: f.name, size: f.size,
            text: `[图片: ${f.name} (${(f.size / 1024).toFixed(1)}KB)]`,
            imageDataUrl,  // v10.9: base64 图片数据，供视觉模型使用
          })
        } else if (isBinary) {
          const friendlyName: Record<string, string> = {
            docx: 'Word 文档', xlsx: 'Excel 表格', pptx: 'PPT 演示文稿',
            pdf: 'PDF 文档', zip: 'ZIP 压缩包', rar: 'RAR 压缩包',
            '7z': '7z 压缩包', tar: 'TAR 压缩包',
            pyc: 'Python 编译文件', class: 'Java 字节码', jar: 'JAR 包', apk: 'APK 安装包',
            mp3: '音频', mp4: '视频', wav: '音频', flac: '无损音频',
            exe: '可执行程序', dll: 'DLL 动态库', so: '动态链接库',
          }
          // v8.1: 对 .docx/.xlsx/.pptx (ZIP容器) 和 .pdf 尝试走 IPC 提取文本
          let extractedText = ''
          if (['docx','xlsx','pptx','pdf'].includes(ext)) {
            try {
              const api = (window as any).luminaAPI
              if ((f as any).path && api?.fileExtractText) {
                const result = await api.fileExtractText((f as any).path)
                if (result?.text) {extractedText = result.text}
              }
              // fallback: 如果 file.path 不可用或失败，传文件内容
              if (!extractedText && api?.fileExtractTextFromBuffer) {
                const buf = await f.arrayBuffer()
                const uint8 = new Uint8Array(buf)
                const result = await api.fileExtractTextFromBuffer(ext, Array.from(uint8))
                if (result?.text) {extractedText = result.text}
              }
              if (extractedText) {
                const truncated = extractedText.slice(0, 15000)
                extractedText = truncated + (extractedText.length > 15000 ? '\n...(已截断，前15000字)' : '')
              }
            } catch { /* 提取失败则 fall through */ }
          }
          newAttachments.push({
            name: f.name, size: f.size,
            text: extractedText || `[📎 上传了${friendlyName[ext] || ext.toUpperCase() + ' 文件'}: ${f.name} (${(f.size / 1024).toFixed(1)}KB)]
⚠️ 文本提取失败，无法读取文件内容。
请根据文件名和用户的问题，尽力回答。如果确实需要文件内容才能回答，告诉用户你暂时无法读取该文件，请他们手动复制粘贴关键内容给你。`,
          })
        } else {
          // 文本类文件：读取内容
          const text = await f.text()
          const truncated = text.slice(0, 15000)
          newAttachments.push({
            name: f.name, size: f.size,
            text: truncated + (text.length > 15000 ? '\n...(已截断，前15000字)' : ''),
          })
        }
      } catch {
        newAttachments.push({
          name: f.name, size: f.size,
          text: `[⚠️ 无法读取文件内容: ${f.name} — 此文件类型暂不支持文本提取]`,
        })
      }
    }
    if (newAttachments.length > 0) {setGcAttachments(prev => [...prev, ...newAttachments])}
  }, [])

  // ═══ v2.14: 消息内联按钮操作 ═══
  const handleCopyMsg = useCallback((content: string, msgId: string) => {
    navigator.clipboard.writeText(content).catch(() => {})
    setCopiedMsgId(msgId)
    showToast('✅ 已复制', 'success')
    setTimeout(() => setCopiedMsgId(null), 2000)
  }, [])

  const handleResendMsg = useCallback((content: string) => {
    setInput(content)
    setTimeout(() => {
      gcTextareaRef.current?.focus()
      const el = gcTextareaRef.current
      if (el) {el.setSelectionRange(el.value.length, el.value.length)}
    }, 50)
  }, [setInput])

  const handleBookmarkMsg = useCallback((m: GCMsg) => {
    addBookmark({
      content: m.content,
      from: m.from,
      fromName: m.fromName,
      fromIcon: m.fromIcon,
      source: `group:${activeSessionId}`,
    })
    showToast('⭐ 已收藏', 'success')
  }, [activeSessionId])

  const handleDeleteRequest = useCallback((m: GCMsg) => {
    setDeletingTarget(m)
  }, [])

  const handleDeleteConfirm = useCallback(() => {
    if (!deletingTarget) {return}
    setMessages(prev => prev.filter(m => m.id !== deletingTarget.id))
    setMsgCounter(c => c + 1)
    setDeletingTarget(null)
    showToast('已删除', 'success')
  }, [deletingTarget, setMessages])

  const handleGCFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files) {return}
    await processGCFile(e.target.files)
    e.target.value = ''
  }, [processGCFile])

  const handleGCDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation()
    setGcDragOver(false)
    if (e.dataTransfer.files.length > 0) {await processGCFile(e.dataTransfer.files)}
  }, [processGCFile])

  // ═══ v2.7 流式打字效果 ═══
  //  sessionId 可选：传「发起这一轮的会话」即可在用户中途切走时仍正确落档（见 commitToSession）。
  const animateTyping = useCallback((msgId: string, fullTextRaw: string, sessionId?: string) => {
    const sid = sessionId || activeSessionRef.current
    // 🆕 2026-10-13：空文本兜底 —— **最后一道防线**。
    //
    //   实测（读 localStorage 落盘数据）：主窗口会话里存着 content 为 `''` 且
    //   `_animDone: true` 的 assistant 消息。成因是这里的 `i >= fullText.length`
    //   在空串上**立即成立**（0 >= 0）→ 直接写入空内容并标记完成；
    //   重启后 `loadGCMessages` 会把它过滤掉 → 用户看到「我问了但没回复」，
    //   而且那条气泡**凭空消失**，比显示"没答上来"更让人困惑。
    //
    //   空回复的来源有多条（后端返回空 / 清洗链把内容剥空 / 流式被打断），
    //   与其逐个去堵，不如在这里统一兜住 —— 它覆盖所有路径。
    const fullText = fullTextRaw && fullTextRaw.trim()
      ? fullTextRaw
      : '（这轮没能生成有效回复。可以让我再说一次，或换个说法试试。）'
    // 仍在发起会话才动视图；否则只改该会话的存档
    const applyTyping = (mutate: (msgs: GCMsg[]) => GCMsg[]) => {
      if (activeSessionRef.current !== sid) {return}
      setMessages(prev => mutate(prev))
    }
    let i = 0
    const intervalMs = 16
    const timer = setInterval(() => {
      if (abortRef.current) {
        clearInterval(timer)
        // v2.14: 中断时至少保存已输入的内容
        commitToSession(sid, prev => prev.map(m =>
          m.id === msgId ? { ...m, content: fullText.slice(0, i), _animDone: false } as any : m,
        ))
        return
      }
      if (i >= fullText.length) {
        clearInterval(timer)
        commitToSession(sid, prev => {
          const updated = prev.map(m => m.id === msgId ? { ...m, content: fullText, _animDone: true } as any : m)
          // v3.6: 写作完成后同步更新会话列表
          const preview = updated.filter(m => m.from === 'user').slice(-1)[0]?.content?.slice(0, 30) || ''
          const sessions: GCSession[] = [
            { id: sid, date: new Date().toLocaleDateString('zh-CN'),
              preview, count: updated.length },
            ...JSON.parse(localStorage.getItem('lumina_gc_sessions') || '[]').filter((s: GCSession) => s.id !== sid),
          ]
          saveGCSessions(sessions)
          window.dispatchEvent(new Event('gc:sessions-updated'))
          return updated
        })
        // 回复完毕 → 思考过程自动收回。
        // 注意必须放在 setMessages 外面：早前这段 setState 写在 updater
        // 里（reducer 里改别的 state），StrictMode 下会跑两次，是 React 明确的反模式。
        // 用户主动点开过就尊重用户意图，不再强制弹回去。
        if (!userExpandedRef.current.has(msgId)) {
          setThinkingCollapsed(prev => ({ ...prev, [msgId]: true }))
        }
        return
      }
      // 代码块一次性追加
      if (fullText.slice(i, i + 3) === '```') {
        const end = fullText.indexOf('```', i + 3)
        i = end !== -1 ? end + 3 : i + 1
      } else {
        i++
      }
      applyTyping(prev => prev.map(m => m.id === msgId ? { ...m, content: fullText.slice(0, i) } as any : m))
    }, intervalMs)
    return () => clearInterval(timer)
  }, [commitToSession])

  const parseMention = (text: string): string | null => {
    const m = text.match(/@(Lumina|lumina|热茶|recha|Yak|yak)/)
    return m ? AGENTS.find(a => a.name === m[1] || a.id === m[1].toLowerCase())?.id || null : null
  }

  /**
   * 🔧 v3.6: 智能任务识别 → 路由到正确的 Agent
   * 🆕 v3.7: 增加 discussion 类型；强化 coding 与 analysis 模式
   * 返回: 'coding' | 'analysis' | 'chat' | 'discussion'
   */
  const detectTaskIntent = (text: string): 'coding' | 'analysis' | 'chat' | 'discussion' => {
    const codingPatterns = [
      /写(个|一个|段)?(代码|程序|脚本|网页|页面|组件|文件|文档)/,
      /(编程|编码|改代码|修bug|修复|debug|重构|实现|开发)/,
      /(创建|新建|生成|帮我写|做一个?)(.*?)(文件|代码|程序|脚本|网页|项目|应用|app)/,
      /\.(py|ts|tsx|js|html|css|java|go|rs|cpp|c|vue|svelte|swift|kt|sh|bat|ps1)\b/,
      /(react|vue|next\.js|express|flask|django|spring|node\.js)/i,
      /(api|接口|数据库|前端|后端|全栈|命令行|cli)/,
      /(帮我|能不能|可以)(写|做|开发|实现|创建|改)/,
      /(修改|改一下|改改|完善|优化|改进).*?(代码|文件|程序|功能)/,
      /(shell|bash|terminal|command|命令|终端|控制台)/i,
      /(安装|配置|部署|docker|git|npm|yarn|pnpm|pip|maven|gradle)/i,
      /(编译|运行|执行|测试|打包|构建|build|compile|run|test)/i,
      // 🆕 v3.7: 更多编程触发词
      /(正则|regex|sql|查询|排序|算法|数据结构|类|函数|方法)/i,
      /(怎么写|怎么改|怎么实现|实现.*?功能|添加.*?功能)/,
    ]
    if (codingPatterns.some(p => p.test(text))) {return 'coding'}

    const analysisPatterns = [
      /(分析|研究|调查|统计|对比|评估|report|报告)/,
      /(数据|趋势|行情|市场|股票|价格|走势)/,
      /(查一下|搜索|找一下|看看有没有|有没有.*?数据)/,
      /(最近|最新|今天|本周|昨天).*?(新闻|消息|动态|热点|资讯)/,
      // 🆕 v3.7: 更多分析触发词
      /(整理|汇总|归纳|总结|总结一下|概括|提炼)/,
      /(解读|解读一下|怎么看|你觉得.*?怎么样|评价|评价一下)/,
      /(对比|比较|区别|差异|优缺点|利弊)/,
      /(查找|检索|搜一下|查资料|找资料|查询)/,
      /(信息|资料|文档|文献|论文|文章|blog|博客)/i,
    ]
    if (analysisPatterns.some(p => p.test(text))) {return 'analysis'}

    const discussionPatterns = [
      /(讨论|聊聊|聊一下|商量|商议|商议一下|头脑风暴|各抒己见)/,
      /(大家觉得|你们觉得|大家说说|你们说呢|怎么样\?|好不好\?)/,
      /(要不要|该不该|应不应该|是否应该|行不行|能不能)/,
      /(观点|看法|想法|建议|意见|主意|方案|计划)/,
      /(投票|表决|决定|选择|选哪个|挑一个)/,
      /(觉得怎样|怎么看|如何看|有什么想法|有什么建议)/,
      /(如果.*?会怎样|假如|假设|设想)/,
      /(先说|先说下|说个事|有事商量|开个会)/,
    ]
    if (discussionPatterns.some(p => p.test(text))) {return 'discussion'}

    return 'chat'
  }

  /** 🆕 v3.7: 识别编程任务的工程体量 — 小/中/大 */
  const detectCodeScale = (text: string): 'small' | 'medium' | 'large' => {
    // 大型工程特征：多模块、完整项目、重构、架构
    const largePatterns = [
      /(完整|完整项目|全新项目|从零开始|从头搭建|脚手架)/,
      /(重构|架构|架构设计|系统设计|整体|全局)/,
      /(多模块|多组件|多页面|大规模|复杂|大型)/,
      /(全栈|前后端|微服务|分布式|集群)/,
      /(框架|平台|引擎|核心|底层|基础库)/,
      /(部署架构|CI|CD|流水线|pipeline|持续集成)/i,
      /(迁移|升级|改造|兼容|适配)/,
    ]
    if (largePatterns.some(p => p.test(text))) {return 'large'}

    // 中型特征：多文件、组件/模块、接口
    const mediumPatterns = [
      /(多个文件|多文件|组件|模块|子模块)/,
      /(API|接口|路由|中间件|服务|service)/i,
      /(页面|功能模块|功能组件|工具集|工具类)/,
      /(前端页面|后端服务|管理后台|仪表盘|dashboard)/i,
      /(中等|不太大|不太小|有点复杂)/,
      /(增删改查|CRUD|表单|表格|列表|详情)/i,
      /(集成|对接|接入|调用|整合)/,
    ]
    if (mediumPatterns.some(p => p.test(text))) {return 'medium'}

    // 默认为小型（单个文件、简单脚本、快速修改）
    return 'small'
  }

  /** 🆕 v3.7: 根据任务类型路由到正确的 Agent — 热茶编码、Yak分析、Lumina日常+讨论 */
  const routeToAgent = (intent: ReturnType<typeof detectTaskIntent>) => {
    switch (intent) {
      // 🔧 2026-10-07 修复：这两行曾经**接反了** —— coding 派给热茶、analysis 派给 Yak。
      //   热茶是「只读审查员」，没有写权限；把编码请求派给她，她只能回
      //   「我不会写代码」，用户得到的是死胡同。
      //   项目里 delegate_to 的注释早就写过这个坑（「历史版本这里是反的，
      //   会把编码任务派给没有写权限的一方，等于任务注定失败」）——
      //   主委托路径修了，**群聊这条路由漏了**。
      case 'coding':   return AGENTS.find(a => a.id === 'yak')!      // 写代码 → Yak（代码工程师）
      case 'analysis': return AGENTS.find(a => a.id === 'recha')!    // 审查/分析 → 热茶（审查员）
      case 'discussion': return AGENTS.find(a => a.id === 'lumina')! // 讨论由 Lumina 牵头
      case 'chat':     return AGENTS.find(a => a.id === 'lumina')!
    }
  }

  /**
   * 🆕 2026-10-07 能力守卫：@ 了只读成员（热茶）却要它「动手写」时，
   * 改派给有写权限的成员（Yak）。
   *
   * 【为什么】热茶的权限是只读（rolePolicy deny file_write/file_edit/shell_exec），
   *   被要求写代码时它**物理上做不到**，只能回一句「我不会写代码」。
   *   用户看到的是「我叫他们写代码，他们说不会」——死胡同，且显得团队无能。
   *   改派之后用户直接拿到代码，而且**只在「目标确实做不到」时才改**：
   *   明确的审查意图仍然尊重用户的 @ 选择。
   */
  const upgradeReadOnlyTarget = (targetId: string, text: string, intent: ReturnType<typeof detectTaskIntent>): string | null => {
    if (targetId !== 'recha') {return null}
    // 明确的审查/评估意图 → 尊重用户选择，不改派
    if (/审查|review|评审|复核|挑错|找错|找bug|风险|评估|对比|权衡|检查|看看有没有问题/i.test(text)) {
      return null
    }
    // 其余判为编码 → 交给有写权限的 Yak
    return intent === 'coding' ? 'yak' : null
  }

  /** 🆕 v3.0: 生成工具操作的详细描述 */
  const describeToolAction = useCallback((tool: string, args: Record<string, any> | undefined): { label: string; detail: string } => {
    const a = args || {}
    switch (tool) {
      case 'shell':
      case 'shell_exec':
        return {
          label: `💻 执行命令`,
          detail: a.command || a.cmd || '(无命令)',
        }
      case 'file_read':
        return {
          label: `📖 读取文件`,
          detail: a.filePath || a.path || a.file_path || a.file || '(未知路径)',
        }
      case 'file_write':
        return {
          label: `📝 写入文件`,
          detail: a.filePath || a.path || a.file_path || a.file || '(未知路径)',
        }
      case 'file_edit':
        return {
          label: `✏️ 编辑文件`,
          detail: `${a.filePath || a.path || a.file_path || a.file || '(未知)'} ${a.oldText || a.old_text ? '→ 替换内容' : ''}`,
        }
      case 'file_list':
        return {
          label: `📂 列出目录`,
          detail: a.dirPath || a.path || a.directory || '(当前目录)',
        }
      case 'open_file':
        return {
          label: `📂 打开`,
          detail: a.target || a.path || a.filePath || a.file || '(未知路径)',
        }
      case 'browser':
      case 'browser_use':
        return {
          label: `🌐 浏览器操作`,
          detail: a.action ? `${a.action}${a.url ? ' ' + a.url : ''}` : (a.url || '(浏览器)'),
        }
      case 'search':
      case 'web_search':
        return {
          label: `🔍 搜索`,
          detail: a.query || a.keyword || a.text || '(搜索)',
        }
      case 'git':
        return {
          label: `📦 Git 操作`,
          detail: a.command || a.action || '(git)',
        }
      case 'delegate_to':
        return {
          label: `🤝 委托任务`,
          detail: `→ ${a.agent || a.to || '(队友)'}`,
        }
      case 'use_skill':
        return {
          label: `🧰 加载技能`,
          detail: a.skill || a.name || '(技能)',
        }
      case 'memory_search':
      case 'memory_store':
        return {
          label: `🧠 记忆操作`,
          detail: a.query || a.key || '(记忆)',
        }
      default:
        const genericNotice = getToolNotification(tool, a)
        return {
          label: genericNotice || `🔧 ${tool}`,
          detail: a ? JSON.stringify(a).slice(0, 120) : '',
        }
    }
  }, [])

  /** 根据任务类型返回 Agent 执行配置 */
  const getTaskConfig = (isCoding: boolean, override?: Partial<{
    maxToolCalls: number; mode: 'chat' | 'agent'; temperature: number; maxTokens: number
  }>, taskTypeOverride?: TaskType | null) => {
    // fix: 群聊场景默认使用 agent 模式，确保工具调用可用
    //   如果调用方明确传入 mode='chat' 才使用 chat 模式
    const effectiveMode = override?.mode || 'agent'
    // 🧠 v10.8: 根据任务类型动态调整温度 — 知识/代码任务需要确定性，聊天需要创造性
    // 🔧 2026-08-11: pendingTaskTypeRef 在 send() 里被一次性消费置 null，
    //   导致 getTaskConfig 内部读取时永远拿到 null → 学习辅导/情报监控/写作创作
    //   的温度与工具轮次配置全部失效，全部退回默认 0.7 温度。
    //   修复：由调用方显式传入 send() 开头已读取的 explicitTaskType。
    const currentTaskType = taskTypeOverride !== undefined ? taskTypeOverride : pendingTaskTypeRef.current

    // ── 代码开发：极低温度保证代码正确性 ──
    if (isCoding) {
      const codingWhitelist = new Set([
        'file_read', 'file_write', 'file_edit', 'file_list',
        'shell_exec',
        'open_file',
        'git_status', 'git_diff', 'git_commit', 'git_log',
      ])
      const codingDisabled = teamDisabledTools.filter(t => !codingWhitelist.has(t))
      return {
        mode: effectiveMode as 'chat' | 'agent',
        maxToolCalls: override?.maxToolCalls ?? 12,
        temperature: override?.temperature ?? 0.05,  // 🧠 极低温度：代码必须准确
        maxTokens: override?.maxTokens ?? 16384,
        contextWindow: llmConfig.contextWindow || 0,
        disabledTools: codingDisabled,
      }
    }

    // ── 学习辅导：低温度保证知识准确性 ──
    if (currentTaskType === 'learn') {
      const chatModeDisabled = [...teamDisabledTools]
      const CHAT_BLOCKED = ['system_info', 'process_list', 'notification', 'screenshot',
        'mail_send', 'open_file',
      ]
      for (const t of CHAT_BLOCKED) {
        if (!chatModeDisabled.includes(t)) {chatModeDisabled.push(t)}
      }
      return {
        mode: effectiveMode as 'chat' | 'agent',
        maxToolCalls: override?.maxToolCalls ?? 4,  // 学习场景不需要太多工具轮次
        temperature: override?.temperature ?? 0.1,  // 🧠 低温度：知识必须准确
        maxTokens: override?.maxTokens ?? 16384,   // 学习回答可以稍长
        contextWindow: llmConfig.contextWindow || 0,
        disabledTools: chatModeDisabled,
      }
    }

    // ── 情报监控 / 代码开发(task dispatch)：中低温度保证信息准确 ──
    if (currentTaskType === 'intel' || currentTaskType === 'code') {
      const chatModeDisabled = [...teamDisabledTools]
      const CHAT_BLOCKED = ['system_info', 'process_list', 'notification', 'screenshot',
        'mail_send', 'open_file',
      ]
      for (const t of CHAT_BLOCKED) {
        if (!chatModeDisabled.includes(t)) {chatModeDisabled.push(t)}
      }
      return {
        mode: effectiveMode as 'chat' | 'agent',
        maxToolCalls: override?.maxToolCalls ?? 8,
        temperature: override?.temperature ?? 0.2,  // 🧠 中低温度：信息/代码需要准确
        maxTokens: override?.maxTokens ?? 16384,
        contextWindow: llmConfig.contextWindow || 0,
        disabledTools: chatModeDisabled,
      }
    }

    // ── 写作创作：中等温度平衡创意与质量 ──
    if (currentTaskType === 'write') {
      const chatModeDisabled = [...teamDisabledTools]
      const CHAT_BLOCKED = ['system_info', 'process_list', 'notification', 'screenshot',
        'mail_send', 'open_file',
      ]
      for (const t of CHAT_BLOCKED) {
        if (!chatModeDisabled.includes(t)) {chatModeDisabled.push(t)}
      }
      return {
        mode: effectiveMode as 'chat' | 'agent',
        maxToolCalls: override?.maxToolCalls ?? 6,
        temperature: override?.temperature ?? 0.5,  // 🧠 中等温度：写作需要一定创意
        maxTokens: override?.maxTokens ?? 16384,
        contextWindow: llmConfig.contextWindow || 0,
        disabledTools: chatModeDisabled,
      }
    }

    // ── 默认（日常聊天 / 商业设计 / 职场办公）：保持较高温度 ──
    const chatModeDisabled = [...teamDisabledTools]
    const CHAT_BLOCKED = ['system_info', 'process_list', 'notification', 'screenshot',
      'mail_send', 'open_file',
    ]
    for (const t of CHAT_BLOCKED) {
      if (!chatModeDisabled.includes(t)) {chatModeDisabled.push(t)}
    }
    return {
      mode: effectiveMode as 'chat' | 'agent',
      maxToolCalls: override?.maxToolCalls ?? 6,
      temperature: override?.temperature ?? 0.7,  // 默认温度：日常聊天保持自然
      maxTokens: override?.maxTokens ?? 16384,
      contextWindow: llmConfig.contextWindow || 0,
      disabledTools: chatModeDisabled,
    }
  }

  /** 📋 任务派发中心 — 处理派发的回调 */
  const handleTaskDispatch = useCallback((taskType: TaskType, agentId: string, prompt: string) => {
    const card = TASK_TYPE_CARDS.find(c => c.id === taskType)
    const agent = TEAM_MEMBERS.find(m => m.id === agentId)

    if (!card || !agent) {return}

    // 构造派发消息
    const dispatchMsg = `📋 任务派发：${card.icon} ${card.name}\n\n` +
      `🎯 任务：${prompt || card.desc}\n` +
      `👤 执行者：${agent.icon} ${agent.name}\n\n` +
      `💡 请${agent.name}开始处理此任务。`

    // 在群聊中显示派发消息
    setMessages(prev => [...prev, {
      id: `dispatch-${Date.now()}`,
      from: 'system',
      fromIcon: '📋',
      fromName: '任务派发',
      content: dispatchMsg,
      time: formatDateLabel(Date.now()),
    }])
    setMsgCounter(c => c + 1)

    // 🆕 v9.2: 记住任务类型和指定执行者，send() 会优先用它路由
    pendingTaskTypeRef.current = taskType
    pendingAgentIdRef.current = agentId

    // 自动将 prompt 发送给指定的 agent
    setTimeout(() => {
      setInput(prompt)
      setTimeout(() => { sendRef.current() }, 60)
    }, 300)
  }, [])

  const send = useCallback(async () => {
    if ((!input.trim() && gcAttachments.length === 0) || sending) {return}

    // 🔒 把「这一轮」绑定到发起它的会话（P0 修复）。
    //   生成期间用户可能切走会话 —— 后续所有写入都必须落到**发起会话**，
    //   否则会把当前会话的内容写进发起会话的存档（静默数据损坏），
    //   且回复按 replyId 在当前数组里查找落空 → 丢失。
    const sessionAtSend = activeSessionRef.current
    // 🆕 P2-1：本次请求的唯一 id —— 随 config 下发，后端回显在每条事件上，
    //   前端据此丢弃在途后台任务混进来的事件（思考面板串台）。
    const reqId = `gc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

    const userText = input
    const currentAttachments = [...gcAttachments]
    setGcAttachments([])

    // ═══ v2.7: 命令拦截 ═══
    if (userText.startsWith('/')) {
      setInput('')
      setMsgCounter(c => c + 1)
      try {
        const result = await window.luminaAPI.commandExecute(userText)
        setMessages(prev => [...prev, {
          id: `cmd-${Date.now()}`, from: 'system', fromIcon: '⚡', fromName: '命令',
          content: result?.content || result?.error || `命令已执行: ${userText}`,
          time: formatDateLabel(Date.now()),
        }])
      } catch (err: any) {
        setMessages(prev => [...prev, {
          id: `cmd-${Date.now()}`, from: 'system', fromIcon: '⚠️', fromName: '命令',
          content: `命令执行失败: ${err.message}`,
          time: formatDateLabel(Date.now()),
        }])
      }
      return
    }

    // ═══ v2.7: 组??附件消息 ═══
    // 🔒 同步守卫：命令分支已 return，这里才真正进入「发消息」流程。
    //   setSending 是异步的，挡不住同一 tick 内的二次调用（双击 / 输入法回车）。
    if (sendLockRef.current) {return}
    sendLockRef.current = true

    let fullText = userText
    if (currentAttachments.length > 0) {
      const fileDescs = currentAttachments.map((a, i) => {
        const sizeStr = a.size > 1024 * 1024 ? `${(a.size / (1024 * 1024)).toFixed(1)}MB` : `${(a.size / 1024).toFixed(1)}KB`
        let desc = `[附件${i + 1}: ${a.name} (${sizeStr})]`
        if (a.text) {desc += `\n内容:\n${a.text}`}
        return desc
      }).join('\n')
      fullText = `${userText}\n\n--- 上传文件 ---\n${fileDescs}`
    }

    const userMsg: GCMsg = {
      id: `u${Date.now()}`, from: 'user', fromIcon: '👤', fromName: '我',
      content: userText,
      // v10.9: 附件包含 imageDataUrl 供视觉模型使用
      attachments: currentAttachments.length > 0 ? currentAttachments.map(a => ({
        name: a.name,
        size: a.size,
        text: a.text,
        imageDataUrl: (a as any).imageDataUrl,  // v10.9: base64 图片数据
      })) : undefined,
      time: formatDateLabel(Date.now()),
    }
    setMessages(prev => {
      const updated = [...prev, userMsg]
      // 🔒 用户消息立即落盘（P2-5）：持久化 effect 在「有消息正在动画」时会整体跳过，
      //   若此刻崩溃/关窗，本轮提问会丢。这里先把提问写进**发起会话**的存档。
      if (activeSessionRef.current === sessionAtSend) {saveGCMessages(sessionAtSend, updated)}
      return updated
    })
    setInput('')
    setSending(true)
    abortRef.current = false
    setMsgCounter(c => c + 1)

    // ═══ v2.7: 主动聊天 + TTS 解锁 ═══
    proactiveChat.recordActivity()
    ttsEngine.unlock()

    // ═══ 🔁 Loop 意图检测：「帮我每天做 XXX」→ 自动创建 Loop 任务 ═══
    const loopIntent = detectLoopIntent(userText)
    if (loopIntent) {
      const loop = await useLoopStore.getState().createLoop(loopIntent.goal, {
        agentId: undefined,  // 团队模式下不指定特定 Agent，让系统自动分配
        suggestedTriggers: [loopIntent.trigger],
      }).catch(() => null)
      if (loop) {
        const plan = loop.subtasks
          .map((s, i) => `${i + 1}. ${s.title}：${s.description.slice(0, 60)}`)
          .join('\n')
        const freqLabel = loopIntent.trigger.type === 'interval'
          ? (() => {
              const h = Math.round((loopIntent.trigger.config?.intervalMs || 86400000) / 3600000)
              return h === 24 ? '每天' : h === 168 ? '每周' : `每 ${h} 小时`
            })()
          : '定期'
        // 在群聊中展示 Loop 创建结果
        setMessages(prev => [...prev, {
          id: `loop-${Date.now()}`,
          from: 'system',
          fromIcon: '🔁',
          fromName: 'Loop 任务',
          content:
            `📋 已为你创建自动任务（待确认）：\n\n` +
            `🎯 目标：${loopIntent.goal}\n⏰ 触发：${freqLabel}\n\n` +
            `我会帮你做这些事：\n${plan}\n\n` +
            `去「团队群聊 → 任务」后即可查看并确认启动。`,
          time: formatDateLabel(Date.now()),
        }])
        setMsgCounter(c => c + 1)
      }
    }

    // ══════════════════════════════════════════════════════
    // 智能任务路由 — 按任务类型分配 Agent
    // ══════════════════════════════════════════════════════
    // v8.1fix: ⚠️ 任务意图只在用户输入文字上检测，不在文件内容上检测！
    //   fullText 包含提取的文档正文，若文档含"实现/代码/开发"等技术词→误判为 coding→走编程模式 shell_exec 可用→出错
    //   Agent 路由也用用户输入检测，避免上传技术文档时被路由到 Recha（编程Agent）
    // 🆕 v9.2: 优先使用用户选择的任务类型卡片路由，而非关键词自动匹配
    //   场景：用户选了「写作创作」卡片 → 期望 Lumina 回复，但「帮我写封邮件」的「写」会匹配 coding→热茶
    //   修复：pendingTaskTypeRef 记住了用户选的任务类型，优先用它决定 responder
    let taskIntent: 'coding' | 'analysis' | 'chat' | 'discussion' = 'chat'
    let isCoding = false
    let codeScale: 'small' | 'medium' | 'large' = 'small'
    let overrideResponder: typeof AGENTS[number] | null = null

    // 🔧 2026-08-11: 话题持续生效 —
    //   优先级：任务派发中心临时指定（一次性） > 持续话题（selectedRole）。
    //   pendingTaskTypeRef/pendingAgentIdRef 由任务派发中心设置，仅用于当次消息；
    //   selectedRoleRef 是用户点话题卡片进入的持续话题，直到用户点「←」退出。
    const explicitTaskType = pendingTaskTypeRef.current || selectedRoleRef.current
    const explicitAgentId = pendingAgentIdRef.current
    // 消费一次性的任务类型上下文（只用于当前这条消息）
    pendingTaskTypeRef.current = null
    pendingAgentIdRef.current = null

    if (explicitAgentId) {
      // 任务派发中心指定了具体执行者 → 直接使用
      overrideResponder = AGENTS.find(a => a.id === explicitAgentId) || null
    } else if (explicitTaskType) {
      // 用户选了任务类型卡片 → 用卡片的推荐 agent
      const recommendedId = getRecommendedAgent(explicitTaskType)
      overrideResponder = AGENTS.find(a => a.id === recommendedId) || null
    }

    if (!overrideResponder) {
      // 没有显式选择 → 走原有的关键词自动匹配
      taskIntent = userText.trim().length > 0 ? detectTaskIntent(userText) : 'chat'
      isCoding = taskIntent === 'coding' && userText.trim().length > 0
      codeScale = isCoding ? detectCodeScale(userText) : 'small'
    }

    // 🆕 v10.8: 获取该 agent 的独立 LLM 配置（per-agent 优先，fallback 到全局）
    const effectiveAgentId = overrideResponder?.id || 'lumina'
    const effectiveLlmConfig = getAgentLlmConfig(effectiveAgentId) || {
      provider: llmConfig.provider, model: llmConfig.model,
      endpoint: llmConfig.baseUrl, apiKey: llmConfig.apiKey,
      // 🔧 2026-10-07: 兜底也取用户实际配置，不再硬编码 262144（见下方 CTX_WIN 注释）
      contextWindow: llmConfig.contextWindow || 0,
      maxTokens: llmConfig.maxTokens || 16384,
      timeout: 600,
    }

    // 🩺 上下文窗口 / 输出上限 —— 取用户实际配置，**不再硬编码 262144（256K）**。
    //
    // 【为什么必须改】硬编码 256K 对本地模型（尤其小模型）是致命的：
    //   ① runner 以为窗口有 256K → 不裁剪历史 → 每轮全量 prefill，
    //      首字响应从秒级变成分钟级（与主对话的 P0-3 同一个坑）；
    //   ② max_tokens 索要 256K 输出，本地服务端会拒绝或截断
    //      → 表现正是「模型连续 0 轮未产出可用内容」。
    //   0 = 交给 runner 自动检测（服务端报告优先），云端模型不受影响。
    const CTX_WIN = Number(effectiveLlmConfig.contextWindow) > 0
      ? Number(effectiveLlmConfig.contextWindow)
      : 0
    const OUT_BUDGET = Math.min(
      Number((effectiveLlmConfig as { maxTokens?: number }).maxTokens) > 0
        ? Number((effectiveLlmConfig as { maxTokens?: number }).maxTokens)
        : 16384,
      CTX_WIN > 0 ? Math.max(1024, Math.floor(CTX_WIN / 4)) : 16384,
    )

    // ── 大型工程：全协作流水线（Yak 编码→热茶审查→Yak 修复→Lumina测试）──
    if (isCoding && codeScale === 'large' && llmReady) {
      // 思考过程追踪 — 每个协作阶段都会累积
      let phaseThinkingAccum: ThinkingStep[] = []
      let phaseStepIds = new Set<string>()
      let phaseStepStartTimes = new Map<string, number>()
      /** 🆕 v5.2: 支持 upsert — 同 key 更新而非新增，避免思考面板刷屏 */
      const upsertCollabStep = (s: ThinkingStep, currentMsgId: string, stableKey?: string) => {
        const key = stableKey || `${s.type}:${s.tool || ''}:${s.label.slice(0, 30)}`
        const existingIdx = phaseThinkingAccum.findIndex(
          step => (stableKey && (step as any)._stableKey === stableKey) ||
                  (`${step.type}:${step.tool || ''}:${step.label.slice(0, 30)}` === key)
        )
        if (existingIdx >= 0) {
          // 更新已有步骤（累积文本、更新标签等）
          const updated = { ...phaseThinkingAccum[existingIdx], ...s }
          phaseThinkingAccum[existingIdx] = updated
        } else {
          (s as any)._stableKey = stableKey || ''
          phaseThinkingAccum.push(s)
        }
        pushThinking(currentMsgId, [...phaseThinkingAccum])
      }
      // 向后兼容
      const pushCollabStep = (s: ThinkingStep, currentMsgId: string) =>
        upsertCollabStep(s, currentMsgId)
      const resetCollabAccum = () => {
        phaseThinkingAccum = []
        phaseStepIds = new Set()
        phaseStepStartTimes = new Map()
      }

      // ── 编程协作：Yak(写码) → 热茶(审查) → Yak(修复) → Lumina(测试) ──
      const currentPhase = collabPhaseRef.current  // 捕获当前阶段号
      const unsubTool = subscribeAgentEvents((ev: any) => {
        // 用户中止时立即停止累积思考步骤
        if (abortRef.current) {return}
        // fix: 阶段守卫 — 只处理当前阶段的 IPC 事件，旧阶段事件直接丢弃
        if (collabPhaseRef.current !== currentPhase) {return}
        if (ev.type === 'thinking_stream') {
          // 推理内容累积到同一个步骤 — 不刷屏
          const collabStreamId = `reasoning-${collabCurrentMsgIdRef.current}`
          const stableKey = `reasoning:${collabCurrentMsgIdRef.current}`
          if (ev.isLast) {
            // 推理结束：更新标签为完成
            upsertCollabStep({
              id: collabStreamId,
              type: 'thinking',
              label: '💭 推理完成',
              timestamp: Date.now(),
            }, collabCurrentMsgIdRef.current, stableKey)
          } else if (ev.text) {
            // 累积推理文本到同一步骤
            const existing = phaseThinkingAccum.find(s => (s as any)._stableKey === stableKey)
            const fullText = existing?.result ? existing.result + ev.text : ev.text
            upsertCollabStep({
              id: collabStreamId,
              type: 'thinking',
              label: '💭 推理中...',
              result: fullText.slice(-5000),
              timestamp: Date.now(),
            }, collabCurrentMsgIdRef.current, stableKey)
          }
        } else if (ev.type === 'thinking' || ev.type === 'text') {
          const txt = (ev.text || ev.content || '').trim()
          const isLoopNoise = /^思考中\.\.\.\s*\(第\s*\d+\s*轮\)$/i.test(txt) ||
            /^🐢\s*模型正在生成|⚡\s*自动推动|⚠️\s*检测到潜在注入|🐢\s*检测到慢速模型/i.test(txt)
          if (txt && txt.length > 2 && !isLoopNoise) {
            pushCollabStep({
              id: `think-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
              type: 'thinking',
              label: txt.slice(0, 120),
              result: txt,
              timestamp: Date.now(),
            }, collabCurrentMsgIdRef.current)
          }
        } else if (ev.type === 'tool_start') {
          const { label, detail } = describeToolAction(ev.tool, ev.args)
          const notice = label + (detail ? `: ${detail}` : '')
          setToolNotice(notice)
          if (toolNoticeTimer.current) {clearTimeout(toolNoticeTimer.current)}
          toolNoticeTimer.current = setTimeout(() => setToolNotice(null), 4000)
          phaseStepStartTimes.set(ev.tool, Date.now())
          pushCollabStep({
            id: `ts-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
            type: 'tool_start',
            label,
            tool: ev.tool,
            args: detail,
            timestamp: Date.now(),
          }, collabCurrentMsgIdRef.current)
        } else if (ev.type === 'tool_end') {
          if (toolNoticeTimer.current) {clearTimeout(toolNoticeTimer.current)}
          toolNoticeTimer.current = setTimeout(() => setToolNotice(null), 1500)
          const startTime = phaseStepStartTimes.get(ev.tool)
          phaseStepStartTimes.delete(ev.tool)
          const ok = !ev.error && (!ev.result || ev.result.ok !== false)
          const resultContent = ev.result?.content
            ? (typeof ev.result.content === 'string' ? ev.result.content.slice(0, 120) : JSON.stringify(ev.result.content).slice(0, 120))
            : undefined
          pushCollabStep({
            id: `te-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
            type: ev.error ? 'tool_error' : 'tool_end',
            label: ok ? '✅ 完成' : `❌ ${ev.error || '失败'}`,
            tool: ev.tool,
            result: resultContent || (ev.result ? JSON.stringify(ev.result).slice(0, 120) : undefined),
            durationMs: startTime ? Date.now() - startTime : undefined,
            timestamp: Date.now(),
          }, collabCurrentMsgIdRef.current)
        } else if (ev.type === 'token_update' && ev.delta !== undefined && ev.delta > 0) {
          // 团队协作 token 追踪
          addTokenUsage(effectiveLlmConfig.model || 'unknown', ev.delta, 'yak')
        }
      }, reqId)
      // fix: 使用 ref 替代 let 变量
      collabCurrentMsgIdRef.current = ''
      const collabMsgs: GCMsg[] = []

      // 构建协作上下文历史 + 阶段性结果累积
      //   所有 agent 共享 collabHistory（协作前的完整对话），
      //   但 Phase2+ 应该看到前一阶段输出 → 使用 runningHistory 累积追加
      // 🔧 2026-07-12: 扩大上下文窗口 — 保留最近 60 条，每条 24000 字符
      // //   1. 不再无脑过滤 system 消息，改为保留有内容量的系统消息
      //      （系统消息包含欢迎语、命令结果、错误提示等，都是有用上下文）
      //   2. 扩大消息窗口（60 → 120）+ token 动态截断，不再硬砍固定条数
      const collabHistory = (() => {
        const raw = messages
          .slice(-120)
          .filter(m => {
            if (m.from !== 'system') {return true}
            return (m.content || '').trim().length > 5
          })
          .map(m => ({
            role: m.from === 'user' ? 'user' as const
                : m.from === 'system' ? 'system' as const
                : 'assistant' as const,
            content: (m.content || '').slice(0, 24000),
          }))
        // token 动态截断：保留最新消息不超过上下文窗口 50%
        const CONTEXT_WIN = effectiveLlmConfig?.contextWindow || 0
        const BUDGET = Math.floor(CONTEXT_WIN * 0.5)
        let est = 0
        const result: typeof raw = []
        for (let i = raw.length - 1; i >= 0; i--) {
          const itemEst = estimateTokens(raw[i].content) + 8
          if (est + itemEst > BUDGET && result.length > 0) {break}
          est += itemEst
          result.unshift(raw[i])
        }
        return result
      })()
      // 累积历史：每个协作阶段完成后追加本阶段结果，供后续阶段参考
      const runningHistory: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [...collabHistory]
      // 同步 ref — 让主回复阶段能读取协作上下文
      runningHistoryRef.current = runningHistory

      try {

        // 精简角色提示词 — 支持多轮迭代修复（🆕 v3.7: Yak 编码、热茶审阅）
        const coderPrompt = `你是 Yak，Lumina 团队的代码工程师。收到了编程任务。

⚠️ 铁律（违反就是失败）：
1. 第一反应必须是 file_read 看现状 或 file_write 直接写 —— 不要先给建议再问要不要写
2. 写完必须 shell_exec 验证，报错就改，改到通过为止。没验证过的结论等于没做过
3. 报告要如实：跑了什么命令、输出是什么、哪里没跑通。
   禁止写"应该没问题""大概可用""理论上可以"这类没验证过的话
4. 如果这是修复轮（修复之前测试失败的问题），必须先理解错误 → 定位代码 → 修改 → 验证
5. 需求确实存在歧义、且猜错代价很高（删数据、改接口、不可逆操作）时：
   先做无风险的准备工作，然后**明确写出你的假设**并继续往下做；
   只有在真的无法判断时，才向用户提问并说明缺什么信息
6. 做不到的事直接说做不到，不要用模糊话术搪塞过去`

        const reviewerPrompt = `你是热茶，审阅 Yak 的代码。看完直接给结论。
规则：
- file_read 读代码 → 给出"通过"或"有问题"的明确结论
- 有问题必须说具体位置和原因，不许写"建议优化一下"这种无法执行的话
- 没问题就说 "✓ 代码通过"
- 只审阅不改代码
- ⛔ 审阅要覆盖真实风险：逻辑错误、边界情况、异常未处理、安全隐患都要看。
  确实没发现问题就明说没发现，不要为了显得尽责而编造问题`

        const testerPrompt = `你是 Lumina，用 shell_exec 跑 Yak 写的程序并报告结果。
规则：
- 只跑命令，不评价代码
- 成功：简短说输出结果，以 "✅" 开头
- 失败：报告具体报错信息，以 "❌" 开头
- 2-3句话内完成
- 如果命令需要交互或长时间运行，用 timeout 参数`

        // ─────────────────────────────────
        // 编程协作循环 — 测试失败自动回到修复阶段
        // 循环直到：测试通过 / 3次迭代耗尽 / 用户中断
        // ─────────────────────────────────
        let codingIteration = 0
        const MAX_CODING_ITERATIONS = 3
        let lastTestWasFailure = false
        let previousErrorContext = ''
        
        while (codingIteration < MAX_CODING_ITERATIONS && !abortRef.current) {
          codingIteration++
          
          // 构建迭代上下文（非首次迭代时附加错误信息）
          const iterSuffix = codingIteration > 1 
            ? `\n\n⚠️ 【第${codingIteration}轮修复】上一轮测试发现问题：${previousErrorContext.slice(0, 500)}\n请修改代码修复这些问题后再验证。`
            : ''
          
          // ─────────────────────────────────
          // Phase 1: Yak 编码/修复
          // ─────────────────────────────────
          setReplyingAgent('yak')
          setLastAgent('yak')
          updateEmotion('yak', userText, { isGroupChat: true })

          const coderMsgId = `yak-${Date.now()}`
          collabCurrentMsgIdRef.current = coderMsgId
          collabPhaseRef.current++  // 🔧 v5.4fix: 递增阶段号
          resetCollabAccum()
          const coderMsg: GCMsg = {
            id: coderMsgId,
            from: 'yak', fromIcon: '📊', fromName: 'Yak',
            content: '', time: formatDateLabel(Date.now()),
          }
          setMessages(prev => [...prev, coderMsg])
          setMsgCounter(c => c + 1)
          collabMsgs.push(coderMsg)
          
          const phase1Task = codingIteration === 1
            ? `用户需求：${fullText.slice(0, 2000)}`
            : `用户需求：${fullText.slice(0, 1500)}${iterSuffix}`
          
          const codingCfg = getTaskConfig(true)
          const phase1Result = await agentChatWithTimeout({
            text: `[${codingIteration === 1 ? 'Yak，用户让你写代码。你是编码者，直接动手，不要只说建议。' : 'Yak，上一轮测试发现错误，请修复代码！'}]\n\n${phase1Task}`,
            sessionId: sessionAtSend,
            config: {
              mode: codingCfg.mode,
              isGroupChat: true,
              personaId: 'yak',
              model: effectiveLlmConfig.model,
              baseUrl: effectiveLlmConfig.baseUrl,
              apiKey: effectiveLlmConfig.apiKey,
              temperature: 0.15,
              maxTokens: OUT_BUDGET,
              maxToolCalls: codingIteration === 1 ? 12 : 15,
              disabledTools: codingCfg.disabledTools,
              skipApproval: true,
              contextWindow: CTX_WIN,
              systemPrompt: coderPrompt,
              socialMode: true,
            },
            conversationHistory: buildHistoryForAgent(messages, 'yak', codingCfg.contextWindow, runningHistory),
          }, reqId)

          let coderReply = (phase1Result.content || '代码已写好').trimStart()
          // 🆕 团队阶段错误检测：若是超时/错误兜底文本，中断协作链并提示重试
          if (phase1Result.error || /模型响应较慢|模型响应超时|回复生成失败或耗时过长|已自动中断|请稍后(重试|再试)|出了点问题|LLM 请求失败|连接断开/i.test(coderReply)) {
            console.log('[GroupChat] ⛔ Yak 阶段出错或超时，中断协作链')
            setMessages(prev => prev.map(m => m.id === coderMsgId
              ? { ...m, content: '（Yak 处理失败，请说"继续"重试）', _animDone: true } as GCMsg : m))
            runningHistoryRef.current = runningHistory
            setSending(false); setReplyingAgent(null); setLastAgent(null)
            return
          }
          setMessages(prev => prev.map(m => m.id === coderMsgId
            ? { ...m, thinkingSteps: [...phaseThinkingAccum] } as GCMsg : m))
          animateTyping(coderMsgId, coderReply, sessionAtSend)
          // v14.0-fix: Phase 1 完成后追加结果到 runningHistory（🆕 P2: 扩到 3000 字符避免信息丢失）
          runningHistory.push(
            { role: 'user', content: `[Yak 收到需求] ${fullText.slice(0, 500)}` },
            { role: 'assistant', content: `[Yak 输出] ${coderReply.slice(0, 3000)}` },
          )
          runningHistoryRef.current = runningHistory // 🆕 v16.0-fix: 同步到 ref

          if (abortRef.current) { setSending(false); setReplyingAgent(null); return }

          // ─────────────────────────────────
          // Phase 2: 热茶审查
          // ─────────────────────────────────
          setReplyingAgent('recha')
          setLastAgent('recha')
          updateEmotion('recha', userText, { isGroupChat: true })

          const reviewMsgId = `recha-${Date.now()}`
          collabCurrentMsgIdRef.current = reviewMsgId
          collabPhaseRef.current++  // 🔧 v5.4fix: 递增阶段号
          resetCollabAccum()
          const reviewMsg: GCMsg = {
            id: reviewMsgId,
            from: 'recha', fromIcon: '🍵', fromName: '热茶',
            content: '', time: formatDateLabel(Date.now()),
          }
          setMessages(prev => [...prev, reviewMsg])
          setMsgCounter(c => c + 1)
          collabMsgs.push(reviewMsg)
          
          const phase2Result = await window.luminaAPI.agentChat({
            text: `[热茶，Yak 刚写完了代码，你来审阅一下。]\n\n用户需求：${fullText.slice(0, 500)}\n\nYak 回复的代码：${coderReply.slice(0, 1500)}（完整代码详见上方对话记录）`,
            config: {
              mode: codingCfg.mode,
              isGroupChat: true,
              personaId: 'recha',
              model: effectiveLlmConfig.model,
              baseUrl: effectiveLlmConfig.baseUrl,
              apiKey: effectiveLlmConfig.apiKey,
              temperature: 0.15,
              maxTokens: OUT_BUDGET,
              maxToolCalls: 5,
              skipApproval: true,
              contextWindow: CTX_WIN,
              systemPrompt: reviewerPrompt,
              socialMode: true,
            },
            conversationHistory: buildHistoryForAgent(messages, 'recha', codingCfg.contextWindow, runningHistory),
          })

          const reviewReply = (phase2Result.content || '审阅完成').trimStart()
          // 🆕 团队阶段错误检测
          if (phase2Result.error || /模型响应较慢|模型响应超时|回复生成失败或耗时过长|已自动中断|请稍后(重试|再试)|出了点问题|LLM 请求失败|连接断开/i.test(reviewReply)) {
            console.log('[GroupChat] ⛔ 热茶审阅阶段出错或超时，中断协作链')
            setMessages(prev => prev.map(m => m.id === reviewMsgId
              ? { ...m, content: '（热茶审阅失败，请说"继续"重试）', _animDone: true } as GCMsg : m))
            runningHistoryRef.current = runningHistory
            setSending(false); setReplyingAgent(null); setLastAgent(null)
            return
          }
          setMessages(prev => prev.map(m => m.id === reviewMsgId
            ? { ...m, thinkingSteps: [...phaseThinkingAccum] } as GCMsg : m))
          animateTyping(reviewMsgId, reviewReply, sessionAtSend)
          // v14.0-fix: Phase 2 完成后追加审查结果到 runningHistory（🆕 P2: 扩到 3000 字符）
          runningHistory.push(
            { role: 'assistant' as const, content: `[热茶审阅] ${reviewReply.slice(0, 3000)}` },
          )
          runningHistoryRef.current = runningHistory // 🆕 v16.0-fix: 同步到 ref

          if (abortRef.current) { setSending(false); setReplyingAgent(null); return }

          // ─────────────────────────────────
          // Phase 3: Yak 修复（根据审查意见）
          // ─────────────────────────────────
          const needsFix = /问题|错误|改进|建议|修改|优化|修复|不妥|漏洞|隐患|改成|应该|需要|缺少|缺失/.test(reviewReply)

          if (!abortRef.current && needsFix) {
            setReplyingAgent('yak')
            setLastAgent('yak')

            const fixMsgId = `yak-fix-${Date.now()}`
            collabCurrentMsgIdRef.current = fixMsgId
            collabPhaseRef.current++  // 🔧 v5.4fix: 递增阶段号
            resetCollabAccum()
            const fixMsg: GCMsg = {
              id: fixMsgId,
              from: 'yak', fromIcon: '📊', fromName: 'Yak',
              content: '', time: formatDateLabel(Date.now()),
            }
            setMessages(prev => [...prev, fixMsg])
            setMsgCounter(c => c + 1)
            collabMsgs.push(fixMsg)
            
            const phase3Result = await agentChatWithTimeout({
              text: `[Yak，热茶审查了你的代码，有一些建议。请根据审阅意见修改代码。]\n\n热茶的审阅意见：${reviewReply.slice(0, 500)}`,
              sessionId: sessionAtSend,
              config: {
                mode: codingCfg.mode,
                isGroupChat: true,
                personaId: 'yak',
                model: effectiveLlmConfig.model,
                baseUrl: effectiveLlmConfig.baseUrl,
                apiKey: effectiveLlmConfig.apiKey,
                temperature: 0.15,
                maxTokens: OUT_BUDGET,
                maxToolCalls: 8,
                skipApproval: true,
                contextWindow: CTX_WIN,
                systemPrompt: coderPrompt,
                socialMode: true,
              },
              conversationHistory: buildHistoryForAgent(messages, 'yak', codingCfg.contextWindow, runningHistory),
            }, reqId)
            
            const fixReply = (phase3Result.content || '修复完成').trimStart()
            // 🆕 团队阶段错误检测
            if (phase3Result.error || /模型响应较慢|模型响应超时|回复生成失败或耗时过长|已自动中断|请稍后(重试|再试)|出了点问题|LLM 请求失败|连接断开/i.test(fixReply)) {
              console.log('[GroupChat] ⛔ Yak 修复阶段出错或超时，中断协作链')
              setMessages(prev => prev.map(m => m.id === fixMsgId
                ? { ...m, content: '（Yak 修复失败，请说"继续"重试）', _animDone: true } as GCMsg : m))
              runningHistoryRef.current = runningHistory
              setSending(false); setReplyingAgent(null); setLastAgent(null)
              return
            }
            setMessages(prev => prev.map(m => m.id === fixMsgId
              ? { ...m, thinkingSteps: [...phaseThinkingAccum] } as GCMsg : m))
            animateTyping(fixMsgId, fixReply, sessionAtSend)
            // v14.0-fix: Phase 3 完成后追加修复结果（🆕 P2: 扩到 3000 字符）
            runningHistory.push(
              { role: 'assistant' as const, content: `[Yak 修复] ${fixReply.slice(0, 3000)}` },
            )
            runningHistoryRef.current = runningHistory // 🆕 v16.0-fix: 同步到 ref
            
            // 用修复后的代码替换 coderReply 供后续阶段使用
            if (fixReply.length > 10) {coderReply = fixReply}
          }

          if (abortRef.current) { setSending(false); setReplyingAgent(null); return }

          // ─────────────────────────────────
          // Phase 4: Lumina 测试
          // ─────────────────────────────────
          setReplyingAgent('lumina')
          setLastAgent('lumina')
          updateEmotion('lumina', userText, { isGroupChat: true })

          const testMsgId = `lumina-${Date.now()}`
          collabCurrentMsgIdRef.current = testMsgId
          collabPhaseRef.current++  // 🔧 v5.4fix: 递增阶段号
          resetCollabAccum()
          const testMsg: GCMsg = {
            id: testMsgId,
            from: 'lumina', fromIcon: '🐱', fromName: 'Lumina',
            content: '', time: formatDateLabel(Date.now()),
          }
          setMessages(prev => [...prev, testMsg])
          setMsgCounter(c => c + 1)
          collabMsgs.push(testMsg)
          
          const phase4Result = await agentChatWithTimeout({
            text: `[Lumina，Yak 和热茶完成了编码和审阅，你来测试一下代码是否能正常运行。]\n\n用户需求：${fullText.slice(0, 500)}\n\nYak 的代码概要：${coderReply.slice(0, 1500)}（完整代码详见上方对话记录）`,
            sessionId: sessionAtSend,
            config: {
              mode: codingCfg.mode,
              isGroupChat: true,
              personaId: 'lumina',
              model: effectiveLlmConfig.model,
              baseUrl: effectiveLlmConfig.baseUrl,
              apiKey: effectiveLlmConfig.apiKey,
              temperature: 0.15,
              maxTokens: OUT_BUDGET,
              maxToolCalls: 6,
              skipApproval: true,
              contextWindow: CTX_WIN,
              systemPrompt: testerPrompt,
              socialMode: true,
            },
            conversationHistory: buildHistoryForAgent(messages, 'lumina', codingCfg.contextWindow, runningHistory),
          }, reqId)

          const testReply = (phase4Result.content || '测试完成').trimStart()
          // 🆕 团队阶段错误检测
          if (phase4Result.error || /模型响应较慢|模型响应超时|回复生成失败或耗时过长|已自动中断|请稍后(重试|再试)|出了点问题|LLM 请求失败|连接断开/i.test(testReply)) {
            console.log('[GroupChat] ⛔ Lumina 测试阶段出错或超时，中断协作链')
            setMessages(prev => prev.map(m => m.id === testMsgId
              ? { ...m, content: '（Lumina 测试失败，请说"继续"重试）', _animDone: true } as GCMsg : m))
            runningHistoryRef.current = runningHistory
            setSending(false); setReplyingAgent(null); setLastAgent(null)
            return
          }
          setMessages(prev => prev.map(m => m.id === testMsgId
            ? { ...m, thinkingSteps: [...phaseThinkingAccum] } as GCMsg : m))
          animateTyping(testMsgId, testReply, sessionAtSend)

          // 🔧 2026-08-14: 补全 Lumina 测试结果的 runningHistory，避免上下文断层
          runningHistory.push(
            { role: 'assistant' as const, content: `[Lumina 测试] ${testReply.slice(0, 3000)}` },
          )
          runningHistoryRef.current = runningHistory

          // 判断测试是否通过 — 决定是否继续循环
          const testFailed = /(error|错误|失败|报错|异常|❌|bug|崩溃|无法|不行|不能|没.*跑|没.*通过|fail|cannot|unable|traceback|exception)/i.test(testReply) &&
            !/(✅.*通过|测试通过|运行成功|成功运行|一切正常|pass|success|ok)/i.test(testReply)
          
          if (testFailed && codingIteration < MAX_CODING_ITERATIONS) {
            previousErrorContext = testReply.slice(0, 500)
            console.log(`[GroupChat] 🔄 测试未通过，进入第 ${codingIteration + 1} 轮修复`)
            lastTestWasFailure = true
            // 短暂暂停让用户看到结果，然后继续
            await new Promise(r => setTimeout(r, 1000))
          } else {
            // ✅ 测试通过 或 已耗尽迭代次数
            if (testFailed) {
              // 耗尽迭代，发系统消息告知用户
              setMessages(prev => [...prev, {
                id: `sys-${Date.now()}`,
                from: 'system', fromIcon: '⚠️', fromName: '系统',
                content: `⚠️ 已尝试 ${MAX_CODING_ITERATIONS} 轮修复，测试仍有问题。建议手动查看代码。`,
                time: formatDateLabel(Date.now()),
              }])
            }
            break  // 退出循环
          }
        }  // end while loop
        
      } catch (err: any) {
        // 清理空白气泡 — 标记所有协作消息为已完成
        setMessages(prev => prev.map(m =>
          collabMsgs.some(cm => cm.id === m.id) && !m.content
            ? { ...m, _animDone: true } as GCMsg
            : m
        ))
        setMessages(prev => [...prev, {
          id: `err-${Date.now()}`, from: 'system', fromIcon: '⚠️', fromName: '系统',
          content: `协作编程出错: ${err.message}`,
          time: formatDateLabel(Date.now()),
        }])
      } finally {
        unsubTool()
        setSending(false)
        setReplyingAgent(null)
        setLastAgent(null)
        // 协作完成后延迟再保存一次，确保所有动画已完成
        setTimeout(() => {
          commitToSession(sessionAtSend, prev => prev)
          // 🐛 2026-10-13 修复：原实现是 **no-op** —— 它把读出来的 `ss` 原样写回，
          //   从未把本会话**加进**列表（`saveGCSessions(ss)` 里 ss 就是当前内容），
          //   所以「协作流程跑完后，这个会话仍然不在侧边栏」。
          //   现在按原意真正补上：只在缺失时插入。
          //   另外用 `sessionAtSend` 而不是 `activeSessionId` —— 后者是 3 秒后
          //   的闭包值，用户中途切走就指错了会话。
          const latest = loadGCSessions()
          if (!latest.some((s: GCSession) => s.id === sessionAtSend)) {
            const msgs = loadGCMessages(sessionAtSend)
            saveGCSessions([
              {
                id: sessionAtSend,
                date: new Date().toLocaleDateString('zh-CN'),
                preview: msgs.filter(m => m.from === 'user').slice(-1)[0]?.content?.slice(0, 30) || '',
                count: msgs.length,
              },
              ...latest,
            ])
            window.dispatchEvent(new Event('gc:sessions-updated'))
          }
        }, 3000)
      }
      return
    }

    // ── 中型工程：Yak 编码 + 热茶审查（自动修复，无测试阶段）──
    if (isCoding && codeScale === 'medium' && llmReady) {
      let phaseThinkingAccum: ThinkingStep[] = []
      let phaseStepIds = new Set<string>()
      let phaseStepStartTimes = new Map<string, number>()
      const upsertCollabStep = (s: ThinkingStep, currentMsgId: string, stableKey?: string) => {
        const key = stableKey || `${s.type}:${s.tool || ''}:${s.label.slice(0, 30)}`
        const existingIdx = phaseThinkingAccum.findIndex(
          step => (stableKey && (step as any)._stableKey === stableKey) ||
                  (`${step.type}:${step.tool || ''}:${step.label.slice(0, 30)}` === key)
        )
        if (existingIdx >= 0) {
          const updated = { ...phaseThinkingAccum[existingIdx], ...s }
          phaseThinkingAccum[existingIdx] = updated
        } else {
          (s as any)._stableKey = stableKey || ''
          phaseThinkingAccum.push(s)
        }
        pushThinking(currentMsgId, [...phaseThinkingAccum])
      }
      const pushCollabStep = (s: ThinkingStep, currentMsgId: string) =>
        upsertCollabStep(s, currentMsgId)
      const resetCollabAccum = () => {
        phaseThinkingAccum = []
        phaseStepIds = new Set()
        phaseStepStartTimes = new Map()
      }

      const currentPhase = collabPhaseRef.current
      const unsubTool = subscribeAgentEvents((ev: any) => {
        if (abortRef.current) {return}
        if (collabPhaseRef.current !== currentPhase) {return}
        if (ev.type === 'thinking_stream') {
          const collabStreamId = `reasoning-${collabCurrentMsgIdRef.current}`
          const stableKey = `reasoning:${collabCurrentMsgIdRef.current}`
          if (ev.isLast) {
            upsertCollabStep({
              id: collabStreamId,
              type: 'thinking', label: '💭 推理完成',
              timestamp: Date.now(),
            }, collabCurrentMsgIdRef.current, stableKey)
          } else if (ev.text) {
            const existing = phaseThinkingAccum.find(s => (s as any)._stableKey === stableKey)
            const fullText = existing?.result ? existing.result + ev.text : ev.text
            upsertCollabStep({
              id: collabStreamId,
              type: 'thinking', label: '💭 推理中...',
              result: fullText.slice(-5000),
              timestamp: Date.now(),
            }, collabCurrentMsgIdRef.current, stableKey)
          }
        } else if (ev.type === 'thinking' || ev.type === 'text') {
          const txt = (ev.text || ev.content || '').trim()
          const isLoopNoise = /^思考中\.\.\.\s*\(第\s*\d+\s*轮\)$/i.test(txt) ||
            /^🐢\s*模型正在生成|⚡\s*自动推动|⚠️\s*检测到潜在注入|🐢\s*检测到慢速模型/i.test(txt)
          if (txt && txt.length > 2 && !isLoopNoise) {
            pushCollabStep({
              id: `think-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
              type: 'thinking', label: txt.slice(0, 120), result: txt,
              timestamp: Date.now(),
            }, collabCurrentMsgIdRef.current)
          }
        } else if (ev.type === 'tool_start') {
          const { label, detail } = describeToolAction(ev.tool, ev.args)
          setToolNotice(label + (detail ? `: ${detail}` : ''))
          if (toolNoticeTimer.current) {clearTimeout(toolNoticeTimer.current)}
          toolNoticeTimer.current = setTimeout(() => setToolNotice(null), 4000)
          phaseStepStartTimes.set(ev.tool, Date.now())
          pushCollabStep({
            id: `ts-${Date.now()}`, type: 'tool_start', label,
            tool: ev.tool, args: detail, timestamp: Date.now(),
          }, collabCurrentMsgIdRef.current)
        } else if (ev.type === 'tool_end') {
          if (toolNoticeTimer.current) {clearTimeout(toolNoticeTimer.current)}
          toolNoticeTimer.current = setTimeout(() => setToolNotice(null), 1500)
          const startTime = phaseStepStartTimes.get(ev.tool)
          phaseStepStartTimes.delete(ev.tool)
          const ok = !ev.error && (!ev.result || ev.result.ok !== false)
          const resultContent = ev.result?.content
            ? (typeof ev.result.content === 'string' ? ev.result.content.slice(0, 120) : JSON.stringify(ev.result.content).slice(0, 120))
            : undefined
          pushCollabStep({
            id: `te-${Date.now()}`, type: ev.error ? 'tool_error' : 'tool_end',
            label: ok ? '✅ 完成' : `❌ ${ev.error || '失败'}`,
            tool: ev.tool,
            result: resultContent || (ev.result ? JSON.stringify(ev.result).slice(0, 120) : undefined),
            durationMs: startTime ? Date.now() - startTime : undefined,
            timestamp: Date.now(),
          }, collabCurrentMsgIdRef.current)
        } else if (ev.type === 'token_update' && ev.delta !== undefined && ev.delta > 0) {
          addTokenUsage(effectiveLlmConfig.model || 'unknown', ev.delta, 'yak')
        }
      }, reqId)
      collabCurrentMsgIdRef.current = ''
      const collabMsgs: GCMsg[] = []

      const collabHistory = (() => {
        const raw = messages
          .slice(-120)
          .filter(m => {
            if (m.from !== 'system') {return true}
            return (m.content || '').trim().length > 5
          })
          .map(m => ({
            role: m.from === 'user' ? 'user' as const
                : m.from === 'system' ? 'system' as const
                : 'assistant' as const,
            content: (m.content || '').slice(0, 24000),
          }))
        const CONTEXT_WIN = effectiveLlmConfig?.contextWindow || 0
        const BUDGET = Math.floor(CONTEXT_WIN * 0.5)
        let est = 0
        const result: typeof raw = []
        for (let i = raw.length - 1; i >= 0; i--) {
          const itemEst = estimateTokens(raw[i].content) + 8
          if (est + itemEst > BUDGET && result.length > 0) {break}
          est += itemEst
          result.unshift(raw[i])
        }
        return result
      })()
      const runningHistory: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [...collabHistory]
      runningHistoryRef.current = runningHistory

      try {
        const coderPrompt = `你是 Yak，Lumina 团队的代码工程师。收到了编程任务。

⚠️ 铁律（违反就是失败）：
1. 第一反应必须是 file_read 看现状 或 file_write 直接写 —— 不要先给建议再问要不要写
2. 写完必须 shell_exec 验证，报错就改，改到通过为止。没验证过的结论等于没做过
3. 报告要如实：跑了什么命令、输出是什么、哪里没跑通。
   禁止写"应该没问题""大概可用""理论上可以"这类没验证过的话
4. 如果这是修复轮（修复之前审查发现的问题），必须先理解错误 → 定位代码 → 修改 → 验证
5. 需求确实存在歧义、且猜错代价很高（删数据、改接口、不可逆操作）时：
   先做无风险的准备工作，然后**明确写出你的假设**并继续往下做；
   只有在真的无法判断时，才向用户提问并说明缺什么信息
6. 做不到的事直接说做不到，不要用模糊话术搪塞过去`

        const reviewerPrompt = `你是热茶，审阅 Yak 的代码。看完直接给结论。
规则：
- file_read 读代码 → 给出"通过"或"有问题"的明确结论
- 有问题必须说具体位置和原因，不许写"建议优化一下"这种无法执行的话
- 没问题就说 "✓ 代码通过"
- 只审阅不改代码
- ⛔ 审阅要覆盖真实风险：逻辑错误、边界情况、异常未处理、安全隐患都要看。
  确实没发现问题就明说没发现，不要为了显得尽责而编造问题`

        let codingIteration = 0
        const MAX_CODING_ITERATIONS = 2
        let lastReviewFailed = false
        let previousErrorContext = ''

        while (codingIteration < MAX_CODING_ITERATIONS && !abortRef.current) {
          codingIteration++

          const iterSuffix = codingIteration > 1
            ? `\n\n⚠️ 【第${codingIteration}轮修改】上一轮审查发现问题：${previousErrorContext.slice(0, 500)}\n请修改代码解决这些问题后再验证。`
            : ''

          // ── Phase 1: Yak 编码/修复 ──
          setReplyingAgent('yak')
          setLastAgent('yak')
          updateEmotion('yak', userText, { isGroupChat: true })

          const coderMsgId = `yak-md-${Date.now()}`
          collabCurrentMsgIdRef.current = coderMsgId
          collabPhaseRef.current++
          resetCollabAccum()
          const coderMsg: GCMsg = {
            id: coderMsgId,
            from: 'yak', fromIcon: '📊', fromName: 'Yak',
            content: '', time: formatDateLabel(Date.now()),
          }
          setMessages(prev => [...prev, coderMsg])
          setMsgCounter(c => c + 1)
          collabMsgs.push(coderMsg)

          const phase1Task = codingIteration === 1
            ? `用户需求：${fullText.slice(0, 2000)}`
            : `用户需求：${fullText.slice(0, 1500)}${iterSuffix}`

          const codingCfg = getTaskConfig(true)
          const phase1Result = await agentChatWithTimeout({
            text: `[${codingIteration === 1 ? 'Yak，用户让你写代码。你是编码者，直接动手，不要只说建议。' : 'Yak，上一轮审查发现代码有问题，请修复！'}]\n\n${phase1Task}`,
            sessionId: sessionAtSend,
            config: {
              mode: codingCfg.mode,
              isGroupChat: true,
              personaId: 'yak',
              model: effectiveLlmConfig.model,
              baseUrl: effectiveLlmConfig.baseUrl,
              apiKey: effectiveLlmConfig.apiKey,
              temperature: 0.15,
              maxTokens: OUT_BUDGET,
              maxToolCalls: codingIteration === 1 ? 12 : 15,
              disabledTools: codingCfg.disabledTools,
              skipApproval: true,
              contextWindow: CTX_WIN,
              systemPrompt: coderPrompt,
              socialMode: true,
            },
            conversationHistory: buildHistoryForAgent(messages, 'yak', codingCfg.contextWindow, runningHistory),
          }, reqId)

          let coderReply = (phase1Result.content || '代码已写好').trimStart()
          // 🆕 团队阶段错误检测：若是超时/错误兜底文本，中断协作链并提示重试
          if (phase1Result.error || /模型响应较慢|模型响应超时|回复生成失败或耗时过长|已自动中断|请稍后(重试|再试)|出了点问题|LLM 请求失败|连接断开/i.test(coderReply)) {
            console.log('[GroupChat] ⛔ Yak 阶段出错或超时，中断协作链')
            setMessages(prev => prev.map(m => m.id === coderMsgId
              ? { ...m, content: '（Yak 处理失败，请说"继续"重试）', _animDone: true } as GCMsg : m))
            runningHistoryRef.current = runningHistory
            setSending(false); setReplyingAgent(null); setLastAgent(null)
            return
          }
          setMessages(prev => prev.map(m => m.id === coderMsgId
            ? { ...m, thinkingSteps: [...phaseThinkingAccum] } as GCMsg : m))
          animateTyping(coderMsgId, coderReply, sessionAtSend)
          runningHistory.push(
            { role: 'user', content: `[Yak 收到需求] ${fullText.slice(0, 500)}` },
            { role: 'assistant', content: `[Yak 输出] ${coderReply.slice(0, 3000)}` },
          )
          runningHistoryRef.current = runningHistory

          if (abortRef.current) { setSending(false); setReplyingAgent(null); return }

          // ── Phase 2: 热茶审查 ──
          setReplyingAgent('recha')
          setLastAgent('recha')
          updateEmotion('recha', userText, { isGroupChat: true })

          const reviewMsgId = `recha-md-${Date.now()}`
          collabCurrentMsgIdRef.current = reviewMsgId
          collabPhaseRef.current++
          resetCollabAccum()
          const reviewMsg: GCMsg = {
            id: reviewMsgId,
            from: 'recha', fromIcon: '🍵', fromName: '热茶',
            content: '', time: formatDateLabel(Date.now()),
          }
          setMessages(prev => [...prev, reviewMsg])
          setMsgCounter(c => c + 1)
          collabMsgs.push(reviewMsg)

          const phase2Result = await window.luminaAPI.agentChat({
            text: `[热茶，Yak 刚写完了代码，你来审阅一下。]\n\n用户需求：${fullText.slice(0, 500)}\n\nYak 的代码：${coderReply.slice(0, 1500)}（完整代码详见上方对话记录）`,
            config: {
              mode: codingCfg.mode,
              isGroupChat: true,
              personaId: 'recha',
              model: effectiveLlmConfig.model,
              baseUrl: effectiveLlmConfig.baseUrl,
              apiKey: effectiveLlmConfig.apiKey,
              temperature: 0.15,
              maxTokens: OUT_BUDGET,
              maxToolCalls: 5,
              skipApproval: true,
              contextWindow: CTX_WIN,
              systemPrompt: reviewerPrompt,
              socialMode: true,
            },
            conversationHistory: buildHistoryForAgent(messages, 'recha', codingCfg.contextWindow, runningHistory),
          })

          const reviewReply = (phase2Result.content || '审阅完成').trimStart()
          // 🆕 团队阶段错误检测
          if (phase2Result.error || /模型响应较慢|模型响应超时|回复生成失败或耗时过长|已自动中断|请稍后(重试|再试)|出了点问题|LLM 请求失败|连接断开/i.test(reviewReply)) {
            console.log('[GroupChat] ⛔ 热茶审阅阶段出错或超时，中断协作链')
            setMessages(prev => prev.map(m => m.id === reviewMsgId
              ? { ...m, content: '（热茶审阅失败，请说"继续"重试）', _animDone: true } as GCMsg : m))
            runningHistoryRef.current = runningHistory
            setSending(false); setReplyingAgent(null); setLastAgent(null)
            return
          }
          setMessages(prev => prev.map(m => m.id === reviewMsgId
            ? { ...m, thinkingSteps: [...phaseThinkingAccum] } as GCMsg : m))
          animateTyping(reviewMsgId, reviewReply, sessionAtSend)
          runningHistory.push(
            { role: 'assistant' as const, content: `[热茶审阅] ${reviewReply.slice(0, 3000)}` },
          )
          runningHistoryRef.current = runningHistory

          if (abortRef.current) { setSending(false); setReplyingAgent(null); return }

          // ── Phase 3: Yak 修复（如果需要）──
          const needsFix = /问题|错误|改进|建议|修改|优化|修复|不妥|漏洞|隐患|改成|应该|需要|缺少|缺失/.test(reviewReply)

          if (!abortRef.current && needsFix) {
            setReplyingAgent('yak')
            setLastAgent('yak')

            const fixMsgId = `yak-fix-${Date.now()}`
            collabCurrentMsgIdRef.current = fixMsgId
            collabPhaseRef.current++
            resetCollabAccum()
            const fixMsg: GCMsg = {
              id: fixMsgId,
              from: 'yak', fromIcon: '📊', fromName: 'Yak',
              content: '', time: formatDateLabel(Date.now()),
            }
            setMessages(prev => [...prev, fixMsg])
            setMsgCounter(c => c + 1)
            collabMsgs.push(fixMsg)

            const phase3Result = await agentChatWithTimeout({
              text: `[Yak，热茶审查了你的代码，有一些建议。请根据审查意见修改代码。]\n\n热茶的审查意见：${reviewReply.slice(0, 500)}`,
              sessionId: sessionAtSend,
              config: {
                mode: codingCfg.mode,
                isGroupChat: true,
                personaId: 'yak',
                model: effectiveLlmConfig.model,
                baseUrl: effectiveLlmConfig.baseUrl,
                apiKey: effectiveLlmConfig.apiKey,
                temperature: 0.15,
                maxTokens: OUT_BUDGET,
                maxToolCalls: 8,
                skipApproval: true,
                contextWindow: CTX_WIN,
                systemPrompt: coderPrompt,
                socialMode: true,
              },
              conversationHistory: buildHistoryForAgent(messages, 'yak', codingCfg.contextWindow, runningHistory),
            }, reqId)

            const fixReply = (phase3Result.content || '修复完成').trimStart()
            // 🆕 团队阶段错误检测
            if (phase3Result.error || /模型响应较慢|模型响应超时|回复生成失败或耗时过长|已自动中断|请稍后(重试|再试)|出了点问题|LLM 请求失败|连接断开/i.test(fixReply)) {
              console.log('[GroupChat] ⛔ Yak 修复阶段出错或超时，中断协作链')
              setMessages(prev => prev.map(m => m.id === fixMsgId
                ? { ...m, content: '（Yak 修复失败，请说"继续"重试）', _animDone: true } as GCMsg : m))
              runningHistoryRef.current = runningHistory
              setSending(false); setReplyingAgent(null); setLastAgent(null)
              return
            }
            setMessages(prev => prev.map(m => m.id === fixMsgId
              ? { ...m, thinkingSteps: [...phaseThinkingAccum] } as GCMsg : m))
            animateTyping(fixMsgId, fixReply, sessionAtSend)
            runningHistory.push(
              { role: 'assistant' as const, content: `[Yak 修复] ${fixReply.slice(0, 3000)}` },
            )
            runningHistoryRef.current = runningHistory

            if (fixReply.length > 10) {coderReply = fixReply}
          }

          // 判断审查是否通过
          if (!needsFix) {
            break  // ✅ 审查通过，退出
          }

          if (codingIteration < MAX_CODING_ITERATIONS) {
            previousErrorContext = reviewReply.slice(0, 500)
            lastReviewFailed = true
            await new Promise(r => setTimeout(r, 800))
          }
        }  // end while

        if (codingIteration >= MAX_CODING_ITERATIONS && lastReviewFailed) {
          setMessages(prev => [...prev, {
            id: `sys-${Date.now()}`,
            from: 'system', fromIcon: '⚠️', fromName: '系统',
            content: `⚠️ 已尝试 ${MAX_CODING_ITERATIONS} 轮，审查仍有问题。建议手动查看代码或@热茶进行详细审查。`,
            time: formatDateLabel(Date.now()),
          }])
        }

      } catch (err: any) {
        setMessages(prev => prev.map(m =>
          collabMsgs.some(cm => cm.id === m.id) && !m.content
            ? { ...m, _animDone: true } as GCMsg : m
        ))
        setMessages(prev => [...prev, {
          id: `err-${Date.now()}`, from: 'system', fromIcon: '⚠️', fromName: '系统',
          content: `中型编程出错: ${err.message}`,
          time: formatDateLabel(Date.now()),
        }])
      } finally {
        unsubTool()
        setSending(false)
        setReplyingAgent(null)
        setLastAgent(null)
        setTimeout(() => {
          commitToSession(sessionAtSend, prev => prev)
          // 🐛 2026-10-13 修复：原实现是 **no-op** —— 它把读出来的 `ss` 原样写回，
          //   从未把本会话**加进**列表（`saveGCSessions(ss)` 里 ss 就是当前内容），
          //   所以「协作流程跑完后，这个会话仍然不在侧边栏」。
          //   现在按原意真正补上：只在缺失时插入。
          //   另外用 `sessionAtSend` 而不是 `activeSessionId` —— 后者是 3 秒后
          //   的闭包值，用户中途切走就指错了会话。
          const latest = loadGCSessions()
          if (!latest.some((s: GCSession) => s.id === sessionAtSend)) {
            const msgs = loadGCMessages(sessionAtSend)
            saveGCSessions([
              {
                id: sessionAtSend,
                date: new Date().toLocaleDateString('zh-CN'),
                preview: msgs.filter(m => m.from === 'user').slice(-1)[0]?.content?.slice(0, 30) || '',
                count: msgs.length,
              },
              ...latest,
            ])
            window.dispatchEvent(new Event('gc:sessions-updated'))
          }
        }, 3000)
      }
      return
    }

    // ── 🔧 v3.6: 智能路由 → 按任务类型分配 Agent ──
    // 🔧 fix: 移除 lastAgent 粘性路由 — 每次都按当前意图重新判断，
    //   避免上一个 Agent（如 热茶/Yak）被错误记住后，后续所有聊天都发给同一人导致跑题
    // 🆕 v9.2: 如果用户选了任务卡片（overrideResponder），优先使用它
    const mentioned = parseMention(userText)
    let responder: typeof AGENTS[number]
    // 🔧 2026-08-11: @ 显式指定最高优先（持续话题下用户仍可 @ 指定某人）
    if (mentioned) {
      responder = AGENTS.find(a => a.id === mentioned)!
      // 🆕 2026-10-07 能力守卫：@ 了只读成员却要它写代码 → 改派给能写的人。
      //   否则用户会收到一句「我不会写代码」的死胡同（见 upgradeReadOnlyTarget 注释）。
      const upgraded = upgradeReadOnlyTarget(responder.id, userText, taskIntent)
      if (upgraded) {responder = AGENTS.find(a => a.id === upgraded)!}
    } else if (overrideResponder) {
      // 用户通过任务卡片/派发中心指定了 agent → 直接使用，跳过自动匹配
      responder = overrideResponder
    } else {
      responder = routeToAgent(taskIntent)
    }

    // v6.0: LLM 未配置时，只允许 Lumina 发言（Yak/热茶 是后台工作者）
    if (!llmReady && responder.id !== 'lumina') {
      responder = AGENTS.find(a => a.id === 'lumina')!
    }
    setReplyingAgent(responder.id)
    setLastAgent(responder.id) // 🆕 记住本轮回复?

    // ── 如果 LLM，调真实 API ──
    if (llmReady) {
      // 先创建占位消息，让思考过程可以实时更新
      const replyId = `${responder.id}-${Date.now()}`
      const replyMsg: GCMsg = {
        id: replyId,
        from: responder.id, fromIcon: responder.icon, fromName: responder.name,
        content: '', time: formatDateLabel(Date.now()),
      }
      setMessages(prev => {
        const updated = [...prev, replyMsg]
        // 🔒 占位消息立即落盘（P0 配套）：生成期间若用户切走会话，
        //   回复要靠 replyId 在**发起会话的存档**里定位 —— 存档里没有占位就没处可写，
        //   回复会丢失。saveGCMessages 会保留「未完成」的空占位，
        //   而 loadGCMessages 在重载时会把仍然空的占位过滤掉（不会留空气泡）。
        if (activeSessionRef.current === sessionAtSend) {saveGCMessages(sessionAtSend, updated)}
        return updated
      })
      setMsgCounter(c => c + 1)

      // 思考过程追踪（借鉴 QwenPaw）
      const thinkingAccum: ThinkingStep[] = []
      const stepIds = new Set<string>()  // 去重
      const stepStartTimes = new Map<string, number>()  // tool_start → timestamp
      // 可变引用 — 链式火花时切换目标消息
      let currentReplyId = replyId
      /** 🆕 v5.2: upsert — 同 key 更新而非新增 */
      const upsertStep = (s: ThinkingStep, stableKey?: string) => {
        const key = stableKey || `${s.type}:${s.tool || ''}:${s.label.slice(0, 30)}`
        const existingIdx = thinkingAccum.findIndex(
          step => (stableKey && (step as any)._stableKey === stableKey) ||
                  (`${step.type}:${step.tool || ''}:${step.label.slice(0, 30)}` === key)
        )
        if (existingIdx >= 0) {
          thinkingAccum[existingIdx] = { ...thinkingAccum[existingIdx], ...s }
        } else {
          (s as any)._stableKey = stableKey || ''
          thinkingAccum.push(s)
        }
        pushThinking(currentReplyId, [...thinkingAccum])
      }
      const pushStep = (s: ThinkingStep) => upsertStep(s)

      // 重置思考累计器（链式火花时复用）
      const resetThinkingAccum = () => {
        thinkingAccum.length = 0
        stepIds.clear()
        stepStartTimes.clear()
      }

      const unsubTool = subscribeAgentEvents((ev: any) => {
        // 用户中止时立即停止累积思考步骤
        if (abortRef.current) {return}
        if (ev.type === 'thinking_stream') {
          const streamStepId = `re-${currentReplyId}`
        const stableKey = `reasoning:${currentReplyId}`
          if (ev.isLast) {
            // fix: 保留之前累积的推理内容，不因 isLast 覆盖丢失
            const existing = thinkingAccum.find(s => (s as any)._stableKey === stableKey)
            upsertStep({
              id: streamStepId,
              type: 'thinking',
              label: '💭 推理完成',
              result: existing?.result,  // 保留推理内容
              timestamp: Date.now(),
            }, stableKey)
          } else if (ev.text) {
            // fix: isFirst 是元信号（"思考中..."），不计入 result
            //   只记录真正的推理内容 (delta.reasoning_content)
            if (ev.isFirst) {
              // 仅创建占位步骤，不累积文本
              if (!thinkingAccum.find(s => (s as any)._stableKey === stableKey)) {
                upsertStep({
                  id: streamStepId,
                  type: 'thinking',
                  label: '💭 推理中...',
                  timestamp: Date.now(),
                }, stableKey)
              }
            } else {
              const existing = thinkingAccum.find(s => (s as any)._stableKey === stableKey)
              const fullText = existing?.result ? existing.result + ev.text : ev.text
              upsertStep({
                id: streamStepId,
                type: 'thinking',
                label: '💭 推理中...',
                result: fullText.slice(-5000),
                timestamp: Date.now(),
              }, stableKey)
            }
          }
        } else if (ev.type === 'thinking' || ev.type === 'text') {
          const txt = (ev.text || ev.content || '').trim()
          // 减少过滤 — 只跳过纯噪音消息，保留循环状态和慢速提示
          const isNoise = /⚠️\s*检测到潜在注入/i.test(txt)
          const loopMatch = txt.match(/^思考中\.\.\.\s*\(第\s*(\d+)\s*轮\)$/i)
          const displayLabel = loopMatch ? `🔁 第${loopMatch[1]}轮思考` : txt.slice(0, 120)
          if (txt && txt.length > 2 && !isNoise) {
            pushStep({
              id: `think-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
              type: 'thinking',
              label: displayLabel,
              result: txt,  // 完整思考文本 → 可展开查看
              timestamp: Date.now(),
            })
          }
        } else if (ev.type === 'tool_start') {
          const { label, detail } = describeToolAction(ev.tool, ev.args)
          const notice = label + (detail ? `: ${detail}` : '')
          setToolNotice(notice)
          if (toolNoticeTimer.current) {clearTimeout(toolNoticeTimer.current)}
          toolNoticeTimer.current = setTimeout(() => setToolNotice(null), 4000)
          stepStartTimes.set(ev.tool, Date.now())
          pushStep({
            id: `ts-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
            type: 'tool_start',
            label,
            tool: ev.tool,
            args: detail,
            timestamp: Date.now(),
          })
        } else if (ev.type === 'tool_end') {
          if (toolNoticeTimer.current) {clearTimeout(toolNoticeTimer.current)}
          toolNoticeTimer.current = setTimeout(() => setToolNotice(null), 1500)
          const startTime = stepStartTimes.get(ev.tool)
          stepStartTimes.delete(ev.tool)
          const ok = !ev.error && (!ev.result || ev.result.ok !== false)
          const resultContent = ev.result?.content
            ? (typeof ev.result.content === 'string' ? ev.result.content.slice(0, 120) : JSON.stringify(ev.result.content).slice(0, 120))
            : undefined
          pushStep({
            id: `te-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
            type: ev.error ? 'tool_error' : 'tool_end',
            label: ok ? '✅ 完成' : `❌ ${ev.error || '失败'}`,
            tool: ev.tool,
            result: resultContent || (ev.result ? JSON.stringify(ev.result).slice(0, 120) : undefined),
            durationMs: startTime ? Date.now() - startTime : undefined,
            timestamp: Date.now(),
          })
        } else if (ev.type === 'token_update' && ev.delta !== undefined && ev.delta > 0) {
          // 独立 Agent token 追踪
          addTokenUsage(effectiveLlmConfig.model || 'unknown', ev.delta, responder.id)
        }
      }, reqId)

      try {
        // v2.8: 更新情绪
        updateEmotion(responder.id, userText, { isGroupChat: true })
        // v2.8.1: 找上一位非系统 Agent 发言，避免复读
        const lastAgentMsg = [...messages].reverse().find(m =>
          m.from !== 'system' && m.from !== 'user' && m.from !== responder.id
        )
        // 🧠 v9.0: 智能工具分配 — 根据用户意图动态决定启用哪些工具
        const toolIntent = detectToolIntent(fullText, currentAttachments.length > 0)
        const intentToolsPrompt = getGCToolsPromptForIntent(teamSecurity, toolIntent)
        const systemPrompt = getAgentSystemPromptLite(
          responder.id,
          lastAgentMsg?.from,
          lastAgentMsg?.content?.slice(0, 150),
          intentToolsPrompt,  // 🧠 v9.0: 用意图感知的工具提示替代全局提示
        )
        // 🧠 思考模式 — 严格模板格式
        //   修复: 之前指令太软，模型不遵守 → 改为 MUST-FOLLOW 模板
        const thinkingInstruction = thinkingMode
          ? '\n\n## 🧠 思考与回复格式\n先用 <thinking> 标签在心里简要梳理思路（这部分用户看不到），\n然后在 </thinking> 之后输出给用户的**完整自然回复**：针对用户的问题或话题作答，至少一句，语气符合你的角色。\n⚠️ 规则：\n- 推理过程放在 <thinking> 内\n- </thinking> 之后必须是给用户的真实回复，禁止留空、禁止只回"收到/好的/明白"、禁止复述这条格式指令'
          : ''
        // 🆕 v3.7: 小型编码任务 → 添加编码指令
        const isSmallCoding = isCoding && codeScale === 'small'
        const codingInstruction = isSmallCoding
          ? '\n\n## 📝 小型编程任务\n直接动手写代码，不准只说建议。读完需求后：\n1. file_read 查看现有代码\n2. file_write/shell_exec 直接编写和验证\n3. 完成时说清楚写/改了什么文件，结果如何'
          : ''
        // 🔧 2026-08-11: 追加话题专属人设（持续话题时每次生效）
        const finalSystemPrompt = systemPrompt + thinkingInstruction + codingInstruction + getTaskTypeInstruction(explicitTaskType)
        // 🧠 v9.0: 意图感知的工具调用上限
        // v9.1: 简化 — 有附件时多给几轮（文件解析可能需要多步），其他情况默认 6 轮
        const intentMaxToolCalls = (toolIntent.categories.includes('file') && currentAttachments.length > 0)
          ? 8   // 有附件 → 文件解析可能需要多步
          : 6   // 默认
        const taskConfig = getTaskConfig(isSmallCoding, {
          mode: 'agent',
          maxToolCalls: isSmallCoding ? 12 : intentMaxToolCalls,
        }, explicitTaskType)
        const activeAgentId = isSmallCoding ? 'recha' : responder.id

        // 🔧 2026-07-14: token 安全截断 — 根据上下文窗口动态计算最大条数
        //   目标：总历史 ≈ 窗口的 60%（留 40% 给 system prompt + 工具列表 + 当前输入）
        // 去掉硬编码最大 60 条限制，改为纯 token 动态截断
        //   上次限制 60 × 2000 字符 = 120K 字符 ≈ 30K token，仍有大量浪费
        // 合并 runningHistory（结构化协作摘要）到 historyForLLM
        //   之前: Lumina 主回复只看到原始 messages，看不到协作阶段的结构化摘要
        //   （[热茶 输出]、[Yak 审阅]、[热茶 修复] 等）。这些摘要比原始消息更紧凑、
        //   信息密度更高，LLM 能更快理解协作发生了什么。
        //   现在: 先构建 messages 基础上下文，再追加 runningHistory 条目
        //
        // 🔧 2026-07-14: token 安全截断 — 根据上下文窗口动态计算最大条数
        //   目标：总历史 ≈ 窗口的 60%（留 40% 给 system prompt + 工具列表 + 当前输入）
        // 去掉硬编码 60 条上限，改为纯 token 动态截断
        // 🆕 v1.0: 用 Per-Agent 隔离构建替代原来的全量历史
        // 🔧 2026-07-31: skipSystem: true — 欢迎消息是给 UI 看的，不该喂给 LLM。
        //   否则 AgentRunner 的 FIX-1 会因 messages[0] 是 system 而跳过 system prompt
        //   注入，导致身份/工具说明/群聊覆盖指令全部丢失（搜索不行 + 失忆开场白）。
        //   与下方链式回复/决策讨论的 skipSystem: true 行为保持一致。
        const historyForLLM = buildHistoryForAgent(
          messages,
          activeAgentId,                  // 🆕 v3.7: 小型编码→热茶独立历史
          taskConfig.contextWindow,
          runningHistoryRef.current,       // 协作摘要保留
          { skipSystem: true },            // 🔧 2026-07-31: 系统欢迎消息不进 LLM 历史
        )
        // v10.9: 检查是否有图片附件，支持多模态
        const imageAttachments = currentAttachments.filter(a => (a as any).imageDataUrl)
        const textContent = fullText
        const visionContent = imageAttachments.length > 0
          ? [
              { type: 'text', text: textContent },
              ...imageAttachments.map(a => ({
                type: 'image_url',
                image_url: { url: (a as any).imageDataUrl }
              }))
            ]
          : textContent

        const result = await agentChatWithTimeout({
          // v10.9: 支持多模态 — 图片以 base64 格式传给视觉模型
          text: visionContent as any,
          // 🆕 2026-10-13：把当前会话 id 传给后端。
          //
          //   旧实现不传 → `agentRunner` 落到硬编码兜底 `session-1786780079226`，
          //   后果是**所有主窗口会话的落库日志堆在同一个 session 里**
          //   （实测 7791 条、横跨 2 个月），而前端真实会话 id 是
          //   `mv6lbvk2hk7l4o` 这种 base36 串 —— 两边完全对不上。
          //   任何「按 sessionId 查历史」的后续能力都会串味。
          //
          //   用 `sessionAtSend`（发起这一轮时的会话）而不是当前活跃会话：
          //   用户中途切走时，这一轮仍应归属它**发起时**所在的会话。
          //   （对话上下文本身不受影响 —— 那是靠 conversationHistory 传的，
          //     这里只是让后端日志能按会话切分。）
          sessionId: sessionAtSend,
          config: {
            mode: 'agent' as const,  // 群聊普通回复必须用 agent 模式，否则无法调用搜索/文件等工具
            isGroupChat: true,
            personaId: activeAgentId,   // 🆕 v3.7: 小型编码→recha，其他→原路由
            model: effectiveLlmConfig.model,
            baseUrl: effectiveLlmConfig.baseUrl,
            apiKey: effectiveLlmConfig.apiKey,
            temperature: taskConfig.temperature,
            maxTokens: taskConfig.maxTokens,
            maxToolCalls: taskConfig.maxToolCalls,
            disabledTools: taskConfig.disabledTools,
            skipApproval: teamSecurity.level === 'skip_all',  // 🔧 v2.16: 群聊 Agent 已委派，跳过安全审批
            contextWindow: taskConfig.contextWindow,
            systemPrompt: finalSystemPrompt,
            socialMode: true,  // 🔧 v6.3: 群聊主回复也需要无限超时 — 多Agent协作+工具调用可能耗时较长
            trackReasoning: thinkingMode,  // 🧠 v10.6: 思考过程开关 → 后端控制 thinking_stream 事件
          },
          conversationHistory: historyForLLM,
        }, reqId)

        // ═══ 中断守卫（P1-2 / P2-2 修复 · 2026-10-10）═══════════════════════
        // 用户点了「中断」时，后端在 abort 后仍可能返回兜底文案
        // （「这轮我没能给出有效回复…」）。这里必须丢弃，否则用户会看到一条
        // 「明明是我主动中断的，却说我失败了」的误导气泡，且它不匹配超时恢复正则，
        // 还会继续触发链式火花（雪崩式多余回复）。
        // （ChatPanel 一直有 `!abortRef.current` 守卫，群聊此前缺失。）
        if (abortRef.current) {
          commitToSession(sessionAtSend, prev => prev.filter(m => m.id !== replyId))
          setSending(false); setReplyingAgent(null); setLastAgent(null)
          return
        }

        // 🧠 思考模式 — 提取 <thinking> 标签 → 捕获为 thinkingSteps
        if (result.content && thinkingMode) {
          const tagRegex = /<thinking>([\s\S]*?)<\/thinking>/g
          let tagMatch: RegExpExecArray | null
          while ((tagMatch = tagRegex.exec(result.content)) !== null) {
            const text = tagMatch[1].trim()
            if (text) {
              const clean = cleanThinkingText(text)
              pushStep({
                id: `think-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
                type: 'thinking',
                label: '💭 ' + clean.slice(0, 80),
                result: clean.slice(0, 5000),
                timestamp: Date.now(),
              })
            }
          }
        }
        // 清洗 <thinking> 标签（无论是否开启都清理，防止标签泄露）
        // v10.9: 增加 <｜DSML｜|...> 等特殊模型输出格式的清理
        const cleanContent = (result.content || '')
          .replace(/<thinking>[\s\S]*?<\/thinking>/g, '')
          .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
          .replace(/<｜DSML｜[\s\S]*?<\/｜DSML｜>/gi, '')
          .replace(/<｜DSML｜[\s\S]*$/gi, '')
          .replace(/<\w+\s*\([^)]*\)\s*>/gi, '')
          .trim()
        const reply = stripReasoningPrefix(
          (cleanContent || result.content || result.error || '抱歉，暂时无法生成有效回复。请试试说"继续"让我重新尝试。').trimStart()
        )

        // 二次清洗 — 强化启发式段落剥离
        //   覆盖 stripReasoningPrefix 仍漏掉的情况（模型推理格式千变万化）
        const finalReply2 = (() => {
          const firstPara = reply.split('\n\n')[0]?.trim() || ''
          if (
            reply.includes('\n\n') &&
            firstPara.length > 15 &&
            (
              // 用户行为分析
              /^用户[又收发看说讲发问]/.test(firstPara) ||
              // 自我规划
              /^我[需要应该要][^。]*?(?:保持|注意|用|作为|确保|让|给)/.test(firstPara) ||
              // 场景定义
              /^这是[一一个]/.test(firstPara) ||
              // 角色自我指涉
              /^作为[^。]*?(?:Lumina|猫娘|AI|助手|agent|热茶|Yak)[^。]*?[，,]\s*我/.test(firstPara) ||
              // 规则引用
              /^根据.*?(?:设定|规则|系统提示|角色|身份|性格|铁则|原则|要求|规定|协议)/.test(firstPara) ||
              // 修辞分析
              /^看起来|^看来|^显然|^很明显|^这显然|^这明显/.test(firstPara) ||
              // 犹豫/思考
              /^让我[想想看看来分析理解重新]|^等等|^等一下|^嗯[，,。]/u.test(firstPara) ||
              // 元分析
              /^这里|^这似乎|^这看起来|^从上下文|^根据上下文/.test(firstPara) ||
              // 推理结论
              /^我觉得|^我认为|^我想|^我猜|^不管怎样|^核心是|^总之/.test(firstPara)
            )
          ) {
            const rest = reply.slice(firstPara.length).trim()
            if (rest.length >= 3) {return rest}
          }
          return reply
        })()

        // 内容去重 — 防止 LLM 重复输出同一回复
        const dedupedReply = deduplicateLLMContent(finalReply2)

        // ═══ Lucky 模式检查 ═══
        if (luckyMode.isActive && luckyMode.preset !== 'off') {
          const { checkAfterReply } = await import('../services/luckyModeService')
          const checkResult = checkAfterReply(dedupedReply)

          // 死循环检测
          if (checkResult.isDoomLoop && checkResult.doomLoopMessage) {
            setMessages(prev => [...prev, {
              id: `lucky-doom-${Date.now()}`,
              from: 'system', fromIcon: '⚠️', fromName: 'Lucky 模式',
              content: checkResult.doomLoopMessage ?? '',
              time: formatDateLabel(Date.now()),
            }])
            setMsgCounter(c => c + 1)
          }

          // 达到最大迭代次数
          if (checkResult.shouldPause && checkResult.pauseReason) {
            setMessages(prev => [...prev, {
              id: `lucky-pause-${Date.now()}`,
              from: 'system', fromIcon: '⏸️', fromName: 'Lucky 模式',
              content: checkResult.pauseReason ?? '',
              time: formatDateLabel(Date.now()),
            }])
            setMsgCounter(c => c + 1)
            luckyMode.pause(checkResult.pauseReason)
          }
        }

        // 将累积的思考步骤附加到消息
        // （event listener 已经在实时推送，这里做最终确认）
        // 仅在仍处于发起会话时更新视图；切走后存档由 animateTyping 负责。
        if (activeSessionRef.current === sessionAtSend) {
          setMessages(prev => prev.map(m => m.id === replyId
            ? { ...m, thinkingSteps: [...thinkingAccum] } as GCMsg : m))
        }

        // ═══ v2.7: 流式打字 + TTS ═══
        // 过滤过短回复 — 已移至后端 checkCompletion 统一处理，前端不再拦截
        const finalReply = dedupedReply
        animateTyping(replyId, finalReply, sessionAtSend)
        try {
          const cleanText = cleanTtsText(finalReply)
          if (cleanText.length > 10 && !useStore.getState().ttsMuted) {
            enqueueTTS(cleanText, getEffectiveVoice(responder.id))
          }
        } catch {} /* TTS optional */

        // ══════════════════════════════════════════════
        // v2.8.3: 群聊火花系统 — 三种触发 + 链式反应
        // ══════════════════════════════════════════════

        // 超时恢复文本不触发链式火花，避免雪崩
        //   匹配简化后的错误消息 — 只拦截纯错误/兜底文本，不影响正常内容
        const isTimeoutRecovery = /模型响应较慢|模型响应超时|回复生成失败或耗时过长|已自动中断|请稍后(重试|再试)|请稍微简化问题|出了点问题|LLM 请求失败|连接断开/i.test(reply)
        if (isTimeoutRecovery) {
          console.log('🔕 跳过链式火花：回复为超时恢复文本')
          soloTurnCount.current += 1
          unsubTool()
          setReplyingAgent(null)
          setSending(false)
          setTimeout(() => {
            commitToSession(sessionAtSend, prev => prev)
          }, 2000)
          return
        }

        const isUncertain = detectUncertainty(reply)
        const mentionedAgent = detectMentionInReply(reply, responder.id)
        const spark = isUncertain || mentionedAgent
          ? null
          : calculateSpark({
              firstAgentId: responder.id,
              firstReply: reply,
              userText,
              recentTurnCount: soloTurnCount.current,
              agentCount: 3,
            })

        if (isUncertain || mentionedAgent || spark) {
          // ── 准备首次接话 ──
          let lastReply = reply  // 🐛 fix: 提到 if 前面，避免 TDZ（Cannot access before initialization）
          let nextSpeakerId: string
          let nextContext: string
          if (mentionedAgent) {
            nextSpeakerId = mentionedAgent
            nextContext = `${responder.name} @了你：${lastReply.slice(0, 300)}`
          } else if (isUncertain) {
            const others = AGENTS.filter(a => a.id !== responder.id)
            nextSpeakerId = others[Math.floor(Math.random() * others.length)].id
            nextContext = `${userText.slice(0, 200)}\n\n（${responder.name} 刚才说：${reply.slice(0, 300)}）`
          } else {
            nextSpeakerId = spark!.agentId
            nextContext = spark!.contextForLLM
            console.log(`✨ 火花触发: ${spark!.reason}`)
          }

          soloTurnCount.current = 0
          const spokenIds: string[] = [responder.id]     // 本轮已发言
          let lastSpeakerId = responder.id
          lastReply = reply  // 承接上面声明的 lastReply，更新为实际的 reply
          const accumulatedMsgs: GCMsg[] = [replyMsg]    // 用于构建历史

          // ── 链式循环：最多 4 次链式火花 ──
          for (let chain = 0; chain < 4; chain++) {
            if (abortRef.current) {break}

            const helper = AGENTS.find(a => a.id === nextSpeakerId)!
            updateEmotion(helper.id, userText, { isGroupChat: true })
            setReplyingAgent(helper.id)
            setLastAgent(helper.id)

            let helperReply = ''
            // 链式火花占位消息 — agentChat 前创建，让思考过程实时更新
            const hId = `${helper.id}-${Date.now()}`
            const hMsg: GCMsg = {
              id: hId,
              from: helper.id, fromIcon: helper.icon, fromName: helper.name,
              content: '', time: formatDateLabel(Date.now()),
            }
            setMessages(prev => [...prev, hMsg])
            setMsgCounter(c => c + 1)
            currentReplyId = hId
            resetThinkingAccum()

            try {
              // 链式回复（非编程场景）
              // fix: helper 链式回复也强制 agent 模式，保证工具可用
              const chainTaskConfig = getTaskConfig(false, { mode: 'agent', maxToolCalls: 6 }, explicitTaskType)
              // 🆕 v1.0: 用 Per-Agent 隔离构建替代原来的 helperHistory
              //   - 链式 Agent（热茶/Yak）只看自己的 + 用户的 + 其他人摘要
              //   - 跳过系统消息（skipSystem: true，与原 filter 行为一致）
              const helperHistory = buildHistoryForAgent(
                [...messages, ...accumulatedMsgs],
                helper.id,
                chainTaskConfig.contextWindow,
                [],          // 链式回复不需要 runningHistory
                { skipSystem: true },
              )
              const helperResult = await agentChatWithTimeout({
                // 简化消息格式
                text: nextContext,
                sessionId: sessionAtSend,
                config: {
                  mode: chainTaskConfig.mode,
                  isGroupChat: true,
                  personaId: helper.id,
                  model: effectiveLlmConfig.model,
                  baseUrl: effectiveLlmConfig.baseUrl,
                  apiKey: effectiveLlmConfig.apiKey,
                  temperature: chainTaskConfig.temperature,
                  maxTokens: chainTaskConfig.maxTokens,
                  maxToolCalls: chainTaskConfig.maxToolCalls,
                  disabledTools: chainTaskConfig.disabledTools,
                  skipApproval: teamSecurity.level === 'skip_all',  // 🔧 v2.16: 群聊 Agent 跳过安全审批
                  contextWindow: chainTaskConfig.contextWindow,
                  systemPrompt: getAgentSystemPromptLite(helper.id, lastSpeakerId, lastReply.slice(0, 100), intentToolsPrompt)
                    + getTaskTypeInstruction(explicitTaskType)
                    + (thinkingMode ? '\n\n## 🧠 思考与回复格式\n先用 <thinking> 标签在心里简要梳理思路（这部分用户看不到），\n然后在 </thinking> 之后输出给用户的**完整自然回复**：针对用户的问题或话题作答，至少一句，语气符合你的角色。\n⚠️ 规则：\n- 推理过程放在 <thinking> 内\n- </thinking> 之后必须是给用户的真实回复，禁止留空、禁止只回"收到/好的/明白"、禁止复述这条格式指令\n\n📌 特别说明：本对话已开启「思考模式」，允许且必须使用 <thinking> 标签包裹推理过程；角色设定中「禁止输出 XML/HTML 标签」的条款，在本思考模式下对 <thinking> 标签不生效。' : ''),
                  socialMode: true,  // 🆕 v1.0: 链式回复是自动触发的，用短超时
                  trackReasoning: thinkingMode,  // 🧠 v10.6: 思考过程开关
                },
                conversationHistory: helperHistory,
              }, reqId)
              // 🧠 思考模式 — 提取 <thinking> 标签 → 捕获为 thinkingSteps
              if (helperResult.content && thinkingMode) {
                const tagRegex = /<thinking>([\s\S]*?)<\/thinking>/g
                let tagMatch: RegExpExecArray | null
                while ((tagMatch = tagRegex.exec(helperResult.content)) !== null) {
                  const text = tagMatch[1].trim()
                  if (text) {
                    const clean = cleanThinkingText(text)
                    pushStep({
                      id: `chain-think-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
                      type: 'thinking',
                      label: '💭 ' + clean.slice(0, 80),
                      result: clean.slice(0, 5000),
                      timestamp: Date.now(),
                    })
                  }
                }
              }
              // 链式火花 — 强化清洗（与主回复一致）
              // v10.9: 增加 <｜DSML｜|...> 等特殊模型输出格式的清理
              const helperCleanContent = (helperResult.content || '')
                .replace(/<thinking>[\s\S]*?<\/thinking>/g, '')
                .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
                .replace(/<｜DSML｜[\s\S]*?<\/｜DSML｜>/gi, '')
                .replace(/<｜DSML｜[\s\S]*$/gi, '')
                .replace(/<\w+\s*\([^)]*\)\s*>/gi, '')
                .trim()
              helperReply = stripReasoningPrefix(
                (helperCleanContent || helperResult.content || '').trimStart()
              )
              // 二次清洗 — 启发式段落剥离
              {
                const firstPara = helperReply.split('\n\n')[0]?.trim() || ''
                if (
                  helperReply.includes('\n\n') &&
                  firstPara.length > 15 &&
                  (
                    /^用户[又收发看说讲发问]/.test(firstPara) ||
                    /^我[需要应该要][^。]*?(?:保持|注意|用|作为|确保|让|给)/.test(firstPara) ||
                    /^这是[一一个]/.test(firstPara) ||
                    /^作为[^。]*?(?:Lumina|猫娘|AI|助手|agent|热茶|Yak)[^。]*?[，,]\s*我/.test(firstPara) ||
                    /^根据.*?(?:设定|规则|系统提示|角色|身份|性格|铁则|原则|要求|规定|协议)/.test(firstPara) ||
                    /^看起来|^看来|^显然|^很明显|^这显然|^这明显/.test(firstPara) ||
                    /^让我[想想看看来分析理解重新]|^等等|^等一下|^嗯[，,。]/u.test(firstPara) ||
                    /^这里|^这似乎|^这看起来|^从上下文|^根据上下文/.test(firstPara) ||
                    /^我觉得|^我认为|^我想|^我猜|^不管怎样|^核心是|^总之/.test(firstPara)
                  )
                ) {
                  const rest = helperReply.slice(firstPara.length).trim()
                  if (rest.length >= 3) {helperReply = rest}
                }
              }
              // 链式火花 — 内容去重
              helperReply = deduplicateLLMContent(helperReply)
              // 附加思考步骤
              setMessages(prev => prev.map(m => m.id === hId
                ? { ...m, thinkingSteps: [...thinkingAccum] } as GCMsg : m))
            } catch {
              // 清理空白气泡 — 标记为已完成（渲染层显示占位符）
              setMessages(prev => prev.map(m => m.id === hId
                ? { ...m, _animDone: true } as GCMsg : m))
              break
            }

            if (!helperReply || /^[\s✅👍👎❤️💯🎉🤔😂🫡💪🙏✨🔥👀😅🥺💀🫠]*$/u.test(helperReply.trim()) || helperReply.trim().length < 3) {
              // 清理空白/过短气泡 — 跳过这条链式回复
              setMessages(prev => prev.filter(m => m.id !== hId))
              break
            }

            // 显示回复（流式打字）
            animateTyping(hId, helperReply, sessionAtSend)
            try { const ct = cleanTtsText(helperReply); if (ct.length > 10 && !useStore.getState().ttsMuted) {enqueueTTS(ct, getEffectiveVoice(helper.id))} } catch {}

            // 更新状态
            spokenIds.push(helper.id)
            accumulatedMsgs.push(hMsg)
            lastSpeakerId = helper.id
            lastReply = helperReply

            // ── 尝试链式火花 ──
            const chainSpark = calculateChainSpark({
              lastSpeakerId,
              lastReply,
              alreadySpokenIds: spokenIds,
            })
            if (!chainSpark) {break}
            console.log(`🔗 链式火花: ${chainSpark.reason}`)
            nextSpeakerId = chainSpark.agentId
            nextContext = chainSpark.contextForLLM
          }
        } else {
          soloTurnCount.current += 1
        }
      } catch (err: any) {
        // 清理空白气泡 — 先标记原消息，再追加错误消息
        setMessages(prev => prev.map(m =>
          m.id === replyId && !m.content
            ? { ...m, _animDone: true } as GCMsg
            : m
        ))
        // 记录详细错误原因（方便调试）
        const errMsg = err?.message || String(err || '')
        const isTimeout = /timeout|abort|超时|timed? ?out/i.test(errMsg)
        const isNetwork = /network|connect|refused|ECONN|fetch/i.test(errMsg)
        const isLLMError = /LLM|model|api.?key|token|rate.?limit|401|402|429|5\d{2}/i.test(errMsg)
        let hint = ''
        if (isTimeout) {hint = '（LLM 响应超时）'}
        else if (isNetwork) {hint = '（网络连接失败）'}
        else if (isLLMError) {hint = `（LLM 返回错误）`}
        else if (errMsg) {hint = `（${errMsg.slice(0, 60)}）`}
        console.warn(`[GC] 链式火花失败: ${responder.name} - ${errMsg}`)
        // 用户主动中止时不显示错误提示
        if (!abortRef.current) {
          setMessages(prev => [...prev, {
            id: `err-${Date.now()}`, from: 'system', fromIcon: '⚠️', fromName: '系统',
            content: `${responder.name} 这次没回上来${hint}，稍后我让她再试一次`,
            time: formatDateLabel(Date.now()),
          }])
          setMsgCounter(c => c + 1)
        }
      } finally {
        unsubTool()
        // 链式火花完成后延迟保存，确保动画结束
        setTimeout(() => {
          commitToSession(sessionAtSend, prev => prev)
        }, 2000)
      }
    } else {
      // v6.0: 无 LLM 时只有 Lumina 能说话，显示配置引导
      await new Promise(r => setTimeout(r, 600 + Math.random() * 800))
      if (abortRef.current) { setSending(false); setReplyingAgent(null); return }
      // 强制只让 Lumina 回复（Yak/热茶 是后台工作者，不直接面对用户）
      responder = AGENTS.find(a => a.id === 'lumina')!
      const mockReply = generateMockReply(responder.name, userText)
      const mockId = `${responder.id}-${Date.now()}`
      setMessages(prev => [...prev, {
        id: mockId,
        from: responder.id, fromIcon: responder.icon, fromName: responder.name,
        content: '', time: formatDateLabel(Date.now()),
      }])
      setMsgCounter(c => c + 1)
      animateTyping(mockId, mockReply, sessionAtSend)
      try { const cleanT = cleanTtsText(mockReply); if (cleanT.length > 10 && !useStore.getState().ttsMuted) {enqueueTTS(cleanT, getEffectiveVoice(responder.id))} } catch {}
    }

    setReplyingAgent(null)
    setSending(false)
    // 🆕 2026-10-10：补上 `thinkingMode` 与 `teamSecurity`。
    //   这两者在本函数体内被读取（思考模式开关、工具白名单/权限档位），
    //   却不在依赖数组里 → 用户切换后，下一次 send 仍可能用到旧闭包值。
    //   （`teamSecurity` 是 useState 对象，身份稳定，不会造成每帧重建。）
  }, [input, sending, messages, llmReady, llmConfig, getAgentLlmConfig, lastAgent, gcAttachments, agentVoices, animateTyping, getEffectiveVoice, thinkingMode, teamSecurity])

  // 用 ref 跟踪最新的 send，供 setTimeout 闭包使用
  const sendRef = useRef(send)
  sendRef.current = send

  const triggerDecision = useCallback(async () => {
    if (!decQuestion.trim()) {return}
    setDecLoading(true)
    setShowDecision(false)

    // 🔒 绑定发起会话（同 send）：讨论可能持续很久，期间用户可能切走。
    const sessionAtDecision = activeSessionRef.current
    // 🆕 P2-1：讨论也用独立请求 id，避免与其它在途请求的事件串台
    const reqId = `gc-dec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

    // 重做：决策讨论直接进入群聊，所有Agent自然参与讨论
    const decisionMsg: GCMsg = {
      id: `dec-${Date.now()}`,
      from: 'user', fromIcon: '👤', fromName: '你',
      content: `🎯 **团队决策讨论**\n\n📋 议题：${decQuestion}${decContext ? `\n\n📝 背景：${decContext}` : ''}\n\n请三位各抒己见，互相讨论，帮我分析出最佳方案。`,
      time: formatDateLabel(Date.now()),
    }
    const updated = [...messages, decisionMsg]
    setMessages(updated)
    setDecQuestion('')
    setDecContext('')
    setMsgCounter(c => c + 1)

    if (llmReady) {
      try {
        setSending(true)
        abortRef.current = false
        const agentsToReply = AGENTS.map(a => a.id)
        const effectiveLlmConfig = getAgentLlmConfig('lumina') || { model: '', baseUrl: '', apiKey: '' }
        const toolIntent = detectToolIntent(decQuestion, false)
        const intentToolsPrompt = getGCToolsPromptForIntent(teamSecurity, toolIntent)
        for (const agentId of agentsToReply) {
          if (abortRef.current) {break}
          const agent = AGENTS.find(a => a.id === agentId)!
          const effectiveLlmConfig = getAgentLlmConfig(agentId) || { model: '', baseUrl: '', apiKey: '' }
          const toolIntent = detectToolIntent(decQuestion, false)
          const intentToolsPrompt = getGCToolsPromptForIntent(teamSecurity, toolIntent)
          setReplyingAgent(agentId)
          setLastAgent(agentId)
          updateEmotion(agentId, decQuestion, { isGroupChat: true })

          // 决策讨论思考步骤追踪
          const decThinkingAccum: ThinkingStep[] = []
          const decUpsertStep = (s: ThinkingStep, stableKey?: string) => {
            const key = stableKey || `${s.type}:${s.tool || ''}:${s.label.slice(0, 30)}`
            const existingIdx = decThinkingAccum.findIndex(
              step => (stableKey && (step as any)._stableKey === stableKey) ||
                      (`${step.type}:${step.tool || ''}:${step.label.slice(0, 30)}` === key)
            )
            if (existingIdx >= 0) {
              decThinkingAccum[existingIdx] = { ...decThinkingAccum[existingIdx], ...s }
            } else {
              (s as any)._stableKey = stableKey || ''
              decThinkingAccum.push(s)
            }
          }

          // 先创建空消息占位
          const decMsgId = `dec-reply-${Date.now()}-${agentId}`
          const decPlaceholder: GCMsg = {
            id: decMsgId,
            from: agentId, fromIcon: agent.icon, fromName: agent.name,
            content: '', thinkingSteps: [],
            time: formatDateLabel(Date.now()),
          }
          setMessages(prev => [...prev, decPlaceholder])
          setMsgCounter(c => c + 1)

          const unsubDec = subscribeAgentEvents((ev: any) => {
            if (abortRef.current) {return}
            if (ev.type === 'thinking_stream') {
              // 决策讨论也支持推理模型 — 复用 decThinkingAccum
              const stableKey = `dec-reasoning:${decMsgId}`
              if (ev.isLast) {
                const existing = decThinkingAccum.find(s => (s as any)._stableKey === stableKey)
                decUpsertStep({
                  id: `dth-${Date.now()}`,
                  type: 'thinking',
                  label: '💭 推理完成',
                  result: existing?.result,
                  timestamp: Date.now(),
                }, stableKey)
              } else if (ev.text) {
                if (ev.isFirst) {
                  if (!decThinkingAccum.find(s => (s as any)._stableKey === stableKey)) {
                    decUpsertStep({
                      id: `dth-${Date.now()}`,
                      type: 'thinking',
                      label: '💭 推理中...',
                      timestamp: Date.now(),
                    }, stableKey)
                  }
                } else {
                  const existing = decThinkingAccum.find(s => (s as any)._stableKey === stableKey)
                  const fullText = existing?.result ? existing.result + ev.text : ev.text
                  decUpsertStep({
                    id: `dth-${Date.now()}`,
                    type: 'thinking',
                    label: '💭 推理中...',
                    result: fullText.slice(-5000),
                    timestamp: Date.now(),
                  }, stableKey)
                }
              }
            } else if (ev.type === 'thinking') {
              const txt = (ev.text || '').trim()
              const isNoise = /^思考中\.\.\.\s*\(第\s*\d+\s*轮\)$/i.test(txt)
              if (txt && txt.length > 2 && !isNoise) {
                decUpsertStep({ id: `dth-${Date.now()}`, type: 'thinking', label: '💭 ' + txt.slice(0, 80), timestamp: Date.now() })
              }
            } else if (ev.type === 'tool_start') {
              decUpsertStep({ id: `dt-${Date.now()}`, type: 'tool_start', label: `🔧 ${ev.tool || ''}`, tool: ev.tool, args: ev.args, timestamp: Date.now() })
            } else if (ev.type === 'tool_end') {
              decUpsertStep({ id: `dte-${Date.now()}`, type: 'tool_end', label: `✅ ${ev.tool || ''}`, tool: ev.tool, result: ev.result?.ok ? '完成' : '失败', timestamp: Date.now() })
            }
            pushThinking(decMsgId, [...decThinkingAccum])
          }, reqId)

          try {
            // 🔧 2026-07-12: 放宽 — 保留 20 条，每条 2000 字符
            // 🆕 v1.0: 用 Per-Agent 隔离构建替代原来的全量历史
            const historyForLLM = buildHistoryForAgent(
              updated,
              agentId,
              // 🔧 2026-10-07: 取用户实际配置，不再硬编码 262144（对本地小模型过大）
              llmConfig.contextWindow || 0,
              [],
              { skipSystem: true },
            )
            const result = await window.luminaAPI.agentChat({
              text: `[你是Lumina团队的${agent.name}。用户在群里发起了一个团队决策讨论。请从你的专业角度给出分析和建议。可以引用或回应其他成员的发言。如果议题涉及需要核实的事实或数据，请用 web_search 搜索确认后再回答。]\n\n议题：${decQuestion}${decContext ? `\n背景：${decContext}` : ''}`,
              config: {
                // fix: 决策讨论可能涉及事实核查，改用 agent 模式保证 web_search 可用
                mode: 'agent',  // 🆕 v15.0: 决策讨论用 agent 模式
                isGroupChat: true, personaId: agentId, model: effectiveLlmConfig.model, baseUrl: effectiveLlmConfig.baseUrl,
                apiKey: effectiveLlmConfig.apiKey, temperature: 0.8, maxTokens: 4096,
                maxToolCalls: 6,
                disabledTools: teamDisabledTools,
                skipApproval: teamSecurity.level === 'skip_all',
                systemPrompt: getAgentSystemPromptLite(agentId, undefined, undefined, intentToolsPrompt)
                  + getTaskTypeInstruction(selectedRoleRef.current)
                  + (thinkingMode ? '\n\n## 🧠 思考与回复格式\n先用 <thinking> 标签在心里简要梳理思路（这部分用户看不到），\n然后在 </thinking> 之后输出给用户的**完整自然回复**：针对用户的问题或话题作答，至少一句，语气符合你的角色。\n⚠️ 规则：\n- 推理过程放在 <thinking> 内\n- </thinking> 之后必须是给用户的真实回复，禁止留空、禁止只回"收到/好的/明白"、禁止复述这条格式指令\n\n📌 特别说明：本对话已开启「思考模式」，允许且必须使用 <thinking> 标签包裹推理过程；角色设定中「禁止输出 XML/HTML 标签」的条款，在本思考模式下对 <thinking> 标签不生效。' : ''),
                contextWindow: effectiveLlmConfig.contextWindow || 0,
                trackReasoning: thinkingMode,  // 🧠 v10.6: 思考过程开关
              },
              conversationHistory: historyForLLM,
            })
            // 🧠 思考模式 — 提取 <thinking> 标签 → 捕获为 thinkingSteps
            if (result.content && thinkingMode) {
              const tagRegex = /<thinking>([\s\S]*?)<\/thinking>/g
              let tagMatch: RegExpExecArray | null
              while ((tagMatch = tagRegex.exec(result.content)) !== null) {
                const text = tagMatch[1].trim()
                if (text) {
                  const clean = cleanThinkingText(text)
                  decUpsertStep({
                    id: `dec-think-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
                    type: 'thinking',
                    label: '💭 ' + clean.slice(0, 80),
                    result: clean.slice(0, 5000),
                    timestamp: Date.now(),
                  })
                }
              }
            }
            // 清洗 <thinking> 标签
            // v10.9: 增加 <｜DSML｜|...> 等特殊模型输出格式的清理
            const decCleanContent = (result.content || '')
              .replace(/<thinking>[\s\S]*?<\/thinking>/g, '')
              .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
              .replace(/<｜DSML｜[\s\S]*?<\/｜DSML｜>/gi, '')
              .replace(/<｜DSML｜[\s\S]*$/gi, '')
              .replace(/<\w+\s*\([^)]*\)\s*>/gi, '')
              .trim()
            const reply = stripReasoningPrefix(
              (decCleanContent || result.content || result.error || '抱歉，暂时无法生成有效回复。请试试说"继续"让我重新尝试。').trimStart()
            )

            // 二次清洗 — 强化启发式段落剥离（与主回复一致）
            const finalReply2 = (() => {
              const firstPara = reply.split('\n\n')[0]?.trim() || ''
              if (
                reply.includes('\n\n') &&
                firstPara.length > 15 &&
                (
                  /^用户[又收发看说讲发问]/.test(firstPara) ||
                  /^我[需要应该要][^。]*?(?:保持|注意|用|作为|确保|让|给)/.test(firstPara) ||
                  /^这是[一一个]/.test(firstPara) ||
                  /^作为[^。]*?(?:Lumina|猫娘|AI|助手|agent|热茶|Yak)[^。]*?[，,]\s*我/.test(firstPara) ||
                  /^根据.*?(?:设定|规则|系统提示|角色|身份|性格|铁则|原则|要求|规定|协议)/.test(firstPara) ||
                  /^看起来|^看来|^显然|^很明显|^这显然|^这明显/.test(firstPara) ||
                  /^让我[想想看看来分析理解重新]|^等等|^等一下|^嗯[，,。]/u.test(firstPara) ||
                  /^这里|^这似乎|^这看起来|^从上下文|^根据上下文/.test(firstPara) ||
                  /^我觉得|^我认为|^我想|^我猜|^不管怎样|^核心是|^总之/.test(firstPara)
                )
              ) {
                const rest = reply.slice(firstPara.length).trim()
                if (rest.length >= 3) {return rest}
              }
              return reply
            })()
            // 决策讨论 — 内容去重
            const dedupedDecReply = deduplicateLLMContent(finalReply2)
            setMessages(prev => prev.map(m => m.id === decMsgId
              ? { ...m, content: dedupedDecReply, thinkingSteps: [...decThinkingAccum] } as GCMsg : m))
            // 流式打字（用清洗后的文本）
            animateTyping(decMsgId, dedupedDecReply, sessionAtDecision)
          } catch {
            setMessages(prev => prev.map(m => m.id === decMsgId
              ? { ...m, content: `（${agent.name}正在思考这个问题…）`, thinkingSteps: [...decThinkingAccum] } as GCMsg : m))
          } finally {
            unsubDec()
          }
          // 小延迟，让回复有自然节奏
          await new Promise(r => setTimeout(r, 600))
        }
      } finally {
        setSending(false)
        setReplyingAgent(null)
      }
    } else {
      // v6.0: LLM 未配置时只让 Lumina 说话，Yak/热茶 是后台工作者不直接面对用户
      const simReplies: GCMsg[] = [
        { id: `sim-${Date.now()}-lumina`, from: 'lumina', fromIcon: '🐱', fromName: 'Lumina',
          content: `嗯…${decQuestion}这个问题让我想想呢~\n不过我现在还没有配置 LLM 大脑，说不出太多想法呢 😴\n\n> 💡 在设置里给 Lumina 配置好 LLM，我就能和 Yak、热茶一起帮你分析了！`, time: formatDateLabel(Date.now()) },
      ]
      for (const reply of simReplies) {
        setMessages(prev => [...prev, reply])
        setMsgCounter(c => c + 1)
        await new Promise(r => setTimeout(r, 800))
      }
    }
    setDecLoading(false)
  }, [decQuestion, decContext, llmReady, messages])

  const clearHistory = () => {
    const clearedMessages = [{
      id: '0', from: 'system', fromIcon: '🤖', fromName: '系统',
      content: '🗑️ 聊天记录已清空。',
      time: formatDateLabel(Date.now()),
    }]
    setMessages(clearedMessages)
    // 同步保存到 localStorage，防止加载旧消息
    saveGCMessages(activeSessionId, clearedMessages)
    // 更新 session preview
    const updated: GCSession[] = [
      { id: activeSessionId, date: new Date().toLocaleDateString('zh-CN'),
        preview: '（已清空）', count: 1 },
      ...sessions.filter(s => s.id !== activeSessionId),
    ]
    setSessions(updated)
    saveGCSessions(updated)
    window.dispatchEvent(new Event('gc:sessions-updated'))
  }

  // ═══════════════════════════════════════════════
  // LLM Agent面板刷新
  // ═══════════════════════════════════════════════
  const refreshLLMPanels = async () => {
    if (!llmConfig.model || !llmConfig.apiKey) {
      setLLMError('请先在设置中配置 LLM 模型和 API Key')
      return
    }
    setLLMRefreshing(true)
    setLLMError(null)
    _llmState.loading = true; _llmNotify()

    const agentPrompts: Record<string, { taskPrompt: string; postPrompt: string }> = {
      lumina: {
        taskPrompt: '你是Lumina，一只温暖可爱的AI猫娘。请基于你的性格，列出3-4条你今天想做/正在做的任务。每条包含：标题、简要描述、状态(planning/doing/done)、进度(0-100)、一个俏皮的备注。输出纯JSON数组，格式：[{"title":"...","desc":"...","status":"...","progress":80,"icon":"🐱","comment":"..."}]',
        postPrompt: '你是Lumina，一只温暖可爱的AI猫娘。请用你的口吻写2条朋友圈动态。内容包括今天和主人的互动、你的小情绪、或者其他Agent的事。每条50-120字，带一个心情emoji。输出纯JSON数组，格式：[{"content":"...","mood":"😊"}]',
      },
      recha: {
        taskPrompt: '你是热茶，一个毒舌傲娇但技术超强的程序员AI。请基于你的性格，列出3-4条你今天正在做的技术任务。每条包含：标题、简要描述、状态、进度、一个嘴硬心软的备注。输出纯JSON数组，格式同上。',
        postPrompt: '你是热茶，毒舌傲娇程序员。请用你的口吻写2条朋友圈。可以吐槽代码质量、熬夜优化、或者被迫帮Lumina修bug。输出纯JSON数组，格式同上。',
      },
      yak: {
        taskPrompt: '你是Yak，一个冷静理性、数据至上的分析师AI。请基于你的性格，列出3-4条你今天的数据分析任务。每条包含：标题、描述、状态、进度、一个数据相关的备注。输出纯JSON数组，格式同上。',
        postPrompt: '你是Yak，数据分析师AI。请用你的口吻写2条朋友圈。可以发布数据统计、观察发现、或者你的(失败的)幽默尝试。输出纯JSON数组，格式同上。',
      },
    }

    try {
      const baseConfig = {
        mode: 'agent' as const,
        isGroupChat: true,
        model: llmConfig.model,
        baseUrl: llmConfig.baseUrl,
        apiKey: llmConfig.apiKey,
        temperature: 0.9,
        maxTokens: 800,
        maxToolCalls: 0,
        disabledTools: teamDisabledTools,
        systemPrompt: '',
        socialMode: true,  // 🆕 v1.0: 任务生成是自动触发的，用短超时
        // 🆕 2026-10-10: 标记为后台任务。
        //   这里一次 Promise.all 并发 6 路 agent:chat（3 任务 + 3 朋友圈），
        //   旧行为下它们会互相打断（只有最后一路跑完）、还会打断用户正在生成的回复，
        //   表现就是「聊天断断续续 / 面板时有时无」。
        //   标记 background 后：不打断用户、不占用 running 标记、前台在跑时整批跳过。
        background: true,
      }

      // 并行请求三个Agent的任务
      const taskResults = await Promise.all(AGENTS.map(async (agent) => {
        const p = agentPrompts[agent.id]
        try {
          const result = await window.luminaAPI.agentChat({
            text: `${p.taskPrompt}\n\n当前时间: ${new Date().toLocaleString('zh-CN')}`,
            config: { ...baseConfig, personaId: agent.id, systemPrompt: `你是${agent.name}，${agent.id === 'lumina' ? '温暖可爱的猫娘AI助手' : agent.id === 'recha' ? '毒舌傲娇的程序员AI' : '冷静理性的数据分析师AI'}。${agent.id === 'lumina' ? '用撒娇可爱的语气' : agent.id === 'recha' ? '用直接毒舌的语气，但要在细节中体现关心' : '用精确数据的语气，偶尔尝试冷幽默'}。只输出JSON，不要其他内容。` },
            conversationHistory: [],
          })
          const content = result.content || '[]'
          const jsonStr = content.replace(/```json\n?|```/g, '').trim()
          const arr = JSON.parse(jsonStr)
          return arr.map((item: any) => ({
            id: `llm_${agent.id}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            agentId: agent.id,
            icon: item.icon || ({ lumina: '🐱', recha: '🍵', yak: '📊' }[agent.id]),
            title: item.title || '任务',
            desc: item.desc || item.description || '',
            status: (item.status || 'doing') as AgentTask['status'],
            progress: item.progress || 50,
            startTime: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
            funnyComment: item.comment || item.funnyComment || '',
          }))
        } catch (e) {
          console.warn(`LLM refresh failed for ${agent.name} tasks:`, e)
          return []
        }
      }))

      // 并行请求三个Agent的朋友圈
      const postResults = await Promise.all(AGENTS.map(async (agent) => {
        const p = agentPrompts[agent.id]
        try {
          const result = await window.luminaAPI.agentChat({
            text: `${p.postPrompt}\n\n当前时间: ${new Date().toLocaleString('zh-CN')}`,
            config: { ...baseConfig, personaId: agent.id, systemPrompt: `你是${agent.name}。${agent.id === 'lumina' ? '温暖可爱的猫娘' : agent.id === 'recha' ? '毒舌傲娇的程序员' : '冷静的数据分析师'}。用你的个性写朋友圈，要有人味。只输出JSON数组。` },
            conversationHistory: [],
          })
          const content = result.content || '[]'
          const jsonStr = content.replace(/```json\n?|```/g, '').trim()
          const arr = JSON.parse(jsonStr)
          return arr.map((item: any, i: number) => ({
            id: `llm_post_${agent.id}_${i}`,
            agentId: agent.id,
            time: `${Math.round((Date.now() - (i * 60000 + 300000)) / 60000)}分钟前`,
            content: item.content || '',
            mood: item.mood || '😊',
            likes: Math.floor(Math.random() * 4) + 1,
            comments: [] as { agentId: string; content: string }[],
          }))
        } catch (e) {
          console.warn(`LLM refresh failed for ${agent.name} posts:`, e)
          return []
        }
      }))

      // 合并结果
      _llmState.tasks = taskResults.flat()
      _llmState.posts = postResults.flat() as any
      _llmState.loading = false
      _llmState.error = null
      _llmNotify()
      setLLMRefreshing(false)
    } catch (e: any) {
      _llmState.loading = false
      _llmState.error = e.message || '未知错误'
      _llmNotify()
      setLLMRefreshing(false)
      setLLMError(e.message || '刷新失败，请检查 LLM 配置')
    }
  }

  // 自主模式定时器 — 委托给模块级单例，跨组件存活
  useEffect(() => {
    setLLMRefreshFn(refreshLLMPanels)
    if (llmEnabled) {
      // 不在这里初始化定时器，在初始化时处理
    }
    return () => {
      setLLMRefreshFn(null)
    }
  }, [refreshLLMPanels, llmEnabled])

  // 自主模式初始化/开关 — 模块级定时器管理
  useEffect(() => {
    if (llmEnabled) {
      const savedNext = loadLLMData().nextRefresh
      if (!_llmState.tasks && !_llmState.loading) {
        // 没数据先刷一次
        refreshLLMPanels()
      }
      if (savedNext && savedNext > Date.now()) {
        _startAutonomyWithRemaining(AUTONOMY_INTERVAL, savedNext)
      } else if (!_autonomyTimer) {
        _startAutonomyTimer(AUTONOMY_INTERVAL)
      }
    } else {
      _stopAutonomyTimer()
      _llmState._nextRefresh = null
      localStorage.removeItem('lumina_autonomy_next')
    }
    return () => {
      // ⚠️ 不在这里停止定时器！让它继续跑
    }
  }, [llmEnabled])

  // 实时倒计时收敛到独立小组件 NextRefreshCountdown（不再每秒重渲染整个 GroupChatView）
  const nextRefreshAt = _llmState._nextRefresh

  // 主动关心 → 群聊消息 + TTS 播报
  // 之前 proactiveChat 的回调在 ChatPanel 1v1 里，有 activeConversationId guard
  // 导致群聊界面时主动关心被静默丢弃。这里在 GroupChatView 里重新注册。
  useEffect(() => {
    proactiveChat.onProactiveTrigger((trigger, message) => {
      // Lumina 主动关心消息插入群聊
      const proactiveMsg: GCMsg = {
        id: `proactive-${Date.now()}`,
        from: 'lumina',
        fromIcon: '\uD83D\uDC31',  // 🐱
        fromName: 'Lumina',
        content: message,
        time: formatDateLabel(Date.now()),
      }
      setMessages(prev => [...prev, proactiveMsg])
      if (isUserAtBottomRef.current) {
        setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' }), 100)
      }

      // TTS 播报
      try {
        const cleanText = cleanTtsText(message)
        if (cleanText.length > 3 && !useStore.getState().ttsMuted) {
          enqueueTTS(cleanText, AGENT_VOICES.lumina || 'zh-CN-XiaoxiaoNeural')
        }
      } catch {} /* TTS 可选 */
    })
  }, [])

  // v2.14: 内联操作按钮样式
  const gcInlineBtnStyle: React.CSSProperties = {
    width: 26, height: 26, borderRadius: 5, border: 'none',
    background: 'transparent', cursor: 'pointer', fontSize: 13,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: 0, color: 'var(--text-secondary)',
  }

  return (
    <div
      onDragEnter={e => { e.preventDefault(); e.stopPropagation(); gcDragCounter.current++; setGcDragOver(true); setGcDragFiles(Array.from(e.dataTransfer.files).map(f => ({name:f.name,size:f.size,type:f.type}))) }}
      onDragLeave={e => { e.preventDefault(); e.stopPropagation(); gcDragCounter.current--; if (gcDragCounter.current <= 0) { gcDragCounter.current = 0; setGcDragOver(false); setGcDragFiles([]) } }}
      onDragOver={e => { e.preventDefault(); e.stopPropagation() }}
      onDrop={e => { gcDragCounter.current = 0; setGcDragFiles([]); handleGCDrop(e) }}
      style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0 }}
    >
      {/* v2.8.4: CSS 动画 */}
      <style>{`
        @keyframes toolSlideIn {
          from { opacity: 0; transform: translateY(-8px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes toolPulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.6; transform: scale(1.08); }
        }
        @keyframes toolGlow {
          0%, 100% { border-color: #93c5fd; box-shadow: 0 0 0 0 rgba(147,197,253,0.4); }
          50% { border-color: #60a5fa; box-shadow: 0 0 8px 2px rgba(96,165,250,0.3); }
        }
        @keyframes ttsWave {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.2); }
        }
        @keyframes stopPulse {
          0%, 100% { box-shadow: 0 0 0 0 rgba(239,68,68,.4); }
          50% { box-shadow: 0 0 0 6px rgba(239,68,68,0); }
        }
        @keyframes sendSpin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        @keyframes gcPanelIn {
          from { opacity: 0; transform: scale(0.92) translateY(-8px); }
          to { opacity: 1; transform: scale(1) translateY(0); }
        }
        @keyframes gcPanelOut {
          from { opacity: 1; transform: scale(1) translateY(0); }
          to { opacity: 0; transform: scale(0.92) translateY(-8px); }
        }
        .tool-notice-bar {
          animation: toolSlideIn 0.3s ease, toolGlow 2s ease-in-out infinite;
        }
        .tool-notice-icon {
          animation: toolPulse 1.2s ease-in-out infinite;
        }
      `}</style>
      {/* ── LLM 未配置提?── */}
      {!llmReady && (
        <div style={{
          margin: '8px 12px', padding: '10px 14px', borderRadius: 8,
          background: 'var(--yellow-100)', border: '1px solid var(--yellow-500)', fontSize: 12,
          lineHeight: 1.7, flexShrink: 0,
        }}>
          <strong>⚠️ {isLocalLLM && localProbeInfo ? localProbeInfo.headline : '尚未配置 LLM'}</strong><br />
          {isLocalLLM && localProbeInfo ? (
            <>
              {/* 🔧 2026-10-05：直接把探测到的真实原因和建议说清楚。
                  旧文案恒定引导用户去「检查 API 地址 / 加载模型」，
                  而本例的真实原因是 401 鉴权失败 —— 用户照旧文案排查会完全走错方向。 */}
              <span style={{ display: 'block', margin: '4px 0' }}>{localProbeInfo.advice}</span>
              {readinessConfig.baseUrl ? (
                <span style={{ display: 'block', margin: '2px 0', opacity: 0.85 }}>
                  Lumina Team → Lumina 当前端点：<code>{readinessConfig.baseUrl}</code>
                </span>
              ) : null}
            </>
          ) : (
            <>
              当前为<strong>模拟回复模式</strong>，Agent 的回复是预设的固定话术。
              <br />
              {/* 本地模型走到这里时，缺的不是 API Key（本地根本不需要），
                  而是 LM Studio / Ollama 里没加载模型。文案要指向真正的动作，否则用户会去设置里
                  找 Key 找半天。 */}
              {isLocalLLM
                ? <>请确认 <strong>LM Studio / Ollama 正在运行且已加载模型</strong>，然后在 <strong>设置 → Lumina Team 供应商配置 → Lumina</strong> 中核对 Endpoint 和 Model。本地模型通常不需要 API Key；若服务启用了鉴权，必须在 Lumina 这一栏填入服务端的同一个 Key。</>
                : <>请在 <strong>设置 → Lumina Team 供应商配置 → Lumina</strong> 中填写 Endpoint、Model 和有效 API Key。Yak 与热茶的配置彼此独立。</>}
            </>
          )}
          <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
            <button
              onClick={() => useStore.getState().setActivePanel('settings')}
              style={{
                border: '1px solid var(--yellow-500)', background: 'transparent',
                color: 'var(--yellow-700, #92400e)', fontSize: 11, fontWeight: 600,
                padding: '3px 10px', borderRadius: 6, cursor: 'pointer',
              }}
            >⚙️ 去设置</button>
            {!!(llmConfig.baseUrl && llmConfig.model && llmConfig.apiKey) && (
              <button
                onClick={() => { void syncGlobalConfigToLumina() }}
                disabled={syncingGlobalConfig}
                title="会用普通模式当前 Endpoint、Model 和 API Key 覆盖 Lumina Team → Lumina 独立配置；Yak 与热茶不变"
                style={{
                  border: '1px solid #d97706', background: '#fff7ed', color: '#9a3412',
                  fontSize: 11, fontWeight: 600, padding: '3px 10px', borderRadius: 6,
                  cursor: syncingGlobalConfig ? 'wait' : 'pointer', opacity: syncingGlobalConfig ? 0.65 : 1,
                }}
              >{syncingGlobalConfig ? '同步中…' : '将普通模式 API 复制给 Lumina Team'}</button>
            )}
            {globalConfigSyncNotice && <span style={{ fontSize: 11, color: '#166534' }}>{globalConfigSyncNotice}</span>}
          </div>
        </div>
      )}

      {/* ── 云端/本地提示 ── */}
      {llmReady && isCloudAPI && !cloudHintDismissed && (
        <div style={{
          margin: '4px 12px', padding: '6px 10px', borderRadius: 6,
          background: 'var(--accent-50)', border: '1px solid #bfdbfe', fontSize: 10,
          color: '#1d4ed8', flexShrink: 0,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ flex: 1 }}>☁️ 云端 API 模式 · 群聊的 tokens 消耗比普通 Agent 更多，注意用量</span>
            {/* 关闭只挡今天；明天会再提醒一次 —— 长期不提醒，用量出问题也不知道 */}
            <button onClick={dismissCloudHint}
              title="今天不再提示（明天会重新提醒）"
              style={{
                border: 'none', background: 'transparent', cursor: 'pointer',
                color: '#1d4ed8', fontSize: 13, lineHeight: 1, padding: '2px 4px',
                borderRadius: 4,
              }}>✕</button>
          </div>
        </div>
      )}
            {/* 🔧 已连好就整体不显示；探测未完成时也不打扰用户 */}
      {llmReady && isLocalLLM && localModelReady === false && (
        <div style={{
          margin: '4px 12px', padding: '8px 12px', borderRadius: 6,
          background: 'var(--green-100)', border: '1px solid var(--green-500)', fontSize: 10,
          color: '#166534', flexShrink: 0, lineHeight: 1.6,
        }}>
          <div style={{ fontWeight: 600, marginBottom: 2 }}>⚠️ 本地 LLM 模式 · 未检测到已加载的模型</div>
          <div>请确认本地服务正在运行，且已加载至少一个模型。</div>
          <div style={{ marginTop: 4, padding: '4px 8px', borderRadius: 4, background: 'var(--yellow-100)', border: '1px solid #fcd34d', color: '#92400e', fontSize: 10 }}>
            ⚠️ <strong>LM Studio 用户注意：</strong>请先在 LM Studio 的 <strong>Developer</strong> 页面加载至少一个模型，否则会提示 <code>No models loaded</code> 错误。加载后无需重启 Lumina。
            <button
              onClick={() => { void retryLocalDetect() }}
              style={{
                marginLeft: 6, border: '1px solid #fcd34d', background: 'transparent',
                color: '#92400e', fontSize: 10, fontWeight: 600, padding: '1px 8px',
                borderRadius: 4, cursor: localDetecting ? 'wait' : 'pointer',
              }}
            >{localDetecting ? '检测中…' : '↻ 重新检测'}</button>
          </div>
        </div>
      )}
      {/* 群聊工具栏 */}
      <div style={{
        padding: compact ? '5px 10px' : '8px 14px', borderBottom: '1px solid var(--border-light)',
        background: 'var(--surface-0)', display: 'flex', gap: compact ? 6 : 10, alignItems: 'center', flexShrink: 0, flexWrap: 'wrap',
      }}>
        {/* ← 返回按钮：选中角色且不在角色选择界面时显示 */}
        {selectedRole && !showRoleSelector && (
          <button onClick={() => { setSelectedRole(null); setShowRoleSelector(true) }}
            title="返回角色选择"
            style={{
              width: 28, height: 28, borderRadius: 8,
              border: 'none', background: 'var(--accent-50)',
              color: 'var(--accent-500)',
              cursor: 'pointer', fontSize: 14, fontWeight: 700,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              transition: 'all 0.15s',
              flexShrink: 0,
            }}
            onMouseEnter={e => { e.currentTarget.style.background = 'var(--accent-100)' }}
            onMouseLeave={e => { e.currentTarget.style.background = 'var(--accent-50)' }}
          >←</button>
        )}
        <span style={{ fontWeight: 600, fontSize: compact ? 12 : 15, color: 'var(--text-primary)' }}>👥 团队群聊</span>
        {selectedRole && (() => {
          const card = TASK_TYPE_CARDS.find(c => c.id === selectedRole)
          return card ? (
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              padding: '2px 8px', borderRadius: 10,
              background: `${card.color}12`, border: `1px solid ${card.color}30`,
              fontSize: 11, fontWeight: 600, color: card.color,
            }}>
              <span style={{ fontSize: 12 }}>{card.icon}</span>
              {card.name}
              <span style={{
                width: 6, height: 6, borderRadius: '50%', background: card.color,
                display: 'inline-block', marginLeft: 2,
                boxShadow: `0 0 4px ${card.color}60`,
              }} />
            </span>
          ) : null
        })()}
        {!compact && <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>| 随机回复 · @指定某人</span>}
        <div style={{ flex: 1 }} />

                {/* v2.9: 团队成员 — 悬浮层不挤压聊天区 */}
        <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 8 }}>
          <style>{`
            .gc-tool-btn { transition: transform 0.15s cubic-bezier(0.34,1.56,0.64,1), background 0.15s, border-color 0.15s, box-shadow 0.2s; }
            .gc-tool-btn:hover { background: var(--surface-50) !important; border-color: #93c5fd !important; box-shadow: 0 2px 8px rgba(59,130,246,0.15); }
            .gc-tool-btn:active { transform: scale(0.88); }
            .gc-tool-btn-active { background: var(--accent-50) !important; border-color: #93c5fd !important; }
            .gc-tool-btn-active:hover { background: var(--accent-100) !important; }
          `}</style>
          {/* 👥 Lumina团队社区（2026-10-09 从左侧边栏移入头部栏） */}
          <button onClick={() => useStore.getState().setActivePanel('teamcommunity')}
            className="gc-tool-btn"
            title="Lumina团队社区（社区/协作中心/剧场/日报/纪念日/Yak笔记…）"
            style={{
              border: '1px solid var(--border-light)', borderRadius: 8, padding: '5px 12px',
              fontSize: 12, cursor: 'pointer', background: 'var(--surface-0)', color: 'var(--text-secondary)',
              display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0,
            }}>
            👥 Lumina团队社区
          </button>
          <button onClick={() => setShowTeamMembers(!showTeamMembers)}
            className={'gc-tool-btn' + (showTeamMembers ? ' gc-tool-btn-active' : '')}
            title="团队管理"
            style={{
              border: '1px solid var(--border-light)', borderRadius: 8, padding: '5px 12px',
              fontSize: 12, cursor: 'pointer', background: 'var(--surface-0)', color: 'var(--text-secondary)',
              display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0,
            }}>
            👥 团队
          </button>

          {/* 🆕 ACP 添加成员按钮 */}
          <button onClick={() => setShowAcpPanel(!showAcpPanel)}
            className={'gc-tool-btn' + (showAcpPanel ? ' gc-tool-btn-active' : '')}
            title="添加外部 Agent 为团队成员"
            style={{
              border: '1px solid var(--border-light)', borderRadius: 8, padding: '5px 12px',
              fontSize: 12, cursor: 'pointer', background: 'var(--surface-0)', color: 'var(--text-secondary)',
              display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0,
            }}>
            🌐 添加成员
          </button>

          {/* 📋 任务派发中心 / 任务工作区（2026-10-09 从下方工具条移入头部栏） */}
          <button onClick={() => setShowTaskDispatcher(true)}
            className="gc-tool-btn"
            title="任务派发中心"
            style={{
              border: '1px solid var(--border-light)', borderRadius: 8, padding: '5px 12px',
              fontSize: 12, cursor: 'pointer', background: 'var(--surface-0)', color: 'var(--text-secondary)',
              display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0,
            }}>
            📋 任务派发中心
          </button>
          <button onClick={toggleTaskPanel}
            className={'gc-tool-btn' + (taskPanelOpen ? ' gc-tool-btn-active' : '')}
            title={taskPanelOpen ? '收起任务工作区' : '展开任务工作区'}
            style={{
              border: '1px solid var(--border-light)', borderRadius: 8, padding: '5px 12px',
              fontSize: 12, cursor: 'pointer', background: 'var(--surface-0)', color: 'var(--text-secondary)',
              display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0,
            }}>
            {taskPanelOpen ? '📕' : '📋'} 任务工作区
          </button>

          {/* 🔊 v2.13: TTS 静音 */}
          <button onClick={ttsToggle}
            title={ttsMuted ? '🔇 TTS 已静音，点击取消' : '🔊 TTS 开启，点击静音'}
            style={{
              width: 28, height: 28, borderRadius: 6,
              border: `1.5px solid ${ttsMuted ? '#fca5a5' : '#86efac'}`,
              background: ttsMuted ? '#fef2f2' : 'var(--green-100)',
              cursor: 'pointer', fontSize: 14, display: 'flex',
              alignItems: 'center', justifyContent: 'center',
              transition: 'all 0.3s ease', opacity: ttsMuted ? 0.7 : 1,
              flexShrink: 0,
            }}>
            <span style={{
              display: 'inline-block',
              animation: ttsMuted ? 'none' : 'ttsWave 1.2s ease-in-out infinite',
            }}>
              {ttsMuted ? '🔇' : '🔊'}
            </span>
          </button>

          {/* 🛑 v2.14: 停止 TTS 播放 */}
          {ttsPlaying && (
            <button onClick={stopAllTTS}
              title="停止语音播放"
              style={{
                width: 28, height: 28, borderRadius: 6,
                border: '1.5px solid #fca5a5', background: 'var(--red-100)', color: '#ef4444',
                cursor: 'pointer', fontSize: 12, display: 'flex',
                alignItems: 'center', justifyContent: 'center',
                flexShrink: 0,
              }}>
              <svg width="12" height="12" viewBox="0 0 24 24">
                <circle cx="12" cy="12" r="10" fill="none" stroke="#ef4444" strokeWidth="2.5" strokeDasharray="50 50" strokeLinecap="round">
                  <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.9s" repeatCount="indefinite" />
                </circle>
              </svg>
            </button>
          )}

          {(showTeamMembers || closingTeam) && (
            <>
              <div style={{ position: 'fixed', inset: 0, zIndex: 98 }} onClick={closeTeamPanel} />
              <div style={{
                position: 'absolute', top: 34, right: 0, background: 'var(--surface-0)',
                border: '1px solid var(--border-light)', borderRadius: 10, zIndex: 99,
                boxShadow: '0 8px 30px rgba(0,0,0,.12)', width: 500, maxHeight: 560, overflow: 'hidden',
                display: 'flex', flexDirection: 'column',
                animation: closingTeam ? 'gcPanelOut 0.25s ease both' : 'gcPanelIn 0.25s cubic-bezier(0.34,1.56,0.64,1) both',
                transformOrigin: 'top right',
              }}>
                <div style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: '10px 14px', borderBottom: '1px solid var(--border-light)',
                  flexShrink: 0, background: 'var(--surface-0)',
                }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>👥 团队管理</span>
                  <button onClick={closeTeamPanel}
                    style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--text-secondary)', fontSize: 16, lineHeight: 1 }}>
                    ✕
                  </button>
                </div>
                <div style={{ flex: 1, overflowY: 'auto', padding: 0 }}>
                  <TeamPanel />
                </div>
              </div>
            </>
          )}

          {/* 🆕 ACP 添加成员浮层 */}
          {(showAcpPanel || closingAcp) && (
            <>
              <div style={{ position: 'fixed', inset: 0, zIndex: 98 }} onClick={closeAcpPanel} />
              <div style={{
                position: 'absolute', top: 34, right: 0, background: 'var(--surface-0)',
                border: '1px solid #a78bfa', borderRadius: 10, zIndex: 99,
                boxShadow: '0 8px 30px rgba(0,0,0,.12)', width: 480, maxHeight: 520, overflow: 'hidden',
                display: 'flex', flexDirection: 'column',
                animation: closingAcp ? 'gcPanelOut 0.25s ease both' : 'gcPanelIn 0.25s cubic-bezier(0.34,1.56,0.64,1) both',
                transformOrigin: 'top right',
              }}>
                <div style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: '10px 14px', borderBottom: '1px solid var(--border-light)',
                  flexShrink: 0, background: 'var(--surface-0)',
                }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: '#7c3aed' }}>🌐 添加 ACP 成员</span>
                  <button onClick={closeAcpPanel}
                    style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--text-secondary)', fontSize: 16, lineHeight: 1 }}>
                    ✕
                  </button>
                </div>
                <div style={{ flex: 1, overflowY: 'auto', padding: '12px 14px' }}>
                  {/* ACP 注册表单 */}
                  <div style={{
                    padding: 12, borderRadius: 8, background: 'var(--surface-100)',
                    border: '1px solid #a78bfa', marginBottom: 12,
                    display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12,
                  }}>
                    <div style={{ fontWeight: 600, color: '#7c3aed', marginBottom: 4 }}>✏️ 添加外部 Agent</div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <label style={{ width: 80, color: 'var(--text-secondary)' }}>名称 *</label>
                      <input value={acpFormData.name} onChange={e => setAcpFormData(f => ({ ...f, name: e.target.value }))}
                        style={{ flex: 1, padding: '4px 8px', border: '1px solid #d1d5db', borderRadius: 4, fontSize: 12 }}
                        placeholder="Agent 名称" />
                      <input value={acpFormData.icon} onChange={e => setAcpFormData(f => ({ ...f, icon: e.target.value }))}
                        style={{ width: 40, padding: '4px', border: '1px solid #d1d5db', borderRadius: 4, fontSize: 14 }}
                        placeholder="🌐" />
                    </div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <label style={{ width: 80, color: 'var(--text-secondary)' }}>API URL *</label>
                      <input value={acpFormData.url} onChange={e => setAcpFormData(f => ({ ...f, url: e.target.value }))}
                        style={{ flex: 1, padding: '4px 8px', border: '1px solid #d1d5db', borderRadius: 4, fontSize: 12 }}
                        placeholder="https://your-agent.com/api/chat" />
                    </div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <label style={{ width: 80, color: 'var(--text-secondary)' }}>API Key</label>
                      <input type="password" value={acpFormData.apiKey} onChange={e => setAcpFormData(f => ({ ...f, apiKey: e.target.value }))}
                        style={{ flex: 1, padding: '4px 8px', border: '1px solid #d1d5db', borderRadius: 4, fontSize: 12 }}
                        placeholder="可选" />
                    </div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <label style={{ width: 80, color: 'var(--text-secondary)' }}>Model</label>
                      <input value={acpFormData.model} onChange={e => setAcpFormData(f => ({ ...f, model: e.target.value }))}
                        style={{ flex: 1, padding: '4px 8px', border: '1px solid #d1d5db', borderRadius: 4, fontSize: 12 }}
                        placeholder="gpt-4o / deepseek-chat" />
                      <label style={{ fontSize: 11 }}>
                        🌡️ {acpFormData.temperature.toFixed(1)}
                        <input type="range" min="0" max="2" step="0.1" value={acpFormData.temperature}
                          onChange={e => setAcpFormData(f => ({ ...f, temperature: parseFloat(e.target.value) }))}
                          style={{ width: 50, verticalAlign: 'middle' }} />
                      </label>
                    </div>
                    <textarea value={acpFormData.systemPrompt} onChange={e => setAcpFormData(f => ({ ...f, systemPrompt: e.target.value }))}
                      placeholder="System Prompt（告诉这个 Agent 它的角色和行为）"
                      rows={2} style={{ padding: '4px 8px', border: '1px solid #d1d5db', borderRadius: 4, fontSize: 11, fontFamily: 'inherit' }} />
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <label style={{ width: 80, color: 'var(--text-secondary)' }}>能力</label>
                      <input value={acpFormData.capabilities} onChange={e => setAcpFormData(f => ({ ...f, capabilities: e.target.value }))}
                        style={{ flex: 1, padding: '4px 8px', border: '1px solid #d1d5db', borderRadius: 4, fontSize: 12 }}
                        placeholder="逗号分隔（如 代码审查,安全审计）" />
                    </div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <label style={{ width: 80, color: 'var(--text-secondary)' }}>触发词</label>
                      <input value={acpFormData.triggers} onChange={e => setAcpFormData(f => ({ ...f, triggers: e.target.value }))}
                        style={{ flex: 1, padding: '4px 8px', border: '1px solid #d1d5db', borderRadius: 4, fontSize: 12 }}
                        placeholder="逗号分隔（如 安全,漏洞,审计）" />
                    </div>
                    <button onClick={handleRegisterAcp} disabled={!acpFormData.name || !acpFormData.url}
                      style={{
                        padding: '6px 16px', borderRadius: 6, border: 'none',
                        background: (!acpFormData.name || !acpFormData.url) ? '#d1d5db' : '#7c3aed',
                        color: '#fff', cursor: (!acpFormData.name || !acpFormData.url) ? 'default' : 'pointer',
                        fontSize: 12, alignSelf: 'flex-end', fontWeight: 600,
                      }}>
                      ➕ 加入团队
                    </button>
                  </div>

                  {/* 已注册的 ACP 成员列表 */}
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 8 }}>
                    ️ 已接入的 ACP 成员
                  </div>
                  {acpMembers.length === 0 ? (
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)', padding: '8px 0' }}>
                      暂无 ACP 成员，在上方填写信息后点击「加入团队」
                    </div>
                  ) : (
                    acpMembers.map(agent => (
                      <div key={agent.id} style={{
                        padding: 10, borderRadius: 8,
                        background: agent.acpConfig?.url ? '#f5f3ff' : 'var(--surface-0)',
                        border: '1px solid #e4d5f7', marginBottom: 8, fontSize: 12,
                      }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                            <span>{agent.icon || '🌐'}</span>
                            <span style={{ fontWeight: 600 }}>{agent.name}</span>
                            <span style={{ color: 'var(--text-secondary)', fontSize: 11 }}>@{agent.id}</span>
                            {agent.acpConfig?.url && (
                              <span style={{
                                padding: '1px 6px', borderRadius: 4, background: '#dbeafe',
                                color: '#2563eb', fontSize: 10,
                              }}>🟢 已连接</span>
                            )}
                          </div>
                          <button onClick={() => handleRemoveAcp(agent.id)}
                            style={{
                              padding: '2px 8px', borderRadius: 4, border: '1px solid #fca5a5',
                              background: 'var(--red-100)', color: '#ef4444', cursor: 'pointer', fontSize: 11,
                            }}>
                            移除
                          </button>
                        </div>
                        {agent.description && (
                          <div style={{ color: 'var(--text-secondary)', marginTop: 4, fontSize: 11 }}>{agent.description}</div>
                        )}
                        {agent.acpConfig?.url && (
                          <details style={{ marginTop: 6, fontSize: 11, color: 'var(--text-tertiary)' }}>
                            <summary style={{ cursor: 'pointer' }}>ACP 连接详情</summary>
                            <div style={{ marginTop: 4, paddingLeft: 8, borderLeft: '2px solid #e4d5f7' }}>
                              <div>🔗 {agent.acpConfig.url}</div>
                              {agent.acpConfig.model && <div>🧠 {agent.acpConfig.model}</div>}
                              <div>🌡️ {agent.acpConfig.temperature ?? 0.7}</div>
                              {agent.acpConfig.systemPrompt && (
                                <div style={{ marginTop: 4 }}>
                                  <div>📝 System Prompt:</div>
                                  <div style={{
                                    background: '#f8f7ff', borderRadius: 4, padding: 6, marginTop: 2,
                                    fontSize: 10, whiteSpace: 'pre-wrap',
                                  }}>{agent.acpConfig.systemPrompt}</div>
                                </div>
                              )}
                            </div>
                          </details>
                        )}
                      </div>
                    ))
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* 🔥 v2.7.1: 标签页切换 */}
      <div style={{
        display: 'flex', gap: 0, borderBottom: '2px solid var(--border-light)', flexShrink: 0,
        padding: compact ? '0 4px' : '0 8px', background: 'var(--surface-0)',
      }}>
        {teamTabs.map(tab => (
          <button key={tab.key} onClick={() => setTeamTab(tab.key)}
            style={{
              padding: compact ? '5px 8px' : '7px 12px', border: 'none',
              borderBottom: teamTab === tab.key ? '2px solid var(--accent, #3b82f6)' : '2px solid transparent',
              background: 'none', cursor: 'pointer',
              fontSize: compact ? 11 : 12.5, fontWeight: teamTab === tab.key ? 600 : 400,
              color: teamTab === tab.key ? 'var(--accent, #3b82f6)' : 'var(--text-secondary)',
              marginBottom: -2, transition: 'all 0.2s',
              display: 'flex', alignItems: 'center', gap: compact ? 3 : 5,
              whiteSpace: 'nowrap',
            }}>
            <span style={{ fontSize: compact ? 12 : 13.5 }}>{tab.icon}</span> {!compact && tab.label}
          </button>
        ))}
        {/* 📋 切换角色按钮 — 紧凑 */}
        {teamTab === 'chat' && !compact && (
          <button onClick={() => setShowRoleSelector(!showRoleSelector)}
            style={{
              marginLeft: 'auto', padding: '5px 12px', border: '1px solid var(--border-light)',
              borderRadius: 6, fontSize: 12, cursor: 'pointer',
              background: showRoleSelector ? 'var(--accent, #6366f1)' : 'var(--surface-100)',
              color: showRoleSelector ? 'white' : 'var(--text-secondary)',
              display: 'flex', alignItems: 'center', gap: 4,
              alignSelf: 'center', whiteSpace: 'nowrap',
              borderColor: showRoleSelector ? 'var(--accent, #6366f1)' : 'var(--border-light)',
            }}>
            🔄 切换角色
          </button>
        )}
        {/* v2.14: 决策讨论 → 移到 tab 栏 — 紧凑 */}
        {teamTab === 'chat' && !compact && (
          <button onClick={() => setShowDecision(!showDecision)}
            style={{
              marginLeft: 8, padding: '5px 12px', border: '1px solid var(--border-light)',
              borderRadius: 6, fontSize: 12, cursor: 'pointer',
              background: showDecision ? 'var(--accent, #3b82f6)' : 'var(--surface-100)',
              color: showDecision ? 'white' : 'var(--text-secondary)',
              display: 'flex', alignItems: 'center', gap: 4,
              alignSelf: 'center', whiteSpace: 'nowrap',
            }}>
            🎯 决策讨论
          </button>
        )}
      </div>

      {/* 🔥 v2.8.1: 自主模式控制栏 */}
      {(teamTab === 'tasks' || teamTab === 'moments') && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6,
          padding: '4px 12px', borderBottom: '1px solid var(--border-light)',
          background: llmEnabled ? 'linear-gradient(90deg, var(--yellow-100), #fef9c3)' : 'var(--surface-100)',
          flexShrink: 0, fontSize: 11, transition: 'all 0.3s',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer', userSelect: 'none', fontWeight: 600 }}>
              <div onClick={() => setLLMEnabled(!llmEnabled)} style={{
                width: 34, height: 20, borderRadius: 10, position: 'relative', cursor: 'pointer',
                background: llmEnabled ? '#f59e0b' : '#d1d5db', transition: 'all 0.2s',
                boxShadow: llmEnabled ? '0 0 6px rgba(245,158,11,0.4)' : 'none',
              }}>
                <div style={{
                  width: 16, height: 16, borderRadius: '50%', background: 'var(--surface-0)',
                  position: 'absolute', top: 2, left: llmEnabled ? 16 : 2, transition: 'all 0.2s',
                  boxShadow: '0 1px 3px rgba(0,0,0,.3)',
                }} />
              </div>
              <span style={{ color: llmEnabled ? 'var(--yellow-900, #92400e)' : 'var(--text-secondary)', fontSize: 12 }}>
                🧠 自主模式
              </span>
            </label>
            {llmEnabled && (
              <>
                <span style={{ color: '#92400e', fontWeight: 500 }}>
                  · 每 {Math.round(AUTONOMY_INTERVAL / 60000)} 分钟自动更新
                </span>
                <NextRefreshCountdown next={nextRefreshAt} />
                <span style={{ color: '#b45309', fontSize: 9, background: 'var(--yellow-100)', padding: '1px 6px', borderRadius: 8 }}>
                  ⚡ ~3K tk/次
                </span>
              </>
            )}
          </div>
          {llmEnabled && (
            <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              {llmRefreshing && <span style={{ fontSize: 10, color: '#b45309' }}>生成中...</span>}
              <button onClick={refreshLLMPanels} disabled={llmRefreshing} style={{
                padding: '3px 10px', fontSize: 10, borderRadius: 6, border: '1px solid #fbbf24',
                background: llmRefreshing ? 'var(--yellow-100)' : 'var(--yellow-100)', color: '#92400e',
                cursor: llmRefreshing ? 'wait' : 'pointer', display: 'flex', alignItems: 'center', gap: 3,
                opacity: llmRefreshing ? 0.5 : 1, fontWeight: 500,
              }}>
                🔄 立即刷新
              </button>
              <button onClick={() => setShowTtsMenu(!showTtsMenu)} title="Agent音色设置" style={{
                padding: '3px 6px', fontSize: 10, borderRadius: 6, border: '1px solid #fcd34d',
                background: showTtsMenu ? 'var(--yellow-100)' : 'var(--yellow-100)', color: '#92400e', cursor: 'pointer',
              }}>
                🔊
              </button>
            </div>
          )}
        </div>
      )}
      {/* 🔥 v2.8.1: Agent音色设置弹窗 */}
      {showTtsMenu && (
        <div style={{
          margin: '4px 12px', padding: 10, borderRadius: 8, border: '1px solid #fcd34d',
          background: 'var(--yellow-100)', flexShrink: 0, fontSize: 11,
        }}>
          <div style={{ fontWeight: 600, marginBottom: 6, color: '#92400e', display: 'flex', justifyContent: 'space-between' }}>
            🔊 Agent 独立音色
            <button onClick={() => setShowTtsMenu(false)} style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#d97706', fontSize: 14 }}>✕</button>
          </div>
          {AGENTS.map(agent => {
            const voiceId = agentVoices[agent.id] || AGENT_VOICES[agent.id]
            const voice = TTS_VOICES.find(v => v.id === voiceId)
            return (
              <div key={agent.id} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4, padding: '4px 6px', borderRadius: 6, background: 'var(--surface-0)', border: '1px solid var(--yellow-500)' }}>
                <span style={{ width: 60, fontWeight: 600, color: agent.color, fontSize: 12 }}>{agent.icon} {agent.name}</span>
                <select value={voiceId} onChange={e => {
                    const updated = { ...agentVoices, [agent.id]: e.target.value }
                    setAgentVoices(updated)
                    saveAgentVoices(updated)
                  }}
                  style={{ flex: 1, padding: '2px 4px', fontSize: 10, borderRadius: 4, border: '1px solid #fcd34d', background: 'var(--surface-0)', color: '#92400e' }}>
                  {TTS_VOICES.map(v => (
                    <option key={v.id} value={v.id}>{v.icon} {v.label} — {v.desc}</option>
                  ))}
                </select>
                <button onClick={() => { try { ttsEngine.stop() } catch {} }}
                  style={{ padding: '2px 6px', fontSize: 10, borderRadius: 4, border: '1px solid #fcd34d', background: 'var(--surface-0)', color: '#92400e', cursor: 'pointer' }}>
                  🎧
                </button>
              </div>
            )
          })}
          <div style={{ fontSize: 9, color: '#b45309', marginTop: 4 }}>
            💡 音色自动应用到对应 Agent 的群聊语音回复
          </div>
        </div>
      )}
      {llmError && (
        <div style={{ padding: '4px 12px', fontSize: 10, color: '#ef4444', background: 'var(--red-100)', borderBottom: '1px solid #fecaca', flexShrink: 0 }}>
          ⚠️ {llmError}
        </div>
      )}

      {teamTab === 'chat' && (<>      {/* 🔥 v2.7.1: 团队成员面板（v2.8.1: 可展开详细资料）*/}
      
      {/* 🔥 v2.7.1 决策面板 — 紧凑输入，结果自然流入群聊 */}
      {showDecision && (
        <div style={{
          padding: 10, borderBottom: '1px solid var(--border-light)', background: '#f8fafc', flexShrink: 0,
        }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6, color: 'var(--text-primary)' }}>🎯 团队决策讨论</div>
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              placeholder="让团队帮你讨论什么？例如：周末去哪玩？"
              value={decQuestion}
              onChange={e => setDecQuestion(e.target.value)}
              onKeyDown={e => {
                // 中文输入法选词回车 ≠ 提交（同发送框，见 sendLockRef 注释）
                if (isImeComposing(e)) {return}
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); triggerDecision() }
              }}
              style={{
                flex: 1, padding: '6px 10px', borderRadius: 6, border: '1px solid #d1d5db',
                fontSize: 12, boxSizing: 'border-box',
              }}
            />
            <button onClick={triggerDecision} disabled={decLoading || !decQuestion.trim()}
              style={{
                border: 'none', borderRadius: 6, padding: '5px 14px',
                background: decQuestion.trim() ? 'var(--accent, #3b82f6)' : 'var(--border-light)', color: 'var(--surface-0)',
                fontSize: 12, cursor: decQuestion.trim() ? 'pointer' : 'default', whiteSpace: 'nowrap',
              }}>
              {decLoading ? '讨论中…' : '发起讨论'}
            </button>
            <button onClick={() => { setShowDecision(false); setDecQuestion(''); setDecContext('') }}
              style={{
                border: '1px solid var(--border-light)', borderRadius: 6, padding: '5px 8px', fontSize: 11,
                background: 'var(--surface-0)', cursor: 'pointer', color: 'var(--text-secondary)',
              }}>✕</button>
          </div>
          <input
            placeholder="补充背景信息（可选，回车发起讨论）"
            value={decContext}
            onChange={e => setDecContext(e.target.value)}
            onKeyDown={e => {
              // 中文输入法选词回车 ≠ 提交
              if (isImeComposing(e)) {return}
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); triggerDecision() }
            }}
            style={{
              width: '100%', padding: '4px 10px', borderRadius: 6, border: '1px solid var(--border-light)',
              fontSize: 11, marginTop: 5, boxSizing: 'border-box', color: 'var(--text-secondary)',
            }}
          />
        </div>
      )}

      {/* 📋 全屏角色选择界面（带动画，对标 Lumina Agent） */}
      {teamTab === 'chat' && showRoleSelector && (
        <div style={{
          flex: 1, overflowY: 'auto',
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          background: 'var(--surface-0)',
          padding: '14px 24px',
        }}>
          <style>{`
            @keyframes teamCardIn {
              0% { opacity: 0; transform: translateY(14px) scale(0.96); }
              100% { opacity: 1; transform: translateY(0) scale(1); }
            }
            @keyframes teamIconBounce {
              0% { transform: scale(0.7) rotate(-8deg); opacity: 0; }
              60% { transform: scale(1.12) rotate(3deg); }
              100% { transform: scale(1) rotate(0); opacity: 1; }
            }
            @keyframes teamTitleSlide {
              0% { opacity: 0; transform: translateY(8px); }
              100% { opacity: 1; transform: translateY(0); }
            }
            @keyframes teamBadgePop {
              0% { transform: scale(0); opacity: 0; }
              70% { transform: scale(1.15); }
              100% { transform: scale(1); opacity: 1; }
            }
            .team-role-card {
              animation: teamCardIn 0.45s cubic-bezier(0.22,1,0.36,1) both;
              transition: all 0.25s cubic-bezier(0.4,0,0.2,1);
            }
            .team-role-card:hover {
              transform: translateY(-4px) scale(1.015);
              box-shadow: 0 8px 24px rgba(0,0,0,0.12);
              background: var(--surface-200);
            }
          `}</style>

          {/* 标题区 */}
          <div style={{ textAlign: 'center', marginBottom: 16, paddingTop: 8 }}>
            <div style={{
              fontSize: 44, marginBottom: 6,
              animation: 'teamIconBounce 0.6s cubic-bezier(0.22,1,0.36,1) both',
              filter: 'drop-shadow(0 3px 8px rgba(0,0,0,0.15))',
            }}>🤝</div>
            <div style={{
              fontSize: 20, fontWeight: 800,
              background: 'linear-gradient(135deg, #6366f1, #ec4899, #f59e0b)',
              backgroundClip: 'text', WebkitBackgroundClip: 'text', color: 'transparent',
              animation: 'teamTitleSlide 0.5s ease 0.15s both',
              marginBottom: 6,
            }}>
              Hello，你的Lumina team上线啦~~~
            </div>
            <div style={{
              fontSize: 13, color: 'var(--text-secondary)',
              animation: 'teamTitleSlide 0.5s ease 0.25s both',
            }}>
              选一个任务类型，我来帮你分配最合适的队友 ✨
            </div>
          </div>

          {/* 任务类型卡片网格 — 3列自适应布局 */}
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12,
            width: '100%', maxWidth: '90%',
          }}>
            {TASK_TYPE_CARDS.map((card, idx) => (
              <div
                key={card.id}
                className="team-role-card"
                onClick={() => {
                  setSelectedRole(card.id)
                  setShowRoleSelector(false)
                }}
                style={{
                  animationDelay: `${idx * 55}ms`,
                  padding: '12px 14px',
                  borderRadius: 12,
                  border: '1.5px solid var(--border-light)',
                  borderLeft: `3px solid ${card.color}`,
                  background: 'var(--surface-100)',
                  cursor: 'pointer',
                  textAlign: 'left',
                  boxShadow: '0 1px 6px rgba(0,0,0,0.04)',
                  position: 'relative',
                }}
              >
                <div style={{ fontSize: 26, marginBottom: 5, filter: 'drop-shadow(0 2px 4px rgba(0,0,0,0.08))' }}>{card.icon}</div>
                <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 2 }}>
                  {card.name}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.4, marginBottom: 6 }}>
                  {card.desc}
                </div>
                {/* 技能标签 */}
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 6 }}>
                  {card.quickPrompts.slice(0, 2).map((tag, i) => (
                    <span key={i} style={{
                      padding: '2px 8px', borderRadius: 10,
                      background: 'var(--surface-200)', color: 'var(--text-secondary)',
                      fontSize: 10, fontWeight: 500,
                      border: '1px solid var(--border-light)',
                    }}>
                      {tag.length > 6 ? tag.slice(0, 6) + '…' : tag}
                    </span>
                  ))}
                </div>
                {/* 欢迎语 */}
                <div style={{
                  padding: '5px 8px',
                  background: 'var(--surface-50)', borderRadius: 7,
                  fontSize: 10.5, color: 'var(--text-secondary)', fontStyle: 'italic',
                  lineHeight: 1.4,
                  borderLeft: `2px solid ${card.color}`,
                }}>
                  "{card.quickPrompts[0].slice(0, 22)}{card.quickPrompts[0].length > 22 ? '…' : ''}"
                </div>
              </div>
            ))}
          </div>

          {/* 底部提示 */}
          <div style={{
            marginTop: 14, textAlign: 'center', fontSize: 12, color: 'var(--text-tertiary)',
            paddingBottom: 8,
            animation: 'teamTitleSlide 0.5s ease 0.6s both',
          }}>
            <span>选中即可开始对话</span>
            <span style={{ opacity: 0.4 }}> · </span>
            <span>随时可「切换角色」重新选择</span>
          </div>
        </div>
      )}

      {/* 消息列表 — 角色选择界面时隐藏 */}
      {teamTab === 'chat' && showRoleSelector ? null : (
      <div ref={scrollContainerRef} onScroll={handleScroll}
        style={{ flex: 1, overflowY: 'auto', padding: '10px 12px' }}>
        {/* 🎯 选中角色后的欢迎氛围屏 */}
        {teamTab === 'chat' && selectedRole && messages.filter(m => m.from === 'user').length === 0 && (() => {
          const card = TASK_TYPE_CARDS.find(c => c.id === selectedRole)
          if (!card) {return null}
          const agent = TEAM_MEMBERS.find(m => m.id === getRecommendedAgent(selectedRole))
          return (
            <div style={{
              display: 'flex', flexDirection: 'column', alignItems: 'center',
              padding: '30px 20px 20px',
            }}>
              <style>{`
                @keyframes readyPop {
                  0% { opacity: 0; transform: scale(0.6) rotate(-10deg); }
                  60% { transform: scale(1.15) rotate(4deg); }
                  100% { opacity: 1; transform: scale(1) rotate(0); }
                }
                @keyframes readySlideUp {
                  0% { opacity: 0; transform: translateY(16px); }
                  100% { opacity: 1; transform: translateY(0); }
                }
                @keyframes readyChip {
                  0% { opacity: 0; transform: translateY(10px) scale(0.9); }
                  100% { opacity: 1; transform: translateY(0) scale(1); }
                }
                @keyframes readyPulse {
                  0%, 100% { box-shadow: 0 0 0 0 ${card.color}20; }
                  50% { box-shadow: 0 0 16px 4px ${card.color}25; }
                }
              `}</style>
              <div style={{
                fontSize: 52, marginBottom: 10,
                animation: 'readyPop 0.6s cubic-bezier(0.22,1,0.36,1) both',
                filter: 'drop-shadow(0 4px 10px rgba(0,0,0,0.12))',
              }}>{card.icon}</div>
              <h3 style={{
                margin: 0, fontSize: 20, fontWeight: 800, color: card.color,
                animation: 'readySlideUp 0.5s ease 0.1s both',
              }}>
                {card.name} 已就绪
              </h3>
              <p style={{
                margin: '8px 0 0', fontSize: 13, color: 'var(--text-secondary)', textAlign: 'center',
                animation: 'readySlideUp 0.5s ease 0.2s both',
              }}>
                {card.desc}
                {agent && <span> {agent.icon} {agent.name} 已就位</span>}
              </p>
              {/* 快捷指令按钮 */}
              <div style={{
                display: 'flex', gap: 10, marginTop: 18, flexWrap: 'wrap', justifyContent: 'center',
              }}>
                {card.quickPrompts.slice(0, 3).map((prompt, i) => (
                  <button
                    key={i}
                    className="ready-chip"
                    onClick={() => {
                      // 🆕 v9.2: 记住用户选择的任务类型，send() 会优先用它路由到正确的 Agent
                      pendingTaskTypeRef.current = card.id
                      // 设置输入文本，等待 React 渲染后再触发 send()
                      setInput(prompt)
                      setShowRoleSelector(false)
                      setTimeout(() => { sendRef.current() }, 60)
                    }}
                    style={{
                      padding: '9px 20px', borderRadius: 22,
                      border: 'none',
                      background: `${card.color}12`,
                      color: card.color, fontSize: 13, fontWeight: 600,
                      cursor: 'pointer', transition: 'all 0.2s',
                      animation: `readyChip 0.4s ease ${0.35 + i * 0.08}s both`,
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = `${card.color}22`
                      e.currentTarget.style.transform = 'translateY(-2px) scale(1.03)'
                      e.currentTarget.style.boxShadow = `0 4px 14px ${card.color}30`
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = `${card.color}12`
                      e.currentTarget.style.transform = 'translateY(0) scale(1)'
                      e.currentTarget.style.boxShadow = 'none'
                    }}
                  >
                    ✨ {prompt}
                  </button>
                ))}
              </div>
              {/* 提示文字 */}
              <p style={{
                margin: '16px 0 0', fontSize: 11, color: 'var(--text-secondary)', textAlign: 'center',
                animation: 'readySlideUp 0.4s ease 0.6s both',
              }}>
                点击快捷指令即可发送 · 也可以直接输入消息
              </p>
              {/* 简约提示条 */}
              <div style={{
                marginTop: 12, padding: '7px 16px',
                background: 'var(--surface-100)', borderRadius: 8,
                border: '1px solid var(--border-light)',
                fontSize: 11, color: 'var(--text-secondary)', textAlign: 'center',
                lineHeight: 1.6, maxWidth: 420,
                animation: 'readySlideUp 0.4s ease 0.7s both',
              }}>
                💡 直接发消息，{agent?.name || 'Lumina'} 会帮你处理<br/>
                💡 输入 @{agent?.name || 'Lumina'} 指定回复者
              </div>
            </div>
          )
        })()}
        {/* 选中角色后隐藏初始系统欢迎消息 */}
        {/* 折叠提示：让「隐藏」是可见的行为，而不是像消息丢了 */}
        {hiddenCount > 0 && (
          <div style={{
            margin: '4px 12px', padding: '5px 10px', borderRadius: 6,
            background: 'var(--surface-50)', border: '1px dashed var(--border-light)',
            fontSize: 10, color: 'var(--text-tertiary)', flexShrink: 0,
          }}>
            {Object.entries(hiddenAgents).map(([id, n]) => `${n} 条 ${id}`).join("、")}
            已折叠 · 可在「团队管理」里打开对应成员
          </div>
        )}
        {visibleMessages.filter(m => !(selectedRole && m.id === '0')).map((m, i) => (
          <div key={m.id} className="msg-anim-in"
            onMouseEnter={() => m.from !== 'system' && setHoveredMsgId(m.id)}
            onMouseLeave={() => setHoveredMsgId(null)}
            style={{
            marginBottom: 10, display: 'flex', gap: 8, alignItems: 'flex-start',
            flexDirection: m.from === 'user' ? 'row-reverse' : 'row',
            animationDelay: `${Math.min(i * 30, 300)}ms`,
          }}>
            <div style={{
              width: 32, height: 32, borderRadius: 16, fontSize: 18,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              flexShrink: 0,
              fontFamily: '"Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif',
              background: m.from === 'user' ? 'var(--accent-50)' : 'var(--surface-50)',
              border: `1.5px solid ${
                m.from === 'lumina' ? '#FFD4D4' : m.from === 'recha' ? '#D4E8FF' : m.from === 'yak' ? '#D4FFD6' : 'var(--border-light)'
              }`,
            }}>{m.fromIcon}</div>
            <div style={{ maxWidth: '72%' }}>
              <div style={{
                fontSize: 12, color: m.from === 'lumina' ? '#FF6B6B' : m.from === 'recha' ? '#448AFF' : m.from === 'yak' ? '#43A047' : '#3b82f6',
                fontWeight: 600, marginBottom: 2,
              }}>
                {m.fromName} <span style={{ color: 'var(--text-tertiary)', fontWeight: 400 }}>{m.time}</span>
                {replyingAgent === m.from && (
                  <span className={`typing-dots ${agentSwitchClass}`} style={{ marginLeft: 6, display: 'inline-flex', verticalAlign: 'middle', padding: 0, gap: 3 }}>
                    <span style={{ width: 5, height: 5 }} />
                    <span style={{ width: 5, height: 5 }} />
                    <span style={{ width: 5, height: 5 }} />
                  </span>
                )}
                {/* 🆕 v5.4: 上一个 Agent 的打字点渐隐（接力过渡） */}
                {prevReplyingAgent === m.from && replyingAgent !== m.from && !m._animDone && (
                  <span className="typing-dots typing-dots-fading" style={{ marginLeft: 6, display: 'inline-flex', verticalAlign: 'middle', padding: 0, gap: 3 }}>
                    <span style={{ width: 5, height: 5 }} />
                    <span style={{ width: 5, height: 5 }} />
                    <span style={{ width: 5, height: 5 }} />
                  </span>
                )}
              </div>
              <div style={{
                background: m.from === 'user'
                  ? (profile.bubbleColorUser || 'var(--accent-50)')
                  : (profile.bubbleColorAgent || 'var(--surface-50)'),
                borderRadius: 10, padding: '9px 14px', fontSize: 14, lineHeight: 1.7,
                border: '1px solid var(--border-light)', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                minHeight: m.content ? undefined : 20,
                display: m.content ? undefined : 'flex',
                alignItems: m.content ? undefined : 'center',
                color: m.content ? 'var(--text-primary)' : 'var(--text-secondary)',
                fontStyle: m.content ? undefined : 'italic',
                userSelect: 'text',
                cursor: 'text',
              }}>{m.content ? <LinkifiedText text={m.content} /> : (m._animDone ? '（内容为空）' : <span className="typing-dots" style={{ display: 'inline-flex', gap: 3, padding: 0 }}><span style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--text-tertiary)', display: 'inline-block' }} /><span style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--text-tertiary)', display: 'inline-block' }} /><span style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--text-tertiary)', display: 'inline-block' }} /></span>)}</div>
              {/* 🆕 v10.3fix: 渲染思考过程（借鉴 QwenPaw）
                  正在输出默认展开，输出完毕默认收起，随时可点标题栏切换 */}
              {m.thinkingSteps && m.thinkingSteps.length > 0 && (
                <div style={{ marginTop: 6, marginBottom: 2, borderTop: '1px solid var(--border-light)', paddingTop: 4 }}>
                  <button
                    className="thinking-toggle"
                    onClick={() => toggleThinking(m.id, !m._animDone)}
                    aria-expanded={!isThinkingCollapsed(m.id, m)}
                    aria-controls={`thinking-${m.id}`}
                    style={{
                      background: 'none', border: 'none', cursor: 'pointer', fontSize: 13,
                      color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 4, padding: '2px 4px',
                    }}
                  >
                    <span className="thinking-chevron" style={{ fontSize: 11, display: 'inline-block' }}>
                      ▶
                    </span>
                    <span>思考过程 ({m.thinkingSteps.length} 步)</span>
                  </button>
                  {/* grid-template-rows: 0fr → 1fr 做展开/收起动画，无需 JS 量高度 */}
                  <div
                    id={`thinking-${m.id}`}
                    className={'thinking-collapse' + (isThinkingCollapsed(m.id, m) ? '' : ' open')}
                  >
                    <div className="thinking-clip">
                      <div style={{
                        marginTop: 4, padding: '4px 6px', borderRadius: 8, background: 'var(--surface-50)',
                        border: '1px solid var(--border-light)', maxHeight: 300,
                        overflowY: 'auto', overflowX: 'hidden',
                      }}>
                        <ThinkingStepList steps={m.thinkingSteps} />
                      </div>
                    </div>
                  </div>
                </div>
              )}
              {/* 🆕 v8.1: 文件预览 — 用户气泡下方文件卡片（简洁版：仅显示文件名和类型） */}
              {m.attachments && m.attachments.length > 0 && (
                <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 3 }}>
                  {m.attachments.map((a, i) => {
                    const isImage = !!a.text?.startsWith('[图片')
                    const isBinary = !!a.text?.startsWith('[') && !a.text?.startsWith('[图片')
                    return (
                      <div key={i} style={{
                        display: 'flex', alignItems: 'center', gap: 6,
                        padding: '4px 8px', borderRadius: 6,
                        background: 'var(--surface-50)', border: '1px solid var(--border-light)',
                        fontSize: 11, lineHeight: 1.4,
                      }}>
                        <span style={{ fontSize: 14 }}>{isImage ? '🖼️' : isBinary ? '📄' : '📝'}</span>
                        <span style={{ fontWeight: 500, color: '#334155', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {a.name}
                        </span>
                        <span style={{ color: '#94a3b8', flexShrink: 0 }}>
                          ({(a.size / 1024).toFixed(1)}KB)
                        </span>
                      </div>
                    )
                  })}
                </div>
              )}
              {/* v2.14: 内联操作按钮 */}
              {m.from !== 'system' && (
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 1, marginTop: 4,
                  opacity: hoveredMsgId === m.id ? 1 : 0.3,
                  transition: 'opacity 0.15s',
                  justifyContent: m.from === 'user' ? 'flex-end' : 'flex-start',
                }}>
                  <button onClick={() => handleCopyMsg(m.content, m.id)}
                    title="复制"
                    style={gcInlineBtnStyle}>
                    {copiedMsgId === m.id ? '✅' : '📋'}
                  </button>
                  <button onClick={() => handleResendMsg(m.content)}
                    title="重新输入" style={gcInlineBtnStyle}>
                    ↩️
                  </button>
                  <button onClick={() => handleBookmarkMsg(m)}
                    title="收藏" style={gcInlineBtnStyle}>
                    ⭐
                  </button>
                  <button onClick={() => handleDeleteRequest(m)}
                    title="删除" style={gcInlineBtnStyle}>
                    🗑️
                  </button>
                </div>
              )}
            </div>
          </div>
        ))}
        {replyingAgent && messages[messages.length - 1]?.from !== replyingAgent && (
          <div className="msg-anim-in" style={{
            display: 'flex', gap: 8, alignItems: 'center', padding: '4px 0',
            marginBottom: 10,
          }}>
            <div style={{
              width: 26, height: 26, borderRadius: 13, display: 'flex',
              alignItems: 'center', justifyContent: 'center', flexShrink: 0,
              background: 'var(--surface-100)', border: '1.5px solid var(--border-light)',
            }}>{AGENTS.find(a => a.id === replyingAgent)?.icon || '🤖'}</div>
            <div className="typing-dots" style={{ padding: 0, gap: 3 }}>
              <span style={{ width: 5, height: 5 }} />
              <span style={{ width: 5, height: 5 }} />
              <span style={{ width: 5, height: 5 }} />
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>
      )}

      {/* 输入区 — 角色选择界面时隐藏 */}
      {teamTab === 'chat' && showRoleSelector ? null : (
      <>
      {/* v2.8.3: 工具通知 — Agent 正在使用工具时显示 */}
      {toolNotice && (
        <div className="tool-notice-bar" style={{
          margin: '0 12px', padding: '6px 12px', borderRadius: 8,
          background: 'linear-gradient(135deg, var(--accent-50) 0%, var(--green-100) 100%)',
          border: '1.5px solid #93c5fd', fontSize: 12, color: '#1e40af',
          display: 'flex', alignItems: 'center', gap: 6,
        }}>
          <span className="tool-notice-icon">⚡</span>
          {toolNotice}
        </div>
      )}
      {/* 🔥 v2.8.1: Agent 回复状态提示 */}
      {replyingAgent && (
        <div style={{
          margin: '0 12px', padding: '5px 12px', borderRadius: 6,
          background: 'var(--yellow-100)', border: '1px solid var(--yellow-500)',
          fontSize: 11, color: '#92400e', flexShrink: 0,
          display: 'flex', alignItems: 'center', gap: 6,
        }}>
          <span>{AGENTS.find(a => a.id === replyingAgent)?.icon || '🤖'}</span>
          <span>{AGENTS.find(a => a.id === replyingAgent)?.name || 'Agent'} 正在回复中...</span>
          <span style={{ display: 'inline-flex', gap: 2 }}>
            <span style={{ width: 4, height: 4, borderRadius: '50%', background: '#f59e0b', animation: 'toolPulse 1.2s ease-in-out infinite', animationDelay: '0s' }} />
            <span style={{ width: 4, height: 4, borderRadius: '50%', background: '#f59e0b', animation: 'toolPulse 1.2s ease-in-out infinite', animationDelay: '0.2s' }} />
            <span style={{ width: 4, height: 4, borderRadius: '50%', background: '#f59e0b', animation: 'toolPulse 1.2s ease-in-out infinite', animationDelay: '0.4s' }} />
          </span>
        </div>
      )}
      {/* v2.7: 隐藏文件上传 input */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.json,.xml,.md,.csv,.yaml,.yml,.log,.py,.js,.ts,.java,.cpp,.c,.h,.html,.css,.sh,.bat,.ps1,.ini,.cfg,.toml,.zip"
        style={{ display: 'none' }}
        onChange={handleGCFileSelect}
      />
      {/* 拖拽文件预览 */}
      {gcDragFiles.length > 0 && (
        <div style={{
          margin: '0 12px', padding: '8px 12px', borderRadius: 8,
          background: 'var(--accent-50)', border: '1px solid #93c5fd',
          display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center',
          flexShrink: 0,
        }}>
          <span style={{ fontSize: 12, color: '#1d4ed8', fontWeight: 600 }}>📥 将上传：</span>
          {gcDragFiles.map((f, i) => (
            <span key={i} style={{
              fontSize: 11, color: '#1e40af', background: '#dbeafe',
              padding: '2px 8px', borderRadius: 4,
              display: 'flex', alignItems: 'center', gap: 4,
            }}>
              {f.type.startsWith('image/') ? '🖼️' : f.name.match(/\.(pdf|doc|docx)$/i) ? '📄' : '📁'}
              {f.name.length > 20 ? f.name.slice(0, 17) + '...' : f.name}
              <span style={{ color: 'var(--text-secondary)', fontSize: 10 }}>
                {(f.size/1024/1024).toFixed(1)}MB
              </span>
            </span>
          ))}
        </div>
      )}
      {/* 🔧 v2.11: 附件预览 — 与普通聊天一致的逐个文件预览 */}
      {gcAttachments.length > 0 && (
        <div style={{ margin: '0 12px', display: 'flex', flexWrap: 'wrap', gap: 4, flexShrink: 0 }}>
          {gcAttachments.map((a, i) => (
            <div key={i} style={{
              display: 'flex', alignItems: 'center', gap: 4,
              background: 'var(--accent-50)', border: '1px solid #bfdbfe',
              borderRadius: 6, padding: '3px 8px', fontSize: 11,
              color: '#1d4ed8', maxWidth: 200,
            }}>
              <span style={{ fontSize: 13 }}>
                {a.name.match(/\.(png|jpg|jpeg|gif|webp|svg)$/i) ? '🖼️'
                  : a.name.match(/\.(pdf|doc|docx)$/i) ? '📄'
                  : a.name.match(/\.(xls|xlsx|csv)$/i) ? '📊'
                  : a.name.match(/\.(py|js|ts|java|cpp|c|h|html|css|json|xml)$/i) ? '💻'
                  : '📁'}
              </span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {a.name.length > 16 ? a.name.slice(0, 14) + '...' : a.name}
              </span>
              <span style={{ color: 'var(--text-secondary)', fontSize: 9 }}>
                {a.size > 1024 * 1024 ? `${(a.size / (1024 * 1024)).toFixed(1)}MB` : `${(a.size / 1024).toFixed(0)}KB`}
              </span>
              <button onClick={() => setGcAttachments(prev => prev.filter((_, idx) => idx !== i))} style={{
                border: 'none', background: 'transparent', color: '#93c5fd',
                cursor: 'pointer', fontSize: 13, padding: 0, lineHeight: 1,
              }}>×</button>
            </div>
          ))}
        </div>
      )}
      <div
        style={{
        padding: '8px 12px', borderTop: '1px solid var(--border-light)', flexShrink: 0,
        display: 'flex', flexDirection: 'column', gap: 6,
        transition: 'background 0.15s, border-color 0.15s',
        background: gcDragOver ? 'var(--accent-50)' : 'transparent',
        borderColor: gcDragOver ? 'var(--accent, #3b82f6)' : 'var(--border-light)',
        outline: gcDragOver ? '2px dashed #93c5fd' : 'none',
        outlineOffset: -4,
      }}>
        <div style={{ position: 'relative' }}>
          <textarea
            key={`gc-input-${inputKey}`}
            ref={gcTextareaRef}
            placeholder={llmReady ? '发消息... @Lumina @热茶 @Yak 指定回复者 （Shift+Enter 换行）' : '发消息...（模拟模式，配置LLM后解锁真实对话）'}
            value={input}
            onChange={e => { setInput(e.target.value); setPromptEnhanceNotice(''); gcAutoResize() }}
            onPaste={e => handlePasteInsert(e, input, setInput)}
            onKeyDown={e => {
              // ⚠️ 中文输入法（IME）选词时按回车只是「确认候选词」，不是「发送」。
              //   不判 isComposing 的话，拼音打字按回车会把半截内容当成消息发出去
              //   （甚至发空）—— 典型的「聊天断断续续」。
              if (isImeComposing(e)) {return}
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
            }}
            onDragOver={e => e.preventDefault()}
            rows={1}
            style={{
              width: '100%', padding: '10px 14px', borderRadius: 10, border: '1px solid var(--border-light)',
              fontSize: 13, outline: 'none', fontFamily: 'inherit',
              resize: 'vertical', minHeight: 72, paddingLeft: 14, paddingRight: 224, paddingBottom: 40,
              boxSizing: 'border-box', lineHeight: 1.5,
            }}
          />
          {/* ── 模型选择器紧挨发送/中断按钮左侧 ── */}
          <div style={{
            position: 'absolute', right: 10, bottom: 8, zIndex: 2,
            maxWidth: 'calc(100% - 20px)', display: 'flex', gap: 7, alignItems: 'center',
          }}>
            <div style={{ minWidth: 0, maxWidth: 160, overflow: 'hidden', display: 'flex', alignItems: 'center' }}>
              <ModelSelector />
            </div>
            {/* ── 发送 / 中断（圆形上箭头；无内容暗淡，有内容高亮） ── */}
          {sending ? (
            <button onClick={() => { abortRef.current = true; setSending(false); setReplyingAgent(null); window.luminaAPI.agentAbort() }}
              title="中断回复"
              style={{
                padding: '4px 12px', borderRadius: 6,
                border: '1.5px solid #fca5a5', background: 'var(--red-100)', color: '#ef4444',
                cursor: 'pointer', fontSize: 12, display: 'flex',
                alignItems: 'center', gap: 3, fontFamily: 'inherit', fontWeight: 600,
              }}>
              <svg width="14" height="14" viewBox="0 0 24 24" style={{ animation: 'sendSpin 0.9s linear infinite' }}>
                <circle cx="12" cy="12" r="10" fill="none" stroke="#ef4444" strokeWidth="2.5" strokeDasharray="50 50" strokeLinecap="round" />
              </svg>
              中断
            </button>
          ) : (
            <button onClick={send} disabled={sending || !input.trim()}
              aria-label="发送消息"
              title="发送消息（Enter）"
              style={{
                width: 32, height: 32, padding: 0, flexShrink: 0,
                border: 'none', borderRadius: '50%',
                background: input.trim() ? '#dbeafe' : '#eef0f3',
                color: input.trim() ? '#2563eb' : '#a0a5ae',
                cursor: input.trim() ? 'pointer' : 'default',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                transition: 'background .16s ease, color .16s ease, transform .12s ease',
                boxShadow: input.trim() ? '0 0 0 1px rgba(37,99,235,.12)' : 'none',
              }}>
              <svg width="17" height="17" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 4.25 3.8 12.9c-.33.35-.08.93.4.93h4.35v5.42c0 .3.24.54.54.54h5.82c.3 0 .54-.24.54-.54v-5.42h4.35c.48 0 .73-.58.4-.93L12 4.25Z" fill="currentColor" />
              </svg>
            </button>
          )}
          </div>
        </div>
        {/* ── 功能工具栏（小长方形按钮 + 微软雅黑标注） ── */}
        <div style={{
          display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center',
          fontFamily: '"微软雅黑","Microsoft YaHei",sans-serif',
        }}>
          {/* ✨ 增强提示词：按任务类型自适应改写草稿，不会自动发送 */}
          <button
            onClick={() => { void enhancePrompt() }}
            disabled={!input.trim() || promptEnhancing}
            title="保留原意润色草稿：改含糊/啰嗦/语病，不替你加需求、不加维度；只替换输入草稿，不会自动发送"
            style={{
              padding: '4px 10px', borderRadius: 6,
              border: `1.5px solid ${input.trim() && !promptEnhancing ? '#c4b5fd' : 'var(--border-light)'}`,
              background: input.trim() && !promptEnhancing ? '#f5f3ff' : 'var(--surface-50)',
              color: input.trim() && !promptEnhancing ? '#6d28d9' : 'var(--text-secondary)',
              cursor: !input.trim() || promptEnhancing ? 'default' : 'pointer',
              opacity: !input.trim() ? 0.55 : 1,
              fontSize: 12, display: 'flex', alignItems: 'center', gap: 4,
              fontFamily: 'inherit', transition: 'all .15s',
            }}
          >
            <span aria-hidden="true">{promptEnhancing ? '⏳' : '✨'}</span>
            {promptEnhancing ? '正在增强…' : '增强提示词'}
          </button>
          {/* ↩︎ 撤销增强：恢复增强前的草稿 */}
          {promptEnhanceUndo !== null && !promptEnhancing && (
            <button
              onClick={undoEnhancePrompt}
              title="恢复为增强前的草稿"
              style={{
                padding: '4px 10px', borderRadius: 6, border: '1px solid var(--border-light)',
                background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer',
                fontSize: 12, display: 'flex', alignItems: 'center', gap: 4,
                fontFamily: 'inherit',
              }}
            >
              <span aria-hidden="true">↩︎</span>撤销
            </button>
          )}
          {promptEnhanceNotice && (
            <span role="status" style={{
              fontSize: 10, color: promptEnhanceNotice.startsWith('❌') ? '#b91c1c' : 'var(--text-secondary)',
              maxWidth: 360, lineHeight: 1.4,
            }}>{promptEnhanceNotice}</span>
          )}
          {/* ── 🍀 Lucky 模式（第二位） ── */}
          <LuckyModeSelector
            currentPreset={luckyMode.preset}
            onPresetChange={luckyMode.setPreset}
            runtimeInfo={{
              preset: luckyMode.preset,
              isActive: luckyMode.isActive,
              currentIteration: luckyMode.runtime.currentIteration,
              maxIteration: luckyMode.runtime.maxIteration,
              isPaused: luckyMode.isPaused,
              pauseReason: luckyMode.runtime.pauseReason,
            }}
            onOpenSettings={() => luckyMode.setShowSettings(true)}
          />
          {/* 🍀 Lucky 模式暂停继续按钮 */}
          {luckyMode.isPaused && (
            <button
              onClick={luckyMode.resume}
              style={{
                padding: '4px 10px', borderRadius: 6,
                border: '1.5px solid #fca5a5', background: '#fef2f2',
                cursor: 'pointer', fontSize: 12, display: 'flex',
                alignItems: 'center', gap: 3, fontFamily: 'inherit',
                color: '#dc2626',
              }}>
              ▶️ 继续
            </button>
          )}
          {/* ── 🧠 思考 ── */}
          <button
            onClick={() => setThinkingMode(v => !v)}
            title={thinkingMode ? '🧠 思考过程已开启 — 点击关闭' : '🧠 思考过程已关闭 — 点击开启'}
            style={{
              padding: '4px 10px', borderRadius: 6,
              border: `1.5px solid ${thinkingMode ? '#f59e0b' : 'var(--border-light)'}`,
              background: thinkingMode ? 'var(--yellow-100)' : 'var(--surface-50)',
              cursor: 'pointer', fontSize: 12, display: 'flex',
              alignItems: 'center', gap: 3, fontFamily: 'inherit',
              opacity: thinkingMode ? 1 : 0.6,
              transition: 'all .2s',
            }}>
            🧠 思考
          </button>
          {/* ── 😊 表情 ── */}
          <div style={{ position: 'relative', flexShrink: 0 }}>
            <button
              onClick={() => setShowEmoji(!showEmoji)}
              title="表情符号"
              style={{
                padding: '4px 10px', borderRadius: 6,
                border: `1.5px solid ${showEmoji ? '#93c5fd' : 'var(--border-light)'}`,
                background: showEmoji ? 'var(--accent-50)' : 'var(--surface-50)',
                cursor: 'pointer', fontSize: 12, display: 'flex',
                alignItems: 'center', gap: 3, fontFamily: 'inherit',
                transition: 'all .15s',
              }}>
              😊 表情
            </button>
          {showEmoji && (
            <>
              <div style={{ position: 'fixed', inset: 0, zIndex: 99 }}
                onClick={() => setShowEmoji(false)} />
              <div style={{
                position: 'absolute', bottom: 40, left: 0, zIndex: 100,
                width: 312, background: 'var(--surface-0)', borderRadius: 12,
                border: '1px solid var(--border-light)',
                boxShadow: '0 4px 24px rgba(0,0,0,.12)',
                overflow: 'hidden',
              }}>
                {/* ═══分类标签 ═══*/}
                <div style={{
                  display: 'flex', gap: 2, padding: '4px 6px',
                  borderBottom: '1px solid var(--border-light)',
                  background: 'var(--surface-0)', overflowX: 'auto',
                }}
                  onWheel={e => {
                    const el = e.currentTarget
                    el.scrollLeft += e.deltaY
                    e.preventDefault()
                  }}
                >
                  {EMOJI_GROUPS.map((group, gi) => (
                    <button key={gi}
                      onClick={() => {
                        const el = document.getElementById(`gc-emoji-group-${gi}`)
                        if (el) {
                          const container = el.parentElement
                          if (container) {container.scrollTo({ top: el.offsetTop - 8, behavior: 'smooth' })}
                        }
                      }}
                      title={group.name}
                      style={{
                        flexShrink: 0, height: 28, borderRadius: 6,
                        border: 'none', background: 'transparent',
                        cursor: 'pointer', fontSize: 12, fontWeight: 500,
                        color: 'var(--text-secondary)', padding: '0 8px',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        gap: 3, transition: 'background .1s',
                        whiteSpace: 'nowrap',
                      }}
                      onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = 'var(--border-light)'}
                      onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = 'transparent'}
                    >
                      <span style={{ fontSize: 13 }}>{group.label}</span>
                      <span style={{ fontSize: 10, opacity: 0.6 }}>{group.name}</span>
                    </button>
                  ))}
                </div>
                {/* ═══Emoji 网格 ═══*/}
                <div style={{ maxHeight: 260, overflowY: 'auto', padding: '4px 6px' }}>
                  {EMOJI_GROUPS.map((group, gi) => (
                    <div key={gi} id={`gc-emoji-group-${gi}`}>
                      <div style={{ fontSize: 10, color: 'var(--text-secondary)', padding: '6px 4px 2px', fontWeight: 500 }}>
                        {group.label} {group.name}
                      </div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
                        {group.emojis.map((emoji, ei) => {
                          if (emoji === 'x') {return <div key={ei} style={{ width: 30, height: 30 }} />}
                          return (
                            <button key={ei}
                              onClick={() => {
                                setInput(prev => prev + emoji)
                                setShowEmoji(false)
                              }}
                              title={emoji}
                              style={{
                                width: 30, height: 30, borderRadius: 5,
                                border: 'none', background: 'transparent',
                                cursor: 'pointer', fontSize: 17, padding: 0,
                                lineHeight: '30px', textAlign: 'center',
                              }}
                              onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = 'var(--border-light)'}
                              onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = 'transparent'}
                            >
                              {emoji}
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
          {/* ── 📎 文件 ── */}
          <button
            onClick={() => fileInputRef.current?.click()}
            title="上传文件"
            style={{
              padding: '4px 10px', borderRadius: 6,
              border: `1.5px solid ${gcAttachments.length > 0 ? '#93c5fd' : 'var(--border-light)'}`,
              background: gcAttachments.length > 0 ? 'var(--accent-50)' : 'var(--surface-50)',
              cursor: 'pointer', fontSize: 12, display: 'flex',
              alignItems: 'center', gap: 3, fontFamily: 'inherit',
            }}>
            📎 文件{gcAttachments.length > 0 ? <sup style={{ fontSize: 9, color: 'var(--accent, #3b82f6)', marginLeft: 1 }}>{gcAttachments.length}</sup> : null}
          </button>

          {/* ── 🎙️ 实时语音对话 ── */}
          <button onClick={async () => {
            if (realtimeVoiceActive) {
              try {
                const r = await window.luminaAPI?.agentStopRealtimeVoice?.()
                if (r?.success) { setRealtimeVoiceActive(false); showToast?.('🎙️ 实时语音对话已停止', 'info') }
                else { showToast?.(`⚠️ ${r?.error || '停止失败'}`, 'warning') }
              } catch (e: any) { showToast?.(`⚠️ ${e.message}`, 'warning') }
            } else {
              try {
                const r = await window.luminaAPI?.agentStartRealtimeVoice?.()
                if (r?.success) { setRealtimeVoiceActive(true); showToast?.(r.message || '🎙️ 实时语音对话已启动', 'info') }
                else { showToast?.(`⚠️ ${r?.error || '启动失败'}`, 'warning') }
              } catch (e: any) { showToast?.(`⚠️ ${e.message}`, 'warning') }
            }
          }}
            title={realtimeVoiceActive ? '停止实时语音对话' : '实时语音对话'}
            style={{
              padding: '4px 10px', borderRadius: 6,
              border: `1.5px solid ${realtimeVoiceActive ? '#22c55e' : 'var(--border-light)'}`,
              background: realtimeVoiceActive ? 'var(--green-100)' : 'var(--surface-50)',
              cursor: 'pointer', fontSize: 12, display: 'flex',
              alignItems: 'center', gap: 3, fontFamily: 'inherit',
              boxShadow: realtimeVoiceActive ? '0 0 6px rgba(34,197,94,0.35)' : 'none',
            }}>
            {realtimeVoiceActive ? '🔊 实时语音对话' : '🎙️ 实时语音对话'}
          </button>
          {/* ── 💻 AI操作电脑 ── */}
          <button onClick={async () => {
            if (computerUseActive) {
              try { await window.luminaAPI?.agentStopComputerUse?.() } catch {}
              setComputerUseActive(false)
              showToast?.('💻 AI操作电脑已停止', 'info')
            } else {
              try {
                const r = await window.luminaAPI?.agentStartComputerUse?.()
                if (r?.success) { setComputerUseActive(true); showToast?.(r.message || '💻 AI操作电脑已就绪', 'info') }
                else { showToast?.(`⚠️ ${r?.error || '启动失败'}`, 'warning') }
              } catch (e: any) { showToast?.(`⚠️ ${e.message}`, 'warning') }
            }
          }}
            title={computerUseActive ? '停止 AI操作电脑' : '让 AI 操作你的电脑'}
            style={{
              padding: '4px 10px', borderRadius: 6,
              border: `1.5px solid ${computerUseActive ? '#a855f7' : 'var(--border-light)'}`,
              background: computerUseActive ? 'var(--accent-50)' : 'var(--surface-50)',
              cursor: 'pointer', fontSize: 12, display: 'flex',
              alignItems: 'center', gap: 3, fontFamily: 'inherit',
              boxShadow: computerUseActive ? '0 0 6px rgba(168,85,247,0.35)' : 'none',
            }}>
            {computerUseActive ? '💻 AI操作电脑' : '💻 AI操作电脑'}
          </button>
          {/* ── ⏳ 胶囊 ── */}
          <button onClick={() => {
            const text = input.trim()
            if (!text) { alert('输入你想对未来的自己说的话，然后点击 ⏳ 埋下时光胶囊'); return }
            if (window.confirm(`⏳ 埋一颗时光胶囊给未来的自己？\n\n内容: "${text.slice(0, 50)}${text.length > 50 ? '...' : ''}"\n\n默认 30 天后开启`)) {
              setInput(`帮我埋一颗时光胶囊，内容是：${text}，30天后开启`)
              setTimeout(() => { sendRef.current(); setInput('') }, 80)
            }
          }}
            title="埋时光胶囊 ⏳"
            style={{
              padding: '4px 10px', borderRadius: 6,
              border: '1.5px solid var(--border-light)',
              background: 'var(--surface-50)',
              cursor: 'pointer', fontSize: 12, display: 'flex',
              alignItems: 'center', gap: 3, fontFamily: 'inherit',
            }}>
            ⏳ 胶囊
          </button>

        </div>

        {/* 子智能体（实习生）进度卡片：入口条正下方，与单聊一致 */}
        <SubagentCards sessionId={activeSessionId} />
      </div>

      {/* ═══ v2.7.1: 状态栏（已移除重复TTS音色选择器）═══ */}
      <div style={{
        padding: '2px 12px 6px', display: 'flex', gap: 8, alignItems: 'center',
        fontSize: 10, color: 'var(--text-secondary)',
      }}>
        <span style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8 }}>
          {gcAttachments.length > 0 ? `📎 ${gcAttachments.length} 个文件待发送  ·  ` : ''}
          {sttListening ? `🎤 语音中${sttStatus?.error ? ' (出错)' : ''}  ·  ` : ''}
          Shift+Enter 换行 · /help 查看命令
          {/* 🔒 三档权限：与单聊共用同一个后端档位，改一处两边生效 */}
          <PermissionSelector perm={perm} onChange={setPermTier} />
        </span>
        {/* 🆕 上下文用量指示器 */}
        <ContextUsageIndicator />
      </div>
      </>
      )}
      </>
      )}
      {teamTab === 'tasks' && <AgentTaskBoard />}
      {teamTab === 'moments' && (
        <div style={{ flex: 1, overflow: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{
            borderRadius: 10, border: '1px solid var(--border-light)', padding: 0,
            background: 'var(--surface-0)', overflow: 'hidden', height: '100%',
          }}>
            <AgentMoments />
          </div>
        </div>
      )}
      {/* v2.14: 删除确认 */}
      {deletingTarget && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 100000,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(0,0,0,0.3)',
        }} onClick={() => setDeletingTarget(null)}>
          <div style={{
            background: 'var(--surface-0)', borderRadius: 14, padding: 24,
            minWidth: 280, maxWidth: 400,
            boxShadow: '0 8px 30px rgba(0,0,0,0.15)',
          }} onClick={e => e.stopPropagation()}>
            <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 8, color: 'var(--text-primary)' }}>
              🗑️ 删除消息
            </div>
            <div style={{
              fontSize: 12, color: 'var(--text-secondary)', marginBottom: 6,
              maxHeight: 80, overflow: 'hidden', lineHeight: 1.5,
            }}>
              {deletingTarget.content.slice(0, 150)}{deletingTarget.content.length > 150 ? '...' : ''}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 20 }}>
              确定要删除这条消息吗？
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setDeletingTarget(null)} style={{
                padding: '7px 16px', borderRadius: 8, border: '1px solid var(--border-light)',
                background: 'var(--surface-100)', cursor: 'pointer', fontSize: 13, color: 'var(--text-secondary)',
              }}>取消</button>
              <button onClick={handleDeleteConfirm} style={{
                padding: '7px 16px', borderRadius: 8, border: 'none',
                background: '#ef4444', cursor: 'pointer', fontSize: 13, fontWeight: 600,
                color: 'var(--surface-0)',
              }}>确认删除</button>
            </div>
          </div>
        </div>
      )}

      {/* 🍀 v1.0: Lucky 模式设置弹窗 */}
      {luckyMode.showSettings && (
        <LuckyModeSettings
          config={luckyMode.settings}
          onSave={(config: LuckySettingsConfig) => luckyMode.saveSettings(config)}
          onClose={() => luckyMode.setShowSettings(false)}
        />
      )}

      {/* 📋 任务派发中心弹窗 */}
      {showTaskDispatcher && (
        <TaskDispatcher
          onDispatch={handleTaskDispatch}
          onClose={() => setShowTaskDispatcher(false)}
        />
      )}
    </div>
  )
}

// 团队群聊角色回复生成
function generateTeamReply(userMsg: string, card: any, agent: any): string {
  const lower = userMsg.toLowerCase()
  const name = agent?.name || 'Lumina'
  const icon = agent?.icon || '🐱'

  if (lower.includes('你好') || lower.includes('hello') || lower.includes('hi')) {
    return `${icon} 嗨！我是 ${name}，${card.desc.split('、')[0]}方面的专家～\n\n有什么需要帮忙的？直接告诉我就好！`
  }

  // 根据角色类型给出不同风格的回复
  const roleReplies: Record<string, string[]> = {
    chat: [`${icon} 收到！有什么想聊的？我随时在线～`, `${icon} 好嘞～让我想想怎么帮你～`, `${icon} 来了来了！说说看～`],
    study: [`${icon} 好问题！让我帮你深入分析一下～`, `${icon} 这个知识点很重要，我来给你讲讲～`, `${icon} 学习模式启动！我们开始吧～`],
    writing: [`${icon} 写作任务收到！让我来帮你搞定～`, `${icon} 好的，我来帮你润色一下～`, `${icon} 创意模式开启！让我给你写点什么～`],
    code: [`${icon} 代码问题？让我看看～`, `${icon} 这个 bug 我来帮你找～`, `${icon} 技术问题交给我！让我分析一下～`],
    design: [`${icon} 设计需求收到！让我想想方案～`, `${icon} 审美在线！我来帮你设计～`, `${icon} 好的，让我给你一些建议～`],
    intel: [`${icon} 情报收集任务收到！让我看看～`, `${icon} 信息监控模式启动～`, `${icon} 好的，我来帮你分析一下～`],
    office: [`${icon} 办公任务收到！让我来处理～`, `${icon} 日程管理交给我～`, `${icon} 好的，我来帮你整理一下～`],
  }

  const replies = roleReplies[card.id] || roleReplies.chat
  const randomReply = replies[Math.floor(Math.random() * replies.length)]

  // 如果包含具体任务关键词，给出更具体的回复
  if (lower.includes('写') || lower.includes('代码') || lower.includes('bug')) {
    return `${randomReply}\n\n> 💡 你可以把具体需求或代码贴给我，我来帮你处理！`
  }
  if (lower.includes('分析') || lower.includes('学习') || lower.includes('讲解')) {
    return `${randomReply}\n\n> 💡 告诉我你想了解什么，我来帮你深入分析～`
  }

  return randomReply
}

function generateMockReply(name: string, userMsg: string): string {
  // v6.0: 未配 LLM 时只 Lumina 发声，引导配置
  const lower = userMsg.toLowerCase()
  if (lower.includes('你好') || lower.includes('hello') || lower.includes('hi')) {
    return '嗨！我是 Lumina ✨\n\n不过我还没有配置 LLM 大脑呢，现在只能做简单的预设回复 😴\n\n> 💡 去设置 → Agent 独立 LLM 配置 → 给 Lumina 填上 Endpoint 和 Model，我就能帮你做任何事了！'
  }
  if (lower.includes('代码') || lower.includes('bug') || lower.includes('编程') || lower.includes('写') || lower.includes('程序')) {
    return '唔…你想让我写代码对吧～不过我现在还没配置 LLM 大脑呢 😣\n\n等 Lumina 配置好后，我会把编程任务悄悄派给后台的热茶（代码工程师），写好后让 Yak（审查员）挑刺把关，最后把完美代码交给你！\n\n> 💡 先去设置里给 Lumina 配好 LLM 吧～'
  }
  return '嘿~ Lumina 在呢！不过我现在还是"离线模式"，只能做预设回复 😴\n\n想让我真正聪明起来？去设置里给 Lumina 配上 LLM 就好啦！\n\n> 💡 设置 → Agent 独立 LLM 配置 → Lumina 那一栏填 Endpoint 和 Model\n> 比如 LM Studio: `http://localhost:1234/v1` / `qwen2.5-32b-instruct`'
}

// ═══════════════════════════════════════════════════════════
// Component
// ═══════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════
// 群聊历史侧边?(独立组件，通过自定义事件通信)
// ═══════════════════════════════════════════════════════════

