// ============================================================
// tests/toolImplFailureHonest.test.ts
//
// 工具实现内部的失败分支必须显式失败 —— 上一轮只修了 registry。
//
// 背景：registry.ts 的「工具不存在 / 被拦截 / 需审批」三条路径已经改成
// ok:false，但工具实现**自己内部**的失败分支还大量返回 ok:true：
//
//   return { ok: true, content: '⚠️ URL 格式无效: ...' }
//   return { ok: true, content: '未找到 xxx 的引用' }
//
// agentRunner 对 ok:true 的处理是「把 content 原样回灌给模型」：
//
//   content: result.ok ? result.content : `工具错误: ${result.error || '未知错误'}`
//
// 于是「压根没抓到」这件事以**普通成功结果**的形状进了模型上下文，
// 模型分不出「抓到了」和「没抓到」——照着「⚠️ 无法访问 xxx」这段话里
// 的线索继续编正文，这就是编造的直接来源。
//
// 反向的坑（本文件同样钉住）：**查询确实跑了、确实 0 条命中**是成功的
// 查询，不能也改成 ok:false，否则模型会开始怀疑正常路径。所以每组改动
// 都配一条「空结果仍是 ok:true」的对照用例。
//
// 为什么改 ok:false 不会打断 ReAct 循环：agentRunner 拿到 tool 结果后
// 无条件 push 一条 role:'tool' 消息再 continue，代码里没有 ok 相关的
// break（这条前提已由 tests/toolFailureSignal.test.ts 钉死）。
// ============================================================

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// ────────────────────────────────────────────────────────────
// 可控桩：全部用动态 import 触发，保证 vi.mock 工厂已注册
// ────────────────────────────────────────────────────────────

const httpState = {
  impl: async (_url: string, _headers: any, _timeout: number) => ({
    ok: true, status: 200, text: '<p>hello</p>', contentType: 'text/html',
  }),
}
vi.mock('../electron/tools/utils/httpClient', () => ({
  httpGet: (url: string, headers: any, timeout: number) => httpState.impl(url, headers, timeout),
  stripHtml: (s: string) => s,
}))

const webState = {
  search: async (_q: string, _c: number) => '',
  fetch: async (_url: string) => '',
}
vi.mock('../electron/tools/impl/webSearch', () => ({
  webSearch: (q: string, c: number) => webState.search(q, c),
  fetchWebContent: (u: string) => webState.fetch(u),
}))

const ctxState = { entries: [] as any[] }
vi.mock('../electron/delegationManager', () => ({
  getDelegationManager: () => ({
    getContext: (key: string) => ctxState.entries.find(e => e.key === key),
    getAllContext: () => ctxState.entries,
    setContext: (key: string, value: string) => {
      ctxState.entries.push({ key, value, updatedBy: 'lumina', timestamp: '2026-01-01' })
    },
  }),
}))

const memoryState = { results: [] as any[] }
vi.mock('../electron/memoryStructured', () => ({
  getStructuredMemory: () => ({ search: async (_q: string, _n: number) => memoryState.results }),
}))

vi.mock('../electron/agentTeamManager', () => ({ getTeamManager: () => ({}) }))
vi.mock('../electron/agentTeamContext', () => ({ getTeamContextManager: () => ({}) }))
vi.mock('../electron/agentTeamPersonas', () => ({ MODE_CONFIGS: {} }))
vi.mock('../electron/lsp/astSearch', () => ({
  astSearch: () => [],
  formatASTResults: () => '',
}))

type WebFetch = typeof import('../electron/tools/impl/webFetch')
type Browser = typeof import('../electron/tools/impl/browser')
type Lsp = typeof import('../electron/tools/impl/lsp')
type Team = typeof import('../electron/tools/impl/team')

let webFetchMod: WebFetch
let browserMod: Browser
let lspMod: Lsp
let teamMod: Team

beforeAll(async () => {
  webFetchMod = await import('../electron/tools/impl/webFetch')
  browserMod = await import('../electron/tools/impl/browser')
  lspMod = await import('../electron/tools/impl/lsp')
  teamMod = await import('../electron/tools/impl/team')
})

beforeEach(() => {
  httpState.impl = async () => ({ ok: true, status: 200, text: '<p>hello</p>', contentType: 'text/html' })
  webState.search = async () => ''
  webState.fetch = async () => ''
  ctxState.entries = []
  memoryState.results = []
})

