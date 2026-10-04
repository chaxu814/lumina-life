// =============================================================
// tests/channelWiring.test.ts — IM 渠道接线守卫
//
// 【为什么要有这个测试】
// 2026-10-04 复核文档时发现：ARCHITECTURE.md / BENCHMARKS.md / README
// 都把 `electron/channels/adapters/` 标为「未接线」，并据此把「IM 渠道」一栏
// 写成 ❌ / 0 个。这是**假话** —— 实际接线是存在的：
//
//   main.ts:629  initChannelManager()
//   main.ts:633  await import('./channels/channelAgentBridge')  ← 动态加载
//   main.ts:634  initChannelAgentBridge()
//   main.ts:640  channelManager.init(msg => bridge.handleMessage(msg))
//
// 之所以一直没人发现，是因为接线用的是 **await import() 动态导入**，
// 而项目里有一批检查是 grep 静态 import 的 —— 动态的天然扫不到。
//
// 后果不轻：
//   1. 竞品对比表把「IM 渠道」写成 0，直接影响定位判断
//   2. 外部贡献者会以为这是半成品而绕开这块
//   3. 真正的缺口（「默认关闭 / 无端到端验证」）反而被这条假话盖住了
//
// 所以本测试把「接线存在」钉成可回归的事实，并**同时**钉住真正缺口的措辞，
// 避免以后有人把「已接线但未验证」又写成「未接线」。
// =============================================================

import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

const root = path.join(__dirname, '..')
const read = (p: string): string => fs.readFileSync(path.join(root, p), 'utf8')

describe('IM 渠道 · 接线存在（文档曾长期写「未接线」）', () => {
  it('main.ts 初始化了 ChannelManager', () => {
    expect(read('electron/main.ts')).toContain('initChannelManager()')
  })

  it('main.ts 通过动态 import 装载了 Agent 桥接器', () => {
    const src = read('electron/main.ts')
    // 关键：用 await import() 而非静态 import —— 这正是它长期逃过 grep 检查的原因
    expect(src).toMatch(/await import\(['"]\.\/channels\/channelAgentBridge['"]\)/)
    expect(src).toContain('initChannelAgentBridge()')
  })

  it('渠道消息被转交给桥接器处理', () => {
    const src = read('electron/main.ts')
    expect(src).toMatch(/channelManager\.init\(/)
    expect(src).toContain('handleMessage(msg)')
  })

  it('7 个渠道适配器文件都存在', () => {
    for (const a of ['telegram', 'wechat', 'qq', 'dingtalk', 'slack', 'discord', 'openclaw']) {
      expect(fs.existsSync(path.join(root, `electron/channels/adapters/${a}.ts`)),
        `缺少适配器 ${a}.ts`).toBe(true)
    }
  })

  it('每个适配器的 init 不是空壳（要有真实实现体）', () => {
    for (const a of ['telegram', 'wechat', 'qq', 'dingtalk', 'slack', 'discord']) {
      const src = read(`electron/channels/adapters/${a}.ts`)
      const m = src.match(/async\s+init\s*\([^)]*\)\s*:\s*Promise<boolean>\s*\{/)
      expect(m, `${a}.ts 找不到 init 实现`).not.toBeNull()
      // 取出 init 的函数体，剔除空实现与纯 throw
      const body = src.slice(m!.index! + m![0].length)
      const meaningful = body.slice(0, 1200)
        .replace(/return (true|false)/g, '')
        .replace(/throw[^\n]*/g, '')
        .replace(/\/\/[^\n]*/g, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .trim()
      expect(meaningful.length, `${a}.ts 的 init 像是空壳`).toBeGreaterThan(20)
    }
  })
})

describe('IM 渠道 · 文档措辞不得倒退成「未接线」', () => {
  /**
   * 允许的措辞：承认「已接线」同时说明真实缺口（默认关闭、需凭据、未经真机验证）。
   * 禁止的措辞：把整块标成未接线 / 0 个 —— 那是事实错误，会误导定位判断。
   */
  it('ARCHITECTURE.md 不再把 adapters 标为未接线', () => {
    const src = read('docs/ARCHITECTURE.md')
    const claims = src.split(/\r?\n/).filter(l =>
      l.includes('channels/adapters') || l.includes('channels/adapters/'))
    expect(claims.length, '找不到提到 adapters 的行，文档结构变了？').toBeGreaterThan(0)
    for (const line of claims) {
      // 【为什么要先抹掉「」里的内容】
      // 更正说明里必然会引用旧措辞（如「此前写的是「未接线」」），
      // 那是**引述历史**，不是**当下声明**。不区分就会把更正本身判成违规。
      // 规则：书名号内是引述，其余才是声明。
      const asserted = line.replace(/「[^」]*」/g, '')
      expect(asserted, `ARCHITECTURE.md 仍在声明未接线：${line.trim()}`)
        .not.toMatch(/未接线/)
    }
  })

  it('README 的 IM 渠道一栏不再写 0', () => {
    const src = read('README.md')
    // 只查能力对比表附近：不能出现「IM 渠道 | ... | ❌ 0」
    const line = src.split(/\r?\n/).find(l => /IM 渠道/.test(l) && l.includes('|'))
    if (line) {
      expect(line, `README 的 IM 渠道行仍写 0：${line.trim()}`)
        .not.toMatch(/❌\s*0/)
      expect(line, `README 的 IM 渠道行仍标未接线：${line.trim()}`)
        .not.toMatch(/未接线/)
    }
  })

  it('BENCHMARKS.md 的渠道数量与实现一致（7 个适配器）', () => {
    const src = read('docs/BENCHMARKS.md')
    const line = src.split(/\r?\n/).find(l => /IM 渠道/.test(l) && l.includes('|'))
    if (line) {
      expect(line, `BENCHMARKS.md 的 IM 渠道行仍写 0：${line.trim()}`)
        .not.toMatch(/我们\s*0/)
    }
  })
})

describe('IM 渠道 · 真实缺口必须被如实写明（别用假话盖住真问题）', () => {
  it('适配器默认不启动 —— 只有 enabled 为真才会起', () => {
    // 这才是真缺口：用户装完不会自动连上任何渠道，必须自己配凭据。
    // 文档若只说「已接线」而不说这条，同样是误导。
    const src = read('electron/channels/channelManager.ts')
    expect(src).toMatch(/if\s*\(\s*cfg\.enabled\s*\)/)
  })

  it('main.ts 对渠道启动失败做了隔离（单渠道失败不影响全局）', () => {
    const src = read('electron/main.ts')
    expect(src).toMatch(/渠道管理器启动可能失败|渠道管理器已初始化/)
    expect(src).toMatch(/catch/)
  })
})
