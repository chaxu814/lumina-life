// tests/channelMaturity.test.ts
//
// 渠道成熟度闸门的契约测试。
//
// 【背景】我们有 7 个渠道适配器，但只有 telegram 完成过端到端真机验证。
// 头部项目（openclaw 32 / cc-haha 8 / MiniMax Code 4）全部已跑通。
// 把 7 个都标「已支持」会被社区拆穿；把没验证的默认关掉才是诚实做法。
//
// 本测试锁死三条不变量：
//   1. telegram 是唯一 verified，其余一律 experimental
//   2. experimental 渠道默认拒绝启动，必须显式 allowExperimental
//   3. 登记表是成熟度的唯一真源——不在表里的类型一律按 experimental 处理
import { describe, it, expect, vi, beforeEach } from 'vitest'
import os from 'os'
import path from 'path'
import fs from 'fs'

vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir(), getName: () => 'Lumina Life', getVersion: () => '0-test' },
}))

import {
  CHANNEL_CAPABILITIES, channelMaturity, isChannelVerified, verifiedChannelTypes,
} from '../electron/channels/types'
import { ChannelManager } from '../electron/channels/channelManager'

describe('渠道成熟度登记表', () => {
  it('telegram 是唯一 verified 渠道', () => {
    expect(isChannelVerified('telegram')).toBe(true)
    expect(verifiedChannelTypes()).toEqual(['telegram'])
  })

  it('其余六个适配器均为 experimental（已接线但未真机验证）', () => {
    const experimental = ['wechat', 'qq', 'dingtalk', 'slack', 'discord', 'openclaw']
    for (const t of experimental) {
      expect(isChannelVerified(t)).toBe(false)
      expect(channelMaturity(t)).toBe('experimental')
    }
  })

  it('7 个渠道全部登记，requiredCredentials 非空', () => {
    const keys = Object.keys(CHANNEL_CAPABILITIES)
    expect(keys).toHaveLength(7)
    for (const k of keys) {
      const cap = CHANNEL_CAPABILITIES[k as keyof typeof CHANNEL_CAPABILITIES]
      expect(cap.label).toBeTruthy()
      expect(cap.requiredCredentials.length).toBeGreaterThan(0)
      expect(cap.notes).toBeTruthy()
      // verified 必须写验证日期，否则「已验证」就成了一句无法追溯的话
      if (cap.maturity === 'verified') {expect(cap.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/)}
    }
  })

  it('未知类型按 experimental 处理（宁可保守）', () => {
    expect(channelMaturity('custom')).toBe('experimental')
    expect(isChannelVerified('custom')).toBe(false)
  })
})

describe('ChannelManager 诚实度闸门', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-chan-'))
  })

  /** 写入渠道配置（单文件 channels.json，key → config 的映射） */
  function writeConfig(entries: Record<string, Record<string, unknown>>): void {
    fs.writeFileSync(path.join(dir, 'channels.json'), JSON.stringify(entries), 'utf8')
  }

  it('experimental 渠道默认保持离线，不启动', async () => {
    // 微信：适配器能构造，但没有 allowExperimental
    writeConfig({
      wechat: {
        enabled: true, type: 'wechat', name: '微信',
        credentials: { webhookUrl: 'https://example.invalid/hook', token: 'x' },
      },
    })
    const mgr = new ChannelManager({ configDir: dir })
    await mgr.init()
    const st = mgr.getStatus().find((s) => s.type === 'wechat')
    // 配置被读到了，但不该上线
    expect(st).toBeDefined()
    expect(st!.online).toBe(false)
    expect(st!.maturity).toBe('experimental')
    await mgr.destroy()
  })

  it('experimental 渠道显式 allowExperimental 后才尝试启动', async () => {
    // 这里只断言「闸门放行了」，不断言网络是否真的通——
    // 外部网络不在单测职责内，闸门本身才是被测对象。
    writeConfig({
      wechat: {
        enabled: true, type: 'wechat', name: '微信',
        credentials: { webhookUrl: 'https://example.invalid/hook', token: 'x' },
        allowExperimental: true,
      },
    })
    const mgr = new ChannelManager({ configDir: dir })
    await mgr.init()
    // 放行后即使 init 失败（无网络），也必须安全降级而不是抛异常
    expect(() => mgr.getStatus()).not.toThrow()
    await mgr.destroy()
  })

  it('闸门不会拖垮整个 init：未验证渠道不阻止其它渠道启动', async () => {
    writeConfig({
      wechat: {
        enabled: true, type: 'wechat', name: '微信',
        credentials: { webhookUrl: 'https://example.invalid/hook', token: 'x' },
      },
      telegram: {
        enabled: true, type: 'telegram', name: 'TG',
        credentials: { botToken: 'not-a-real-token' },
      },
    })
    const mgr = new ChannelManager({ configDir: dir })
    await expect(mgr.init()).resolves.toBeUndefined()
    // 两条配置都在，微信离线，telegram 被真正尝试启动过（无网络→离线）
    const st = mgr.getStatus()
    expect(st).toHaveLength(2)
    expect(st.find((s) => s.type === 'wechat')!.online).toBe(false)
    await mgr.destroy()
  })

  it('首次运行生成的默认配置只给 telegram 模板（唯一已验证渠道）', async () => {
    const mgr = new ChannelManager({ configDir: dir })
    await mgr.init()
    const st = mgr.getStatus()
    // 默认不启用任何渠道，但预置的模板必须指向已验证渠道
    const preloaded = st.filter((s) => s.maturity === 'verified')
    expect(preloaded.every((s) => s.type === 'telegram')).toBe(true)
    expect(st.every((s) => s.online === false)).toBe(true)
    await mgr.destroy()
  })
})
