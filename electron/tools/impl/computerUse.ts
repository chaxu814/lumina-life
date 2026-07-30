// ============================================================
// impl/computerUse.ts — Computer Use 模块 (v2.10 优化)
//
// desktop_see: 截图 + VLM 视觉理解
// desktop_act: Kimi Agent 模式 (截图→VLM规划→键鼠执行)
//
// v2.10 截屏性能:
//   当前: screenshot-desktop（原生 C++ 绑定），~50-150ms
//   之前: PowerShell Add-Type，~1500-3000ms
//   提升: 15-30x
// ============================================================

import * as cp from 'child_process'
import * as path from 'path'
import * as os from 'os'
import * as fs from 'fs'
import * as https from 'https'
import * as http from 'http'
import screenshot from 'screenshot-desktop'
import type { ToolDef, ToolResult } from '../types'

// ──────────────────────────────────────────────────────────
// 1. 截屏 (v2.10: screenshot-desktop 原生绑定，~50ms)
// ──────────────────────────────────────────────────────────

async function screenshotToFile(): Promise<string> {
  const id = Date.now()
  const pngPath = path.join(os.tmpdir(), `lu-sc-${id}.png`)

  try {
    // screenshot-desktop 原生 C++ 绑定，直接调 Windows GDI
    // 速度: ~50-150ms vs PowerShell 的 1500-3000ms
    await screenshot({ filename: pngPath, format: 'png' })
    return pngPath
  } catch (e: any) {
    // 回退：screenshot-desktop 依赖原生模块，如果失败则回退到 PowerShell
    console.warn('[computerUse] screenshot-desktop failed, falling back to PowerShell:', e.message)
    return screenshotFallbackPS(pngPath)
  }
}

// ── PowerShell 回退（当 screenshot-desktop 原生模块不可用时） ──
function screenshotFallbackPS(pngPath: string): Promise<string> {
  const psCmd = [
    'Add-Type -AssemblyName System.Windows.Forms,System.Drawing;',
    `$s=[System.Windows.Forms.Screen]::PrimaryScreen;`,
    `$b=New-Object System.Drawing.Bitmap($s.Bounds.Width,$s.Bounds.Height);`,
    `$g=[System.Drawing.Graphics]::FromImage($b);`,
    `$g.CopyFromScreen($s.Bounds.X,$s.Bounds.Y,0,0,$s.Bounds.Size);`,
    `$b.Save('${pngPath.replace(/\\/g, '\\\\')}',[System.Drawing.Imaging.ImageFormat]::Png);`,
    `$g.Dispose();$b.Dispose();`,
  ].join(' ')

  // PowerShell -EncodedCommand 需要 UTF-16LE → Base64，彻底绕过字符集/引号问题
  const psB64 = Buffer.from(psCmd, 'utf16le').toString('base64')

  return new Promise<string>((resolve, reject) => {
    cp.execFile('powershell', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-EncodedCommand', psB64,
    ], { timeout: 8000, windowsHide: true },
    (err) => {
      if (err) {
        try { fs.unlinkSync(pngPath) } catch {}
        reject(new Error(`screenshot_fallback:${err.code || 'unknown'}`))
        return
      }
      try {
        if (fs.statSync(pngPath).size > 0) resolve(pngPath)
        else reject(new Error('screenshot_fallback:empty'))
      } catch (e: any) {
        reject(new Error(`screenshot_fallback:${e.message}`))
      }
    })
  })
}

function fileToB64(f: string): string {
  return fs.readFileSync(f).toString('base64')
}

// ──────────────────────────────────────────────────────────
// 2. VLM 调用 (OpenAI 兼容接口 + 图片)
// ──────────────────────────────────────────────────────────

function getVLMConfig() {
  return {
    url: (process.env.LUMINA_VLM_BASE_URL || process.env.LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''),
    key: process.env.LUMINA_VLM_API_KEY || process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || '',
    model: process.env.LUMINA_VLM_MODEL || process.env.LLM_MODEL || 'gpt-4o',
  }
}

