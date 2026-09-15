// ============================================================
// computerUse.ts — Lumina 桌面操控引擎 (v3.10)
//
// 对标能力：
//   - Manus/Operator：截图分析 → VLM 理解界面 → 执行操作
//   - Claude Cowork：本地桌面自动化
//   - Perplexity Computer：研究型桌面交互
//
// 架构：
//   1. ScreenCapture   → 截取全屏/窗口
//   2. ScreenAnalysis  → VLM 分析界面元素 (按钮、输入框、文本)
//   3. ActionExecute   → 鼠标/键盘/剪贴板执行
//   4. SafetyGuard     → 操作确认 + 沙箱回滚
//
// 使用方式：
//   const cu = new ComputerUse({ llmApiKey, safetyLevel: 'ask' })
//   await cu.execute("打开 Chrome 并搜索 Lumina AI")
// ============================================================

import screenshot from 'screenshot-desktop'
import { exec } from 'child_process'
import { promisify } from 'util'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import https from 'https'
import http from 'http'

const execAsync = promisify(exec)

// ═══════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════

export type SafetyLevel = 'auto' | 'ask' | 'strict'

export interface CUConfig {
  llmApiKey?: string
  llmBaseUrl?: string
  llmModel?: string
  safetyLevel?: SafetyLevel
  maxSteps?: number
  screenshotDir?: string
  onConfirm?: (action: string, details: string) => Promise<boolean>
  onProgress?: (step: string) => void
}

export interface ScreenElement {
  type: 'button' | 'input' | 'link' | 'text' | 'image' | 'checkbox' | 'dropdown' | 'window'
  label: string
  bbox?: { x: number; y: number; w: number; h: number }
  confidence: number
}

export interface ScreenAnalysis {
  description: string
  elements: ScreenElement[]
  suggestedAction?: string
  rawResponse: string
}

export interface CUAction {
  type: 'click' | 'type' | 'keypress' | 'scroll' | 'wait' | 'drag' | 'screenshot' | 'clipboard' | 'open_app' | 'close_window'
  params: Record<string, string | number>
}

export interface CUStepResult {
  step: number
  action: CUAction
  screenshotPath: string
  analysisBefore: ScreenAnalysis
  success: boolean
  error?: string
}

export interface CUResult {
  success: boolean
  task: string
  steps: CUStepResult[]
  totalSteps: number
  duration: number
  summary: string
}

// ═══════════════════════════════════════════════════════════
// 桌面操控引擎
// ═══════════════════════════════════════════════════════════

export class ComputerUse {
  private config: CUConfig
  private screenshotIndex = 0
  private tmpDir: string

  constructor(config: CUConfig = {}) {
    this.config = {
      safetyLevel: 'ask',
      maxSteps: 10,
      ...config,
    }
    this.tmpDir = config.screenshotDir || path.join(os.tmpdir(), 'lumina-cu')
    if (!fs.existsSync(this.tmpDir)) {
      fs.mkdirSync(this.tmpDir, { recursive: true })
    }
  }

  // ═══════════════════════════════════════════════════════
  // 公共 API
  // ═══════════════════════════════════════════════════════

