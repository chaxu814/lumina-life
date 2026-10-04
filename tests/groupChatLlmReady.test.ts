// 复现「本地 LLM 明明配好了，黄色提示框还在 + Agent 退回模拟话术」
//
// 根因：llmReady 判据是 `!!(model && apiKey)`，强制要求 API Key。
// 但 LM Studio / Ollama 走 localhost，本地根本不存在 Key —— 于是
// `apiKey: ''` + `model: 'qwen2.5:7b'` + `baseUrl: 'http://127.0.0.1:1234/v1'`
// 这个完全正常的配置被判成「未配置」。
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

const src = fs.readFileSync(
  path.join(process.cwd(), 'src', 'panels', 'GroupChatView.tsx'),
  'utf-8',
)

describe('群聊 LLM 就绪判据', () => {
  it('不再强制要求 apiKey（本地模型没有 Key）', () => {
    // 旧写法：llmReady = !!(llmConfig.model && llmConfig.apiKey)
    expect(src).not.toMatch(/const llmReady\s*=\s*!!\(llmConfig\.model\s*&&\s*llmConfig\.apiKey\)/)
  })

  it('llmConfigured 允许「本地 + 有模型」而没有 Key', () => {
    // isLocalLLM || apiKey：任一成立即视为「配了」
    expect(src).toMatch(/const llmConfigured = !!\(llmConfig\.model && \(llmConfig\.apiKey \|\| isLocalLLM\)\)/)
  })

  it('本地模型额外要求真的加载了；探测未完成时不阻塞', () => {
    // null（探测中）不能判为未就绪，否则刚打开界面会闪一下「模拟模式」
    expect(src).toMatch(/const llmReady = llmConfigured && \(isLocalLLM \? localModelReady !== false : true\)/)
  })

  it('探测 effect 依赖 llmConfigured 而不是 llmReady（避免自引用）', () => {
    const dep = src.slice(src.indexOf('probeLocal().then((ready) => { if (alive)'))
    const line = dep.split('\n').slice(0, 4).join('\n')
    expect(line).toMatch(/\}, \[llmConfigured, isLocalLLM, llmConfig\.baseUrl\]\)/)
  })

  it('探测与「重新检测」按钮共用同一套判定', () => {
    expect(src).toMatch(/const probeLocal = \(\) => \{/)
    expect(src).toMatch(/const retryLocalDetect = \(\) => \{ probeLocal\(\)/)
  })

  it('本地未就绪时文案不再误导用户去填 API Key', () => {
    // 走到黄色框的本地分支时，缺的是「模型没加载」，不是 Key
    expect(src).toMatch(/本地模型不需要 API Key/)
    expect(src).toMatch(/isLocalLLM\s*\n?\s*\?/)
  })

  it('两个提示框都给了「去设置」/「重新检测」入口', () => {
    expect(src).toMatch(/⚙️ 去设置/)
    expect(src).toMatch(/↻ 重新检测/)
  })

  it('云端判据未被改坏（仍按 sk- / openai / moonshot / deepseek 识别）', () => {
    expect(src).toMatch(/isCloudAPI = llmConfig\.apiKey\?\.startsWith\('sk-'\)/)
    expect(src).toMatch(/api\.deepseek/)
  })
})
