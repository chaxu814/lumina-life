// ============================================================
// trayMenu.ts — 自定义圆角浮层托盘菜单（仿 ATK X1 Ultra 风格）
//
// 替换 Electron 原生 Tray.setContextMenu：
//   - 无边框 BrowserWindow 浮层，圆角卡片 + 阴影 + 毛玻璃
//   - 顶部：Lumina 圆形图标 + 名称 + 状态指示器
//   - 菜单项：显示/隐藏、设置、任务工作区、游戏陪伴开关、退出
//   - 失焦自动关闭（blur + 全局点击兜底）
//   - 位置跟随托盘图标（Windows 上方弹出 / macOS 下方弹出）
//
// 边界：
//   - 本模块不碰 petWindow、团队协作、i18n
//   - 任务工作区菜单项先尝试 IPC，未注册则前端提示"即将推出"
//   - 浮层真实渲染与托盘坐标未实机验证（诚实披露）
// ============================================================
import {
  BrowserWindow,
  Tray,
  ipcMain,
  screen,
  app,
} from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'

// ─── 类型 ─────────────────────────────────────────────────

export interface TrayMenuState {
  /** 是否在线（主窗口可见/进程存活即视为在线） */
  online: boolean
  /** 当前情绪文字，例如 "兴奋" / "开心" */
  mood: string
  /** 情绪/状态圆点颜色（CSS color） */
  moodColor: string
  /** 顶部右侧状态文字，例如 "95%" / "在线" */
  statusText: string
  /** 游戏陪伴开关是否开启 */
  gameEnabled: boolean
  /** 主窗口当前是否可见 */
  windowVisible: boolean
}

export interface TrayMenuActions {
  /** 切换主窗口显示/隐藏 */
  toggleMainWindow: () => void
  /** 打开设置 */
  openSettings: () => void
  /** 打开任务工作区（未接入时由主进程提示"即将推出"） */
  openTaskWorkspace: () => void
  /** 切换游戏陪伴开关，返回切换后的布尔值 */
  toggleGame: () => boolean
  /** 退出应用 */
  quit: () => void
}

export interface TrayMenuOptions {
  actions: TrayMenuActions
  /** 提供最新状态；每次 show 时调用一次 */
  getState: () => TrayMenuState
}

// ─── 常量 ─────────────────────────────────────────────────

const MENU_WIDTH = 248
const MENU_HEIGHT = 332
const POPUP_GAP = 6 // 与托盘图标的间距(px)

// ─── 模块级单例 ───────────────────────────────────────────

let menuWindow: BrowserWindow | null = null
let boundTray: Tray | null = null
let options: TrayMenuOptions | null = null
let ipcRegistered = false

// ─── 路径解析（dev / build / 打包后都能找到） ──────────────

function resolveTrayMenuHtml(): string {
  const candidates = [
    join(__dirname, 'trayMenu.html'),                 // out/main/trayMenu.html
    join(__dirname, '..', 'electron', 'tray', 'trayMenu.html'), // dev
    join(__dirname, '..', '..', 'electron', 'tray', 'trayMenu.html'),
    join(process.cwd(), 'electron', 'tray', 'trayMenu.html'),
  ]
  for (const c of candidates) {
    if (c && existsSync(c)) { return c }
  }
  return join(__dirname, 'trayMenu.html')
}

function resolveTrayMenuPreload(): string {
  const candidates = [
    join(__dirname, '..', 'preload', 'trayMenu.js'),  // out/preload/trayMenu.js
    join(__dirname, '..', '..', 'out', 'preload', 'trayMenu.js'),
    join(process.cwd(), 'out', 'preload', 'trayMenu.js'),
  ]
  for (const c of candidates) {
    if (c && existsSync(c)) { return c }
  }
  return join(__dirname, '..', 'preload', 'trayMenu.js')
}

// ─── 位置计算 ──────────────────────────────────────────────

export interface PopupPosition {
  x: number
  y: number
  width: number
  height: number
}

/**
 * 根据托盘图标 bounds 计算浮层窗口位置。
 * - Windows/Linux：托盘在屏幕底部 → 浮层在图标上方，右对齐图标
 * - macOS：菜单栏在顶部 → 浮层在图标下方，水平居中于图标
 * 结果夹取在最近显示器的 workArea 内。
 */
export function calcPopupPosition(
  trayBounds: { x: number; y: number; width: number; height: number },
  width: number = MENU_WIDTH,
  height: number = MENU_HEIGHT,
  platform: NodeJS.Platform = process.platform,
): PopupPosition {
  const display = screen.getDisplayNearestPoint({
    x: trayBounds.x + trayBounds.width / 2,
    y: trayBounds.y + trayBounds.height / 2,
  })
  const wa = display.workArea

  let x: number
  let y: number

  if (platform === 'darwin') {
    // 菜单栏顶部：浮层在图标下方，水平居中
    x = trayBounds.x + trayBounds.width / 2 - width / 2
    y = trayBounds.y + trayBounds.height + POPUP_GAP
  } else {
    // Windows/Linux 系统托盘：浮层在图标上方，右对齐图标右边缘
    x = trayBounds.x + trayBounds.width - width
    y = trayBounds.y - height - POPUP_GAP
  }

  // 夹取到 workArea
  x = Math.max(wa.x, Math.min(x, wa.x + wa.width - width))
  y = Math.max(wa.y, Math.min(y, wa.y + wa.height - height))

  return { x: Math.round(x), y: Math.round(y), width, height }
}

