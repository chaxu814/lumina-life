// ============================================================
// impl/computerUse.ts — Computer Use agent 工具（编排层，v3.0）
//
// 执行原语 / 视觉配置 / 高危拦截 / 急停全部收敛在 ./cuCore，本文件只负责：
//   desktop_see: 截图 + VLM 视觉理解
//   desktop_act: 截图 → (Set-of-Mark 标注) → VLM 规划 → 键鼠执行 的闭环
// ============================================================

import type { ToolDef, ToolResult } from '../types'
import {
  captureScreen, callVisionModel, executeCuAction,
  resetCuAbort, isCuAborted, type CuAction,
} from './cuCore'

// ──────────────────────────────────────────────────────────
// VLM 返回动作解析
// ──────────────────────────────────────────────────────────

interface VLMAction extends CuAction {
  thought?: string
  summary?: string
  /** 批量动作（computer_batch） */
  actions?: CuAction[]
  /** Set-of-Mark 网格编号（全图粗定位 / zoom 目标格） */
  cell?: number
}

function parseAction(raw: string): VLMAction {
  try {
    const j = JSON.parse(raw.replace(/```json\s*/gi, '').replace(/```/g, '').trim())
    return { thought: j.thought || '', action_type: j.action_type || 'none', ...j }
  } catch { return { thought: raw, action_type: 'none', summary: raw.slice(0, 200) } }
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

// ──────────────────────────────────────────────────────────
// desktop_see
// ──────────────────────────────────────────────────────────

export const desktopSeeDef: ToolDef = {
  name: 'desktop_see',
  description: `截取用户当前屏幕，用视觉模型分析屏幕内容。
参数 question (可选): 针对屏幕的提问。如"用户在做什么？"。不填返回通用描述。
该操作只观察屏幕、不做任何点击输入，默认安全放行。`,
  params: {
    question: { type: 'string', description: '针对屏幕内容的提问', required: false },
  },
  toolsets: ['agent', 'desktop', 'computer_use'],
}

export async function desktopSee(args: Record<string, any>): Promise<ToolResult> {
  const q = (args.question as string) || '请详细描述当前屏幕上的所有内容：有哪些窗口和应用？用户在做什么？'

  let screen
  try { screen = await captureScreen() } catch (e: any) {
    return { callId: '', ok: false, content: '', error: `截图失败: ${e.message}` }
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
    const raw = await callVisionModel(sys, q, screen.b64, true)
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

// ──────────────────────────────────────────────────────────
// desktop_act
// ──────────────────────────────────────────────────────────

export const desktopActDef: ToolDef = {
  name: 'desktop_act',
  description: `Computer Use: 截取屏幕，让视觉模型决定鼠标/键盘操作，自动执行。

支持的操作：
- click / double_click / right_click(nx, ny) — 在归一化坐标(0–100)处点击
- type("文本") — 键盘输入文本（Windows 自动走剪贴板，支持中文）
- keypress("enter"|"esc"|"ctrl_c"|…) — 单个按键/组合键
- scroll(amount) — 滚动（正数向下，负数向上）
- drag(nx,ny,nx2,ny2) — 拖拽
- wait(seconds) — 等待
- done — 任务完成

安全：观察类默认放行；点击/输入等写操作受审批与高危硬拦截保护；
任何时候按全局急停快捷键 Ctrl+Alt+X 可立即中止。

参数：
- instruction (必填): 任务描述
- max_steps (可选): 最多执行步数，默认5、上限10`,
  params: {
    instruction: { type: 'string', description: '要执行的任务描述', required: true },
    max_steps: { type: 'number', description: '最多步数，默认5', required: false },
  },
  toolsets: ['agent', 'desktop', 'computer_use'],
  dangerous: true,
}

function buildSysPrompt(step: number, maxSteps: number): string {
  return `你是一个计算机操作助手 (Computer Use Agent)。
你的任务是根据屏幕截图和用户指令，输出下一步要执行的鼠标/键盘操作。

屏幕坐标使用【归一化坐标 0–100】（与分辨率无关，程序会自动换算成真实像素）：
- nx：横向位置，0=最左边，50=水平正中，100=最右边
- ny：纵向位置，0=最上边，50=垂直正中，100=最下边
- 先在心里把画面横向、纵向各平分成 100 格，判断目标元素【中心点】落在哪一格
- 例如屏幕正中的按钮约 nx=50,ny=50；左下角开始按钮约 nx=5,ny=97

你必须输出一个JSON对象，格式如下：
{
  "thought": "你观察到了什么？接下来打算做什么？（中文）",
  "action_type": "操作类型",
  "nx": 0到100的横向位置,
  "ny": 0到100的纵向位置,
  "text": "要输入的文本（仅type操作需要）",
  "key": "按键（仅keypress需要，如 enter/esc/ctrl_c）",
  "scroll_amount": 滚动量（仅scroll操作需要，正数向下，负数向上）,
  "nx2": 拖拽终点横向位置（仅drag操作需要）,
  "ny2": 拖拽终点纵向位置（仅drag操作需要）,
  "wait_seconds": 等待秒数（仅wait操作需要）,
  "summary": "完成后的总结（仅done操作需要）"
}

操作类型 action_type 必须是以下之一：
- click / double_click / right_click: 鼠标点击，需要 nx 和 ny
- type: 键盘输入，需要 text
- keypress: 单个按键或组合键，需要 key
- scroll: 鼠标滚轮，需要 scroll_amount
- drag: 鼠标拖拽，需要 nx,ny 和 nx2,ny2
- wait: 等待，需要 wait_seconds
- done: 任务已完成，需要 summary

规则：
1. 每次只返回一个操作
2. 一律用归一化坐标 nx/ny（0–100）定位元素【中心】，不要输出像素坐标
3. 先找屏幕边缘、任务栏、窗口边框等明显参照物，再据此估算目标的相对位置
4. 点文字或图标要点正中心，不要点在边缘
5. 如果截图上看不到目标元素，选择 done 并说明原因
6. 如果任务很明显已完成，选择 done
7. nx、ny 必须是 0–100 的整数（当前第 ${step + 1}/${maxSteps} 步）`
}

export async function desktopAct(args: Record<string, any>): Promise<ToolResult> {
  const instruction = (args.instruction as string) || ''
  if (!instruction) return { callId: '', ok: false, content: '', error: '请提供 instruction 参数（要执行的任务描述）' }

  const maxSteps = Math.min((args.max_steps as number) || 5, 10)
  const steps: string[] = []
  resetCuAbort()

  for (let step = 0; step < maxSteps; step++) {
    if (isCuAborted()) { steps.push('🛑 已收到全局急停(Ctrl+Alt+X)，立即停止操作'); break }

    // 1) 截图（含真实像素尺寸）
    let shot
    try { shot = await captureScreen() } catch (e: any) {
      steps.push(`❌ 截图失败: ${e.message}`)
      break
    }

    // 2) VLM 规划
    let vlmResult = ''
    try {
      vlmResult = await callVisionModel(
        buildSysPrompt(step, maxSteps),
        `用户指令: ${instruction}\n\n这是第 ${step + 1}/${maxSteps} 步。请分析当前屏幕截图，输出下一步操作。`,
        shot.b64, true,
      )
    } catch (e: any) {
      steps.push(`❌ VLM调用失败(第${step + 1}步): ${e.message}`)
      break
    }

    // 3) 解析
    const act = parseAction(vlmResult)
    if (!act.thought && act.action_type === 'none' && !act.summary) {
      steps.push(`⚠️ VLM返回无法解析: ${vlmResult.slice(0, 150)}；结束循环`)
      break
    }
    if (act.action_type === 'done') {
      steps.push(`✅ 完成: ${act.summary || act.thought || '任务结束'}`)
      break
    }
    if (act.action_type === 'none') {
      steps.push(`⏸️ 无需操作: ${act.summary || act.thought || vlmResult.slice(0, 100)}`)
      break
    }
    if (isCuAborted()) { steps.push('🛑 已收到全局急停，立即停止操作'); break }

    // 4) 执行（统一内核：坐标映射 + 高危拦截）
    const view = { imgW: shot.w, imgH: shot.h }
    let result: { ok: boolean; msg: string; denied?: boolean }
    if (act.action_type === 'wait') {
      const sec = Math.min(30, Math.max(0, act.wait_seconds || 1))
      await sleep(sec * 1000)
      result = { ok: true, msg: `等待 ${sec} 秒` }
    } else {
      result = await executeCuAction(act, view)
    }

    steps.push(`📌 第${step + 1}步: ${act.thought || act.action_type} → ${result.msg}`)

    if (result.denied) { steps.push('⛔ 命中高危硬拦截，终止本次操控'); break }
    if (!result.ok) { steps.push('⚠️ 操作失败，跳过剩余步骤'); break }
  }

  if (isCuAborted() && !steps.some(s => s.includes('急停'))) steps.push('🛑 已急停')

  return {
    callId: '',
    ok: true,
    content: `🖥️ Computer Use 执行报告:\n任务: ${instruction}\n\n${steps.join('\n')}`,
  }
}
