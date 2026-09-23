// ============================================================
// electron/gaming/visualRoute.ts — 路线1：视觉路线（截图 + VLM + cuCore）
//
// 复用既有 cuCore 原语：
//   - captureScreen() / callVisionModel()  —— 截屏与 VLM 识别
//   - cuPressKey() / cuClick() / executeCuAction() —— 键鼠操作（走平台适配器 + 安全门）
//
// 游戏特有的两个原语（持续按键移动 / 相对鼠标视角）：
//   桌面自动化只需要「点一下」，而 Minecraft 需要「按住 W 走 1 秒」和
//   「相对移动鼠标转动视角」。这两个原语是游戏场景专属，隔离在本文件，
//   不改动通用 cuCore 与平台适配器接口。
// ============================================================

import * as cp from 'child_process'
import * as os from 'os'
import * as fs from 'fs'
import * as path from 'path'
import {
  captureScreen,
  callVisionModel,
  cuPressKey,
  type CuView,
} from '../tools/impl/cuCore'
import { getPlatformAdapter } from '../core/platform'
import { GAME_VLM_SYSTEM_PROMPT, parseVlmGameState, formatGameState } from './gameState'
import type { GameActionRequest, GameActionResult, GameConfig, GameState } from './types'

// ──────────────────────────────────────────────────────────
// 游戏专属原语（持续按键 / 相对鼠标）
// ──────────────────────────────────────────────────────────

function runPS(lines: string[], timeout = 8000): Promise<string> {
  const ps1 = path.join(os.tmpdir(), `lu-game-${Date.now()}-${Math.round(Math.random() * 1e6)}.ps1`)
  return new Promise<string>((resolve) => {
    try { fs.writeFileSync(ps1, lines.join('\n'), 'utf-8') }
    catch (e: any) { return resolve(`ERR:write:${e.message}`) }
    cp.execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1],
      { timeout, windowsHide: true },
      (err, stdout, stderr) => {
        try { fs.unlinkSync(ps1) } catch {}
        if (err) { resolve(`ERR:${err.message}|${String(stderr).slice(0, 80)}`) }
        else { resolve(String(stdout).trim()) }
      })
  })
}

/** 虚拟键码映射（游戏常用键） */
const VK_CODES: Record<string, number> = {
  w: 0x57, a: 0x41, s: 0x53, d: 0x44,
  space: 0x20, shift: 0x10, e: 0x45, t: 0x54, enter: 0x0D,
  '1': 0x31, '2': 0x32, '3': 0x33, '4': 0x34, '5': 0x35,
  '6': 0x36, '7': 0x37, '8': 0x38, '9': 0x39,
}

/**
 * 按住某键 durationMs 毫秒后松开（游戏移动需要持续按键）。
 * Windows 走 keybd_event；其它平台退化为点按（best-effort）。
 */
export async function holdKey(key: string, durationMs: number): Promise<string> {
  const ms = Math.max(50, Math.min(5000, Math.floor(durationMs || 500)))
  if (process.platform !== 'win32') {
    // 非 Windows：退化为点按一次（短移动近似）
    await cuPressKey(key)
    return `非 Windows 平台，退化为点按 ${key}`
  }
  const vk = VK_CODES[key.toLowerCase()]
  if (vk == null) {
    // 未知键码 → 走通用点按
    await cuPressKey(key)
    return `键码未知，退化为点按 ${key}`
  }
  const r = await runPS([
    'Add-Type @"',
    'using System;using System.Runtime.InteropServices;',
    'public class GK{',
    '[DllImport("user32.dll")]public static extern void keybd_event(byte vk,byte s,uint f,IntPtr e);',
    '}',
    '"@",',
    `[GK]::keybd_event(${vk},0,0,[IntPtr]::Zero)`,           // down
    `Start-Sleep -Milliseconds ${ms}`,
    `[GK]::keybd_event(${vk},0,2,[IntPtr]::Zero)`,           // up (KEYEVENTF_KEYUP=0x2)
    "Write-Output 'OK'",
  ])
  return r.startsWith('ERR') ? `按住按键失败: ${r.slice(4)}` : `按住 ${key} ${ms}ms`
}

/**
 * 相对移动鼠标（转动游戏视角）。dx/dy 为像素级相对偏移。
 * Windows 走 mouse_event MOUSEEVENTF_MOVE；其它平台返回提示。
 */
export async function mouseDelta(dx: number, dy: number): Promise<string> {
  if (process.platform !== 'win32') {
    return '⚠️ 当前平台不支持相对鼠标移动（视角转动仅在 Windows 实现）'
  }
  const rx = Math.round(dx), ry = Math.round(dy)
  const r = await runPS([
    'Add-Type @"',
    'using System;using System.Runtime.InteropServices;',
    'public class GM{',
    '[DllImport("user32.dll")]public static extern void mouse_event(uint f,int dx,int dy,uint d,IntPtr e);',
    '}',
    '"@",',
    // MOUSEEVENTF_MOVE=0x0001
    `[GM]::mouse_event(1,${rx},${ry},0,[IntPtr]::Zero)`,
    "Write-Output 'OK'",
  ])
  return r.startsWith('ERR') ? `相对鼠标移动失败: ${r.slice(4)}` : `鼠标相对移动 (${rx},${ry})`
}

// ──────────────────────────────────────────────────────────
// 视觉路线：观察游戏状态
// ──────────────────────────────────────────────────────────

/**
 * 截取游戏画面并用 VLM 识别游戏状态。
 * 优先尝试前台窗口为 Minecraft，退化为全屏截图。
 */