// ─── IPC ──────────────────────────────────────────────────

function registerIpc(): void {
  if (ipcRegistered) { return }
  ipcRegistered = true

  // 渲染进程请求最新状态
  ipcMain.handle('trayMenu:get-state', () => {
    if (!options) { return defaultState() }
    return options.getState()
  })

  // 渲染进程触发菜单项
  ipcMain.on('trayMenu:menu-click', (_e, action: string) => {
    if (!options) { return }
    switch (action) {
      case 'toggle-main':
        options.actions.toggleMainWindow()
        break
      case 'open-settings':
        options.actions.openSettings()
        break
      case 'open-task-workspace':
        options.actions.openTaskWorkspace()
        break
      case 'toggle-game':
        options.actions.toggleGame()
        break
      case 'quit':
        options.actions.quit()
        break
      default:
        break
    }
    // 菜单项点击后关闭浮层（退出除外，退出会直接关进程）
    if (action !== 'quit') {
      hideTrayMenu()
    }
  })
}

function defaultState(): TrayMenuState {
  return {
    online: true,
    mood: '在线',
    moodColor: '#4ade80',
    statusText: '在线',
    gameEnabled: false,
    windowVisible: true,
  }
}

// ─── 窗口生命周期 ─────────────────────────────────────────

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: MENU_WIDTH,
    height: MENU_HEIGHT,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    // macOS 阴影由 CSS/窗口合成器提供；Windows 下透明窗口阴影需额外 dwm，这里先靠 CSS 投影
    webPreferences: {
      preload: resolveTrayMenuPreload(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  win.loadFile(resolveTrayMenuHtml()).catch((err) => {
    console.error('[trayMenu] loadFile failed:', err)
  })

  // 失焦自动关闭
  win.on('blur', () => {
    // 延迟一帧，避免点击托盘图标触发显示后立刻被自己的 blur 关掉
    setTimeout(() => {
      if (menuWindow && !menuWindow.isDestroyed() && !menuWindow.isFocused()) {
        menuWindow.hide()
      }
    }, 120)
  })

  win.on('closed', () => {
    if (menuWindow === win) { menuWindow = null }
  })

  return win
}

// ─── 公开 API ──────────────────────────────────────────────

/**
 * 绑定托盘与动作。不立即显示，等待托盘点击触发 showTrayMenu。
 */
export function createTrayMenu(tray: Tray, opts: TrayMenuOptions): void {
  boundTray = tray
  options = opts
  registerIpc()
}

/** 计算位置并显示浮层；若窗口不存在则创建。 */
export function showTrayMenu(): void {
  if (!boundTray) { return }
  let bounds: { x: number; y: number; width: number; height: number }
  try {
    bounds = boundTray.getBounds()
  } catch {
    return
  }

  if (!menuWindow || menuWindow.isDestroyed()) {
    menuWindow = createWindow()
  }

  const pos = calcPopupPosition(bounds)
  menuWindow.setPosition(pos.x, pos.y, false)
  menuWindow.setSize(pos.width, pos.height)

  // 先刷新状态再显示，保证顶部指示器是最新的
  menuWindow.webContents.once('did-finish-load', () => {
    pushState(menuWindow)
  })
  // 如果已经加载过（复用窗口），直接推一次
  if (menuWindow.webContents.isLoadingMainFrame() === false) {
    pushState(menuWindow)
  }

  menuWindow.showInactive()
  menuWindow.focus()
}

import { pushThemeToWindow } from '../ipc/themeIpc'

function pushState(win: BrowserWindow | null): void {
  if (win && !win.isDestroyed()) { try { pushThemeToWindow(win) } catch { /* ignore */ } }
  if (!win || win.isDestroyed()) { return }
  const state = options ? options.getState() : defaultState()
  win.webContents.send('trayMenu:state', state)
}

/** 隐藏浮层。 */
export function hideTrayMenu(): void {
  if (menuWindow && !menuWindow.isDestroyed()) {
    menuWindow.hide()
  }
}

/** 浮层当前是否可见。 */
export function isTrayMenuVisible(): boolean {
  return !!menuWindow && !menuWindow.isDestroyed() && menuWindow.isVisible()
}

/** 仅用于测试/调试：取到内部窗口实例。 */
export function getTrayMenuWindow(): BrowserWindow | null {
  return menuWindow
}

/** 退出时清理。 */
export function disposeTrayMenu(): void {
  if (menuWindow && !menuWindow.isDestroyed()) {
    menuWindow.close()
  }
  menuWindow = null
  boundTray = null
  options = null
}

// 应用退出时兜底清理
app?.on?.('before-quit', () => { disposeTrayMenu() })
