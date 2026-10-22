// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// tests/fileSearchCount.test.ts — P3: file_search 计数模式精确性验证
//
// 【修复背景】
// 旧版 file_search 只返回「路径列表（默认截断 50 条）」，模型为了回答
// "有多少个 .ts 文件" 这类计数问题，只能把 file_search + file_list 多次
// 结果相加，极易虚高（P3 的 503 计数存疑即源于此）。
//
// 新增 count=true 模式：返回**完整统计的精确数量、不截断**，从根上消除
// "多源搜索结果相加" 的需要。本测试钉死"精确、不截断"这一行为。
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { fileSearch } from '../electron/tools/impl/fileSearch'

let tmp: string

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-fs-count-'))
  for (let i = 0; i < 7; i++) fs.writeFileSync(path.join(tmp, `a${i}.log`), 'x')
  for (let i = 0; i < 3; i++) fs.writeFileSync(path.join(tmp, `b${i}.txt`), 'y')
  fs.mkdirSync(path.join(tmp, 'sub'))
  fs.writeFileSync(path.join(tmp, 'sub', 'nested.log'), 'z')
})

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('file_search 计数模式（P3 精确计数）', () => {
  it('count=true 返回精确匹配数，且标注未截断', async () => {
    const res = await fileSearch({ pattern: '*.log', rootDir: tmp, count: true })
    expect(res.ok).toBe(true)
    // 7 个顶层 .log + 1 个 sub/nested.log = 8
    expect(res.content).toMatch(/共\s*8\s*个/)
    expect(res.content).toContain('未截断')
  })

  it('计数不受 maxResults 截断影响（精确而非封顶 50）', async () => {
    // 即便 maxResults 设得很小，count 模式也应返回真实总数
    const res = await fileSearch({ pattern: '*.*', rootDir: tmp, count: true, maxResults: 3 })
    expect(res.ok).toBe(true)
    // 11 个带点的文件，远超过 maxResults=3，证明计数是真实全量统计
    expect(res.content).toMatch(/共\s*11\s*个/)
  })

  it('非计数模式默认不进入计数分支（行为保持不变）', async () => {
    const res = await fileSearch({ pattern: '*.txt', rootDir: tmp })
    expect(res.ok).toBe(true)
    expect(res.content).not.toContain('未截断')
  })
})
