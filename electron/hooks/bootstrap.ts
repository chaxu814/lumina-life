// ============================================================
// hooks/bootstrap.ts — 首次交互引导 Hook (v3.5)
//
// 借鉴 QwenPaw BootstrapHook:
//   检测 BOOTSTRAP.md → 首次用户交互时注入引导提示
//   帮助 Agent 建立身份认同和用户偏好
// ============================================================

import * as fs from 'fs'
import * as path from 'path'
import type { HookRegistration, BeforeReasoningInput } from './types'

const BOOTSTRAP_FILE = 'BOOTSTRAP.md'
const BOOTSTRAP_FLAG = '.bootstrap_completed'

export function createBootstrapHook(workingDir: string): HookRegistration {
  const bootstrapPath = path.join(workingDir, BOOTSTRAP_FILE)
  const flagPath = path.join(workingDir, BOOTSTRAP_FLAG)

  return {
    id: 'core.bootstrap',
    name: '首次引导',
    description: '首次用户交互时读取 BOOTSTRAP.md 并注入引导',
    priority: 'highest',
    enabled: true,

    async beforeReasoning(input: BeforeReasoningInput) {
      // 已完成的跳过
      if (fs.existsSync(flagPath)) {return}
      // 文件不存在跳过（但标记已完成避免重复检测）
      if (!fs.existsSync(bootstrapPath)) {
        fs.writeFileSync(flagPath, new Date().toISOString())
        return
      }
      // 不是首次用户交互则跳过
      const userMsgs = input.ctx.messages.filter(m => m.role === 'user')
      if (userMsgs.length > 1) {return}

      try {
        const content = fs.readFileSync(bootstrapPath, 'utf-8').trim()
        if (!content) {
          fs.writeFileSync(flagPath, new Date().toISOString())
          return
        }

        // 在 system prompt 中注入引导
        const systemMsg = input.messages.find(m => m.role === 'system')
        if (systemMsg) {
          systemMsg.content = `${systemMsg.content}\n\n---\n## 首次启动引导 (BOOTSTRAP.md)\n${content}\n\n请根据以上引导建立你的身份和交互风格。完成后回复用户即可。`
        }

        console.log('[BootstrapHook] ✅ 已注入首次引导 (~' + content.length + ' 字符)')
      } catch (err: any) {
        console.warn('[BootstrapHook] 读取 BOOTSTRAP.md 失败:', err.message)
      }

      // 标记已完成
      fs.writeFileSync(flagPath, new Date().toISOString())
    },
  }
}
