// ============================================================
// browser_cdp.ts - CDP Browser Control (Phase 3)
//
// Based on Electron built-in webContents + debugger module
// Supports:
//   - Connect to running Chrome
//   - Navigate, click, type, screenshot
//   - JavaScript execution
//   - Multi-Agent shared browser instance
// ============================================================

import { BrowserWindow, webContents } from 'electron'
import { getAppIconPath } from '../../appIcon'
import type { ToolDef, ToolResult } from '../types'

// ============================================================
// CDP Browser Manager
// ============================================================

interface CDPSession {
  id: string
  browserWindow: BrowserWindow
  webContents: Electron.WebContents
  attached: boolean
  lastActivity: number
}

class CDPBrowserManager {
  private sessions = new Map<string, CDPSession>()
  private activeSessionId: string | null = null
  private idleTimeout = 300_000 // 5 minutes auto-disconnect

  /**
   * Start new browser window (with CDP debug port)
   */
  async start(options: { cdpPort?: number; headed?: boolean; width?: number; height?: number } = {}): Promise<ToolResult> {
    const { cdpPort, headed = true, width = 1280, height = 800 } = options

    // Check if there is already an active session
    if (this.activeSessionId && this.sessions.has(this.activeSessionId)) {
      const session = this.sessions.get(this.activeSessionId)!
      if (Date.now() - session.lastActivity < this.idleTimeout) {
        return { callId: '', ok: true, content: `Browser already running (session=${this.activeSessionId})` }
      }
    }

    try {
      const browserWindow = new BrowserWindow({
        width,
        height,
        icon: getAppIconPath(256),
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
        },
        show: headed,
      })

      // Enable CDP debugging (use as any to bypass TypeScript debugger keyword restriction)
      const debuggerApi = browserWindow.webContents as any
      if (cdpPort) {
        await new Promise<void>((resolve, reject) => {
          debuggerApi.debugger.attach('1.3', cdpPort.toString())
          debuggerApi.debugger.on('attached', () => resolve())
          debuggerApi.debugger.on('error', (err: any) => reject(err))
          setTimeout(() => reject(new Error('CDP attach timeout')), 5000)
        })
      } else {
        // Auto-select port
        await debuggerApi.debugger.attach('1.3')
      }

      const sessionId = `cdp_${Date.now()}`
      const session: CDPSession = {
        id: sessionId,
        browserWindow,
        webContents: browserWindow.webContents,
        attached: true,
        lastActivity: Date.now(),
      }

      this.sessions.set(sessionId, session)
      this.activeSessionId = sessionId

      // Listen to close event
      browserWindow.on('closed', () => {
        this.sessions.delete(sessionId)
        if (this.activeSessionId === sessionId) {
          this.activeSessionId = null
        }
      })

      // Listen to activity
      browserWindow.webContents.on('did-navigate', () => this.updateActivity(sessionId))
      browserWindow.webContents.on('did-finish-load', () => this.updateActivity(sessionId))

      return { callId: '', ok: true, content: `Browser started (session=${sessionId}, headed=${headed})` }
    } catch (err: any) {
      return { callId: '', ok: false, content: '', error: `Failed to start browser: ${err.message}` }
    }
  }

  /**
   * Connect to running Chrome (via CDP URL)
   */
  async connect(cdpUrl: string): Promise<ToolResult> {
    try {
      // Parse CDP URL
      const url = new URL(cdpUrl)
      const port = parseInt(url.port)

      // Create new window and connect to remote debug port
      const browserWindow = new BrowserWindow({
        show: false,
        icon: getAppIconPath(256),
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
        },
      })

      const debuggerApi = browserWindow.webContents as any
      await debuggerApi.debugger.attach('1.3', port.toString())

      const sessionId = `cdp_${Date.now()}`
      const session: CDPSession = {
        id: sessionId,
        browserWindow,
        webContents: browserWindow.webContents,
        attached: true,
        lastActivity: Date.now(),
      }

      this.sessions.set(sessionId, session)
      this.activeSessionId = sessionId

      return { callId: '', ok: true, content: `Connected to Chrome (session=${sessionId})` }
    } catch (err: any) {
      return { callId: '', ok: false, content: '', error: `Connection failed: ${err.message}` }
    }
  }

  /**
   * Navigate to URL
   */
  async navigate(url: string, sessionId?: string): Promise<ToolResult> {
    const session = this.getSession(sessionId)
    if (!session) {return { callId: '', ok: false, content: '', error: 'No active browser session' }}

    try {
      await session.webContents.loadURL(url)
      this.updateActivity(session.id)
      return { callId: '', ok: true, content: `Navigated to: ${url}` }
    } catch (err: any) {
      return { callId: '', ok: false, content: '', error: `Navigation failed: ${err.message}` }
    }
  }

  /**
   * Click element
   */
  async click(selector: string, sessionId?: string): Promise<ToolResult> {
    const session = this.getSession(sessionId)
    if (!session) {return { callId: '', ok: false, content: '', error: 'No active browser session' }}

    try {
      await session.webContents.executeJavaScript(`
        (() => {
          const el = document.querySelector('${selector}')
          if (!el) throw new Error('Element not found: ${selector}')
          el.click()
          return 'clicked'
        })()
      `)
      this.updateActivity(session.id)
      return { callId: '', ok: true, content: `Clicked: ${selector}` }
    } catch (err: any) {
      return { callId: '', ok: false, content: '', error: `Click failed: ${err.message}` }
    }
  }

  /**
   * Type text
   */
  async type(selector: string, text: string, sessionId?: string): Promise<ToolResult> {
    const session = this.getSession(sessionId)
    if (!session) {return { callId: '', ok: false, content: '', error: 'No active browser session' }}

    try {
      await session.webContents.executeJavaScript(`
        (() => {
          const el = document.querySelector('${selector}')
          if (!el) throw new Error('Element not found: ${selector}')
          el.value = '${text.replace(/'/g, "\\'")}'
          el.dispatchEvent(new Event('input', { bubbles: true }))
          el.dispatchEvent(new Event('change', { bubbles: true }))
          return 'typed'
        })()
      `)
      this.updateActivity(session.id)
      return { callId: '', ok: true, content: `Typed into: ${selector}` }
    } catch (err: any) {
      return { callId: '', ok: false, content: '', error: `Type failed: ${err.message}` }
    }
  }

  /**
   * Execute JavaScript
   */
  async evaluate(code: string, sessionId?: string): Promise<ToolResult> {
    const session = this.getSession(sessionId)
    if (!session) {return { callId: '', ok: false, content: '', error: 'No active browser session' }}

    try {
      const result = await session.webContents.executeJavaScript(code)
      this.updateActivity(session.id)
      return { callId: '', ok: true, content: JSON.stringify(result, null, 2) }
    } catch (err: any) {
      return { callId: '', ok: false, content: '', error: `Evaluation failed: ${err.message}` }
    }
  }

  /**
   * Screenshot
   */
  async screenshot(sessionId?: string): Promise<ToolResult> {
    const session = this.getSession(sessionId)
    if (!session) {return { callId: '', ok: false, content: '', error: 'No active browser session' }}

    try {
      const image = await session.webContents.capturePage()
      const buffer = image.toPNG()
      const fs = await import('fs')
      const path = await import('path')
      const os = await import('os')
      
      const savePath = path.join(os.homedir(), 'Desktop', `lumina_browser_screenshot_${Date.now()}.png`)
      fs.writeFileSync(savePath, buffer)
      
      this.updateActivity(session.id)
      return { callId: '', ok: true, content: `Screenshot saved: ${savePath}` }
    } catch (err: any) {
      return { callId: '', ok: false, content: '', error: `Screenshot failed: ${err.message}` }
    }
  }

  /**
   * Get page content
   */
  async getContent(sessionId?: string): Promise<ToolResult> {
    const session = this.getSession(sessionId)
    if (!session) {return { callId: '', ok: false, content: '', error: 'No active browser session' }}

    try {
      const html = await session.webContents.executeJavaScript('document.documentElement.outerHTML')
      this.updateActivity(session.id)
      return { callId: '', ok: true, content: html.slice(0, 50000) } // Limit length
    } catch (err: any) {
      return { callId: '', ok: false, content: '', error: `Get content failed: ${err.message}` }
    }
  }

  /**
   * Close browser
   */
  async stop(sessionId?: string): Promise<ToolResult> {
    const targetId = sessionId || this.activeSessionId
    if (!targetId) {return { callId: '', ok: true, content: 'No active browser session' }}

    const session = this.sessions.get(targetId)
    if (!session) {return { callId: '', ok: true, content: `Session not found: ${targetId}` }}

    try {
      const debuggerApi = session.webContents as any
      debuggerApi.debugger.detach()
      session.browserWindow.close()
      this.sessions.delete(targetId)
      
      if (this.activeSessionId === targetId) {
        this.activeSessionId = null
      }
      
      return { callId: '', ok: true, content: `Browser closed (session=${targetId})` }
    } catch (err: any) {
      return { callId: '', ok: false, content: '', error: `Close failed: ${err.message}` }
    }
  }

  /**
   * List all sessions
   */
  listSessions(): Array<{ id: string; url?: string; title?: string; attached: boolean }> {
    const result: Array<{ id: string; url?: string; title?: string; attached: boolean }> = []
    
    const sessions = Array.from(this.sessions.entries())
    for (const [id, session] of sessions) {
      result.push({
        id,
        url: session.webContents.getURL(),
        title: session.webContents.getTitle(),
        attached: session.attached,
      })
    }
    
    return result
  }

  // ============================================================
  // Private methods
  // ============================================================

  private getSession(sessionId?: string): CDPSession | undefined {
    const id = sessionId || this.activeSessionId
    if (!id) {return undefined}
    return this.sessions.get(id)
  }

  private updateActivity(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (session) {
      session.lastActivity = Date.now()
    }
  }
}

