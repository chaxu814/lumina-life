// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// tests/forceDelegateCommands.test.ts
//
// 【要防的真实问题】
//   1. 默认路由由模型裁量（routingDecider 只注入提示语），同一问题两次问
//      可能派活不同 —— 专业用户最在意确定性。新增 /yak /recha /lumina
//      三条「强制派活」命令作为逃生舱，本测试钉死它们存在且解析正确。
//   2. /switch 的 usage 文案、以及 main.ts 里 /agents 与 /switch 的处理器
//      长期残留旧多角色模型的名字（luna/ray/sora/assistant），而真实角色
//      早已是 lumina/yak/recha —— 用户照提示输入会直接失败。本测试防止回潮。
// ============================================================

import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { CommandRouter } from '../electron/chatCommands'

const root = path.resolve(__dirname, '..')
const mainSrc = fs.readFileSync(path.join(root, 'electron', 'main.ts'), 'utf-8')

describe('确定性派活命令 /yak /recha /lumina', () => {
  it('三条命令都能被 CommandRouter 解析到', () => {
    const router = new CommandRouter()
    for (const name of ['yak', 'recha', 'lumina']) {
      const parsed = router.parse(`/${name} 帮我看看这个 bug`)
      expect(parsed, `/${name} 应能解析`).not.toBeNull()
      expect(parsed!.command.name).toBe(name)
      expect(parsed!.args.join(' ')).toContain('bug')
    }
  })

  it('无参数时 minArgs 生效（提示用法）', async () => {
    const router = new CommandRouter()
    const parsed = router.parse('/yak')!
    const res = await router.execute(parsed)
    expect(res.success).toBe(false)
    expect(res.message).toContain('用法')
  })

  it('别名可用（码 / 茶 / 自己答）', () => {
    const router = new CommandRouter()
    expect(router.parse('/码 x')!.command.name).toBe('yak')
    expect(router.parse('/茶 x')!.command.name).toBe('recha')
    expect(router.parse('/自己答 x')!.command.name).toBe('lumina')
  })
})

describe('/switch 与 /agents 不能再出现旧角色名', () => {
  it('/switch 的 usage 指向 lumina|yak|recha', () => {
    const sw = CommandRouter.listCommands().find(c => c.name === 'switch')!
    expect(sw.usage).toContain('lumina')
    expect(sw.usage).toContain('yak')
    expect(sw.usage).toContain('recha')
    expect(sw.usage).not.toContain('luna')
    expect(sw.usage).not.toContain('sora')
  })

  it('main.ts 的 switch 处理器校验真实角色，且不含旧名字', () => {
    const start = mainSrc.indexOf("switch: async (p)")
    expect(start, '找不到 switch 处理器').toBeGreaterThan(-1)
    const body = mainSrc.slice(start, start + 900)
    expect(body).toContain("'lumina'")
    expect(body).toContain("'yak'")
    expect(body).toContain("'recha'")
    // 旧角色名不得作为**字符串常量**出现在校验数组里（注释里提到历史名字不算）
    expect(body).not.toContain("'luna'")
    expect(body).not.toContain("'sora'")
    expect(body).not.toContain("'assistant'")
  })

  it('main.ts 的 agents 处理器列出真实团队，且不含旧名字', () => {
    const start = mainSrc.indexOf('agents: async ()')
    expect(start, '找不到 agents 处理器').toBeGreaterThan(-1)
    const body = mainSrc.slice(start, start + 900)
    expect(body).toContain('lumina')
    expect(body).toContain('yak')
    expect(body).toContain('recha')
    // 旧名字不应作为 name 字段出现
    expect(body).not.toContain("name: 'luna'")
    expect(body).not.toContain("name: 'ray'")
    expect(body).not.toContain("name: 'sora'")
  })
})

describe('/help 不遗漏任何已注册命令', () => {
  it('每个命令都能在帮助文本里出现', () => {
    const router = new CommandRouter()
    const help = router.generateHelp()
    for (const cmd of CommandRouter.listCommands()) {
      expect(help, `/${cmd.name} 应出现在 /help 中`).toContain(cmd.usage)
    }
  })
})
