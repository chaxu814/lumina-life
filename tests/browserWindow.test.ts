// ============================================================
// tests/browserWindow.test.ts
//
// 内置浏览器的**架构守卫**。
//
// 这套东西坏过一次，症状是用户看到「打开就是一片空白，地址栏写着
// file:///.../browser.html，标题栏一堆重复的「— Lumina 浏览器」」，
// 而代码看起来每一步都"合理"。根因是把角色搞反了：
//
//   BrowserWindow.webContents  →  只是工具栏宿主页，**永不导航**
//   <webview>                   →  真正的网页本体
//
// 早前 navigate() 直接 win.loadURL(网页)，于是一导航整个窗口就被目标页
// 替换、工具栏消失；地址栏读的是宿主页自己的 file:// 地址；标题每次
// page-title-updated 就再拼一次后缀，无限重复；Agent 的 browser_read
// 读到的全是工具栏自己的文字。
//
// browserWindow.ts 顶层 import electron，Node 测试环境引不进来，
// 所以这里做源码级断言 + 把页面里的标题逻辑抽出来实跑。
// ============================================================

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const browserDir = join(__dirname, '..', 'electron', 'browser')
const winSrc = readFileSync(join(browserDir, 'browserWindow.ts'), 'utf-8')
const html = readFileSync(join(browserDir, 'browser.html'), 'utf-8')
const preloadSrc = readFileSync(join(browserDir, 'browserPreload.ts'), 'utf-8')
const mainSrc = readFileSync(join(__dirname, '..', 'electron', 'main.ts'), 'utf-8')

