// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// computerUse.ts — Lumina 桌面操控引擎 (IPC 外壳, v3.20)
//
// v3.20 起，键鼠执行 / 视觉配置 / 中文输入 / 高危拦截 / 急停全部统一到
//       electron/tools/impl/cuCore.ts（与 agent 工具 desktop_act 同一内核）。
//       本类只保留 IPC 需要的外壳：截图落盘、VLM 分析协议、单步 executeAction、
//       多步 execute 编排、安全确认与单例管理。
//
// 架构：
//   1. ScreenCapture   → 截取全屏/窗口（captureScreen）
//   2. ScreenAnalysis  → VLM 分析界面元素（analyzeScreen）
//   3. ActionExecute   → 统一内核 executeCuAction / cuOpenApp / cuSetClipboard
//   4. SafetyGuard     → 操作确认 + 内核高危硬拦截 + 全局急停 Ctrl+Alt+X
// ============================================================

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import https from 'https'
import http from 'http'
import { screen } from 'electron'
import {
  executeCuAction,
  captureScreen as captureCuScreen,
  virtualDesktopBounds,
  resetCuAbort, isCuAborted,
} from './tools/impl/cuCore'
import {
  acquireCuSession, releaseCuSession, getCuPolicy,
} from './tools/impl/cuPermissions'

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
    | 'hover' | 'mouse_move' | 'long_press' | 'select_text' | 'set_value'
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
  /** v3.20: 当前多步任务持有的会话锁标识；null 表示没有持锁 */
  private _sessionId: string | null = null

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

  /** 视图物理像素尺寸（多显示器开启时为整个虚拟桌面）+ 虚拟原点偏移 */
  private physicalView(): { imgW: number; imgH: number; vx: number; vy: number } {
    try {
      if (getCuPolicy().multiMonitor) {
        const vb = virtualDesktopBounds()
        if (vb.w > 0 && vb.h > 0) {
          return { imgW: vb.w, imgH: vb.h, vx: vb.x, vy: vb.y }
        }
      }
      const d = screen.getPrimaryDisplay()
      return {
        imgW: Math.round(d.size.width * d.scaleFactor),
        imgH: Math.round(d.size.height * d.scaleFactor),
        vx: 0, vy: 0,
      }
    } catch {
      return { imgW: 0, imgH: 0, vx: 0, vy: 0 }
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
    resetCuAbort()

    // v3.20: 申请会话锁（与 agent desktop_act 互斥，避免并发键鼠冲突）
    const sessionId = `cu_engine_${Date.now()}`
    let locked = false
    try {
      locked = acquireCuSession(sessionId, 'IPC engine')
      if (!locked) {
        summary = '另一个 Computer Use 任务正在执行（会话锁占用），本次取消'
        this.log(`🚫 ${summary}`)
        return {
          success: false, task, steps: [], totalSteps: 0,
          duration: Date.now() - startTime, summary,
        }
      }
      this._sessionId = sessionId
    } catch { /* 会话锁模块异常时不阻塞 */ }

    this.log(`🖥️ 开始执行: ${task}`)
    this.config.onProgress?.(`开始: ${task}`)

    try {
      for (let i = 0; i < (this.config.maxSteps || 10); i++) {
        if (isCuAborted()) {
          summary = '用户触发了急停 (Ctrl+Alt+X)'
          this.log(`🛑 ${summary}`)
          break
        }
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

        if (isCuAborted()) {
          summary = '用户触发了急停 (Ctrl+Alt+X)'
          this.log(`🛑 ${summary}`)
          break
        }

        // 5. 执行操作（统一内核）
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

    if (locked) {
      try { releaseCuSession(sessionId) } catch { /* ignore */ }
      this._sessionId = null
    }

    return {
      success: !!summary.includes('完成') || !!summary.includes('已执行'),
      task,
      steps: steps.filter(s => s.action.type !== 'screenshot'),
      totalSteps: steps.filter(s => s.action.type !== 'screenshot').length,
      duration,
      summary: summary || `已执行 ${steps.length} 步`,
    }
  }

  /**
   * 快速截图（落盘，供 IPC / 预览使用）。
   * v3.30：统一走 cuCore.captureScreen，自动应用多显示器虚拟桌面与隐私遮罩策略。
   */
  async captureScreen(filename?: string): Promise<string> {
    const name = filename || `screen_${Date.now()}_${++this.screenshotIndex}.png`
    const filepath = path.join(this.tmpDir, name)
    const shot = await captureCuScreen()
    fs.writeFileSync(filepath, shot.buffer)
    return filepath
  }

  /** 分析截图中的界面元素 */
  async analyzeScreen(screenshotPath: string, task: string, history: CUStepResult[]): Promise<ScreenAnalysis> {
    if (!this.config.llmApiKey) {
      return this.fallbackAnalysis(screenshotPath, task, history)
    }
    return this.vlmAnalysis(screenshotPath, task, history)
  }

  /**
   * 执行单个操作 —— 全部走共享内核 cuCore。
   * click/drag 同时支持归一化坐标 (nx/ny 0–100) 与像素坐标 (x/y)；
   * type 在 Windows 自动走剪贴板（支持中文），并继承内核高危硬拦截。
   */
  async executeAction(action: CUAction): Promise<boolean> {
    // 单步 IPC（非多步任务）时申请一次性会话锁；多步任务复用 this._sessionId
    const oneShotId = this._sessionId ? null : `cu_action_${Date.now()}`
    const sessionId = this._sessionId || oneShotId
    if (oneShotId) {
      try {
        if (!acquireCuSession(oneShotId, 'IPC single action')) {return false}
      } catch { /* fail-open */ }
    }
    try {
      // sessionId 恒为字符串：多步任务复用 this._sessionId，单步用 oneShotId
      return await this._executeActionGated(action, sessionId as string)
    } finally {
      if (oneShotId) {try {releaseCuSession(oneShotId)} catch { /* ignore */ }}
    }
  }

  private async _executeActionGated(action: CUAction, sessionId: string): Promise<boolean> {
    try {
      const p = action.params || {}
      const view = this.physicalView()
      const num = (k: string): number | undefined => {
        const v = Number(p[k])
        return Number.isFinite(v) ? v : undefined
      }
      const opts = { sessionId }

      switch (action.type) {
        case 'click': {
          if (num('nx') === undefined && num('x') === undefined) {return false}
          const r = await executeCuAction(
            { action_type: 'click', nx: num('nx'), ny: num('ny'), x: num('x'), y: num('y') },
            view, opts,
          )
          return r.ok
        }
        case 'drag': {
          const startNorm = num('nx') !== undefined, startPx = num('x') !== undefined
          const endNorm = num('nx2') !== undefined, endPx = (num('x2') ?? num('drag_end_x')) !== undefined
          if ((!startNorm && !startPx) || (!endNorm && !endPx)) {return false}
          const r = await executeCuAction({
            action_type: 'drag',
            nx: num('nx'), ny: num('ny'), nx2: num('nx2'), ny2: num('ny2'),
            x: num('x'), y: num('y'),
            drag_end_x: num('x2') ?? num('drag_end_x'),
            drag_end_y: num('y2') ?? num('drag_end_y'),
          }, view, opts)
          return r.ok
        }
        case 'hover':
        case 'mouse_move': {
          if (num('nx') === undefined && num('x') === undefined) {return false}
          const r = await executeCuAction(
            { action_type: 'hover', nx: num('nx'), ny: num('ny'), x: num('x'), y: num('y'), wait_seconds: num('hold_seconds') },
            view, opts,
          )
          return r.ok
        }
        case 'long_press': {
          if (num('nx') === undefined && num('x') === undefined) {return false}
          const r = await executeCuAction(
            { action_type: 'long_press', nx: num('nx'), ny: num('ny'), x: num('x'), y: num('y'), wait_seconds: num('hold_seconds') },
            view, opts,
          )
          return r.ok
        }
        case 'select_text': {
          const r = await executeCuAction({
            action_type: 'select_text',
            nx: num('nx'), ny: num('ny'), nx2: num('nx2'), ny2: num('ny2'),
            x: num('x'), y: num('y'),
            drag_end_x: num('x2'), drag_end_y: num('y2'),
          }, view, opts)
          return r.ok
        }
        case 'set_value': {
          if (num('nx') === undefined && num('x') === undefined) {return false}
          const r = await executeCuAction(
            { action_type: 'set_value', nx: num('nx'), ny: num('ny'), x: num('x'), y: num('y'), text: String(p.text ?? '') },
            view, opts,
          )
          return r.ok
        }
        case 'type':
          return (await executeCuAction({ action_type: 'type', text: String(p.text ?? '') }, view, opts)).ok
        case 'keypress':
          return (await executeCuAction({ action_type: 'keypress', key: String(p.key ?? '') }, view, opts)).ok
        case 'scroll': {
          const dir = String(p.direction || 'down')
          const amount = Number(p.amount || 3)
          const signed = dir === 'up' ? -Math.abs(amount) : Math.abs(amount)
          return (await executeCuAction({ action_type: 'scroll', scroll_amount: signed }, view, opts)).ok
        }
        case 'wait':
          await this.sleep(Number(p.ms || 1000))
          return true
        case 'clipboard':
          // v3.20: 统一走内核权限门（剪贴板写入需 full 授权）
          return (await executeCuAction({ action_type: 'clipboard', text: String(p.text || '') }, view, opts)).ok
        case 'open_app':
          return (await executeCuAction({ action_type: 'open_app', app: String(p.app || '') }, view, opts)).ok
        case 'close_window':
          return (await executeCuAction({ action_type: 'close_window' }, view, opts)).ok
        case 'screenshot':
          try { await this.captureScreen(); return true } catch { return false }
        default:
          return false
      }
    } catch {
      return false
    }
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
- click(x, y) — 点击像素坐标
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
      const jsonMatch = response.match(/\{[\s\S]*\}/)
      if (!jsonMatch) {throw new Error('No JSON found')}
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
    if (!suggested || suggested === 'DONE') {return null}

    const clickMatch = suggested.match(/click\s*\(\s*(\d+)\s*,\s*(\d+)\s*\)/i)
    if (clickMatch) {
      return { type: 'click', params: { x: Number(clickMatch[1]), y: Number(clickMatch[2]) } }
    }

    const typeMatch = suggested.match(/type\s*\(\s*"([^"]*?)"\s*\)/i)
    if (typeMatch) {return { type: 'type', params: { text: typeMatch[1] } }}

    const keyMatch = suggested.match(/keypress\s*\(\s*"([^"]*?)"\s*\)/i)
    if (keyMatch) {return { type: 'keypress', params: { key: keyMatch[1] } }}

    const scrollMatch = suggested.match(/scroll\s*\(\s*"(\w+)"\s*,\s*(\d+)\s*\)/i)
    if (scrollMatch) {return { type: 'scroll', params: { direction: scrollMatch[1], amount: Number(scrollMatch[2]) } }}

    const waitMatch = suggested.match(/wait\s*\(\s*(\d+)\s*\)/i)
    if (waitMatch) {return { type: 'wait', params: { ms: Number(waitMatch[1]) } }}

    const clipboardMatch = suggested.match(/clipboard\s*\(\s*"([^"]*?)"\s*\)/i)
    if (clipboardMatch) {return { type: 'clipboard', params: { text: clipboardMatch[1] } }}

    const openMatch = suggested.match(/open_app\s*\(\s*"([^"]*?)"\s*\)/i)
    if (openMatch) {return { type: 'open_app', params: { app: openMatch[1] } }}

    return null
  }

  // ═══════════════════════════════════════════════════════
  // LLM 调用
  // ═══════════════════════════════════════════════════════

  private async callLLM(prompt: string, imagePath?: string): Promise<string> {
    const apiKey = this.config.llmApiKey || process.env.OPENAI_API_KEY || ''
    const baseUrl = this.config.llmBaseUrl || process.env.OPENAI_BASE_URL || 'https://api.openai.com'
    const model = this.config.llmModel || process.env.LLM_VISION_MODEL || 'gpt-4o'

    if (!apiKey) {throw new Error('No API key configured')}

    const url = new URL(baseUrl.replace(/\/+$/, '') + '/chat/completions')
    const isHttps = url.protocol === 'https:'
    const transport = isHttps ? https : http

    const messages: any[] = [{ role: 'user', content: prompt }]

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
  // 安全确认（破坏性硬拦截已在 cuCore 执行层统一处理）
  // ═══════════════════════════════════════════════════════

  private async confirmAction(action: CUAction): Promise<boolean> {
    if (this.config.safetyLevel === 'auto') {return true}

    const desc = `${action.type}(${JSON.stringify(action.params)})`
    this.log(`🔒 确认操作: ${desc}`)

    if (this.config.safetyLevel === 'strict') {
      // strict 模式额外拒绝关闭窗口类操作；命令破坏由 cuCore 硬拦截兜底
      if (action.type === 'close_window') {
        this.log('🚫 严格模式拒绝关闭窗口')
        return false
      }
      return true
    }

    // ask 模式：询问用户
    if (this.config.onConfirm) {
      return this.config.onConfirm(action.type, JSON.stringify(action.params))
    }

    return true // 未提供确认回调时默认允许（agent 工具路径另有审批门）
  }

  // ═══════════════════════════════════════════════════════
  // 工具方法
  // ═══════════════════════════════════════════════════════

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
