// ============================================================
// tests/featureFlags.test.ts — 创新功能开关组（feature flags）
//
// 三个创新功能都是「默认开、可关闭」的增强层。
// 这组测试钉住的核心语义只有一条：
//
//   **键缺失 = 开；显式 false = 关。**
//
// 为什么这条值得钉死：
// 这类 bug 的典型形态是「设置面板显示已关闭，但功能还在跑」或反之。
// 原因是三处判据不一致——主进程默认值合并、主进程运行时读取、
// 渲染进程 UI 初始化。只要有一处写成 `=== true`，缺省用户就会拿到
// 错误的初始行为，而这种问题在测试里几乎抓不到，只能靠人发现。
// ============================================================

import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

function readSrc(rel: string): string {
  return fs.readFileSync(path.join(process.cwd(), ...rel.split('/')), 'utf-8')
}

describe('featureFlags · 主进程默认值', () => {
  it('CONFIG_DEFAULTS 里三个开关都是 true', () => {
    const src = readSrc('electron/ipc/memoryIpc.ts')
    for (const key of ['theater', 'emotionGating', 'affinityDecay']) {
      expect(src, `缺少 ${key} 默认值`).toMatch(new RegExp(`${key}:\\s*true`))
    }
  })

  it('config:get 走 withConfigDefaults（否则默认值永远到不了渲染进程）', () => {
    const src = readSrc('electron/ipc/memoryIpc.ts')
    expect(src).toMatch(/config:get.*withConfigDefaults/s)
  })
})

describe('featureFlags · 三处判据一致（防止幽灵状态）', () => {
  it('主进程运行时：剧场走单一开关入口', () => {
    const src = readSrc('electron/orchestration/theaterBridge.ts')
    // 🔧 2026-10-04：原实现是 `require('./agentConfig').getConfig()` ——
    //   agentConfig 根本不导出 getConfig，且 require 在打包后必然失败；
    //   双重失败被 catch 吞掉，使 features.theater **永远读到 undefined**，
    //   即「任务剧场」开关从未生效过，而 UI 上它是给用户看的。
    //   判据已收敛到 core/appConfig.ts，这里只守「别又自己写一套」。
    expect(src).toMatch(/readFeatureFlag\(\s*'theater'/)
    // 调用点不得再做自己的判据（否则又是一处会漂移的第二真相）
    expect(src).not.toMatch(/features\?\.theater/)
  })

  it('主进程运行时：情绪门控走单一开关入口', () => {
    // P2-10：工具选择流水线已从 agentRunner.ts 纯搬移到 agentRunner.toolSelection.ts，
    // 门控开关读取随流水线一起搬走；拼两个文件守住「单一入口、无第二判据」。
    const src = readSrc('electron/agentRunner.ts') + '\n' + readSrc('electron/agentRunner.toolSelection.ts')
    expect(src).toMatch(/readFeatureFlag\(\s*'emotionGating'/)
    expect(src).not.toMatch(/features\?\.emotionGating/)
  })

  it('单一实现里用 !== false（键缺失 = 默认开），不得出现 === true', () => {
    // 【为什么比原来守两处更强】
    // 原来 theater 与 emotionGating 各写一份判据，改一处忘另一处就会出现
    // 「界面显示开着、实际不工作」的幽灵状态。现在判据只有一份，守住它就够了。
    //
    // 【为什么要先去注释】
    // 判据的说明文字里必然会提到「不要用 === true」这句话本身。
    // 直接对原文做 not.toMatch 会把自己的说明当成违规 —— 守卫把自己卡死了。
    // 沿用 agentQuality.test.ts 的 stripComments 做法：只对代码生效。
    const code = readSrc('electron/core/appConfig.ts')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split(/\r?\n/)
      .filter(line => !/^\s*\/\//.test(line))
      .join('\n')
    expect(code).toMatch(/!==\s*false/)
    expect(code, '反向判据会把「键缺失」当成关闭').not.toMatch(/===\s*true/)
    // 默认值必须显式来自调用方，不允许在实现里偷偷写死 false
    expect(code).toMatch(/defaultOn\s*=\s*true/)
  })

  it('渲染进程：三个开关都用 !== false', () => {
    const src = readSrc('src/panels/settings/TheaterPanel.tsx')
    for (const key of ['theater', 'emotionGating', 'affinityDecay']) {
      expect(src, `UI 侧 ${key} 判据不一致`).toMatch(
        new RegExp(`features\\.${key}|\\.${key}\\s*!==\\s*false`),
      )
    }
    // 不能出现 === true 的反向判据
    expect(src).not.toMatch(/=== true/)
  })

  it('聊天区挂载：关闭时 TheaterMount 返回 null（零开销而非隐藏）', () => {
    const src = readSrc('src/components/TheaterMount.tsx')
    // 【v3.34 括号容错】原断言是 /if\s*\(!enabled\)\s*return null/，
    // 但 eslint 的 curly 规则（--fix）会把单行 if 补成 if (...) { return null }，
    // 于是断言失配。这类「读源码文本」的断言天然脆 —— 格式化工具一改就红。
    // 这里改成对花括号/换行不敏感，避免每次 lint 修复都要回来改测试。
    expect(src.replace(/\s+/g, ' ')).toMatch(/if\s*\(\s*!enabled\s*\)\s*\{?\s*return null/)
  })
})

describe('featureFlags · 接线完整性', () => {
  it('preload 暴露了剧场的两个事件通道', () => {
    const src = readSrc('electron/preload.ts')
    expect(src).toContain('onTheaterBeat')
    expect(src).toContain('onTheaterState')
  })

  it('preload 的取消订阅清理了监听（不泄漏）', () => {
    const src = readSrc('electron/preload.ts')
    expect(src).toMatch(/removeListener\('theater:beat'/)
    expect(src).toMatch(/removeListener\('theater:state'/)
  })

  it('bridge 广播的通道名与 preload 监听的一致', () => {
    const bridge = readSrc('electron/orchestration/theaterBridge.ts')
    expect(bridge).toContain("'theater:beat'")
    expect(bridge).toContain("'theater:state'")
  })

  it('CSS 已在入口引入', () => {
    expect(readSrc('src/main.tsx')).toContain("theater-feed.css")
  })

  it('ChatPanel 已挂载 TheaterMount', () => {
    const src = readSrc('src/panels/ChatPanel.tsx')
    expect(src).toContain('<TheaterMount />')
  })

  it('设置菜单已有「任务剧场」入口', () => {
    const src = readSrc('src/components/MoreSettingsModal.tsx')
    expect(src).toContain("id: 'theater'")
    expect(src).toContain('<TheaterPanel />')
  })
})

describe('featureFlags · 菜单命名', () => {
  it('商城已改名为「Live2D 模型」（它管的是本体模型，不是饰品）', () => {
    const src = readSrc('src/components/MoreSettingsModal.tsx')
    expect(src).toContain("label: 'Live2D 模型'")
    expect(src).not.toContain("label: '配件商城'")
  })

  it('面板文案已同步为 Live2D', () => {
    const src = readSrc('src/panels/ModelStorePanel.tsx')
    expect(src).toContain('Live2D 模型')
    // 「配件商城」只允许出现在解释改名理由的注释里，不得出现在 UI 文案中
    const uiStrings = src
      .split('\n')
      .filter(l => !l.trim().startsWith('//'))
      .join('\n')
    expect(uiStrings).not.toContain('配件商城')
  })
})
