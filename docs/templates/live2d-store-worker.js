// ============================================================
// docs/templates/live2d-store-worker.js — Live2D 配件商城后端 (Cloudflare Workers + R2)
//
// 客户端 MVP 不依赖此服务（本地/离线模式已可用）。本文件是「未来上线云端商城」
// 的后端模板，零服务器运维：R2 存模型文件，Workers 做 API。
//
// 接口（均带 CORS；简单 Bearer 鉴权，MVP 不做支付）：
//   GET  /api/models            列出模型（R2 index）
//   GET  /api/models/:id        单个模型元数据
//   POST /api/upload            上传模型包（multipart，鉴权）
//   GET  /api/download/:id      下载模型（命中即给下载量+1）
//   POST /api/purchase/:id      【占位】购买，MVP 永远返回 not-implemented
//
// 部署：见 live2d-store-README.md
// ============================================================

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS },
  })
}

export default {
  /**
   * @param {Request} request
   * @param {{ MODELS: R2Bucket, INDEX: KVNamespace, AUTH_TOKEN: string }} env
   */
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {return new Response(null, { headers: CORS })}

    const url = new URL(request.url)
    const path = url.pathname

    // ── 鉴权（写操作）──────────────────────────────
    const auth = request.headers.get('Authorization') || ''
    const authed = auth === `Bearer ${env.AUTH_TOKEN}`

    try {
      if (path === '/api/models' && request.method === 'GET') {
        const list = await env.INDEX.get('model-index', 'json') || { models: [] }
        return json({ ok: true, models: list.models })
      }

      if (path.startsWith('/api/models/') && request.method === 'GET') {
        const id = path.split('/')[3]
        const list = (await env.INDEX.get('model-index', 'json')) || { models: [] }
        const m = list.models.find((x) => x.id === id)
        return m ? json({ ok: true, model: m }) : json({ ok: false, error: 'not found' }, 404)
      }

      if (path === '/api/upload' && request.method === 'POST') {
        if (!authed) {return json({ ok: false, error: 'unauthorized' }, 401)}
        const form = await request.formData()
        const file = form.get('file')
        const meta = form.get('meta')
        if (!file || !(file instanceof File)) {return json({ ok: false, error: 'missing file' }, 400)}

        const id = crypto.randomUUID()
        await env.MODELS.put(`${id}.zip`, file.stream())
        const list = (await env.INDEX.get('model-index', 'json')) || { models: [] }
        const info = JSON.parse(meta || '{}')
        list.models.unshift({ id, name: info.name || id, author: info.author || 'anonymous', downloads: 0, size: file.size })
        await env.INDEX.put('model-index', JSON.stringify(list))
        return json({ ok: true, id })
      }

      if (path.startsWith('/api/download/') && request.method === 'GET') {
        const id = path.split('/')[3]
        const obj = await env.MODELS.get(`${id}.zip`)
        if (!obj) {return json({ ok: false, error: 'not found' }, 404)}
        // 下载量 +1（异步，不阻塞返回）
        env.INDEX.get('model-index', 'json').then((raw) => {
          const list = raw || { models: [] }
          const m = list.models.find((x) => x.id === id)
          if (m) {m.downloads = (m.downloads || 0) + 1; return env.INDEX.put('model-index', JSON.stringify(list))}
        })
        return new Response(obj.body, {
          headers: { 'Content-Type': 'application/zip', ...CORS },
        })
      }

      // 【占位】购买：MVP 不接支付，永远返回未实现
      if (path.startsWith('/api/purchase/') && request.method === 'POST') {
        return json({ ok: false, error: 'purchase not implemented yet（支付/分成为远期规划）' }, 501)
      }

      return json({ ok: false, error: 'not found' }, 404)
    } catch (e) {
      return json({ ok: false, error: String(e && e.message || e) }, 500)
    }
  },
}