function callVLM(sys: string, usr: string, b64: string, jsonMode = false): Promise<string> {
  const cfg = getVLMConfig()
  const u = new URL(cfg.url + '/chat/completions')
  const t = u.protocol === 'https:' ? https : http

  const bodyObj: any = {
    model: cfg.model,
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: [
        { type: 'text', text: usr },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}`, detail: 'high' } },
      ]},
    ],
    max_tokens: 1024,
    temperature: 0.3,
  }
  if (jsonMode) bodyObj.response_format = { type: 'json_object' }

  const body = JSON.stringify(bodyObj)

  return new Promise<string>((resolve, reject) => {
    const r = t.request({
      hostname: u.hostname, port: u.port || (t === https ? 443 : 80),
      path: u.pathname, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${cfg.key}`,
        'Content-Length': String(Buffer.byteLength(body)),
      },
      timeout: 30000,
    }, res => {
      let d = ''
      res.on('data', c => d += c)
      res.on('end', () => {
        try {
          const j = JSON.parse(d)
          if (j.error) return reject(new Error(j.error.message || 'vlm_err'))
          resolve(j.choices?.[0]?.message?.content || '')
        } catch { reject(new Error(`vlm_parse:${d.slice(0, 200)}`)) }
      })
    })
    r.on('error', reject)
    r.on('timeout', () => { r.destroy(); reject(new Error('vlm_timeout')) })
    r.write(body)
    r.end()
  })
}

// ──────────────────────────────────────────────────────────
// 3. 键鼠执行 (跨平台: Windows → PowerShell, macOS → osascript, Linux → xdotool)
// ──────────────────────────────────────────────────────────

/** 跨平台执行shell命令 */
function execCmd(cmd: string, args: string[], timeout = 15000): Promise<string> {
  return new Promise<string>(resolve => {
    const child = cp.execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout, stderr) => {
      if (err) resolve(`ERR:${err.message}|${String(stderr).slice(0, 100)}`)
      else resolve(String(stdout).trim())
    })
    if (child.stdin) child.stdin.end()
  })
}

/** Windows: 写临时 .ps1 执行 */
function runPS(lines: string[], timeout = 15000): Promise<string> {
  const ps1 = path.join(os.tmpdir(), `lu-ps-${Date.now()}.ps1`)
  return new Promise<string>(resolve => {
    try { fs.writeFileSync(ps1, lines.join('\n'), 'utf-8') } catch (e: any) {
      return resolve(`ERR:ps1_write:${e.message}`)
    }
    cp.execFile('powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1],
      { timeout, windowsHide: true },
      (err, stdout, stderr) => {
        try { fs.unlinkSync(ps1) } catch {}
        if (err) resolve(`ERR:${err.message}|${String(stderr).slice(0, 100)}`)
        else resolve(String(stdout).trim())
      }
    )
  })
}

