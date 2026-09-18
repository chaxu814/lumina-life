import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import os from 'os'
import path from 'path'
import fs from 'fs'

const tmp = vi.hoisted(() => ({ dir: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => tmp.dir },
}))

import {
  generateDream, generateDreamAsync, registerDreamLLM,
  generateTodayDreamAsync,
} from '../electron/dream/dreamEngine'

beforeAll(() => {
  tmp.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-dream-'))
  // 双保险：即使动态 require('electron') 未被 mock 拦截，也强制走临时目录
  process.env.QWENPAW_WORKING_DIR = tmp.dir
})

describe('dreamEngine 梦境生成', () => {
  beforeEach(() => {
    registerDreamLLM(null)
    try { fs.rmSync(path.join(tmp.dir, 'data', 'dreams.json'), { force: true }) } catch {}
  })

  it('模板路径产出完整字段且标记 source=template', () => {
    const d = generateDream('用户最近提到海边')
    expect(d.content.length).toBeGreaterThan(20)
    expect(d.title.length).toBeGreaterThan(0)
    expect(d.tags.length).toBeGreaterThan(0)
    expect(d.source).toBe('template')
  })

  it('未注册 LLM 时异步生成回退模板', async () => {
    const d = await generateDreamAsync('一些记忆')
    expect(d.source).toBe('template')
  })

  it('注册 LLM 后采用真实生成，解析 title/content/mood/tags', async () => {
    registerDreamLLM(async () => JSON.stringify({
      title: '粉色的海',
      content: '我梦见一片粉色的海，浪是棉花糖做的，踩上去软软的。Lumina 坐在贝壳上对我笑。',
      mood: '✨ 奇幻',
      tags: ['海洋', '粉色'],
    }))
    const d = await generateDreamAsync('用户想去海边')
    expect(d.source).toBe('llm')
    expect(d.title).toBe('粉色的海')
    expect(d.content).toContain('棉花糖')
    expect(d.mood).toBe('✨ 奇幻')
    expect(d.tags).toContain('粉色')
  })

  it('LLM 输出被 markdown 包裹也能解析', async () => {
    registerDreamLLM(async () => '```json\n' + JSON.stringify({
      title: '旧书店', content: '我走进一家会移动的旧书店，每本书都在低声念我的名字。', mood: '🌌 神秘', tags: ['书店'],
    }) + '\n```')
    const d = await generateDreamAsync()
    expect(d.source).toBe('llm')
    expect(d.title).toBe('旧书店')
  })

  it('LLM 返回垃圾内容时安全回退模板', async () => {
    registerDreamLLM(async () => '我不是 JSON，我只是一句话')
    const d = await generateDreamAsync()
    expect(d.source).toBe('template')
  })

  it('LLM 抛错时安全回退模板', async () => {
    registerDreamLLM(async () => { throw new Error('network down') })
    const d = await generateDreamAsync()
    expect(d.source).toBe('template')
  })

  it('同一天只生成一次（异步并发不会重复）', async () => {
    const [a, b] = await Promise.all([
      generateTodayDreamAsync('记忆甲'),
      generateTodayDreamAsync('记忆乙'),
    ])
    // 第一个生成成功，第二个跳过（false）
    expect(a || b).toBe(true)
    expect(a && b).toBe(false)
  })
})
