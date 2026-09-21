// ============================================================
// impl/computerUse.ts — Computer Use agent 工具（编排层，v3.20）
//
// 执行原语 / 视觉配置 / 高危拦截 / 急停全部收敛在 ./cuCore，本文件只负责：
//   desktop_see: 截图 + VLM 视觉理解
//   desktop_act: 截图 → (Set-of-Mark 网格 / zoom 放大) → VLM 规划
//                → cell 编号/归一化坐标解析 → 内核执行（支持 batch）→ 再截图闭环
// ============================================================

import type { ToolDef, ToolResult } from '../types'
import {
  captureScreen, callVisionModel, executeCuAction,
  resetCuAbort, isCuAborted, type CuAction, type CuScreen,
} from './cuCore'
import { getUiaCache, renderElementsText, parseUiaJson, normalizeElements, setValueByPoint } from './cuUia'
import { acquireCuSession, releaseCuSession, gateCuAction } from './cuPermissions'
import { destructiveReason } from './cuSafety'
import { cellToNorm, zoomCrop, localToGlobal, gridDims, type GridInfo, type NormRect } from './cuGeometry'
import { annotateGrid, annotateZoom, type AnnotatedImage } from './cuAnnotate'

// ──────────────────────────────────────────────────────────
// VLM 返回动作解析
// ──────────────────────────────────────────────────────────

interface VLMAction extends CuAction {
  thought?: string
  summary?: string
  /** computer_batch：一次回多个确定性动作，顺序执行、末帧才回传截图 */
  actions?: VLMAction[]
  /** Set-of-Mark 网格编号（全图=全局格；zoom 视图=放大图内细格） */
  cell?: number
  /** drag 终点格（可选） */
  cell2?: number
  /** zoom 边长（归一化，默认 25） */
  span?: number
}

type View = { kind: 'full' } | { kind: 'zoom'; crop: NormRect }

/** v3.30 截图 → 动作视图（含多显示器虚拟原点） */
const viewOf = (shot: CuScreen) => ({ imgW: shot.w, imgH: shot.h, vx: shot.vx || 0, vy: shot.vy || 0 })

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
const num = (v: any): number | null => {
  if (v === undefined || v === null || v === '') {return null}
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function parseAction(raw: string): VLMAction | null {
  if (!raw) {return null}
  let j: string = raw.trim().replace(/```json\s*/gi, '').replace(/```/g, '').trim()
  const s = j.indexOf('{'), e = j.lastIndexOf('}')
  if (s >= 0 && e > s) {j = j.slice(s, e + 1)}
  try {
    const o = JSON.parse(j)
    if (!o || !o.action_type) {return null}
    return { ...o } as VLMAction
  } catch { return null }
}

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
  description: `Computer Use: 截屏并自主操控电脑完成任务（截屏→视觉决策→键鼠执行→再截屏闭环）。

定位方式（对本地小模型尤其友好）：
- 截图叠加编号网格，优先用 "cell":目标所在格编号（点格中心），无需估算像素；
- 目标太小可先 {"action_type":"zoom","cell":编号} 放大局部，再在细网格里精确定位；
- 也可直接用归一化坐标 nx,ny（0–100，左上角0,0、右下角100,100）。

支持的操作：
- click / double_click / right_click(cell 或 nx,ny)
- type("文本")（Windows 自动走剪贴板，支持中文）
- keypress("enter"|"esc"|"ctrl_c"|…)、scroll(scroll_amount，正下负上)
- drag(nx,ny → nx2,ny2)、open_app("名称")、close_window、clipboard("文本")、wait(wait_seconds)
- batch(actions=[...])：一连串确定性动作一次给出，顺序执行、只在最后回一帧
- done(summary)：任务完成

安全：观察类默认放行；写操作受审批与高危硬拦截保护；任何时候按 Ctrl+Alt+X 全局急停。

参数：
- instruction (必填): 任务描述
- max_steps (可选): 最多步数，默认8、上限16`,
  params: {
    instruction: { type: 'string', description: '要执行的任务描述', required: true },
    max_steps: { type: 'number', description: '最多步数，默认8、上限16', required: false },
  },
  toolsets: ['agent', 'desktop', 'computer_use'],
  dangerous: true,
}