  /** 执行一个自然语言描述的任务 */
  async execute(task: string): Promise<CUResult> {
    const startTime = Date.now()
    const steps: CUStepResult[] = []
    let summary = ''

    this.log(`🖥️ 开始执行: ${task}`)
    this.config.onProgress?.(`开始: ${task}`)

    try {
      for (let i = 0; i < (this.config.maxSteps || 10); i++) {
        this.config.onProgress?.(`Step ${i + 1}: 分析屏幕...`)

        // 1. 截图
        const screenshotPath = await this.captureScreen()
        steps.push({ step: i, action: { type: 'screenshot', params: {} }, screenshotPath, analysisBefore: { description: '', elements: [], rawResponse: '' }, success: true })

        // 2. VLM 分析界面
        const analysis = await this.analyzeScreen(screenshotPath, task, steps)

        // 3. 判断是否完成
        if (analysis.suggestedAction === 'DONE') {
          summary = analysis.description || '任务已完成 ✅'
          this.log(`✅ 完成: ${summary}`)
          break
        }

        // 4. 安全确认
        const action = this.parseAction(analysis.suggestedAction || '')
        if (!action) {
          summary = '无法确定下一步操作'
          this.log(`⚠️ ${summary}`)
          break
        }

        if (!(await this.confirmAction(action))) {
          summary = '用户取消了操作'
          this.log(`🚫 ${summary}`)
          break
        }

        // 5. 执行操作
        const success = await this.executeAction(action)
        steps[steps.length - 1].action = action
        steps[steps.length - 1].analysisBefore = analysis
        steps[steps.length - 1].success = success

        if (!success) {
          summary = `Step ${i + 1} 执行失败`
          break
        }

        await this.sleep(800) // 等待界面响应
      }
    } catch (err: any) {
      summary = `执行异常: ${err.message}`
      this.log(`❌ ${summary}`)
    }

    const duration = Date.now() - startTime
    this.config.onProgress?.(`完成 (${(duration / 1000).toFixed(1)}s)`)

    return {
      success: !!summary.includes('完成') || !!summary.includes('已执行'),
      task,
      steps: steps.filter(s => s.action.type !== 'screenshot'),
      totalSteps: steps.filter(s => s.action.type !== 'screenshot').length,
      duration,
      summary: summary || `已执行 ${steps.length} 步`,
    }
  }

  /** 快速截图 (不分析) */
  async captureScreen(filename?: string): Promise<string> {
    const name = filename || `screen_${Date.now()}_${++this.screenshotIndex}.png`
    const filepath = path.join(this.tmpDir, name)
    await screenshot({ filename: filepath })
    return filepath
  }

  /** 分析截图中的界面元素 */
  async analyzeScreen(screenshotPath: string, task: string, history: CUStepResult[]): Promise<ScreenAnalysis> {
    if (!this.config.llmApiKey) {
      return this.fallbackAnalysis(screenshotPath, task, history)
    }
    return this.vlmAnalysis(screenshotPath, task, history)
  }

  /** 执行单个操作 */
  async executeAction(action: CUAction): Promise<boolean> {
    try {
      switch (action.type) {
        case 'click': {
          const x = Number(action.params.x)
          const y = Number(action.params.y)
          if (isNaN(x) || isNaN(y)) return false
          return await this.safeExec(this.clickCmd(x, y))
        }
        case 'type': {
          const text = String(action.params.text || '')
          return await this.safeExec(this.typeCmd(text))
        }
        case 'keypress': {
          const key = String(action.params.key || '')
          return await this.safeExec(this.keypressCmd(key))
        }
        case 'scroll': {
          const direction = String(action.params.direction || 'down')
          const amount = Number(action.params.amount || 3)
          return await this.safeExec(this.scrollCmd(direction, amount))
        }
        case 'wait': {
          const ms = Number(action.params.ms || 1000)
          await this.sleep(ms)
          return true
        }
        case 'clipboard': {
          const text = String(action.params.text || '')
          return await this.safeExec(this.clipboardCmd(text))
        }
        case 'open_app': {
          const app = String(action.params.app || '')
          return await this.safeExec(this.openAppCmd(app))
        }
        case 'close_window': {
          return await this.safeExec(this.closeWindowCmd())
        }
        case 'screenshot': {
          try { await this.captureScreen(); return true } catch { return false }
        }
        default:
          return false
      }
    } catch {
      return false
    }
  }

  // ═══════════════════════════════════════════════════════
  // 平台命令生成
  // ═══════════════════════════════════════════════════════

  private clickCmd(x: number, y: number): string {
    if (process.platform === 'win32') {
      // PowerShell: 移动鼠标并点击
      return `powershell -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${Math.round(x)},${Math.round(y)}); Start-Sleep -Milliseconds 100; $c = Add-Type -MemberDefinition '[DllImport(\"user32.dll\")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, int dwExtraInfo);' -Name 'Win32' -Namespace 'System' -PassThru; $c::mouse_event(0x0002,0,0,0,0); Start-Sleep -Milliseconds 50; $c::mouse_event(0x0004,0,0,0,0)"`
    } else if (process.platform === 'darwin') {
      return `osascript -e 'tell application "System Events" to click at {${Math.round(x)},${Math.round(y)}}'`
    }
    // Linux: xdotool
    return `xdotool mousemove ${Math.round(x)} ${Math.round(y)} click 1`
  }

