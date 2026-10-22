// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import os from 'os'
import path from 'path'
import fs from 'fs'

const tmp = vi.hoisted(() => ({ dir: '' }))
vi.mock('electron', () => ({ app: { getPath: () => tmp.dir } }))
// memoryStore 在测试环境会因 better-sqlite3 ABI 问题失败，这里桩掉合成取素材阶段
vi.mock('../electron/memory/memoryStore', () => ({
  getMemoryStore: () => ({
    getRecentSummaries: () => ['用户说周末想去看展', '用户在玩某款游戏'],
    searchFacts: () => [{ content: '用户答应明天取快递' }],
  }),
}))

import { FollowupTopicsStore, synthesizeFollowups } from '../electron/proactive/followupTopics'

beforeAll(() => {
  tmp.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-followup-'))
})

describe('synthesizeFollowups LLM 合成', () => {
  it('注入 LLM 返回 JSON topics → 解析成字符串数组', async () => {
    const llm = async () => '{"topics":["上次你说周末要去看展","那个游戏后续怎么样了","明天记得取快递"]}'
    const out = await synthesizeFollowups(llm)
    expect(out).toHaveLength(3)
    expect(out[0]).toBe('上次你说周末要去看展')
  })

  it('LLM 返回非 JSON / 解析失败 → 空数组', async () => {
    expect(await synthesizeFollowups(async () => '乱七八糟没有 JSON')).toEqual([])
    expect(await synthesizeFollowups(async () => '{bad json')).toEqual([])
  })
})

describe('FollowupTopicsStore 生命周期', () => {
  const DAY = 24 * 60 * 60 * 1000
  beforeEach(() => {
    try { fs.rmSync(path.join(tmp.dir, 'proactive-followups.json'), { force: true }) } catch { /* 无文件 */ }
  })

  it('合成后注入：replaceWith → getActive 拿到前 3 条', () => {
    const store = new FollowupTopicsStore()
    store.replaceWith(['话头一', '话头二', '话头三'], 1_000_000)
    expect(store.getActive(3, 1_000_000)).toEqual(['话头一', '话头二', '话头三'])
  })

  it('问完清除：markAsked 后不再返回', () => {
    const store = new FollowupTopicsStore()
    store.replaceWith(['旧事A', '旧事B'], 1_000_000)
    store.markAsked('旧事A')
    expect(store.getActive(5, 1_000_000)).toEqual(['旧事B'])
  })

  it('过期清除：超过 7 天的自动 prune', () => {
    const store = new FollowupTopicsStore()
    const createdAt = 1_000_000
    store.replaceWith(['陈年旧事'], createdAt)
    // 6 天后还在
    expect(store.getActive(3, createdAt + 6 * DAY)).toEqual(['陈年旧事'])
    // 8 天后过期
    expect(store.getActive(3, createdAt + 8 * DAY)).toEqual([])
  })

  it('持久化：新实例从磁盘恢复未问的话头', () => {
    const s1 = new FollowupTopicsStore()
    s1.replaceWith(['磁盘里的旧事'], 1_000_000)
    const s2 = new FollowupTopicsStore()
    expect(s2.getActive(3, 1_000_000)).toEqual(['磁盘里的旧事'])
  })
})
