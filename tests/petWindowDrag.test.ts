// 新需求（2026-10-04）：Lumina Live2D 窗口「只能在窗口内移动，不能全屏自定义拖动」
//
// 根因：不是窗口太小，也不是 clamp 把位置卡死了，而是
// **整个页面没有任何 -webkit-app-region: drag 区域**。
//   · #pet-container 设了 no-drag
//   · #chat-panel .cp-head 写了 `cursor: move`（看起来像能拖），
//     但没配套 app-region: drag —— 纯视觉暗示，按住标题栏拖不动任何东西
//   · 角色能拖是因为 JS 在移动模型坐标（dragOffX/dragOffY），不是移动窗口
//
// 窗口本身（isCompact=false 时）是整个屏幕大小，所以一旦标题栏能拖，
// 面板就能在整块屏幕范围内自由摆放。
import { describe, it, expect } from 'vitest'
import fs from 'fs'

const html = fs.readFileSync('electron/pet/pet-live2d.html', 'utf-8')

describe('Live2D 窗口全屏拖动', () => {
  it('聊天面板标题栏是拖动区域', () => {
    const i = html.indexOf('#chat-panel .cp-head {')
    const block = html.slice(i, i + 700)
    expect(block).toMatch(/-webkit-app-region:\s*drag/)
  })

  it('标题栏内的按钮/输入必须 no-drag，否则按下去变成拖窗口而不是点击', () => {
    expect(html).toMatch(/#chat-panel \.cp-head \.cp-actions[\s\S]*?-webkit-app-region:\s*no-drag/)
    expect(html).toMatch(/#chat-panel \.cp-head button[\s\S]*?-webkit-app-region:\s*no-drag/)
  })

  it('页面别处仍是 no-drag（不能整体变可拖，否则模型点击全废）', () => {
    expect(html).toMatch(/#pet-container\s*\{[\s\S]*?-webkit-app-region:\s*no-drag/)
  })

  it('非 compact 模式下窗口本身就是整块屏幕（拖动范围=全屏）', () => {
    const src = fs.readFileSync('electron/pet/petWindow.ts', 'utf-8')
    expect(src).toMatch(/const winW = isCompact \? Math\.min\(PET_WINDOW_W, _wa\.width - 20\) : display\.bounds\.width/)
    expect(src).toMatch(/const winH = isCompact \? Math\.min\(PET_WINDOW_H, _wa\.height - 20\) : display\.bounds\.height/)
  })

  it('clamp 允许窗口压在任务栏上，且保留 48px 找回余量', () => {
    const src = fs.readFileSync('electron/pet/petWindow.ts', 'utf-8')
    expect(src).toMatch(/const KEEP = 48/)
  })
})
