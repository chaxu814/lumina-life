// ============================================================
// services/loopExecutor.ts — 真实 LLM 子任务执行器
//
// 把 Loop 子任务交给 LLM 执行，返回结构化产出。
// 被 loopStore.ts 在初始化时注入到 LoopEngine。
// ============================================================

import type { SubTask, LoopTask, LoopSubtaskResult } from './loopTypes'
import type { LoopExecutor } from './loopEngine'

/**
 * 创建真实 LLM 执行器。
 * @param getLLMConfig — 获取当前 LLM 配置的回调（动态读取，避免硬依赖）
 */
export function createLLMExecutor(
  getLLMConfig: () => { model: string; baseUrl: string; apiKey: string; temperature?: number; maxTokens?: number } | undefined,
): LoopExecutor {
  return async (subtask: SubTask, loop: LoopTask): Promise<LoopSubtaskResult> => {
    const config = getLLMConfig()
    if (!config || !config.apiKey) {
      return { ok: false, error: 'LLM 配置不可用（缺少 API Key）' }
    }

    // ── 构建上下文：前置已完成子任务的摘要 ──
    const prevContext = loop.progress.completed
      .map(id => loop.subtasks.find(s => s.id === id))
      .filter(Boolean)
      .map(s => `- ${s!.title}：${(s!.result || '').slice(0, 200)}`)
      .join('\n')

    const prompt = [
      `你正在执行一个自驱任务循环。目标：${loop.goal}`,
      prevContext ? `\n前置已完成任务：\n${prevContext}` : '',
      `\n当前任务：${subtask.title}`,
      `\n任务描述：${subtask.description}`,
      `\n请直接执行任务，给出结果。如果有产出物（链接、文件路径、数据），请明确列出。`,
    ].join('\n')

    try {
      const result = await (window as any).luminaAPI.agentChat({
        text: prompt,
        config: {
          mode: 'agent',
          model: config.model,
          baseUrl: config.baseUrl,
          apiKey: config.apiKey,
          temperature: config.temperature ?? 0.7,
          maxTokens: config.maxTokens ?? 2000,
          maxToolCalls: 5,
          systemPrompt: [
            '你是一个高效的任务执行助手。',
            '根据任务描述完成工作，直接给出结果。',
            '如果有产出物（链接、文件路径、数据摘要），请在结果中明确标注。',
            '保持简洁，重点突出。',
          ].join('\n'),
        },
        conversationHistory: [],
      })

      const content = result?.content || ''
      if (!content) {
        return { ok: false, error: 'LLM 返回空内容' }
      }

      return {
        ok: true,
        content: content.slice(0, 2000),
        artifacts: extractArtifacts(content),
      }
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e) }
    }
  }
}

/** 从 LLM 输出中提取产出物（URL、文件路径等） */
function extractArtifacts(text: string): string[] {
  const artifacts: string[] = []
  // URL
  const urlRe = /https?:\/\/[^\s)>\]]+/g
  let m: RegExpExecArray | null
  while ((m = urlRe.exec(text)) !== null) {
    artifacts.push(m[0])
  }
  // 文件路径（Windows / Unix）
  const fileRe = /(?:[A-Z]:\\[\w\\.\-]+|\/[\w/.\-]+\.\w{1,5})/g
  while ((m = fileRe.exec(text)) !== null) {
    if (!artifacts.includes(m[0])) {artifacts.push(m[0])}
  }
  return artifacts.slice(0, 5)
}