// ────────────────────────────────────────────────────────────
// 统一失败信号断言：与 registry.ts 的 buildNotExecutedResult 同一套口径
// ────────────────────────────────────────────────────────────
function expectFailure(res: { ok: boolean; content: string; error?: string }, keyword: string) {
  expect(res.ok).toBe(false)
  expect(res.content).toContain('⛔ 未执行成功')
  expect(res.content).toContain('禁止据此作答')
  expect(res.content).toContain(keyword)
  // agentRunner 在 ok:false 时只回灌 error，所以防幻觉提示必须也写进 error
  expect(res.error).toBeTruthy()
  expect(res.error).toContain('未执行成功')
  expect(res.error).toContain('禁止据此作答')
  expect(res.error).toContain(keyword)
}

/** 反向断言：真的查了但结果是空的 = 成功的查询 */
function expectEmptySuccess(res: { ok: boolean; content: string; error?: string }) {
  expect(res.ok).toBe(true)
  expect(res.error).toBeUndefined()
  expect(res.content).toContain('0 条结果')
  expect(res.content).not.toContain('⛔ 未执行成功')
}

describe('web_fetch：没抓到网页不许说成功', () => {
  it('缺 url 参数 → ok:false', async () => {
    expectFailure(await webFetchMod.webFetch({}), 'web_fetch')
  })

  it('HTTP 非 200 → ok:false，error 里保留状态码', async () => {
    httpState.impl = async () => ({ ok: false, status: 404, text: 'Not Found', contentType: 'text/html' })
    const res = await webFetchMod.webFetch({ url: 'https://example.com/missing' })
    expectFailure(res, 'HTTP 404')
  })

  it('抓取过程抛异常 → ok:false，error 里保留原始错误串', async () => {
    httpState.impl = async () => { throw new Error('ECONNREFUSED 原始网络错误') }
    const res = await webFetchMod.webFetch({ url: 'https://example.com' })
    expectFailure(res, 'ECONNREFUSED 原始网络错误')
  })

  it('对照：真的抓到网页仍是 ok:true', async () => {
    const res = await webFetchMod.webFetch({ url: 'https://example.com' })
    expect(res.ok).toBe(true)
    expect(res.content).toContain('📄 网页内容')
    expect(res.error).toBeUndefined()
  })
})

describe('browser：参数非法 / 读不到 / 提不出链接都是失败', () => {
  it('action=open 缺 url → ok:false', async () => {
    expectFailure(await browserMod.browserHandler({ action: 'open' }), 'browser')
  })

  it('action=open URL 格式无效 → ok:false', async () => {
    expectFailure(await browserMod.browserHandler({ action: 'open', url: 'example.com' }), 'URL 格式无效')
  })

  it('action=open 读取正文抛错 → ok:false，error 保留原始错误', async () => {
    webState.fetch = async () => { throw new Error('ECONNRESET 原始抓取错误') }
    expectFailure(await browserMod.browserHandler({ action: 'open', url: 'https://example.com' }), 'ECONNRESET 原始抓取错误')
  })

  it('action=launch URL 格式无效 → ok:false', async () => {
    expectFailure(await browserMod.browserHandler({ action: 'launch', url: 'ftp://x/y' }), 'URL 格式无效')
  })

  it('action=search_and_read 搜索 0 命中 → 仍是成功的查询 ok:true', async () => {
    webState.search = async () => `搜索 "不存在的东西" 未找到结果。`
    expectEmptySuccess(await browserMod.browserHandler({ action: 'search_and_read', query: '不存在的东西' }))
  })

  it('action=search_and_read 提取不到任何链接 → ok:false', async () => {
    webState.search = async () => `🔍 搜索 "x" (2 条):\n\n**1. 标题**\n   📄 摘要`
    expectFailure(await browserMod.browserHandler({ action: 'search_and_read', query: 'x' }), '提取不到任何链接')
  })

  it('action=search_and_read 所有链接都读失败 → ok:false，保留最后错误', async () => {
    webState.search = async () => `🔍 搜索 "x" (1 条):\n\n**1. 标题**\n   🔗 https://example.com/a\n   📄 摘要`
    webState.fetch = async () => { throw new Error('HTTP 500 最后一个链接的错误') }
    const res = await browserMod.browserHandler({ action: 'search_and_read', query: 'x' })
    expectFailure(res, '均无法读取正文')
    expect(res.error).toContain('HTTP 500 最后一个链接的错误')
  })

  it('action=search_and_read 读到正文 → ok:true', async () => {
    webState.search = async () => `🔍 搜索 "x" (1 条):\n\n**1. 标题**\n   🔗 https://example.com/a\n   📄 摘要`
    webState.fetch = async () => '真实正文内容'
    const res = await browserMod.browserHandler({ action: 'search_and_read', query: 'x' })
    expect(res.ok).toBe(true)
    expect(res.content).toContain('真实正文内容')
  })
})