async function doClick(x: number, y: number, btn: 'left'|'right', dbl: boolean): Promise<string> {
  const plat = process.platform
  const rx = Math.round(x)
  const ry = Math.round(y)

  if (plat === 'win32') {
    const click = dbl ? '[MO]::DoubleClickLeft()'
      : btn === 'right' ? '[MO]::ClickRight()' : '[MO]::ClickLeft()'
    const r = await runPS([
      "Add-Type @'",
      "using System;using System.Runtime.InteropServices;",
      "public class MO{",
      "[DllImport(\"user32.dll\")]public static extern void mouse_event(uint f,uint dx,uint dy,uint d,int e);",
      "public const uint L=0x0002;public const uint LU=0x0004;",
      "public const uint R=0x0008;public const uint RU=0x0010;",
      "public static void ClickLeft(){mouse_event(L,0,0,0,0);System.Threading.Thread.Sleep(50);mouse_event(LU,0,0,0,0);}",
      "public static void ClickRight(){mouse_event(R,0,0,0,0);System.Threading.Thread.Sleep(50);mouse_event(RU,0,0,0,0);}",
      "public static void DoubleClickLeft(){ClickLeft();System.Threading.Thread.Sleep(100);ClickLeft();}",
      "}",
      "'@",
      "Add-Type -AssemblyName System.Windows.Forms",
      `[System.Windows.Forms.Cursor]::Position=New-Object System.Drawing.Point(${rx},${ry})`,
      "Start-Sleep -Milliseconds 80",
      click,
      "Write-Output 'OK'",
    ])
    return r.startsWith('ERR:') ? `点击失败:${r.slice(4)}` : '点击完成'
  }

  if (plat === 'darwin') {
    const btnCode = btn === 'right' ? 'button 2' : 'button 1'
    const clickAction = dbl ? `click at {${rx},${ry}}` : `click at {${rx},${ry}}`
    // macOS: 双击用两次 click + 按住时间区分
    const osaCmd = dbl
      ? `tell application "System Events" to click at {${rx},${ry}}; delay 0.1; tell application "System Events" to click at {${rx},${ry}}`
      : `tell application "System Events" to ${clickAction}`
    const r = await execCmd('osascript', ['-e', osaCmd])
    return r.startsWith('ERR:') ? `点击失败:${r.slice(4)}` : '点击完成'
  }

  // Linux: xdotool
  const btnCode = btn === 'right' ? '3' : '1'
  const clickCount = dbl ? '--repeat 2 --delay 100 ' : ''
  const r = await execCmd('xdotool', ['mousemove', String(rx), String(ry), 'click', '--repeat', String(dbl ? 2 : 1), '--delay', '100', btnCode])
  return r.startsWith('ERR:') ? `点击失败:${r.slice(4)}` : '点击完成'
}

