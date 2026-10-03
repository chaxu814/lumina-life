// ============================================================
// tests/configDefaults.test.ts — 配置默认值（浏览器联动默认开启）
//
// 这组测试钉的是一个具体的产品决策：**浏览器链接联动默认开启**，
// 并且钉住「键缺失 = 默认值，显式 false = 用户选择」这条规则。
//
// 为什么值得单独写测试：
// 历史上这类默认值改过 bug——只改了设置面板的 UI 初始状态，
// 没改执行侧（ChatPanel）的读取判据，结果「开关显示开着但实际不工作」。
// 两边判据必须永远一致，这类 bug 靠人 review 是抓不住的。
// ============================================================

// 注意：本文件不 import memoryIpc —— 那会拉进 Electron 的 app.getPath，
// 在纯 Node 测试环境下会报 "Cannot read properties of undefined"。
// 因此 CONFIG_DEFAULTS 在此重复定义一份纯数据，并加测试保证与主进程一致。
// 单一事实源仍是 electron/ipc/memoryIpc.ts；这里是它的无依赖镜像。
const CONFIG_DEFAULTS = {
  browser: { autoOpenLinks: true as boolean },
}

function withConfigDefaults(cfg: Record<string, any> | null | undefined): Record<string, any> {
  const base = (cfg && typeof cfg === 'object') ? cfg : {}
  const out: Record<string, any> = { ...base }
  for (const [k, v] of Object.entries(CONFIG_DEFAULTS)) {
    const isPlainObj = typeof v === 'object' && v !== null
    const cur = out[k]
    if (cur === undefined || cur === null || (isPlainObj && typeof cur !== 'object')) {
      out[k] = isPlainObj ? { ...v } : v
    } else if (isPlainObj) {
      out[k] = { ...v, ...cur }
    }
  }
  return out
}

import { describe, it, expect } from 'vitest'
import { shouldAutoOpen } from '../src/utils/linkifyText'

describe('configDefaults · 浏览器联动默认开启', () => {
  it('默认配置里 autoOpenLinks 为 true', () => {
    expect(CONFIG_DEFAULTS.browser?.autoOpenLinks).toBe(true)
  })

  it('空配置会补全出默认开启', () => {
    const r = withConfigDefaults({})
    expect(r.browser.autoOpenLinks).toBe(true)
  })

  it('null / undefined 配置也补全（不抛异常）', () => {
    expect(withConfigDefaults(null).browser.autoOpenLinks).toBe(true)
    expect(withConfigDefaults(undefined).browser.autoOpenLinks).toBe(true)
  })

  it('用户显式关过时尊重用户选择（不覆盖成 true）', () => {
    const r = withConfigDefaults({ browser: { autoOpenLinks: false } })
    expect(r.browser.autoOpenLinks).toBe(false)
  })

  it('browser 子键存在但缺 autoOpenLinks 时也补默认值', () => {
    const r = withConfigDefaults({ browser: { other: 1 } })
    expect(r.browser.autoOpenLinks).toBe(true)
    expect(r.browser.other).toBe(1)   // 不得丢失同级已有配置
  })

  it('不修改传入对象（不污染调用方数据）', () => {
    const input = { browser: {} }
    withConfigDefaults(input)
    expect(input.browser).not.toHaveProperty('autoOpenLinks')
  })

  it('不覆盖其他顶层配置', () => {
    const r = withConfigDefaults({ model: 'x', browser: { autoOpenLinks: false } })
    expect(r.model).toBe('x')
  })

  it('非对象的 browser 字段被安全替换为默认值', () => {
    const r = withConfigDefaults({ browser: 'garbage' as any })
    expect(typeof r.browser).toBe('object')
    expect(r.browser.autoOpenLinks).toBe(true)
  })
})

describe('configDefaults · 与主进程保持一致', () => {
  it('镜像值与 electron/ipc/memoryIpc 的 CONFIG_DEFAULTS 一致', async () => {
    // 读源码而非 import：import 会拉进 Electron，测试环境下直接崩
    const fs = await import('fs')
    const path = await import('path')
    const src = fs.readFileSync(
      path.join(process.cwd(), 'electron', 'ipc', 'memoryIpc.ts'),
      'utf-8',
    )
    expect(src).toMatch(/autoOpenLinks:\s*true/)
  })
})

describe('configDefaults · 执行侧判据一致性', () => {
  it('键缺失时视为开启（与设置面板 !== false 一致）', () => {
    // 模拟 ChatPanel 里的判据
    const cfg: any = withConfigDefaults({})
    expect(cfg.browser.autoOpenLinks !== false).toBe(true)
  })

  it('显式关闭时确实关闭', () => {
    const cfg: any = withConfigDefaults({ browser: { autoOpenLinks: false } })
    expect(cfg.browser.autoOpenLinks !== false).toBe(false)
  })

  it('关闭时 shouldAutoOpen 不返回 URL', () => {
    const r = shouldAutoOpen('看这个 https://example.com 很有用', false)
    expect(r).toBeNull()
  })

  it('开启且回复含链接时返回该链接', () => {
    const r = shouldAutoOpen('看这个 https://example.com 很有用', true)
    expect(r).toContain('example.com')
  })

  it('开启但回复无链接时不返回（不弹空窗）', () => {
    expect(shouldAutoOpen('今天天气不错', true)).toBeNull()
  })
})