describe('lsp_references：stderr 不能再被吞成「未找到」', () => {
  const realPlatform = process.platform
  let tmpDir = ''

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'lumina-lsp-'))
  })
  afterAll(() => {
    // process.platform 只读（Node 20+），用 defineProperty 才能还原
    if (process.platform !== realPlatform) {
      Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true })
    }
    if (tmpDir) { try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ } }
  })

  it('命令执行失败 → ok:false，并把真实 stderr / 退出码 / 原始错误透出来', async () => {
    // 原来的 catch 把任何 "Command failed" 一律吞成「未找到 xxx 的引用」+ ok:true，
    // 目录不存在、grep 不存在、超时全被伪装成「搜过了，没有」。
    // 这里强制走 Unix 分支触发 execSync 异常（Windows 上 sh 不存在 → 必然抛错）。
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    try {
      const res = await lspMod.lspReferencesHandler({ symbol: '绝对不存在的符号zzz', dir: tmpDir, file_pattern: '*.ts' })
      expect(res.ok).toBe(false)
      expect(res.content).toContain('⛔ 未执行成功')
      expect(res.content).toContain('禁止据此作答')
      expect(res.error).toContain('stderr:')
      expect(res.error).toContain('退出码:')
      expect(res.error).toContain('原始错误:')
      // 最关键：绝不能再出现「未找到…的引用」这种伪装成成功的结论
      expect(res.error).not.toContain('的引用')
      expect(res.content).not.toContain('未找到 "绝对不存在的符号zzz" 的引用')
    } finally {
      Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true })
    }
  })

  it('目录下一个文件都没匹配上 → ok:false（没搜 ≠ 没有）', async () => {
    expectFailure(
      await lspMod.lspReferencesHandler({ symbol: 'foo', dir: tmpDir, file_pattern: '*.nope_never_match' }),
      '没有匹配',
    )
  })

  it('对照：搜过了、0 条命中 → 仍是成功的查询 ok:true', async () => {
    writeFileSync(join(tmpDir, 'sample.ts'), 'export const unrelated = 1\n', 'utf-8')
    const res = await lspMod.lspReferencesHandler({ symbol: '绝对不存在的符号zzz', dir: tmpDir, file_pattern: '*.ts' })
    expectEmptySuccess(res)
  })

  it('缺 symbol 参数 → ok:false', async () => {
    expectFailure(await lspMod.lspReferencesHandler({}), 'lsp_references')
  })
})

describe('team：查不到共享上下文不许说成功', () => {
  it('load_context 按 key 查不到 → ok:false，error 写明是哪个 key', async () => {
    const res = await teamMod.loadContext({ key: 'project_status' })
    expectFailure(res, '未找到共享上下文')
    expect(res.content).toContain('project_status')
  })

  it('对照：load_context 不带 key 且存储为空 → 成功的查询 ok:true', async () => {
    expectEmptySuccess(await teamMod.loadContext({}))
  })

  it('load_context 命中 → ok:true 并返回真实内容', async () => {
    ctxState.entries = [{ key: 'project_status', value: '真实状态值', updatedBy: 'lumina', timestamp: '2026-01-01' }]
    const res = await teamMod.loadContext({ key: 'project_status' })
    expect(res.ok).toBe(true)
    expect(res.content).toContain('真实状态值')
    expect(res.error).toBeUndefined()
  })

  it('对照：memory_search 检索到 0 条 → 成功的查询 ok:true', async () => {
    expectEmptySuccess(await teamMod.memorySearch({ query: '某个关键词' }))
  })
})
