// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import os from 'os'
import path from 'path'
import fs from 'fs'

const tmp = vi.hoisted(() => ({ dir: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => tmp.dir },
}))

import { isQuestion, UnfinishedThreadStore } from '../electron/proactive/unfinishedThread'

beforeAll(() => {
  tmp.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-thread-'))
})

describe('isQuestion 问句识别', () => {
  it('正面例：句尾标点/语气词', () => {
    expect(isQuestion('今天吃什么？')).toBe(true)
    expect(isQuestion('在干嘛?')).toBe(true)
    expect(isQuestion('今天吃什么呢')).toBe(true)
    expect(isQuestion('你好吗')).toBe(true)
    expect(isQuestion('要不要一起走嘛')).toBe(true)
    expect(isQuestion('早点休息吧')).toBe(true)
  })

  it('正面例：句中含「呢/吗」', () => {
    expect(isQuestion('你在看什么呢')).toBe(true)
    expect(isQuestion('这个好吗')).toBe(true)
  })

  it('反面例：陈述/命令', () => {
    expect(isQuestion('好的')).toBe(false)
    expect(isQuestion('我先去忙了')).toBe(false)
    expect(isQuestion('')).toBe(false)
    expect(isQuestion('   ')).toBe(false)
  })
})

describe('UnfinishedThreadStore 话头生命周期', () => {
  beforeEach(() => {
    try { fs.rmSync(path.join(tmp.dir, 'proactive-unfinished.json'), { force: true }) } catch { /* 首次无文件 */ }
  })

  it('record → consume 取出并清除；再次 consume 为 null', () => {
    const store = new UnfinishedThreadStore()
    expect(store.peek()).toBeNull()
    store.record('今天晚饭吃什么呀？', 1_000_000)
    expect(store.peek()).toBe('今天晚饭吃什么呀？')
    expect(store.consume()).toBe('今天晚饭吃什么呀？')
    expect(store.consume()).toBeNull()
    expect(store.peek()).toBeNull()
  })

  it('用户回答后 clear 清除话头', () => {
    const store = new UnfinishedThreadStore()
    store.record('周末去玩吗？')
    expect(store.peek()).not.toBeNull()
    store.clear()
    expect(store.peek()).toBeNull()
  })

  it('record 覆盖旧话头', () => {
    const store = new UnfinishedThreadStore()
    store.record('第一个问题？')
    store.record('第二个问题呢')
    expect(store.consume()).toBe('第二个问题呢')
  })

  it('持久化：新实例从磁盘恢复未答话头', () => {
    const s1 = new UnfinishedThreadStore()
    s1.record('上次聊到一半，你后来看完了吗？', 1_234_567)
    const s2 = new UnfinishedThreadStore()
    expect(s2.peek()).toBe('上次聊到一半，你后来看完了吗？')
  })

  it('consume 后落盘空状态，新实例不再恢复', () => {
    const s1 = new UnfinishedThreadStore()
    s1.record('一个悬而未决的问题')
    s1.consume()
    const s2 = new UnfinishedThreadStore()
    expect(s2.peek()).toBeNull()
  })
})
