// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// tests/webdavClient.test.ts — WebDAV 客户端单测（提案4）
// 用 mock fetch 验证请求构造（PROPFIND/PUT/GET/DELETE/MKCOL）与 XML 解析。
import { describe, it, expect, vi } from 'vitest'
import { WebDavClient, parseMultiStatus } from '../electron/sync/webdavClient'

interface Captured {
  url: string
  method: string
  headers: Record<string, string>
  body?: any
}

function makeFetch(captured: Captured[], responder: (url: string, method: string) => any) {
  return vi.fn(async (url: any, init: any = {}) => {
    captured.push({ url: String(url), method: init.method || 'GET', headers: init.headers || {}, body: init.body })
    return responder(String(url), init.method || 'GET')
  }) as any
}

const SAMPLE_XML = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:">
  <d:response>
    <d:href>/dav/lumina-sync/</d:href>
    <d:propstat><d:prop>
      <d:resourcetype><d:collection/></d:resourcetype>
      <d:getlastmodified>Mon, 01 Jan 2024 00:00:00 GMT</d:getlastmodified>
    </d:prop></d:propstat>
  </d:response>
  <d:response>
    <d:href>/dav/lumina-sync/memory%2F2026-09-21.md</d:href>
    <d:propstat><d:prop>
      <d:size>123</d:size>
      <d:getlastmodified>Tue, 02 Jan 2024 03:04:05 GMT</d:getlastmodified>
    </d:prop></d:propstat>
  </d:response>
</d:multistatus>`

describe('WebDavClient 请求构造', () => {
  it('PROPFIND 带 Depth 头、Basic 认证、正确 URL', async () => {
    const captured: Captured[] = []
    const client = new WebDavClient({
      baseUrl: 'https://dav.jianguoyun.com/dav/',
      username: 'user@example.com',
      password: 's3cret',
      fetchImpl: makeFetch(captured, () => new Response(SAMPLE_XML, { status: 207 })),
    })
    await client.list('/lumina-sync', 1)
    expect(captured).toHaveLength(1)
    const c = captured[0]
    expect(c.method).toBe('PROPFIND')
    expect(c.headers.Depth).toBe('1')
    expect(c.headers.Authorization).toMatch(/^Basic /)
    // baseUrl 去掉末尾斜杠后拼接
    expect(c.url).toBe('https://dav.jianguoyun.com/dav/lumina-sync')
  })

  it('PUT 上传 body，Content-Type 设为 octet-stream', async () => {
    const captured: Captured[] = []
    const client = new WebDavClient({
      baseUrl: 'https://cloud.example.com/remote.php/dav/files/u/',
      username: 'u', password: 'p',
      fetchImpl: makeFetch(captured, () => new Response('', { status: 200 })),
    })
    await client.put('/lumina-sync/note.md', Buffer.from('hello'))
    expect(captured[0].method).toBe('PUT')
    expect(captured[0].url).toBe('https://cloud.example.com/remote.php/dav/files/u/lumina-sync/note.md')
    expect(captured[0].headers['Content-Type']).toBe('application/octet-stream')
  })

  it('GET 404 返回 null；非 404 错误抛错', async () => {
    const client404 = new WebDavClient({
      baseUrl: 'https://x.com', username: 'u', password: 'p',
      fetchImpl: makeFetch([], () => new Response('', { status: 404 })),
    })
    expect(await client404.get('/nope.md')).toBeNull()

    const client500 = new WebDavClient({
      baseUrl: 'https://x.com', username: 'u', password: 'p',
      fetchImpl: makeFetch([], () => new Response('boom', { status: 500 })),
    })
    await expect(client500.get('/x.md')).rejects.toThrow(/500/)
  })

  it('DELETE 调用正确方法；MKCOL 逐级创建', async () => {
    const captured: Captured[] = []
    const client = new WebDavClient({
      baseUrl: 'https://x.com/dav', username: 'u', password: 'p',
      fetchImpl: makeFetch(captured, () => new Response('', { status: 200 })),
    })
    await client.delete('/a/b.md')
    expect(captured.at(-1)!.method).toBe('DELETE')
    expect(captured.at(-1)!.url).toBe('https://x.com/dav/a/b.md')

    await client.mkcol('/a/b/c')
    const mkcols = captured.filter((c) => c.method === 'MKCOL').map((c) => c.url)
    expect(mkcols).toContain('https://x.com/dav/a')
    expect(mkcols).toContain('https://x.com/dav/a/b')
    expect(mkcols).toContain('https://x.com/dav/a/b/c')
  })
})

describe('PROPFIND XML 解析', () => {
  it('解析 collection 与文件，size/mtime 正确', () => {
    const entries = parseMultiStatus(SAMPLE_XML, 'https://dav.jianguoyun.com/dav/')
    // 两条 response
    expect(entries).toHaveLength(2)
    const root = entries.find((e) => e.path === '/lumina-sync/' || e.isDir)
    expect(root?.isDir).toBe(true)
    const file = entries.find((e) => e.path.includes('2026-09-21.md'))
    expect(file?.isDir).toBe(false)
    expect(file?.size).toBe(123)
    expect(file?.lastModified).toBeGreaterThan(0)
  })

  it('兼容不同命名空间前缀（d: / D: / webdav:）', () => {
    const xml = `<D:multistatus xmlns:D="DAV:">
      <D:response><D:href>/x/f.md</D:href>
      <D:propstat><D:prop><D:size>5</D:size></D:prop></D:propstat>
      </D:response></D:multistatus>`
    const entries = parseMultiStatus(xml, 'https://x.com/')
    expect(entries[0].size).toBe(5)
  })
})
