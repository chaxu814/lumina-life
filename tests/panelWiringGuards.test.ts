// ============================================================
// tests/panelWiringGuards.test.ts
//
// 【为什么需要】
//   本项目反复出现同一类缺陷：**功能写好了，但没接线** ——
//     · DiagnosticsPanel 调 `window.electronAPI.ipcInvoke`（preload 里从不存在）
//       → 面板静默跑 mockData（假数据），用户看到的"诊断"是编的；
//     · coding-mode-injector 的 8 套纪律是死代码；
//     · 技能市场面板整个是死的（通道没暴露）；
//     · EmotionDashboardPanel 调 teamEmotions() 但 preload 里没有。
//
//   这类缺陷的共同点：**代码能通过 typecheck 与单测，运行时却一行都跑不到。**
//   所以这里用静态断言把「通道两端都接上」钉死 —— 谁拆掉一端，这里立刻红。
// ============================================================

import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

const root = path.resolve(__dirname, '..')
const read = (rel: string) => fs.readFileSync(path.join(root, ...rel.split('/')), 'utf-8')

describe('preload 暴露 · 诊断与精灵表', () => {
  const preload = read('electron/preload.ts')

  it('diagnostics 命名空间存在且含 modelHealth / modelHealthText', () => {
    expect(preload).toMatch(/diagnostics:\s*\{/)
    expect(preload).toContain("invoke('diagnostics:modelHealth'")
    expect(preload).toContain("invoke('diagnostics:modelHealthText'")
  })

  it('sprite 命名空间存在且含 spec / prompt', () => {
    expect(preload).toMatch(/sprite:\s*\{/)
    expect(preload).toContain("invoke('sprite:spec'")
    expect(preload).toContain("invoke('sprite:prompt'")
  })
})

describe('主进程 handler · 两端匹配', () => {
  it('spriteIpc 注册了与 preload 对应的三个通道', () => {
    const src = read('electron/ipc/spriteIpc.ts')
    expect(src).toContain("ipcMain.handle('sprite:spec'")
    expect(src).toContain("ipcMain.handle('sprite:prompt'")
    expect(src).toContain("ipcMain.handle('sprite:quickPrompt'")
  })

  it('main.ts 真的调用了 registerSpriteIpc（否则 handler 永不注册）', () => {
    const src = read('electron/main.ts')
    expect(src).toContain('registerSpriteIpc')
    // 既有 import 也有调用
    expect(src).toMatch(/import \{ registerSpriteIpc \}/)
    expect(src).toMatch(/registerSpriteIpc\(\)/)
  })

  it('diagnostics 的 modelHealth 通道在主进程存在', () => {
    const src = read('electron/ipc/diagnosticsIpc.ts')
    expect(src).toContain("ipcMain.handle('diagnostics:modelHealth'")
  })
})

describe('面板可达性 · 不能是孤儿', () => {
  it('DiagnosticsPanel 在 App.tsx 的 panelMap 里', () => {
    const app = read('src/App.tsx')
    expect(app).toMatch(/import DiagnosticsPanel from '\.\/panels\/DiagnosticsPanel'/)
    expect(app).toMatch(/diagnostics:\s*DiagnosticsPanel/)
  })

  it('SpriteGalleryPanel 在 App.tsx 的 panelMap 里', () => {
    const app = read('src/App.tsx')
    expect(app).toMatch(/import SpriteGalleryPanel from '\.\/panels\/SpriteGalleryPanel'/)
    expect(app).toMatch(/spritegallery:\s*SpriteGalleryPanel/)
  })

  it('SpriteGalleryPanel 在「更多设置」侧栏有入口且有渲染分支', () => {
    const modal = read('src/components/MoreSettingsModal.tsx')
    expect(modal).toContain("id: 'spritegallery'")
    expect(modal).toMatch(/activeSection === 'spritegallery'/)
  })
})

describe('DiagnosticsPanel 不再依赖不存在的通用通道', () => {
  const panel = read('src/panels/DiagnosticsPanel.tsx')

  it('不再把 window.electronAPI.ipcInvoke 当作主路径', () => {
    // 允许作为兜底出现，但主路径必须是 luminaAPI.diagnostics
    expect(panel).toContain('luminaAPI?.diagnostics')
    expect(panel).toContain("'diagnostics:summary': 'summary'")
  })

  it('含模型体检渲染分支', () => {
    expect(panel).toContain('模型体检')
    expect(panel).toMatch(/LEVEL_META/)
  })
})

describe('情绪因果链 · 从引擎到 UI', () => {
  it('team:emotions 返回 causalReasons（真实因果，非模板）', () => {
    const src = read('electron/ipc/observabilityIpc.ts')
    expect(src).toContain('causalReasons')
    expect(src).toContain('getCausalGatingHints')
  })

  it('EmotionDashboardPanel 渲染 causalReasons', () => {
    const panel = read('src/panels/EmotionDashboardPanel.tsx')
    expect(panel).toContain('causalReasons')
    expect(panel).toContain('情绪因果链')
  })
})