function buildSysPrompt(step: number, maxSteps: number, som?: { view: View; grid: GridInfo }): string {
  const head = `你是一个计算机操作助手 (Computer Use Agent)。根据屏幕截图和用户指令，输出下一步鼠标/键盘操作。
屏幕坐标用【归一化坐标 0–100】（与分辨率无关，程序自动换算真实像素）：左上角 (0,0)、右下角 (100,100)。
当前第 ${step + 1}/${maxSteps} 步。只输出一个 JSON 对象，不要解释、不要 markdown。

通用动作 action_type：
- click / double_click / right_click：点击
- hover：悬停（展开悬停菜单/提示），可带 wait_seconds；long_press：长按（触发右键菜单/拖拽手柄）
- select_text：从 nx,ny 按住拖到 nx2,ny2 选中文本
- set_value：定位输入框并整体替换内容，{"action_type":"set_value","nx":..,"ny":..,"text":"内容"}（比 click+type 更可靠，中文直接给）
- type：输入文本，{"action_type":"type","text":"内容"}（中文自动走剪贴板）
- keypress：按键/组合键，key 如 enter esc tab space backspace up down left right ctrl_c ctrl_v ctrl_a ctrl_z ctrl_s alt_f4 win shift_tab（多键用下划线连接，如 ctrl_shift_esc）
- scroll：滚动，scroll_amount 正数向下、负数向上
- drag：拖拽，起点 nx,ny 终点 nx2,ny2
- open_app：打开应用，app 为名称；close_window：关当前窗；clipboard：写剪贴板 text；wait：等待 wait_seconds 秒
- done：任务完成，带 summary`

  if (!som) {
    return `${head}

这一步没有网格，请直接估计目标【中心】的 nx,ny：
{"thought":"...","action_type":"click","nx":52,"ny":18}
规则：参照任务栏/窗口边框等明显地标；点文字或图标要点正中心；看不到目标或已完成就 done。`
  }

  const { view, grid } = som
  if (view.kind === 'full') {
    return `${head}

截图上叠加了 ${grid.cols} 列 × ${grid.rows} 行编号网格，编号 0..${grid.count - 1}，从左到右、从上到下递增（左上角为0）。
- 【首选】用 "cell" 给目标所在格编号，引擎点击该格中心：{"thought":"...","action_type":"click","cell":237}
- 目标很小、格中心可能点偏时，先放大：{"action_type":"zoom","cell":237}（可带 "span":10~60，默认25），下一步收到该区域放大图与更细网格；
- 也可不用 cell，直接给更精确的 nx,ny；
- 一连串确定性动作合并为批量，省往返：{"action_type":"batch","actions":[{"action_type":"click","cell":12},{"action_type":"type","text":"hi"}]}（批量内用 cell 或 nx,ny）；
- 放大后想退回全图：{"action_type":"reset_view"}。`
  }

  return `${head}

这是上一步放大的【局部区域】，叠加 ${grid.cols} × ${grid.rows} 细网格，编号 0..${grid.count - 1}。
- 用 "cell" 指出放大图中的精确目标，引擎自动换算回全屏坐标执行，点击后自动回到全图；
- 区域选错就 {"action_type":"reset_view"} 回全图重选；
- 这一步通常直接给 click/double_click/right_click + cell，不要再 zoom。
示例：{"thought":"放大后精确定位","action_type":"click","cell":42}`
}

/** 把 cell / 局部坐标解析为全屏全局归一化坐标 */
function resolvePoint(a: any, grid: GridInfo, view: View): { nx: number; ny: number } | null {
  let p: { nx: number; ny: number } | null = null
  if (typeof a.cell === 'number') {
    p = cellToNorm(a.cell, grid.cols, grid.rows)
  } else {
    const nx = num(a.nx), ny = num(a.ny)
    if (nx !== null && ny !== null) {p = { nx, ny }}
  }
  if (!p) {return null}
  if (view.kind === 'zoom') {p = localToGlobal(p.nx, p.ny, view.crop)}
  return p
}

/** 解析点击/拖拽坐标（含 zoom 换算），就地写回全局 nx/ny；坐标缺失返回 false */
function preparePoint(a: any, grid: GridInfo, view: View): boolean {
  const t = a.action_type
  const pointActions = ['click', 'double_click', 'right_click', 'drag',
    'hover', 'long_press', 'select_text', 'set_value']
  if (!pointActions.includes(t)) {return true}
  const start = resolvePoint(a, grid, view)
  if (!start) {return false}
  a.nx = start.nx; a.ny = start.ny
  delete a.cell
  if (t === 'drag' || t === 'select_text') {
    let end: { nx: number; ny: number } | null = null
    if (typeof a.cell2 === 'number') {end = cellToNorm(a.cell2, grid.cols, grid.rows)}
    else { const x2 = num(a.nx2), y2 = num(a.ny2); if (x2 !== null && y2 !== null) {end = { nx: x2, ny: y2 }} }
    if (!end) {return false}
    if (view.kind === 'zoom') {end = localToGlobal(end.nx, end.ny, view.crop)}
    a.nx2 = end.nx; a.ny2 = end.ny
    delete a.cell2
  }
  return true
}