async function doType(text: string): Promise<string> {
  const plat = process.platform
  if (plat === 'win32') {
    const safe = text.replace(/'/g, "''")
    const r = await runPS([
      'Add-Type -AssemblyName System.Windows.Forms',
      `[System.Windows.Forms.SendKeys]::SendWait('${safe}')`,
      "Write-Output 'OK'",
    ])
    return r.startsWith('ERR:') ? `输入失败:${r.slice(4)}` : '输入完成'
  }

  if (plat === 'darwin') {
    const escaped = text.replace(/"/g, '\\"')
    const r = await execCmd('osascript', ['-e',
      `tell application "System Events" to keystroke "${escaped}"`])
    return r.startsWith('ERR:') ? `输入失败:${r.slice(4)}` : '输入完成'
  }

  // Linux: xdotool type
  const r = await execCmd('xdotool', ['type', '--delay', '50', text])
  return r.startsWith('ERR:') ? `输入失败:${r.slice(4)}` : '输入完成'
}

async function doScroll(amount: number): Promise<string> {
  const plat = process.platform
  const n = Math.abs(amount)
  const dir = amount > 0 ? 'down' : 'up'

  if (plat === 'win32') {
    const dirHex = amount > 0 ? '0x0800' : '0x0078'
    const reps = Array(n).fill(`[MS]::mouse_event(${dirHex},0,0,0,0);Start-Sleep -Milliseconds 20`).join(';')
    const r = await runPS([
      "Add-Type @'",
      "using System;using System.Runtime.InteropServices;",
      "public class MS{[DllImport(\"user32.dll\")]public static extern void mouse_event(uint f,uint dx,uint dy,uint d,int e);}",
      "'@",
      reps,
      "Write-Output 'OK'",
    ])
    return r.startsWith('ERR:') ? `滚动失败:${r.slice(4)}` : '滚动完成'
  }

  if (plat === 'darwin') {
    // macOS: 模拟滚轮每次 1 格
    const r = await execCmd('osascript', ['-e',
      `tell application "System Events" to repeat ${n} times\n  key code 124 using {control down}\n  delay 0.02\nend repeat`])
    return r.startsWith('ERR:') ? `滚动失败:${r.slice(4)}` : '滚动完成'
  }

  // Linux: xdotool click 4 (up) / 5 (down)
  const btnCode = amount > 0 ? '5' : '4'
  const r = await execCmd('xdotool', ['click', '--repeat', String(n), '--delay', '50', btnCode])
  return r.startsWith('ERR:') ? `滚动失败:${r.slice(4)}` : '滚动完成'
}

async function doDrag(x1: number, y1: number, x2: number, y2: number): Promise<string> {
  const plat = process.platform
  const rx1 = Math.round(x1); const ry1 = Math.round(y1)
  const rx2 = Math.round(x2); const ry2 = Math.round(y2)

  if (plat === 'win32') {
    const r = await runPS([
      "Add-Type @'",
      "using System;using System.Runtime.InteropServices;",
      "public class MD{",
      "[DllImport(\"user32.dll\")]public static extern void mouse_event(uint f,uint dx,uint dy,uint d,int e);",
      "[DllImport(\"user32.dll\")]public static extern bool SetCursorPos(int X,int Y);",
      "}",
      "'@",
      `[MD]::SetCursorPos(${rx1},${ry1})`,
      "Start-Sleep -Milliseconds 80",
      "[MD]::mouse_event(0x0002,0,0,0,0)",
      "Start-Sleep -Milliseconds 50",
      `$steps=20;for($i=1;$i -le $steps;$i++){$nx=[int](${rx1}+(${rx2}-${rx1})*$i/$steps);$ny=[int](${ry1}+(${ry2}-${ry1})*$i/$steps);[MD]::SetCursorPos($nx,$ny);Start-Sleep -Milliseconds 15}`,
      `[MD]::SetCursorPos(${rx2},${ry2})`,
      "Start-Sleep -Milliseconds 50",
      "[MD]::mouse_event(0x0004,0,0,0,0)",
      "Write-Output 'OK'",
    ])
    return r.startsWith('ERR:') ? `拖拽失败:${r.slice(4)}` : '拖拽完成'
  }

  // macOS / Linux: 使用通用 approach — mousemove → mousedown → mousemove → mouseup
  // macOS: osascript 可以一次完成
  if (plat === 'darwin') {
    const r = await execCmd('osascript', ['-e',
      `tell application "System Events"\n  set mousePosition to {${rx1},${ry1}}\n  perform action "AXPress" at mousePosition\n  delay 0.05\n  set mousePosition to {${rx2},${ry2}}\n  perform action "AXPress" at mousePosition\nend tell`])
    return r.startsWith('ERR:') ? `拖拽失败:${r.slice(4)}` : '拖拽完成'
  }

  // Linux: xdotool mousedown + mousemove + mouseup
  const r = await execCmd('bash', ['-c',
    `xdotool mousemove ${rx1} ${ry1} && xdotool mousedown 1 && xdotool mousemove ${rx2} ${ry2} && xdotool mouseup 1`])
  return r.startsWith('ERR:') ? `拖拽失败:${r.slice(4)}` : '拖拽完成'
}

interface VLMAction {
  thought: string
  action_type: string
  x?: number; y?: number; text?: string
  scroll_amount?: number; drag_end_x?: number; drag_end_y?: number
  wait_seconds?: number; summary?: string
}

function parseAction(raw: string): VLMAction {
  try {
    const j = JSON.parse(raw.replace(/```json\s*/gi, '').replace(/```/g, '').trim())
    return { thought: j.thought || '', action_type: j.action_type || 'none', ...j }
  } catch { return { thought: raw, action_type: 'none', summary: raw.slice(0, 200) } }
}

// ──────────────────────────────────────────────────────────
// 4. 工具定义
// ──────────────────────────────────────────────────────────

export const desktopSeeDef: ToolDef = {
  name: 'desktop_see',
  description: `截取用户当前屏幕，用视觉模型分析屏幕内容。
参数 question (可选): 针对屏幕的提问。如"用户在做什么？"。不填返回通用描述。`,
  params: {
    question: { type: 'string', description: '针对屏幕内容的提问', required: false },
  },
  toolsets: ['agent', 'desktop', 'computer_use'],
}

export async function desktopSee(args: Record<string, any>): Promise<ToolResult> {
  const q = (args.question as string) || '请详细描述当前屏幕上的所有内容：有哪些窗口和应用？用户在做什么？'

  let f = ''
  try { f = await screenshotToFile() } catch (e: any) {
    return { callId: '', ok: false, content: '', error: `截图失败: ${e.message}` }
  }

  let b64 = ''
  try { b64 = fileToB64(f); fs.unlinkSync(f) } catch (e: any) {
    try { fs.unlinkSync(f) } catch {}
    return { callId: '', ok: false, content: '', error: `读取截图失败: ${e.message}` }
  }

  try {
    const sys = `你是一个桌面视觉助手。请仔细查看用户屏幕截图，用中文回答问题。

你必须输出一个JSON对象，格式如下：
{
  "summary": "用户屏幕内容的简洁概述（一句话）",
  "applications": ["正在运行的应用1", "应用2"],
  "activity": "用户正在做什么",
  "details": "屏幕上的详细内容描述",
  "notable": "值得注意的亮点或异常"
}`
    const raw = await callVLM(sys, q, b64, true)
    try {
      const j = JSON.parse(raw.replace(/```json\s*/gi, '').replace(/```/g, '').trim())
      return { callId: '', ok: true, content:
        `👁️ 屏幕内容:\n` +
        `📋 概述: ${j.summary || 'N/A'}\n` +
        `🖥️ 应用: ${(j.applications || []).join(', ') || 'N/A'}\n` +
        `🎯 活动: ${j.activity || 'N/A'}\n` +
        `📝 详情: ${j.details || 'N/A'}\n` +
        `💡 亮点: ${j.notable || '无'}` }
    } catch {
      return { callId: '', ok: true, content: `👁️ 屏幕内容:\n${raw.slice(0, 2000)}` }
    }
  } catch (e: any) {
    return { callId: '', ok: false, content: '', error: `VLM分析失败: ${e.message}` }
  }
}

// ═══════════════════════════════════════════════════════════
// desktop_act — Kimi Agent 模式
// ═══════════════════════════════════════════════════════════

export const desktopActDef: ToolDef = {
  name: 'desktop_act',
  description: `Computer Use: 截取屏幕，让视觉模型决定鼠标/键盘操作，自动执行。

支持的操作：
- click(x, y) — 鼠标左键点击指定坐标
- double_click(x, y) — 双击
- right_click(x, y) — 右键点击
- type("文本") — 键盘输入文本
- scroll(amount) — 滚动（正数向下，负数向上，1=一格）
- drag(x1,y1,x2,y2) — 拖拽从(x1,y1)到(x2,y2)
- wait(seconds) — 等待指定秒数
- done — 任务完成

参数：
- instruction (必填): 任务描述
- max_steps (可选): 最多执行步数，默认5`,
  params: {
    instruction: { type: 'string', description: '要执行的任务描述', required: true },
    max_steps: { type: 'number', description: '最多步数，默认5', required: false },
  },
  toolsets: ['agent', 'desktop', 'computer_use'],
  dangerous: true,
}

export async function desktopAct(args: Record<string, any>): Promise<ToolResult> {
  const instruction = (args.instruction as string) || ''
  if (!instruction) return { callId: '', ok: false, content: '', error: '请提供 instruction 参数（要执行的任务描述）' }

  const maxSteps = Math.min((args.max_steps as number) || 5, 10)
  const steps: string[] = []

  for (let step = 0; step < maxSteps; step++) {
    // 1) 截图
    let f = ''
    try { f = await screenshotToFile() } catch (e: any) {
      steps.push(`❌ 截图失败: ${e.message}`)
      break
    }
    let b64 = ''
    try { b64 = fileToB64(f); fs.unlinkSync(f) } catch (e: any) {
      try { fs.unlinkSync(f) } catch {}
      steps.push(`❌ 读取截图失败: ${e.message}`)
      break
    }

    // 2) VLM 规划
    const sysPrompt = `你是一个计算机操作助手 (Computer Use Agent)。
你的任务是根据屏幕截图和用户指令，输出下一步要执行的鼠标/键盘操作。

屏幕坐标系: 左上角为 (0,0)，x 轴向右增大，y 轴向下增大。
请仔细观察截图中的UI元素，精确估计它们的像素坐标。

你必须输出一个JSON对象，格式如下：
{
  "thought": "你观察到了什么？接下来打算做什么？（中文）",
  "action_type": "操作类型",
  "x": 数字坐标,
  "y": 数字坐标,
  "text": "要输入的文本（仅type操作需要）",
  "scroll_amount": 滚动量（仅scroll操作需要，正数向下，负数向上）,
  "drag_end_x": 拖拽终点x（仅drag操作需要）,
  "drag_end_y": 拖拽终点y（仅drag操作需要）,
  "wait_seconds": 等待秒数（仅wait操作需要）,
  "summary": "完成后的总结（仅done操作需要）"
}

操作类型 action_type 必须是以下之一：
- click: 左键点击，需要 x 和 y
- double_click: 双击，需要 x 和 y
- right_click: 右键点击，需要 x 和 y
- type: 键盘输入，需要 text
- scroll: 鼠标滚轮，需要 scroll_amount
- drag: 拖拽，需要 x,y 和 drag_end_x,drag_end_y
- wait: 等待，需要 wait_seconds
- done: 任务已完成，需要 summary

规则：
1. 每次只返回一个操作
2. 仔细观察截图，根据UI元素位置估计坐标
3. 如果截图上看不到目标元素，选择 done 并说明原因
4. 如果任务很明显已完成，选择 done
5. 坐标必须是整数，尽量精确`
    
    const userPrompt = `用户指令: ${instruction}\n\n这是第 ${step + 1}/${maxSteps} 步。请分析当前屏幕截图，输出下一步操作。`
    
    let vlmResult = ''
    try {
      vlmResult = await callVLM(sysPrompt, userPrompt, b64, true)
    } catch (e: any) {
      steps.push(`❌ VLM调用失败(第${step+1}步): ${e.message}`)
      break
    }

    // 3) 解析动作
    const act = parseAction(vlmResult)

    if (!act.thought && act.action_type === 'none' && !act.summary) {
      steps.push(`⚠️ VLM返回无法解析: ${vlmResult.slice(0, 150)}`)
      steps.push(`⏭️ 跳过，结束循环`)
      break
    }

    // 4) 执行动作
    if (act.action_type === 'done') {
      steps.push(`✅ 完成: ${act.summary || act.thought || '任务结束'}`)
      break
    }
    if (act.action_type === 'none') {
      steps.push(`⏸️ 无需操作: ${act.summary || act.thought || vlmResult.slice(0, 100)}`)
      break
    }

    let result = ''
    switch (act.action_type) {
      case 'click':
        if (act.x === undefined || act.y === undefined) {
          result = '❌ 缺少坐标'
        } else {
          result = await doClick(act.x!, act.y!, 'left', false)
        }
        break
      case 'double_click':
        if (act.x === undefined || act.y === undefined) {
          result = '❌ 缺少坐标'
        } else {
          result = await doClick(act.x!, act.y!, 'left', true)
        }
        break
      case 'right_click':
        if (act.x === undefined || act.y === undefined) {
          result = '❌ 缺少坐标'
        } else {
          result = await doClick(act.x!, act.y!, 'right', false)
        }
        break
      case 'type':
        if (!act.text) {
          result = '❌ 缺少输入文本'
        } else {
          result = await doType(act.text)
        }
        break
      case 'scroll':
        result = await doScroll(act.scroll_amount || 3)
        break
      case 'drag':
        if (act.x === undefined || act.y === undefined || act.drag_end_x === undefined || act.drag_end_y === undefined) {
          result = '❌ 缺少拖拽坐标'
        } else {
          result = await doDrag(act.x!, act.y!, act.drag_end_x!, act.drag_end_y!)
        }
        break
      case 'wait':
        result = `等待 ${act.wait_seconds || 1} 秒`
        break
      default:
        result = `❓ 未知操作类型: ${act.action_type}`
    }

    steps.push(`📌 第${step+1}步: ${act.thought || act.action_type} → ${result}`)

    if (act.action_type === 'wait') {
      // 等待不需要重新截图，继续循环
      continue
    }
    if (result.startsWith('❌') || result.startsWith('❓')) {
      steps.push(`⚠️ 操作失败，跳过剩余步骤`)
      break
    }
  }

  return {
    callId: '',
    ok: true,
    content: `🖥️ Computer Use 执行报告:\n任务: ${instruction}\n\n${steps.map((s, i) => `${s}`).join('\n')}`,
  }
}
