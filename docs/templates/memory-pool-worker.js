/**
 * docs/templates/memory-pool-worker.js — 公共记忆池 Worker（提案3, Level 2：模板）
 * ============================================================================
 *
 * 这是一个「模板」，不是 Lumina 主进程里运行的代码。
 * 它演示如何用 Cloudflare Workers + KV 搭一个极简的公共记忆池：
 *   - 发布（publish）：把一段记忆包（JSON）上传到 KV
 *   - 订阅（subscribe）：按标签/来源拉取记忆包列表与内容
 *   - 简单 token 鉴权：请求头 Authorization: Bearer <POOL_TOKEN>
 *
 * ⚠️ 隐私红线：
 *   - 这个池子里的内容是「明文」的，只适合放你愿意公开分享的、脱敏后的记忆。
 *   - 真正端到端加密的 P2P 方案见 docs/federation-e2ee-design.md（尚未实现）。
 *   - 不要把包含真实个人隐私的记忆直接 publish 到这里。
 *
 * ----------------------------------------------------------------------------
 * 部署步骤（wrangler）：
 *   1. npm i -g wrangler
 *   2. wrangler login
 *   3. wrangler kv namespace create MEMORY_POOL
 *      把返回的 id 填到下面 [kv_namespaces].id
 *   4. 设置访问 token：
 *        wrangler secret put POOL_TOKEN
 *        （输入一个长随机串，客户端请求时带 Bearer）
 *   5. wrangler deploy
 *
 * 客户端用法（在 Lumina 里手动导出 JSON 后）：
 *   发布：
 *     curl -X POST https://<your-worker>.workers.dev/publish \
 *       -H "Authorization: Bearer <POOL_TOKEN>" \
 *       -H "Content-Type: application/json" \
 *       -d @lumina-memory-export.json
 *   列表：
 *     curl https://<your-worker>.workers.dev/pool?tag=cat-lover \
 *       -H "Authorization: Bearer <POOL_TOKEN>"
 *   拉取单条：
 *     curl https://<your-worker>.workers.dev/mem/<id> \
 *       -H "Authorization: Bearer <POOL_TOKEN>"
 * ----------------------------------------------------------------------------
 */

/** KV 绑定：在 wrangler.toml 里配 [kv_namespaces] binding = "MEMORY_POOL" */
const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' }

function unauthorized() {
  return new Response(JSON.stringify({ ok: false, error: 'unauthorized' }), {
    status: 401, headers: JSON_HEADERS,
  })
}

function checkToken(request, env) {
  const auth = request.headers.get('Authorization') || ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  if (!env.POOL_TOKEN || token !== env.POOL_TOKEN) {return false}
  return true
}

/** KV key 规约：mem:<id> 存内容；index 存 "id\nid\n..." 的索引（含 tag 前缀） */
async function listPool(env, tag) {
  const indexKey = tag ? `index:${tag}` : 'index'
  const raw = await env.MEMORY_POOL.get(indexKey)
  const ids = raw ? raw.split('\n').filter(Boolean) : []
  // 只返回元信息，不返回正文
  const items = []
  for (const id of ids) {
    const meta = await env.MEMORY_POOL.get(`meta:${id}`)
    if (meta) {items.push(JSON.parse(meta))}
  }
  return items.sort((a, b) => b.publishedAt - a.publishedAt)
}

export default {
  async fetch(request, env) {
    if (!checkToken(request, env)) {return unauthorized()}

    const url = new URL(request.url)
    const method = request.method

    try {
      // ── 列表：GET /pool?tag=xxx ──────────────────────
      if (method === 'GET' && url.pathname === '/pool') {
        const tag = url.searchParams.get('tag') || ''
        const items = await listPool(env, tag)
        return new Response(JSON.stringify({ ok: true, items }), { headers: JSON_HEADERS })
      }

      // ── 拉取单条：GET /mem/<id> ─────────────────────
      if (method === 'GET' && url.pathname.startsWith('/mem/')) {
        const id = url.pathname.slice('/mem/'.length)
        const body = await env.MEMORY_POOL.get(`mem:${id}`)
        if (!body) {
          return new Response(JSON.stringify({ ok: false, error: 'not found' }), { status: 404, headers: JSON_HEADERS })
        }
        return new Response(body, { headers: JSON_HEADERS })
      }

      // ── 发布：POST /publish  body = Lumina 记忆包 JSON ──
      if (method === 'POST' && url.pathname === '/publish') {
        const pkg = await request.json()
        if (!pkg || pkg.app !== 'lumina-life') {
          return new Response(JSON.stringify({ ok: false, error: 'only lumina-life package accepted' }), { status: 400, headers: JSON_HEADERS })
        }
        const id = (pkg.source || 'anon').replace(/[^\w-]/g, '_') + '-' + Date.now().toString(36)
        const tag = (pkg.source || 'misc').replace(/[^\w-]/g, '_')

        await env.MEMORY_POOL.put(`mem:${id}`, JSON.stringify(pkg))
        await env.MEMORY_POOL.put(`meta:${id}`, JSON.stringify({
          id, source: pkg.source, tag,
          entries: (pkg.entries || []).length,
          publishedAt: Date.now(),
        }))

        // 追加进索引
        for (const idx of [`index:${tag}`, 'index']) {
          const prev = await env.MEMORY_POOL.get(idx) || ''
          await env.MEMORY_POOL.put(idx, prev ? prev + '\n' + id : id)
        }

        return new Response(JSON.stringify({ ok: true, id }), { headers: JSON_HEADERS })
      }

      return new Response(JSON.stringify({ ok: false, error: 'not found' }), { status: 404, headers: JSON_HEADERS })
    } catch (err) {
      return new Response(JSON.stringify({ ok: false, error: String(err) }), { status: 500, headers: JSON_HEADERS })
    }
  },
}