// ============================================================
// Global singleton
// ============================================================

const cdpManager = new CDPBrowserManager()

// ============================================================
// Tool definitions
// ============================================================

export const browserCDPDef: ToolDef = {
  name: 'browser_cdp',
  description: `CDP Browser Control. Supports:
- action="start": Start new browser window (optional CDP port)
- action="connect": Connect to running Chrome
- action="navigate": Navigate to URL
- action="click": Click element
- action="type": Type text
- action="evaluate": Execute JavaScript
- action="screenshot": Screenshot
- action="content": Get page HTML
- action="stop": Close browser
- action="list": List all sessions`,
  params: {
    action: { type: 'string', description: 'Action type', required: true },
    url: { type: 'string', description: 'URL (for navigate/connect)', required: false },
    selector: { type: 'string', description: 'CSS selector (for click/type)', required: false },
    text: { type: 'string', description: 'Text (for type/evaluate)', required: false },
    code: { type: 'string', description: 'JavaScript code (for evaluate)', required: false },
    cdpPort: { type: 'number', description: 'CDP port (for start)', required: false },
    headed: { type: 'boolean', description: 'Show window (for start)', required: false },
    width: { type: 'number', description: 'Window width', required: false },
    height: { type: 'number', description: 'Window height', required: false },
    sessionId: { type: 'string', description: 'Session ID', required: false },
  },
  toolsets: ['agent', 'browser'],
}

export async function browserCDPHandler(args: Record<string, any>): Promise<ToolResult> {
  const action = args.action || 'start'
  const sessionId = args.sessionId

  switch (action) {
    case 'start':
      return cdpManager.start({
        cdpPort: args.cdpPort,
        headed: args.headed !== false,
        width: args.width || 1280,
        height: args.height || 800,
      })

    case 'connect':
      return cdpManager.connect(args.url)

    case 'navigate':
      return cdpManager.navigate(args.url, sessionId)

    case 'click':
      return cdpManager.click(args.selector, sessionId)

    case 'type':
      return cdpManager.type(args.selector, args.text, sessionId)

    case 'evaluate':
      return cdpManager.evaluate(args.code, sessionId)

    case 'screenshot':
      return cdpManager.screenshot(sessionId)

    case 'content':
      return cdpManager.getContent(sessionId)

    case 'stop':
      return cdpManager.stop(sessionId)

    case 'list':
      const sessions = cdpManager.listSessions()
      return { callId: '', ok: true, content: JSON.stringify(sessions, null, 2) }

    default:
      return { callId: '', ok: false, content: '', error: `Unknown action: ${action}` }
  }
}