describe('内置浏览器：窗口与 webview 的角色分工', () => {
  it('窗口 webContents 不得被拿去导航网页', () => {
    // loadFile 是允许的（加载工具栏宿主页本身）
    expect(winSrc).toContain('loadFile(')

    // 但绝不能出现 win.loadURL / w.loadURL / win.webContents.loadURL
    const offenders = winSrc
      .split('\n')
      .map((line, i) => ({ line: line.trim(), no: i + 1 }))
      .filter(({ line }) => /\.loadURL\(/.test(line))

    expect(offenders.map((o) => `L${o.no}: ${o.line}`)).toEqual([])
  })

  it('宿主页一旦被导航走就 preventDefault（否则工具栏会消失）', () => {
    expect(winSrc).toMatch(/webContents\.on\('will-navigate',\s*\(e\)\s*=>\s*e\.preventDefault\(\)\)/)
    expect(winSrc).toContain("setWindowOpenHandler(() => ({ action: 'deny' }))")
  })

  it('网页本体的跳转白名单挂在 webview 上，而不是页面里各写一份', () => {
    // did-attach-webview → guest.on('will-navigate') → isAllowedUrl
    expect(winSrc).toContain("'did-attach-webview'")
    expect(winSrc).toMatch(/guest\.on\('will-navigate'/)
    // 【v3.34 括号容错】原断言是 /if \(!isAllowedUrl\(url\)\) ev\.preventDefault\(\)/。
  // eslint 的 curly 规则（--fix）会把单行 if 补成 if (...) { ev.preventDefault() }，
  // 断言随之失配。读源码文本的断言对格式化工具天然脆弱，这里压掉空白、
  // 允许可选花括号，让 lint 修复不会再连带打红。
  const flatWin = winSrc.replace(/\s+/g, ' ')
  expect(flatWin).toMatch(/if \(!isAllowedUrl\(url\)\) \{? ?ev\.preventDefault\(\)/)

    // target=_blank 一律在当前窗口打开，不弹一堆窗
    expect(winSrc).toContain('guest.setWindowOpenHandler')
    expect(winSrc).toContain("return { action: 'deny' }")
  })

  it('所有网页操作都经 callHost 转发到宿主页的 window.__b', () => {
    // execInPage 是读页面/点元素/填输入框的唯一入口
    expect(winSrc).toContain('async function callHost<T>')
    expect(winSrc).toContain('async function execInPage')
    expect(winSrc).toMatch(/window\.__b\.\$\{method\}/)
    expect(winSrc).toContain('throw new Error(\'工具栏宿主页未就绪\')')

    // 读页面/点击/输入/截图不得再直接打窗口 webContents
    for (const fn of ['readPage', 'readInteractive', 'clickInteractive', 'typeInto', 'screenshot']) {
      const body = winSrc.slice(winSrc.indexOf(`export async function ${fn}`))
      const seg = body.slice(0, body.indexOf('\n}\n'))
      expect(seg, `${fn} 不该直接操作窗口 webContents`).not.toMatch(/webContents\.executeJavaScript/)
    }
  })

  it('转发前必须等宿主页加载完成（否则 window.__b 还不存在）', () => {
    expect(winSrc).toContain('let hostReady')
    expect(winSrc).toMatch(/hostReady = new Promise<void>/)
    expect(winSrc).toMatch(/await hostReady/)
  })

  it('清除 Cookie 用浏览器自己的 partition，不能误伤用户日常浏览数据', () => {
    expect(winSrc).toContain("electronSession.fromPartition(SESSION_PARTITION)")
    expect(winSrc).not.toMatch(/fromPartition\([^)]*\)\s*\?\s*/) // 不再有走位兜底
  })
})

describe('内置浏览器：标题栏不再无限拼接', () => {
  // 把页面里真实的剥后缀正则抽出来实跑，而不是抄一份过来假装在测
  const fnStart = html.indexOf('function setWindowTitle')
  const fnBody = html.slice(fnStart, html.indexOf('function applyState'))
  const rxMatch = fnBody.match(/\.replace\(\/((?:[^/\\]|\\.)+)\/g/)

  it('页面里确实有剥旧后缀的逻辑', () => {
    expect(fnStart).toBeGreaterThan(-1)
    expect(rxMatch).not.toBeNull()
    expect(html).toContain("' — Lumina 浏览器'")
  })

  const strip = new RegExp(rxMatch![1])
  const applyTitle = (raw: string) => {
    const base = String(raw || '').replace(strip, '').trim()
    return base ? base + ' — Lumina 浏览器' : 'Lumina 浏览器'
  }

  it('同一标题重复套用不会累积后缀（幂等）', () => {
    let t = 'example.com'
    for (let i = 0; i < 6; i++) {t = applyTitle(t)}
    expect(t).toBe('example.com — Lumina 浏览器')
    expect(t.match(/Lumina 浏览器/g)).toHaveLength(1)
  })

  it('已经叠了几个后缀也能一次剥干净', () => {
    expect(applyTitle('A — Lumina 浏览器 — Lumina 浏览器 — Lumina 浏览器'))
      .toBe('A — Lumina 浏览器')
  })

  it('空标题回到默认名，不留空后缀', () => {
    expect(applyTitle('')).toBe('Lumina 浏览器')
    expect(applyTitle('   ')).toBe('Lumina 浏览器')
  })

  it('页面标题里自带的后缀不被误伤', () => {
    expect(applyTitle('Lumina 浏览器文档')).toBe('Lumina 浏览器文档 — Lumina 浏览器')
  })
})

describe('内置浏览器：宿主页页面', () => {
  it('暴露 window.__b 命令桥，且导航落在 view 上', () => {
    expect(html).toContain('window.__b = __b')
    expect(html).toContain('view.loadURL(url)')
    expect(html).toContain('navigate: function (url)')
  })

  it('状态一律从 <webview> 读，而不是窗口地址', () => {
    expect(html).toContain('function readState()')
    expect(html).toContain('view.getURL()')
    expect(html).toContain('view.getTitle()')
  })

  it('空白页不往地址栏塞 about:blank，且有引导层', () => {
    expect(html).toContain('function isBlank(u)')
    expect(html).toContain("welcome.classList.toggle('show', isBlank(s.url))")
    expect(html).toContain('id="welcome"')
  })

  it('toolbar 按钮直连 window.__b，不绕 preload IPC', () => {
    // 后退/前进/刷新/缩放都在页面里直接操作 webview
    expect(html).toContain('$(\'btnBack\').onclick = function () { __b.back(); }')
    expect(html).toContain('$(\'btnReload\').onclick = function () { __b.reload(); }')
    expect(html).toContain('view.setZoomFactor(next)')
    // preload 因此不需要再暴露这堆能力
    expect(preloadSrc).not.toContain('back:')
    expect(preloadSrc).not.toContain('reload:')
    expect(preloadSrc).not.toContain('zoom:')
  })

  it('webview 加载失败只认主框架，避免子资源报错把地址栏冲掉', () => {
    expect(html).toContain('if (e && e.isMainFrame === false) return;')
  })

  it('设备预览五种预设都在，且能恢复自适应', () => {
    for (const id of ['responsive', 'desktop', 'iphone-xr', 'mobile', 'tablet']) {
      expect(html).toContain(`'${id}'`)
    }
    expect(html).toContain("view.removeAttribute('devicepixelratio')")
  })
})

describe('内置浏览器：IPC 注册', () => {
  it('browser:close 只注册一次（重复注册 Electron 会抛错）', () => {
    const inBrowser = (winSrc.match(/ipcMain\.handle\('browser:close'/g) || []).length
    const inMain = (mainSrc.match(/ipcMain\.handle\('browser:close'/g) || []).length
    expect(inBrowser).toBe(0)
    expect(inMain).toBe(1)
  })

  it('不再有全局 browser-window-created 转发（会污染主窗口）', () => {
    expect(winSrc).not.toContain('browser-window-created')
    expect(winSrc).not.toContain('attachBrowserStateRelay')
    expect(mainSrc).not.toContain('attachBrowserStateRelay')
  })

  it('状态改由宿主页回报并缓存，Agent 导航后工具栏也会刷新', () => {
    expect(winSrc).toContain("ipcMain.on('browser:state-changed'")
    expect(winSrc).toContain('function sendState(s: BrowserState)')
    expect(winSrc).toMatch(/sendState\(await getBrowserState\(\)\)/)
  })
})

describe('内置浏览器：底部水平滚动条「抽搐」修复', () => {
  it('responsive 模式下宿主页默认不滚动（overflow:hidden，网页自身在 webview 内滚）', () => {
    expect(html).toMatch(/\.viewport\s*\{[^}]*overflow:\s*hidden/)
  })
  it('仅设备预览（.device）才允许宿主页出现滚动条', () => {
    expect(html).toContain('.viewport.device { overflow: auto; }')
  })
  it('webview 允许收缩（min-width:0），避免 flex 最小宽度撑出横向滚动条', () => {
    expect(html).toMatch(/webview\s*\{[^}]*min-width:\s*0/)
  })
  it('切换 responsive/device 时正确加/移除 .device 类', () => {
    expect(html).toContain("viewport.classList.toggle('device', !!d.w)")
    // 默认回到 responsive 时不带 .device
    expect(html).toContain("applyDevice('responsive')")
  })
})