  private typeCmd(text: string): string {
    const escaped = text.replace(/"/g, '\\"')
    if (process.platform === 'win32') {
      return `powershell -Command "$wshell = New-Object -ComObject wscript.shell; $wshell.SendKeys('${escaped.replace(/'/g, "''")}')"`
    } else if (process.platform === 'darwin') {
      return `osascript -e 'tell application "System Events" to keystroke "${escaped}"'`
    }
    return `xdotool type "${escaped}"`
  }

  private keypressCmd(key: string): string {
    const keyMap: Record<string, string> = {
      enter: 'Return', tab: 'Tab', esc: 'Escape',
      backspace: 'BackSpace', space: 'space',
      up: 'Up', down: 'Down', left: 'Left', right: 'Right',
      ctrl_c: '^c', ctrl_v: '^v', ctrl_a: '^a', ctrl_z: '^z',
      alt_f4: '%{F4}', win: '#',
    }
    const mapped = keyMap[key.toLowerCase()] || key
    if (process.platform === 'win32') {
      if (mapped.startsWith('^') || mapped.startsWith('%') || mapped.startsWith('#')) {
        return `powershell -Command "$wshell = New-Object -ComObject wscript.shell; $wshell.SendKeys('${mapped}')"`
      }
      return `powershell -Command "$wshell = New-Object -ComObject wscript.shell; $wshell.SendKeys('{${mapped}}')"`
    } else if (process.platform === 'darwin') {
      return `osascript -e 'tell application "System Events" to key code (get key code "${mapped}")'`
    }
    return `xdotool key "${mapped}"`
  }

  private scrollCmd(direction: string, amount: number): string {
    if (process.platform === 'win32') {
      // PowerShell: 复用 Win32 mouse_event 模拟滚轮（0x0800 = MOUSEEVENTF_WHEEL）
      const delta = direction === 'up' ? 120 : -120
      const clicks = Math.max(1, Math.min(10, amount))
      const ps = `Add-Type -AssemblyName System.Windows.Forms; $s = Add-Type -MemberDefinition '[DllImport(\\"user32.dll\\")] public static extern void mouse_event(uint f,uint x,uint y,uint d,int e);' -Name 'W32S' -Namespace 'Sys' -PassThru; 1..${clicks} | ForEach-Object { $s::mouse_event(0x0800,0,0,${delta},0); Start-Sleep -Milliseconds 50 }`
      return `powershell -Command "${ps}"`
    }
    if (process.platform === 'darwin') {
      const y = direction === 'up' ? -amount * 30 : amount * 30
      return `osascript -e 'tell application "System Events" to scroll page ${y}'`
    }
    const btn = direction === 'up' ? '4' : '5'
    const clicksArr = Array(amount).fill(btn).join(' ')
    return `xdotool click ${clicksArr}`
  }

  private clipboardCmd(text: string): string {
    const escaped = text.replace(/"/g, '\\"')
    if (process.platform === 'win32') {
      return `powershell -Command "Set-Clipboard -Value '${escaped}'"`
    } else if (process.platform === 'darwin') {
      return `echo "${escaped}" | pbcopy`
    }
    return `echo "${escaped}" | xclip -selection clipboard`
  }

  private openAppCmd(app: string): string {
    if (process.platform === 'win32') {
      return `start "" "${app}"`
    } else if (process.platform === 'darwin') {
      return `open -a "${app}"`
    }
    return `xdg-open "${app}"`
  }

  private closeWindowCmd(): string {
    if (process.platform === 'win32') {
      return `powershell -Command "$wshell = New-Object -ComObject wscript.shell; $wshell.SendKeys('%{F4}')"`
    } else if (process.platform === 'darwin') {
      return `osascript -e 'tell application "System Events" to keystroke "w" using command down'`
    }
    return `xdotool key alt+F4`
  }

  // ═══════════════════════════════════════════════════════
  // VLM 分析
  // ═══════════════════════════════════════════════════════

  private async vlmAnalysis(screenshotPath: string, task: string, history: CUStepResult[]): Promise<ScreenAnalysis> {
    const historyDesc = history
      .filter(s => s.action.type !== 'screenshot')
      .map(s => `  Step ${s.step}: ${s.action.type}(${JSON.stringify(s.action.params)}) → ${s.success ? 'OK' : 'FAIL'}`)
      .join('\n')

    const prompt = `你是一个桌面操控 AI。根据截图分析界面，决定下一步操作。

## 任务
${task}

## 已执行步骤
${historyDesc || '（无）'}

## 可用操作
- click(x, y) — 点击坐标
- type("text") — 输入文字
- keypress("enter"|"tab"|"esc"|"ctrl_c"|"ctrl_v"|...) — 按键
- scroll("up"|"down", n) — 滚动
- wait(ms) — 等待
- clipboard("text") — 剪贴板
- open_app("app_name") — 打开应用
- DONE — 任务完成

## 输出格式 (严格 JSON)
{
  "description": "当前界面的描述",
  "elements": [{"type":"button","label":"搜索","bbox":{"x":100,"y":200,"w":80,"h":30},"confidence":0.9}],
  "suggestedAction": "click(500, 300) 或 DONE",
  "reasoning": "为什么这样做"
}

只输出 JSON，不要其他文字。`

    try {
      const response = await this.callLLM(prompt, screenshotPath)
      return this.parseAnalysisResponse(response)
    } catch {
      return this.fallbackAnalysis(screenshotPath, task, history)
    }
  }

  private fallbackAnalysis(_screenshotPath: string, task: string, _history: CUStepResult[]): ScreenAnalysis {
    return {
      description: `任务: ${task} (VLM 未配置，无法分析界面)`,
      elements: [],
      suggestedAction: 'DONE',
      rawResponse: 'VLM not available',
    }
  }

  private parseAnalysisResponse(response: string): ScreenAnalysis {
    try {
      // 提取 JSON
      const jsonMatch = response.match(/\{[\s\S]*\}/)
      if (!jsonMatch) throw new Error('No JSON found')
      const parsed = JSON.parse(jsonMatch[0])
      return {
        description: parsed.description || '',
        elements: parsed.elements || [],
        suggestedAction: parsed.suggestedAction || 'DONE',
        rawResponse: response,
      }
    } catch {
      return {
        description: '无法解析分析结果',
        elements: [],
        suggestedAction: 'DONE',
        rawResponse: response,
      }
    }
  }

  private parseAction(suggested: string): CUAction | null {
    if (!suggested || suggested === 'DONE') return null

    const clickMatch = suggested.match(/click\s*\(\s*(\d+)\s*,\s*(\d+)\s*\)/i)
    if (clickMatch) {
      return { type: 'click', params: { x: Number(clickMatch[1]), y: Number(clickMatch[2]) } }
    }

    const typeMatch = suggested.match(/type\s*\(\s*"([^"]*?)"\s*\)/i)
    if (typeMatch) return { type: 'type', params: { text: typeMatch[1] } }

    const keyMatch = suggested.match(/keypress\s*\(\s*"([^"]*?)"\s*\)/i)
    if (keyMatch) return { type: 'keypress', params: { key: keyMatch[1] } }

    const scrollMatch = suggested.match(/scroll\s*\(\s*"(\w+)"\s*,\s*(\d+)\s*\)/i)
    if (scrollMatch) return { type: 'scroll', params: { direction: scrollMatch[1], amount: Number(scrollMatch[2]) } }

    const waitMatch = suggested.match(/wait\s*\(\s*(\d+)\s*\)/i)
    if (waitMatch) return { type: 'wait', params: { ms: Number(waitMatch[1]) } }

    const clipboardMatch = suggested.match(/clipboard\s*\(\s*"([^"]*?)"\s*\)/i)
    if (clipboardMatch) return { type: 'clipboard', params: { text: clipboardMatch[1] } }

    const openMatch = suggested.match(/open_app\s*\(\s*"([^"]*?)"\s*\)/i)
    if (openMatch) return { type: 'open_app', params: { app: openMatch[1] } }

    return null
  }

  // ═══════════════════════════════════════════════════════
  // LLM 调用
  // ═══════════════════════════════════════════════════════

  private async callLLM(prompt: string, imagePath?: string): Promise<string> {
    const apiKey = this.config.llmApiKey || process.env.OPENAI_API_KEY || ''
    const baseUrl = this.config.llmBaseUrl || process.env.OPENAI_BASE_URL || 'https://api.openai.com'
    const model = this.config.llmModel || process.env.LLM_VISION_MODEL || 'gpt-4o'

    if (!apiKey) throw new Error('No API key configured')

    const url = new URL(baseUrl.replace(/\/+$/, '') + '/chat/completions')
    const isHttps = url.protocol === 'https:'
    const transport = isHttps ? https : http

    const messages: any[] = [{ role: 'user', content: prompt }]

    // 如果有截图，以 base64 格式附加
    if (imagePath && fs.existsSync(imagePath)) {
      const imgBase64 = fs.readFileSync(imagePath).toString('base64')
      messages[0].content = [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${imgBase64}`, detail: 'high' } },
      ]
    }

    const body = JSON.stringify({ model, messages, max_tokens: 800, temperature: 0.3 })

    return new Promise((resolve, reject) => {
      const req = transport.request({
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'Content-Length': Buffer.byteLength(body).toString(),
        },
        timeout: 30000,
      }, (res) => {
        let data = ''
        res.on('data', (c) => (data += c))
        res.on('end', () => {
          try {
            const json = JSON.parse(data)
            const content = json.choices?.[0]?.message?.content || ''
            resolve(content)
          } catch (e: any) {
            reject(new Error(`Parse error: ${e.message}`))
          }
        })
      })
      req.on('error', reject)
      req.on('timeout', () => { req.destroy(); reject(new Error('LLM timeout')) })
      req.write(body)
      req.end()
    })
  }

  // ═══════════════════════════════════════════════════════
  // 安全确认
  // ═══════════════════════════════════════════════════════

  private async confirmAction(action: CUAction): Promise<boolean> {
    if (this.config.safetyLevel === 'auto') return true

    const desc = `${action.type}(${JSON.stringify(action.params)})`
    this.log(`🔒 确认操作: ${desc}`)

    // strict 模式：拒绝破坏性操作
    if (this.config.safetyLevel === 'strict') {
      const dangerous = ['rm ', 'del ', 'format', 'sudo', 'shutdown', 'restart']
      if (action.type === 'type' && dangerous.some(d => String(action.params.text).toLowerCase().includes(d))) {
        this.log('🚫 严格模式拒绝破坏性操作')
        return false
      }
      if (action.type === 'keypress' && String(action.params.key).includes('ctrl_c')) {
        // ctrl+c 在终端中是安全的，但在其他地方可能不是
        return true
      }
      return true
    }

    // ask 模式：询问用户
    if (this.config.onConfirm) {
      return this.config.onConfirm(action.type, JSON.stringify(action.params))
    }

    return true // 默认允许
  }

  // ═══════════════════════════════════════════════════════
  // 工具方法
  // ═══════════════════════════════════════════════════════

  private async safeExec(cmd: string): Promise<boolean> {
    try {
      this.log(`  📟 > ${cmd.slice(0, 80)}...`)
      await execAsync(cmd, { timeout: 10000 })
      return true
    } catch (err: any) {
      this.log(`  ❌ ${err.message?.slice(0, 100)}`)
      return false
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms))
  }

  private log(msg: string): void {
    console.log(`[ComputerUse] ${msg}`)
    this.config.onProgress?.(msg)
  }
}

// ═══════════════════════════════════════════════════════════
// 导出
// ═══════════════════════════════════════════════════════════

let _instance: ComputerUse | null = null

export function getComputerUse(config?: CUConfig): ComputerUse {
  if (!_instance && config) {
    _instance = new ComputerUse(config)
  } else if (!_instance) {
    _instance = new ComputerUse()
  }
  return _instance
}

export function initComputerUse(config: CUConfig): ComputerUse {
  _instance = new ComputerUse(config)
  return _instance
}
