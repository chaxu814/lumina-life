// tests/petWindowUrl.test.ts
//
// 回归测试：Live2D 不显示（%3F 编码 bug）。
// 根因：旧代码把 `?model=entryRel` 直接拼进文件路径再传给 electron 的
//   petWindow.loadFile(路径)，loadFile 把整串当文件路径，内部转 file URL 时
//   把 `?` 编码成 %3F → ERR_FAILED 白屏。
// 修复：拆成 getRendererHtmlFilePath()（纯路径）+ getRendererModelParam()（query 值），
//   统一用 loadFile(纯路径, { query: { model } }) 让 Electron 正确构造 URL。
//
// ⚠️ 为什么现在要同时测两条路径（2026-10-05 补）
//   仓库不再内置任何 Live2D 模型资产（受 Cubism SDK 再分发条款约束），
//   保底形象是**程序化小猫**，走的是另一个渲染页 `pet-cat.html`，
//   且不带 query。所以「live2d + query」这条路径不再被默认覆盖，
//   一旦它坏了，测试依然全绿——而用户导入 Live2D 模型后会直接白屏。
//   因此这里显式构造一个「已导入 Live2D 模型」的状态来守住这条回归点。
//
// 本测试 mock electron，断言：
//   1. resolvePetLoadTarget() 返回的 filePath 是纯路径、不含 `?`（两种形态都测）
//   2. live2d 形态下 query.model === 用户导入模型的 entryRel
//   3. loadPetHtml() 真正调用 loadFile 时，第一参是纯路径、第二参带 { query }
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
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

/** 写入模型库状态：currentId 指向一个自定义 Live2D 模型 */
function useImportedLive2D(entryRel = 'Shiro/shiro.model3.json'): void {
  fs.writeFileSync(
    path.join(h.tmpDir, 'pet-model-library.json'),
    JSON.stringify({
      currentId: 'Shiro',
      custom: [
        { id: 'Shiro', name: 'Shiro', entryRel, kind: 'live2d', builtin: false, addedAt: 1 },
      ],
    }),
    'utf8',
  )
}

/** 清空模型库状态 → 回到保底形象（程序化小猫） */
function useFallbackCat(): void {
  try { fs.unlinkSync(path.join(h.tmpDir, 'pet-model-library.json')) } catch { /* 本来就没有 */ }
}

beforeEach(() => {
  h.loadFileSpy.mockClear()
  useFallbackCat()
})

afterEach(() => {
  __setPetWindowForTest(null)
  useFallbackCat()
})

describe('petWindow URL 编码修复（%3F bug）', () => {
  it('保底形象（程序化小猫）走独立渲染页，且路径不含 `?`', () => {
    const { filePath, query } = resolvePetLoadTarget()
    // 关键回归点：路径里绝不允许出现 `?`（旧 bug 根因）
    expect(filePath).not.toContain('?')
    expect(filePath).not.toContain('%3F')
    expect(filePath.endsWith('.html')).toBe(true)
    // 小猫是程序化渲染，没有模型文件要传，因此不带 query
    expect(path.basename(filePath)).toBe('pet-cat.html')
    expect(query).toBeUndefined()
  })

  it('live2d 形态下 query.model 等于用户导入模型的 entryRel', () => {
    useImportedLive2D()
    const { filePath, query } = resolvePetLoadTarget()
    // 同样不许把 `?` 编进路径
    expect(filePath).not.toContain('?')
    expect(filePath).not.toContain('%3F')
    expect(path.basename(filePath)).toBe('pet.html')
    expect(query).toBeDefined()
    expect(query!.model).toBe('Shiro/shiro.model3.json')
    // entryRel 里的斜杠应原样保留，由 Electron 在 file URL 里编码成 %2F，
    // 而不是由我们自己把整段拼进路径导致 ? 被编码成 %3F
    expect(query!.model).toContain('/')
  })

  it('库文件里残留的已退役模型 id 会回退到保底形象而不是指向不存在的资产', () => {
    // 旧版库文件可能记着 'Mao'。它已从仓库移除，必须回退，
    // 否则渲染层会拿到 'Mao/mao_pro.model3.json' 去 load 一个不存在的文件。
    fs.writeFileSync(
      path.join(h.tmpDir, 'pet-model-library.json'),
      JSON.stringify({ currentId: 'Mao', custom: [] }),
      'utf8',
    )
    const { filePath, query } = resolvePetLoadTarget()
    expect(path.basename(filePath)).toBe('pet-cat.html')
    expect(query).toBeUndefined()
  })

  it('loadPetHtml() 调用 loadFile：纯路径为第一参，第二参带 { query }', async () => {
    useImportedLive2D()
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
    expect((argOpts as any).query.model).toBe('Shiro/shiro.model3.json')
  })

  it('未注入窗口时 loadPetHtml 抛错，不静默吞掉', async () => {
    __setPetWindowForTest(null)
    await expect(loadPetHtml()).rejects.toThrow(/petWindow/)
  })
})