export async function desktopAct(args: Record<string, any>): Promise<ToolResult> {
  const instruction = (args.instruction as string) || ''
  if (!instruction) {return { callId: '', ok: false, content: '', error: '请提供 instruction 参数（要执行的任务描述）' }}

  const maxSteps = Math.min(Math.max(1, (args.max_steps as number) || 8), 16)
  const steps: string[] = []
  let view: View = { kind: 'full' }
  resetCuAbort()

  // v3.20: 会话锁——同一时刻只允许一个操控者驱动键鼠（对标 cc-haha ForegroundLease）
  const sessionId = `desktop_act_${Date.now()}`
  let locked = false
  try {
    locked = acquireCuSession(sessionId, 'agent desktop_act')
    if (!locked) {
      return {
        callId: '', ok: false,
        content: '🖥️ Computer Use 会话锁正被另一个操控任务占用，请等待当前任务结束后再试。',
        error: 'cu_session_busy',
      }
    }
  } catch { /* 会话锁模块异常时不阻塞 */ }

  try {
    return await desktopActLoop(instruction, maxSteps, steps, view, sessionId)
  } finally {
    if (locked) {try {releaseCuSession(sessionId)} catch { /* ignore */ }}
  }
}

async function desktopActLoop(
  instruction: string,
  maxSteps: number,
  steps: string[],
  view: View,
  sessionId: string,
): Promise<ToolResult> {
  for (let step = 0; step < maxSteps; step++) {
    if (isCuAborted()) { steps.push('🛑 已收到全局急停(Ctrl+Alt+X)，立即停止'); break }

    // 1) 截图
    let shot
    try { shot = await captureScreen() } catch (e: any) {
      steps.push(`❌ 截图失败: ${e.message}`); break
    }

    // 2) 标注（全图网格 / zoom 细网格）；失败回退原图 + 纯归一化
    let imgB64 = shot.b64, imgMime = 'image/png'
    const fallbackGrid = gridDims(shot.w, shot.h, 10)
    let som: { view: View; grid: GridInfo } | null = null
    let ann: AnnotatedImage | null = null
    try {
      ann = view.kind === 'full' ? await annotateGrid(shot.buffer) : await annotateZoom(shot.buffer, view.crop)
    } catch { ann = null }
    if (ann) { imgB64 = ann.b64; imgMime = ann.mime; som = { view, grid: ann.grid } }

    // 3) VLM 规划
    let raw = ''
    try {
      const hist = steps.length ? `\n此前进展:\n${steps.slice(-6).join('\n')}` : ''
      const vh = view.kind === 'zoom' ? '\n（当前为放大局部视图）' : ''
      raw = await callVisionModel(
        buildSysPrompt(step, maxSteps, som ?? undefined),
        `用户指令: ${instruction}${vh}${hist}\n\n这是第 ${step + 1}/${maxSteps} 步，请输出动作 JSON。`,
        imgB64, true, imgMime,
      )
    } catch (e: any) {
      steps.push(`❌ VLM调用失败(第${step + 1}步): ${e.message}`); break
    }

    const act = parseAction(raw)
    if (!act) { steps.push(`⚠️ VLM返回无法解析: ${raw.slice(0, 120)}；结束`); break }
    const grid = som?.grid ?? fallbackGrid

    // 4) 视图控制
    if (act.action_type === 'zoom') {
      const center = resolvePoint(act, grid, view)
      if (!center) { steps.push('⚠️ zoom 缺少有效目标(cell/nx,ny)'); continue }
      const span = Math.max(8, Math.min(60, num(act.span) ?? 25))
      view = { kind: 'zoom', crop: zoomCrop(center.nx, center.ny, span) }
      steps.push(`🔍 放大区域 (${center.nx.toFixed(0)},${center.ny.toFixed(0)}) span=${span}`)
      await sleep(120)
      continue
    }
    if (act.action_type === 'reset_view') { view = { kind: 'full' }; steps.push('↩️ 回到全屏视图'); continue }

    // 5) 批量动作：顺序执行，仅在最后回一帧
    if (act.action_type === 'batch' && Array.isArray(act.actions) && act.actions.length > 0) {
      const msgs: string[] = []
      let denied = false
      for (const sub of act.actions) {
        if (isCuAborted()) { steps.push('🛑 急停，批量动作中止'); denied = true; break }
        // 按“当前视图”映射坐标：全图 cell→全局；zoom 视图 cell/局部→自动换算回全屏
        if (!preparePoint(sub, grid, view)) { msgs.push('(某动作坐标无效，跳过)'); continue }
        const r = await executeCuAction(sub, viewOf(shot), { sessionId })
        msgs.push(r.msg)
        if (r.denied) { denied = true; break }
        await sleep(180)
      }
      view = { kind: 'full' }
      steps.push(`📦 批量: ${msgs.join('；')}`)
      if (denied) {break}
      await sleep(450)
      continue
    }

    if (act.action_type === 'done') { steps.push(`✅ 完成: ${act.summary || act.thought || '任务结束'}`); break }
    if (act.action_type === 'none') { steps.push(`⏸️ 无需操作: ${act.summary || act.thought || ''}`); break }

    // 6) 普通动作：cell/局部 → 全局，交统一内核执行
    if (isCuAborted()) { steps.push('🛑 已收到全局急停，立即停止'); break }
    if (!preparePoint(act, grid, view)) { steps.push('⚠️ 点击/拖拽缺少有效坐标(cell 或 nx,ny)，结束'); break }

    const result = await executeCuAction(act, viewOf(shot), { sessionId })
    steps.push(`📌 第${step + 1}步 ${act.thought || act.action_type} → ${result.msg}`)
    view = { kind: 'full' }
    if (result.denied) { steps.push('⛔ 命中高危硬拦截，终止本次操控'); break }
    if (!result.ok) { steps.push('⚠️ 操作失败，结束以避免连环误动作'); break }
    if (act.action_type !== 'wait') {await sleep(700)}
  }

  if (isCuAborted() && !steps.some(s => s.includes('急停'))) {steps.push('🛑 已急停')}
  const aborted = isCuAborted()
  return {
    callId: '',
    ok: !aborted,
    content: `🖥️ Computer Use 执行报告:\n任务: ${instruction}\n\n${steps.join('\n')}`,
    ...(aborted ? { error: '用户急停（Ctrl+Alt+X）' } : {}),
  }
}

