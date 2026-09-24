// tests/petWindowUrl.test.ts
//
// 回归测试：Live2D 不显示（%3F 编码 bug）。
// 根因：旧代码把 `?model=entryRel` 直接拼进文件路径再传给 electron 的
//   petWindow.loadFile(路径)，loadFile 把整串当文件路径，内部转 file URL 时
//   把 `?` 编码成 %3F → ERR_FAILED 白屏。
// 修复：拆成 getRendererHtmlFilePath()（纯路径）+ getRendererModelParam()（query 值），
//   统一用 loadFile(纯路径, { query: { model } }) 让 Electron 正确构造 URL。
//
// 本测试 mock electron，断言：
//   1. resolvePetLoadTarget() 返回的 filePath 是纯路径、不含 `?`
//   2. query.model === 'Mao/mao_pro.model3.json'
//   3. loadPetHtml() 真正调用 loadFile 时，第一参是纯路径、第二参带 { query }
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import os from 'os'
import path from 'path'
import fs from 'fs'

// 用 hoisted 让 mock 工厂能访问到临时目录与 loadFile 间谍
const h = vi.hoisted(() => {
  return {
    tmpDir: '',
    loadFileSpy: vi.fn(async (_p: string, _opts?: unknown) => {}),
  }
})

vi.mock('electron', () => {
  class FakeBrowserWindow {
    loadFile = h.loadFileSpy
    isDestroyed = () => false
    webContents = { send: () => {}, on: () => {} }
    on = () => {}
  }
  return {
    app: {
      getPath: () => h.tmpDir,
      getAppPath: () => process.cwd(),
      getName: () => 'Lumina Life',
      getVersion: () => '0.0.0-test',
      on: () => {},
      whenReady: async () => undefined,
    },
    BrowserWindow: FakeBrowserWindow,
    screen: {
      getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 } }),
      on: () => {},
    },
    ipcMain: { on: () => {}, handle: () => {}, removeHandler: () => {} },
    desktopCapturer: { getSources: async () => [] },
    globalShortcut: { register: () => true, unregister: () => {}, unregisterAll: () => {} },
  }
})

beforeAll(() => {
  h.tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-peturl-'))
})

import {
  resolvePetLoadTarget,
  loadPetHtml,
  __setPetWindowForTest,
} from '../electron/pet/petWindow'

beforeEach(() => {
  h.loadFileSpy.mockClear()
})

describe('petWindow URL 编码修复（%3F bug）', () => {
  it('resolvePetLoadTarget 返回纯文件路径，不含 `?` 或 query 串', () => {
    const { filePath } = resolvePetLoadTarget()
    // 必须是磁盘文件路径，basename 应为 pet.html（live2d 渲染页）
    expect(path.basename(filePath)).toBe('pet.html')
    // 关键回归点：路径里绝不允许出现 `?`（旧 bug 根因）
    expect(filePath).not.toContain('?')
    expect(filePath).not.toContain('%3F')
    expect(filePath.endsWith('.html')).toBe(true)
  })

  it('live2d 形态下 query.model 等于内置 Mao 的 entryRel', () => {
    const { query } = resolvePetLoadTarget()
    expect(query).toBeDefined()
    expect(query!.model).toBe('Mao/mao_pro.model3.json')
    // entryRel 里的斜杠应原样保留，由 Electron 在 file URL 里编码成 %2F，
    // 而不是由我们自己把整段拼进路径导致 ? 被编码成 %3F
    expect(query!.model).toContain('/')
  })

  it('loadPetHtml() 真正调用 loadFile：第一参纯路径、第二参带 { query }', async () => {
    // 注入一个最小假窗口
    const fakeWin: any = {
      isDestroyed: () => false,
      loadFile: h.loadFileSpy,
    }
    __setPetWindowForTest(fakeWin)

    await loadPetHtml()

    expect(h.loadFileSpy).toHaveBeenCalledTimes(1)
    const [argPath, argOpts] = h.loadFileSpy.mock.calls[0]

    // 第一参：纯文件路径，不含 ?
    expect(typeof argPath).toBe('string')
    expect(argPath).not.toContain('?')
    expect(argPath).not.toContain('%3F')
    expect(path.basename(argPath)).toBe('pet.html')

    // 第二参：options.query.model 正确
    expect(argOpts).toBeDefined()
    expect(argOpts).toHaveProperty('query')
    expect((argOpts as any).query.model).toBe('Mao/mao_pro.model3.json')
  })

  it('未注入窗口时 loadPetHtml 抛错，不静默吞掉', async () => {
    __setPetWindowForTest(null)
    await expect(loadPetHtml()).rejects.toThrow(/petWindow/)
  })
})
