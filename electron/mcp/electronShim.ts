// ============================================================
// electronShim.ts — 纯 Node 形态（MCP server）下的 electron 安全垫片
//
// 背景：对外 MCP server 以 ELECTRON_RUN_AS_NODE=1 运行，进程里没有真正的
// electron 运行时；但工具注册表的部分模块在「加载时」会 import electron。
// 本垫片提供：
//   1) 可工作的 app.getPath（数据目录落到用户目录，可被环境变量覆盖）；
//   2) 其余 GUI/IPC API 的安全空实现，保证模块加载不崩、误调用不炸。
// 真正需要 GUI/窗口/系统对话框的能力在 MCP 模式下不适用，调用得到空结果。
//
// 仅在 MCP server 打包时通过 esbuild --alias:electron 指向本文件，
// 不影响 Electron 主进程的真实 electron 模块。
// ============================================================

import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

const noop = () => {}
const asyncNoop = async () => undefined

// 数据根目录：优先环境变量，否则落到用户目录下的 .lumina
const dataRoot =
  process.env.LUMINA_DATA_DIR ||
  process.env.LUMINA_USERDATA ||
  path.join(os.homedir(), '.lumina')

try {
  fs.mkdirSync(dataRoot, { recursive: true })
} catch {
  // 目录创建失败时 getPath 仍返回路径，写入方会自行处理
}

function appDataDir(): string {
  if (process.env.APPDATA) {
    return process.env.APPDATA
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support')
  }
  return dataRoot
}

function getPath(name: string): string {
  const home = os.homedir()
  switch (name) {
    case 'home':
      return home
    case 'appData':
      return appDataDir()
    case 'userData':
      return dataRoot
    case 'temp':
      return os.tmpdir()
    case 'logs':
      return path.join(dataRoot, 'logs')
    case 'crashDumps':
      return path.join(dataRoot, 'crashdumps')
    case 'exe':
    case 'module':
      return process.execPath
    case 'documents':
      return path.join(home, 'Documents')
    case 'downloads':
      return path.join(home, 'Downloads')
    case 'desktop':
      return path.join(home, 'Desktop')
    case 'pictures':
      return path.join(home, 'Pictures')
    case 'music':
      return path.join(home, 'Music')
    case 'videos':
      return path.join(home, 'Videos')
    case 'recent':
      return appDataDir()
    case 'sessionData':
      return path.join(dataRoot, 'sessions')
    default:
      return dataRoot
  }
}

class StubClass {
  static getAllWindows(): unknown[] {
    return []
  }
  static getFocusedWindow(): null {
    return null
  }
  constructor() {
    // 任意方法都安全为空
    return new Proxy(this, {
      get(target, prop) {
        if (prop in target) {
          return (target as Record<string | symbol, unknown>)[prop]
        }
        return noop
      },
    })
  }
}

const app = {
  getPath,
  setPath: noop,
  getVersion: () => process.env.npm_package_version || '0.0.0',
  getName: () => 'Lumina',
  setName: noop,
  getLocale: () => process.env.LANG || 'en-US',
  getSystemLocale: () => process.env.LANG || 'en-US',
  getLocaleCountryCode: () => 'US',
  isReady: () => true,
  whenReady: () => Promise.resolve(),
  on: () => app,
  once: () => app,
  off: () => app,
  addListener: () => app,
  removeListener: () => app,
  emit: () => false,
  quit: noop,
  exit: noop,
  relaunch: noop,
  focus: noop,
  hide: noop,
  show: noop,
  isHidden: () => false,
  requestSingleInstanceLock: () => true,
  hasSingleInstanceLock: () => true,
  releaseSingleInstanceLock: noop,
  disableHardwareAcceleration: noop,
  disableDomainBlocking: noop,
  setAppUserModelId: noop,
  setBadgeCount: () => true,
  getBadgeCount: () => 0,
  isUnityRunning: () => false,
  getLoginItemSettings: () => ({ openAtLogin: false, argsAsStr: '' }),
  setLoginItemSettings: noop,
  getFileIcon: asyncNoop,
  getAppPath: () => dataRoot,
  commandLine: {
    appendSwitch: noop,
    appendArgument: noop,
    hasSwitch: () => false,
    getSwitchValue: () => '',
  },
  dock: {
    bounce: noop,
    cancelBounce: noop,
    downloadFinished: noop,
    setBadge: noop,
    getBadge: () => '',
    hide: noop,
    show: () => Promise.resolve(),
    setMenu: noop,
    getMenu: () => null,
  },
}

const ipcMain = {
  on: noop,
  once: noop,
  off: noop,
  removeAllListeners: noop,
  handle: noop,
  handleOnce: noop,
  removeHandler: noop,
}

const ipcRenderer = {
  on: noop,
  once: noop,
  off: noop,
  send: noop,
  invoke: asyncNoop,
  sendSync: () => undefined,
  sendTo: noop,
  postMessage: noop,
  removeListener: noop,
}

const contextBridge = {
  exposeInMainWorld: noop,
}

