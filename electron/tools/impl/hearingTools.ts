// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// impl/hearingTools.ts — 听觉系统工具 (v2.5)
// ============================================================

import type { ToolDef, ToolResult } from '../types'
import { getHearingManager } from '../../hearingManager'

export const hearingDefs: Array<{ def: ToolDef; handler: (args: Record<string, any>) => Promise<ToolResult> }> = [
  {
    def: {
      name: 'hearing_start',
      description: `启动听觉系统，开始监听麦克风/系统音频。

参数:
- mode: 听觉模式 ("dictation" 语音输入 / "passive" 陪伴监听 / "summary" 总结模式, 默认 "passive")
- source: 音频源 ("mic" 麦克风 / "system" 系统音频 / "both", 默认 "mic")

使用场景:
- "dictation": 用户想用语音输入时，转录结果自动发送给AI
- "passive": AI 陪伴模式，AI 可以通过 hearing_transcript 查看近期听到的内容
- "summary": 停止时自动提供完整转录给 AI 总结`,
      params: {
        mode: { type: 'string', description: '听觉模式', required: false },
        source: { type: 'string', description: '音频源', required: false },
      },
      toolsets: ['hearing', 'agent'],
    },
    handler: async (args) => {
      const hearing = getHearingManager()
      try {
        const status = await hearing.start(
          (args.mode as any) || 'passive',
          (args.source as any) || 'mic'
        )
        return { callId: '', ok: true, content: status }
      } catch (err: any) {
        return { callId: '', ok: false, content: '', error: err.message }
      }
    },
  },
  {
    def: {
      name: 'hearing_stop',
      description: '停止听觉系统',
      params: {},
      toolsets: ['hearing', 'agent'],
    },
    handler: async () => {
      getHearingManager().stop()
      return { callId: '', ok: true, content: '听觉系统已停止' }
    },
  },
  {
    def: {
      name: 'hearing_status',
      description: '获取听觉系统当前状态 (是否活跃、模式、转录计数等)',
      params: {},
      toolsets: ['hearing', 'agent'],
    },
    handler: async () => {
      const status = getHearingManager().getStatus()
      return {
        callId: '',
        ok: true,
        content: `🎤 听觉系统: ${status.active ? '✅ 活跃' : '❌ 未启动'}
模式: ${status.mode}
音源: ${status.source || '无'}
转录数: ${status.transcriptionCount}
STT服务: ${status.sttServerRunning ? '✅' : '❌'}`,
      }
    },
  },
  {
    def: {
      name: 'hearing_transcript',
      description: `获取听觉转录文本。在 passive 或 summary 模式下，AI 可主动读取听到的内容。

参数:
- mode: "full" 获取全部 / "recent" 最近内容 (默认 "recent")
- seconds: 最近多少秒的内容 (默认 60)
- max_sentences: 最多返回几句 (默认 5)`,
      params: {
        mode: { type: 'string', description: '获取模式', required: false },
        seconds: { type: 'number', description: '最近秒数', required: false },
        max_sentences: { type: 'number', description: '最多句子数', required: false },
      },
      toolsets: ['hearing', 'agent'],
    },
    handler: async (args) => {
      const hearing = getHearingManager()
      const text = hearing.getTranscript({
        mode: args.mode as any || 'recent',
        seconds: (args.seconds as number) || 60,
        maxSentences: (args.max_sentences as number) || 5,
      })
      return {
        callId: '',
        ok: true,
        content: text ? `🎤 转录内容:\n${text}` : '（暂无转录内容）',
      }
    },
  },
]