export async function visualSee(config: GameConfig, windowTitle?: string): Promise<GameState> {
  const title = (windowTitle || config.windowTitle).trim()

  // 尝试确认前台窗口（仅用于提示，不强制）
  let activeTitle: string | undefined
  try {
    const aw = await getPlatformAdapter().getActiveWindow()
    activeTitle = aw?.title
  } catch { /* best-effort */ }

  let shot
  try {
    shot = await captureScreen()
  } catch (e: any) {
    const s: GameState = { detected: false, hotbar: [] }
    ;(s as any).error = `截图失败: ${e?.message || e}`
    return s
  }

  try {
    const usr = `请分析这张游戏截图${title ? `（窗口标题包含「${title}」）` : ''}。`
      + (activeTitle ? `当前前台窗口: ${activeTitle}` : '')
    const raw = await callVisionModel(GAME_VLM_SYSTEM_PROMPT, usr, shot.b64, true)
    const state = parseVlmGameState(raw)
    if (title && !state.windowTitle) { state.windowTitle = activeTitle || title }
    return state
  } catch (e: any) {
    const s: GameState = { detected: false, hotbar: [] }
    ;(s as any).error = `VLM 分析失败: ${e?.message || e}`
    return s
  }
}

// ──────────────────────────────────────────────────────────
// 视觉路线：执行动作
// ──────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/** 把动作映射到 cuCore 键鼠原语。调用前已通过 security 审查。 */
export async function visualAct(req: GameActionRequest): Promise<GameActionResult> {
  const dur = Math.max(50, Math.min(5000, Math.floor(req.durationMs ?? 500)))
  const action = req.action

  switch (action) {
    case 'move_forward':
    case 'move_back':
    case 'move_left':
    case 'move_right': {
      const keyMap: Record<string, string> = {
        move_forward: 'w', move_back: 's', move_left: 'a', move_right: 'd',
      }
      const msg = await holdKey(keyMap[action], dur)
      return { ok: true, content: `🏃 ${action} ${dur}ms — ${msg}`, route: 'visual' }
    }
    case 'jump': {
      const msg = await holdKey('space', 200)
      return { ok: true, content: `🦘 跳跃 — ${msg}`, route: 'visual' }
    }
    case 'sneak': {
      const msg = await holdKey('shift', dur)
      return { ok: true, content: `🥷 潜行 ${dur}ms — ${msg}`, route: 'visual' }
    }
    case 'select_slot': {
      const msg = await cuPressKey(String(req.slot))
      return { ok: true, content: `🎒 切换到槽位 ${req.slot} — ${msg}`, route: 'visual' }
    }
    case 'inventory': {
      const msg = await cuPressKey('e')
      return { ok: true, content: `🎒 打开/关闭背包 — ${msg}`, route: 'visual' }
    }
    case 'attack': {
      // 攻击 = 鼠标左键（对准准星，即屏幕中心）
      const view: CuView = { imgW: 100, imgH: 100 }
      const { executeCuAction } = await import('../tools/impl/cuCore')
      const r = await executeCuAction(
        { action_type: 'click', nx: 50, ny: 50 },
        view,
        { sessionId: `game_${Date.now()}` },
      )
      return {
        ok: r.ok && !r.denied,
        content: `⚔️ 攻击（左键准星）— ${r.msg}`,
        ...(r.denied ? { error: r.denyReason || '权限拦截' } : {}),
        route: 'visual',
      }
    }
    case 'use':
    case 'place': {
      // 使用/放置 = 鼠标右键
      const view: CuView = { imgW: 100, imgH: 100 }
      const { executeCuAction } = await import('../tools/impl/cuCore')
      const r = await executeCuAction(
        { action_type: 'right_click', nx: 50, ny: 50 },
        view,
        { sessionId: `game_${Date.now()}` },
      )
      return {
        ok: r.ok && !r.denied,
        content: `🖱️ ${action === 'place' ? '放置' : '使用'}（右键准星）— ${r.msg}`,
        ...(r.denied ? { error: r.denyReason || '权限拦截' } : {}),
        route: 'visual',
      }
    }
    case 'chat': {
      // 按 T 打开聊天 → 输入文本 → 回车
      const text = (req.text || '').trim()
      await cuPressKey('t')
      await sleep(120)
      const { cuType } = await import('../tools/impl/cuCore')
      await cuType(text)
      await sleep(80)
      await cuPressKey('enter')
      return { ok: true, content: `💬 发送聊天: ${text}`, route: 'visual' }
    }
    case 'look_at': {
      // 相对鼠标移动。yaw/pitch 绝对角 → 用 delta 近似；优先用 deltaX/deltaY。
      let dx = Number(req.deltaX ?? 0)
      let dy = Number(req.deltaY ?? 0)
      if ((!Number.isFinite(dx) || dx === 0) && req.yaw != null) {
        // 粗略：1 度 ≈ 1.5 像素（灵敏度默认）
        dx = Number(req.yaw) * 1.5
      }
      if ((!Number.isFinite(dy) || dy === 0) && req.pitch != null) {
        dy = Number(req.pitch) * 1.5
      }
      if (!Number.isFinite(dx)) {dx = 0}
      if (!Number.isFinite(dy)) {dy = 0}
      const msg = await mouseDelta(dx, dy)
      return { ok: true, content: `👁️ 视角调整 (${dx.toFixed(0)},${dy.toFixed(0)}) — ${msg}`, route: 'visual' }
    }
    case 'craft': {
      // 视觉路线难以可靠合成（需要 VLM 定位网格），给出明确提示
      return {
        ok: false,
        content: '⚠️ 视觉路线不支持精确合成（craft）。请配置 Mineflayer 程序化路线以可靠合成。',
        error: 'craft_unsupported_visual',
        route: 'visual',
      }
    }
    default:
      return { ok: false, content: `未知游戏动作: ${action}`, error: 'unknown_action', route: 'visual' }
  }
}

export { formatGameState }