// ═══════════════════════════════════════════════════════════
// v3.30 UIA 元素树工具（对标 cc-haha 可交互元素）
// ═══════════════════════════════════════════════════════════

/** desktop_elements：列出前台窗口可交互元素（名字/控件类型/坐标） */
export const desktopElementsDef: ToolDef = {
  name: 'desktop_elements',
  description: `扫描前台窗口的可交互 UI 元素树（Windows UI Automation）：按钮、输入框、标签页、菜单项等，
返回「[序号] 控件类型 名称/自动化ID @(归一化坐标)」。适合：
- 看不清截图、控件密集时点不准（用序号精确定位，比猜坐标可靠）；
- 操作前确认控件是否存在/是否禁用/焦点在谁身上。
扫描后用 desktop_element_act 按序号操作。该操作只读、不输入，默认放行。`,
  params: {},
  toolsets: ['agent', 'desktop', 'computer_use'],
}

export async function desktopElements(_args: Record<string, any> = {}): Promise<ToolResult> {
  let shot: CuScreen
  try {
    shot = await captureScreen({})
  } catch (e: any) {
    return { callId: '', ok: false, content: '', error: `截图失败: ${e.message}` }
  }
  const els = await getUiaCache().scan(shot.w, shot.h, shot.vx || 0, shot.vy || 0)
  return { callId: '', ok: true, content: renderElementsText(els) }
}

/** desktop_element_act：按元素 index 操作 */
export const desktopElementActDef: ToolDef = {
  name: 'desktop_element_act',
  description: `按 desktop_elements 返回的元素序号精确操作：
- action="click"（默认）：点击该元素中心；
- action="set_value" + text：把文本填入输入框。v3.31 起优先用 UIA ValuePattern 控件级直接赋值（不经过键盘与剪贴板，不吃焦点时序）；控件不支持时自动回退「点击聚焦→全选→粘贴」。
元素树可能随界面变化失效，失效时重新 desktop_elements 扫描。受写操作审批与急停保护。`,
  params: {
    index: { type: 'number', description: 'desktop_elements 返回的元素序号', required: true },
    action: { type: 'string', description: 'click 或 set_value', required: false },
    text: { type: 'string', description: 'set_value 时要填入的文本', required: false },
  },
  toolsets: ['agent', 'desktop', 'computer_use'],
  dangerous: true,
}

