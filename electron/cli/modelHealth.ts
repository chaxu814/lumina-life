// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// cli/modelHealth.ts — `lumina health` 命令（2026-10-05）
//
// 【为什么单独开一个命令，而不是并进 doctor】
// `lumina doctor` 查的是「环境是否正常」（Node 版本、内存、端口）。
// 而本命令查的是「【这个模型】能不能好好用」—— 上下文窗口对不对、
// 工具能不能调、能不能看图。
// 两者回答的是不同问题：前者是「装好了吗」，后者是「能用吗」。
// 用户抱怨「Lumina 很卡 / 工具不灵」时，要看的是后者。
//
// 【为什么这件事值得单独做】
// 深度评测发现最高频的故障是「上下文窗口填得比模型实际能吃的大」，
// 而这个问题在旧版本里【既不报错也不裁剪】—— 用户只能自己猜。
// 有了这条命令，用户第一件事就能得到一句人话结论。
// ============================================================

import { buildModelHealthReport, formatHealthReportText } from '../core/modelHealthReport'
import { recallServerFacts } from '../core/modelServerFacts'
import { getModelCapabilityCache } from '../modelCapabilityCache'
import { isLocalEndpoint } from '../core/modelCompat'
import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'

/**
 * 读取当前 LLM 配置。
 * 走与 GUI 相同的配置来源，避免 CLI 与界面看到不同的模型。
 */
function readLlmConfig(): { model: string; baseUrl: string; contextWindow: number } | null {
  const candidates: string[] = []
  // dev 模式：仓库根目录
  candidates.push(path.join(process.cwd(), '.env'))
  candidates.push(path.join(process.cwd(), 'userData', 'config.json'))
  // 打包后：userData 目录
  try {
    const userDir = (app as any)?.getPath?.('userData')
    if (userDir) {
      candidates.push(path.join(userDir, 'config.json'))
      candidates.push(path.join(userDir, '.env'))
    }
  } catch { /* 非 Electron 环境取不到 userData */ }

  for (const f of candidates) {
    try {
      if (!fs.existsSync(f)) {continue}
      const raw = fs.readFileSync(f, 'utf-8')

      if (f.endsWith('.json')) {
        const j = JSON.parse(raw)
        const llm = j.llm || j
        const model = llm.model || j.model
        const baseUrl = llm.baseUrl || llm.endpoint || j.baseUrl
        if (model && baseUrl) {
          return {
            model: String(model),
            baseUrl: String(baseUrl),
            contextWindow: Number(llm.contextWindow || j.contextWindow || 0) || 0,
          }
        }
      } else {
        // .env
        const pick = (k: string): string | null => {
          const m = new RegExp(`^\\s*${k}\\s*=\\s*["']?([^"'\\r\\n]+)`, 'm').exec(raw)
          return m ? m[1].trim() : null
        }
        const model = pick('LLM_MODEL') || pick('MODEL')
        const baseUrl = pick('LLM_BASE_URL') || pick('LLM_ENDPOINT') || pick('OPENAI_BASE_URL')
        if (model && baseUrl) {
          return {
            model,
            baseUrl,
            contextWindow: Number(pick('LLM_CONTEXT_WINDOW') || '0') || 0,
          }
        }
      }
    } catch { /* 该文件不是合法配置，继续下一个 */ }
  }
  return null
}

export async function handleModelHealth(_args: string[]): Promise<{ ok: boolean; data?: any; error?: string }> {
  // 命令行可覆盖：lumina health --model X --baseUrl Y --context N
  const args = _args
  const opt = (name: string): string | null => {
    const i = args.indexOf(`--${name}`)
    return i >= 0 && i + 1 < args.length ? args[i + 1] : null
  }

  const cfg = readLlmConfig()
  let model = opt('model') || cfg?.model
  let baseUrl = opt('baseUrl') || cfg?.baseUrl

  // 2026-10-19：.env 里通常只有 provider + API Key（没有 LLM_MODEL/LLM_BASE_URL），
  // 于是 health 直接报「未能读取到 LLM 配置」——但应用/doctor 明明认识这套配置。
  // 回退到 Agent 配置（与 doctor、应用内同一事实源），取第一个已配置的 Agent。
  if (!model || !baseUrl) {
    try {
      const { getAgentConfig } = await import('../agentConfig')
      const mgr = getAgentConfig()
      for (const id of ['lumina', 'yak', 'recha'] as const) {
        const c = mgr.get(id)
        if (c?.model && c?.endpoint) {
          model = model || c.model
          baseUrl = baseUrl || c.endpoint
          break
        }
      }
    } catch { /* Agent 配置不可读时继续走下面的报错分支 */ }
  }

  if (!model || !baseUrl) {
    const msg = [
      '未能读取到 LLM 配置。',
      '',
      '请任选一种方式指定：',
      '  lumina health --model <模型名> --baseUrl <API 地址>',
      '  或在应用内「设置 → LLM 配置」里配置一个可用模型（推荐，health/doctor 会自动复用）',
      '',
      `已尝试读取的位置：\n  ${path.join(process.cwd(), '.env')}\n  ${path.join(process.cwd(), 'userData', 'config.json')}\n  Agent 配置（lumina / yak / recha）`,
    ].join('\n')
    return { ok: false, error: msg }
  }

  const contextWindow = Number(opt('context') || cfg?.contextWindow || 0) || 0

  try {
    const report = buildModelHealthReport({ modelName: model, baseUrl, userContextWindow: contextWindow })

    // 纯 CLI 下服务端事实通常还没探测过（探测发生在 GUI 启动的模型发现流程）。
    // 这里如实告知「哪些结论是猜的」，而不是假装权威。
    const hasServerFacts = !!recallServerFacts(model)
    const runtime = getModelCapabilityCache().get(model)

    const lines: string[] = []
    lines.push(formatHealthReportText(report))
    lines.push('')
    lines.push('─'.repeat(48))
    if (!hasServerFacts) {
      lines.push(
        'ℹ️  本次未读取到服务端上报的模型信息（通常是因为 GUI 尚未完成一次模型发现）。',
        '   上下文窗口等字段此时来自按模型名推测，仅供参考。',
        '   要拿到权威值：先在 GUI 里保存一次模型配置，或直接用 --context 指定。',
      )
    }
    if (!runtime) {
      lines.push(
        'ℹ️  尚未积累运行时实测数据 —— 工具/视觉能力结论来自模型名推测，首次调用后才能确认。',
      )
    }
    if (!isLocalEndpoint(baseUrl)) {
      lines.push('ℹ️  正在体检云端模型（云端并发与配额不受本地限制影响）。')
    }

    // ok 的判定：只要没有 blocker 就算通过 —— notice 是优化建议，不是故障
    return {
      ok: report.level !== 'blocker',
      data: {
        report,
        text: lines.join('\n'),
      },
    }
  } catch (err: any) {
    return { ok: false, error: `生成体检报告失败: ${err?.message || err}` }
  }
}
