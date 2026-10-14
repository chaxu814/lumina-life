// Live2D 独立聊天窗与主动搭话选项的交互契约。
// 桌宠是透明且可能穿透鼠标的窗口；可见卡片必须使窗口接管鼠标，
// 用户点击选项后要打开聊天窗、显示所选内容并转发给主 Agent。
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'

const live2d = fs.readFileSync('electron/pet/pet-live2d.html', 'utf-8')
const petWin = fs.readFileSync('electron/pet/petWindow.ts', 'utf-8')

describe('Live2D 独立聊天窗与主动卡片交互', () => {
  it('聊天入口打开独立 BrowserWindow，而非恢复内嵌面板', () => {
    const start = live2d.indexOf('function openChatWindow')
    const fn = live2d.slice(start, start + 400)
    expect(start).toBeGreaterThan(-1)
    expect(fn).toMatch(/pet:open-chat-window/)
    expect(fn).not.toMatch(/toggleChat\(true\)/)
    expect(petWin).toMatch(/ipcMain\.handle\('pet:open-chat-window'/)
  })

  it('内嵌聊天 DOM 已移除，避免两套聊天 UI 互相冲突', () => {
    expect(live2d).not.toMatch(/<div[^>]+id=["']chat-panel["']/)
    expect(live2d).not.toMatch(/<input[^>]+id=["']pet-chat-input["']/)
    expect(live2d).not.toMatch(/<button[^>]+id=["']pet-chat-send["']/)
  })

  it('显示主动搭话卡片时立即解除 Electron 鼠标穿透', () => {
    const start = live2d.indexOf('function showProactiveCard')
    const end = live2d.indexOf('function addChatOptions', start)
    const fn = live2d.slice(start, end)
    expect(fn).toMatch(/card\.classList\.add\('show'\)/)
    expect(fn).toMatch(/pet:set-ignore-mouse', false/)
  })

  it('命中主动卡片/生活菜单时保持窗口可交互，不能再穿透到桌面', () => {
    const start = live2d.indexOf('function overAnyUI')
    const end = live2d.indexOf('function inInteractiveZone', start)
    const fn = live2d.slice(start, end)
    expect(fn).toMatch(/proactive\.classList\.contains\('show'\).*isMouseOverEl\(proactive\)/s)
    expect(fn).toMatch(/lifeMenu\.classList\.contains\('show'\).*isMouseOverEl\(lifeMenu\)/s)
  })

  it('点击 A/B/C 会打开聊天窗、回显所选选项，并转发给主 Agent', () => {
    const start = live2d.indexOf('function replyProactive')
    const end = live2d.indexOf('function positionProactiveCard', start)
    const fn = live2d.slice(start, end)
    expect(fn).toMatch(/pet:open-chat-window/)
    expect(fn).toMatch(/pet:sync-reply', \{ text, role: 'user' \}/)
    expect(fn).toMatch(/pet:sync-send', \{ text \}/)
  })

  it('主进程仍将 pet:sync-send 转给主窗口，并为独立聊天窗路由回复', () => {
    expect(petWin).toMatch(/ipcMain\.on\('pet:sync-send'/)
    expect(petWin).toMatch(/target\.webContents\.send\('pet:sync-message'/)
    // 🔧 2026-10-13：转发方式改为经 sendWhenReady()——聊天窗「已创建但页面未加载完」
    //   时要等 did-finish-load 再发，否则首次点角色头顶卡片选项的消息会静默丢失。
    //   路由优先级不变：独立聊天窗 > 桌宠窗。
    expect(petWin).toMatch(/sendWhenReady\(petChatWindow, 'pet:sync-reply'/)
  })
})