const dialog = {
  showMessageBox: async () => ({ response: 0, checkboxChecked: false }),
  showMessageBoxSync: () => 0,
  showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  showOpenDialogSync: () => [],
  showSaveDialog: async () => ({ canceled: true, filePath: undefined }),
  showSaveDialogSync: () => undefined,
  showErrorBox: noop,
  showCertificateTrustDialog: asyncNoop,
}

const screen = {
  getPrimaryDisplay: () => ({
    id: 1,
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    workArea: { x: 0, y: 0, width: 1920, height: 1040 },
    scaleFactor: 1,
    rotation: 0,
    touchSupport: 'unknown',
    accelerometerSupport: 'unknown',
    colorDepth: 24,
    colorSpace: '{primaries:D65}',
    size: { width: 1920, height: 1080 },
    workAreaSize: { width: 1920, height: 1040 },
  }),
  getAllDisplays: () => [],
  getDisplayNearestPoint: () => screen.getPrimaryDisplay(),
  getDisplayMatching: () => screen.getPrimaryDisplay(),
  getCursorScreenPoint: () => ({ x: 0, y: 0 }),
  screenToDipPoint: (p: unknown) => p,
  dipToScreenPoint: (p: unknown) => p,
  on: noop,
  once: noop,
  off: noop,
}

const shell = {
  openExternal: async () => '' as unknown,
  openPath: async () => '',
  showItemInFolder: noop,
  trashItem: async () => undefined,
  beep: noop,
  writeShortcutLink: noop,
  readShortcutLink: () => ({}),
}

const clipboard = {
  readText: () => '',
  writeText: noop,
  readHTML: () => '',
  writeHTML: noop,
  readImage: () => ({}),
  writeImage: noop,
  readRTF: () => '',
  writeRTF: noop,
  clear: noop,
  availableFormats: () => [],
  has: () => false,
  read: () => '',
  write: noop,
}

const globalShortcut = {
  register: () => true,
  unregister: noop,
  unregisterAll: noop,
  isRegistered: () => false,
}

const nativeImage = {
  createEmpty: () => ({}),
  createFromPath: () => ({}),
  createFromBitmap: () => ({}),
  createFromBuffer: () => ({}),
  createFromDataURL: () => ({}),
  createFromNamedImage: () => ({}),
}

const session = {
  defaultSession: new Proxy({}, { get: () => noop }),
  fromPartition: () => new Proxy({}, { get: () => noop }),
  fromPath: () => new Proxy({}, { get: () => noop }),
}

const safeStorage = {
  isEncryptionAvailable: () => false,
  encryptString: (s: string) => Buffer.from(s),
  decryptString: (b: Buffer) => b.toString(),
}

const nativeTheme = {
  shouldUseDarkColors: false,
  shouldUseHighContrastColors: false,
  shouldUseInvertedColorScheme: false,
  themeSource: 'light' as string,
  on: noop,
  once: noop,
  off: noop,
}

const powerMonitor = {
  on: noop,
  once: noop,
  off: noop,
  getSystemIdleTime: () => 0,
  getSystemIdleState: () => 'active',
  getCurrentThermalState: () => 'nominal',
  isOnBatteryPower: () => false,
}

export {
  app,
  ipcMain,
  ipcRenderer,
  contextBridge,
  dialog,
  screen,
  shell,
  clipboard,
  globalShortcut,
  nativeImage,
  session,
  safeStorage,
  nativeTheme,
  powerMonitor,
}

export const BrowserWindow = StubClass
export const Tray = StubClass
export const Menu = {
  buildFromTemplate: () => ({}),
  setApplicationMenu: noop,
  getApplicationMenu: () => null,
  popup: noop,
}
export const MenuItem = StubClass
export const Notification = StubClass
export const webContents = {
  fromId: () => ({}),
  getAllWebContents: () => [],
  getFocusedWebContents: () => null,
}
export const crashReporter = { start: noop, getCrashesDirectory: () => getPath('crashDumps') }
export const contentTracing = {
  startRecording: asyncNoop,
  stopRecording: async () => '',
  getCategories: async () => [],
  getTraceBufferUsage: async () => 0,
}
export const desktopCapturer = {
  getSources: async () => [],
}
export const systemPreferences = {
  subscribeNotification: noop,
  unsubscribeNotification: noop,
  getUserDefault: () => null,
  getMediaAccessStatus: () => 'granted',
  askForMediaAccess: async () => true,
}
export const inAppPurchase = {
  purchaseProduct: asyncNoop,
  getProducts: async () => [],
  canMakePayments: () => true,
}
export const net = {
  request: () => {
    const obj: Record<string, unknown> = {
      on: noop,
      write: noop,
      end: noop,
      abort: noop,
    }
    return obj
  },
  fetch: async () => ({ ok: false, status: 0, json: asyncNoop, text: async () => '' }),
}
export const webFrame = {
  setZoomFactor: noop,
  getZoomFactor: () => 1,
  setZoomLevel: noop,
  getZoomLevel: () => 0,
}
export const webUtils = {
  getPathForFile: () => '',
}
