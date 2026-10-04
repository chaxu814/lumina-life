// 图2：Live2D 出现两个窗口（用户称之为「两派」）
//
// 根因不是渲染错位，而是同一功能有两套实现 + 触发路径还不一样：
//   · 点角色身体 / 快捷键 / 工具栏 / intent 'chat' → ipc.invoke('pet:open-chat-window')
//     弹出独立 BrowserWindow（屏幕右侧）
//   · 主动搭话 / 追问 / 生命视图                → toggleChat(true) 内嵌面板（左侧）
// 于是主窗口已经有面板时，右侧又弹一个，像是两个程序在跑。
import { describe, it, expect } from 'vitest'
import fs from 'fs'

const live2d = fs.readFileSync('electron/pet/pet-live2d.html', 'utf-8')
const petWin = fs.readFileSync('electron/pet/petWindow.ts', 'utf-8')

describe('Live2D 单窗口化', () => {
  it('openChatWindow 不再弹独立窗口', () => {
    const fn = live2d.slice(
      live2d.indexOf('function openChatWindow'),
      live2d.indexOf('function openChatWindow') + 300,
    )
    expect(fn).not.toMatch(/pet:open-chat-window/)
    expect(fn).toMatch(/toggleChat\(true\)/)
  })

  it('没有任何地方再 invoke 独立聊天窗 IPC', () => {
    expect(live2d).not.toMatch(/invoke\('pet:open-chat-window'\)/)
  })

  it('内嵌面板本身仍然完整（面板、提交、关闭都还在）', () => {
    expect(live2d).toMatch(/function toggleChat\(force\)/)
    expect(live2d).toMatch(/function submitChat\(\)/)
    expect(live2d).toMatch(/chat-panel/)
  })

  it('主动搭话等路径仍走同一个面板（三处）', () => {
    const calls = (live2d.match(/if \(!chatOpenNow\(\)\) toggleChat\(true\);/g) || []).length
    expect(calls).toBeGreaterThanOrEqual(3)
  })

  it('启用桌宠时关闭残留的独立聊天窗', () => {
    const idx = petWin.indexOf('export function togglePet')
    const block = petWin.slice(idx, idx + 700)
    expect(block).toMatch(/closePetChatWindow\(\)/)
  })

  it('主进程仍保留 pet:open-chat-window handler（不删 API，避免破坏 preload 契约）', () => {
    expect(petWin).toMatch(/ipcMain\.handle\('pet:open-chat-window'/)
  })
})