export async function desktopElementAct(args: Record<string, any>): Promise<ToolResult> {
  const index = Number(args.index)
  if (!Number.isFinite(index)) {
    return { callId: '', ok: false, content: '', error: '请提供 desktop_elements 返回的 index' }
  }
  const action = String(args.action || 'click')
  if (action !== 'click' && action !== 'set_value') {
    return { callId: '', ok: false, content: '', error: 'action 只能是 click 或 set_value' }
  }
  if (action === 'set_value' && (args.text == null || String(args.text) === '')) {
    return { callId: '', ok: false, content: '', error: 'set_value 需要 text 参数' }
  }

  const sessionId = `element_act_${Date.now()}`
  let locked = false
  try {
    locked = acquireCuSession(sessionId, 'agent desktop_element_act')
    if (!locked) {
      return {
        callId: '', ok: false,
        content: '🖥️ Computer Use 会话锁正被另一个操控任务占用，请稍后再试。',
        error: 'cu_session_busy',
      }
    }
  } catch { /* 锁模块异常不阻塞 */ }

  try {
    const shot = await captureScreen({ sessionId })
    // 元素树强制刷新（避免缓存过期点错）
    getUiaCache().clear()
    const els = await getUiaCache().scan(shot.w, shot.h, shot.vx || 0, shot.vy || 0)
    const el = els.find(e => e.index === index)
    if (!el) {
      return { callId: '', ok: false, content: '', error: `元素 index=${index} 已不在前台窗口，请重新 desktop_elements 扫描` }
    }
    if (action === 'set_value') {
      const text = String(args.text)
      // 0) 高危文本硬拦截（与 executeCuAction 同口径）
      const hard = destructiveReason(text)
      if (hard) {
        return {
          callId: '', ok: false,
          content: `🖥️ 元素操作被拦截 [${index}]：${hard}`,
          error: hard,
        }
      }
      // 1) 权限门（会话锁/前台分区/人机互斥，与键鼠动作同一套策略）
      const gate = await gateCuAction({ action_type: 'set_value', text } as any, { sessionId })
      if (!gate.allow) {
        return {
          callId: '', ok: false,
          content: `🖥️ 元素操作被拦截 [${index}]：${gate.reason}`,
          error: gate.reason || '权限拦截',
        }
      }
      // 2) 优先 ValuePattern 控件级赋值（元素 rect 是截图像素，加虚拟原点还原物理坐标）
      const physX = el.rect.x + el.rect.w / 2 + (shot.vx || 0)
      const physY = el.rect.y + el.rect.h / 2 + (shot.vy || 0)
      const v = await setValueByPoint(physX, physY, text)
      if (v.ok) {
        return {
          callId: '', ok: true,
          content: `🖥️ 元素操作: set_value [${index}] ${el.type} ${el.name || el.automationId || ''} → ValuePattern 直接赋值成功（${text.length} 字）`,
        }
      }
      // 3) 回退：点击聚焦 → 全选 → 粘贴
      const act: any = { action_type: 'set_value', nx: el.nx, ny: el.ny, text }
      const r = await executeCuAction(act, viewOf(shot), { sessionId })
      return {
        callId: '',
        ok: r.ok && !r.denied,
        content: `🖥️ 元素操作: set_value [${index}] ${el.type} ${el.name || el.automationId || ''} → ${r.msg}（ValuePattern 不可用：${v.reason}，已回退粘贴）`,
        ...(r.denied ? { error: r.denyReason || '权限拦截' } : r.ok ? {} : { error: r.msg }),
      }
    }

    const act: any = { action_type: 'click', nx: el.nx, ny: el.ny, wait_seconds: 0.2 }
    const r = await executeCuAction(act, viewOf(shot), { sessionId })
    return {
      callId: '',
      ok: r.ok && !r.denied,
      content: `🖥️ 元素操作: click [${index}] ${el.type} ${el.name || el.automationId || ''} → ${r.msg}`,
      ...(r.denied ? { error: r.denyReason || '权限拦截' } : r.ok ? {} : { error: r.msg }),
    }
  } catch (e: any) {
    return { callId: '', ok: false, content: '', error: e?.message || String(e) }
  } finally {
    if (locked) {try {releaseCuSession(sessionId)} catch { /* ignore */ }}
  }
}

export { parseUiaJson, normalizeElements }
