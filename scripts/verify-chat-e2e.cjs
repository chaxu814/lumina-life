#!/usr/bin/env node
/**
 * scripts/verify-chat-e2e.cjs — 聊天链路端到端冒烟验证
 *
 * 【为什么需要它】
 *   2026-10-10 的聊天质量审计发现：大量聊天行为**只有源码正则测试**，
 *   用户真正点击的那条路（sendMessage 端到端、消息装配、上下文窗口下发）
 *   没有任何运行时证明。而正是靠真跑一次，才抓到了单测发现不了的 bug：
 *     · Agent 配置的 maxContextTokens 从未到达 AgentRunner（实测填 32768，
 *       日志却是 context=256000）；
 *     · 同一轮里 AgentRunner 与 LLMProvider 打印的上下文窗口不一致。
 *
 *   本脚本把「真跑一次」固化下来：起一个 OpenAI 兼容 mock 服务 →
 *   用**真实构建产物**跑一轮 CLI 对话 → 断言请求与回复。
 *
 * 【用法】
 *   npx electron-vite build          # 先构建
 *   node scripts/verify-chat-e2e.cjs
 *
 * ⚠️ 必须在**普通终端**里运行。受限的 Agent 沙箱会拦截 child_process，
 *    表现为 spawnSync 直接返回 EBUSY / status=null（脚本会明确提示）。
 *
 * 退出码 0 = 全部通过；1 = 有断言失败（详情打印在 stdout）。
 */

const http = require('http')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..')
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const MAIN = path.join(ROOT, 'out', 'main', 'index.js')

const PORT = Number(process.env.E2E_MOCK_PORT || 18099)
const REPLY = '【E2E-OK】收到，这是 mock 模型的回答。'
const CTX_WINDOW = 32768
const USER_TEXT = '端到端验证：请确认你收到了这条消息'

let failures = 0
const ok = (cond, label, extra) => {
  console.log(`${cond ? '  ✅' : '  ❌'} ${label}${extra ? '  → ' + extra : ''}`)
  if (!cond) {failures++}
}

// ── 1) mock OpenAI 服务（支持 SSE 流式） ──────────────────────────
const requests = []
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', c => { body += c })
  req.on('end', () => {
    let parsed = null
    try { parsed = JSON.parse(body) } catch { /* 忽略非 JSON */ }
    requests.push({ url: req.url, body: parsed })

    if (String(req.url).includes('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'e2e-model' }] }))
      return
    }
    if (!String(req.url).includes('/chat/completions')) {
      res.writeHead(404); res.end('{}'); return
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
    const chunks = REPLY.match(/[\s\S]{1,6}/g) || []
    let i = 0
    const timer = setInterval(() => {
      if (i < chunks.length) {
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: chunks[i++] } }] })}\n\n`)
      } else {
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`)
        res.write('data: [DONE]\n\n')
        clearInterval(timer); res.end()
      }
    }, 4)
  })
})

function run() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-e2e-'))
  const userData = path.join(tmpRoot, 'userdata')
  fs.mkdirSync(userData, { recursive: true })

  // 关键：**只**通过 maxContextTokens 配置上下文窗口（单一真相源）
  const agentCfg = {
    enabled: true, provider: 'custom', model: 'e2e-model',
    endpoint: `http://127.0.0.1:${PORT}/v1`, apiKey: '',
    maxContextTokens: CTX_WINDOW, timeout: 600,
  }
  fs.writeFileSync(
    path.join(userData, 'agent-llm-configs.json'),
    JSON.stringify({ lumina: agentCfg, yak: agentCfg, recha: agentCfg }, null, 2),
    'utf8',
  )

  console.log(`\n▶ 用真实构建产物跑一轮 CLI 对话（mock 端口 ${PORT}）…\n`)
  const env = { ...process.env, LUMINA_USER_DATA: userData }
  // 这几个环境变量会让 electron.exe 退化成纯 Node（见 electron/appName.ts 的自检）
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NODE_OPTIONS
  delete env.CODE_BUDDY_SAFE_DELETE_BULK_GUARD
  delete env.CODEBUDDY_SAFE_DELETE_BULK_GUARD

  const r = spawnSync(ELECTRON, [MAIN, '--cli', 'chat', USER_TEXT], {
    cwd: ROOT, env, encoding: 'utf8', timeout: 120_000,
  })
  const out = `${r.stdout || ''}\n${r.stderr || ''}`

  // 起不来时先把原因说清楚，别让断言失败信息误导排查方向
  if (r.error || r.status === null) {
    const code = r.error && r.error.code
    console.error(`\n❌ 无法启动 Electron（${code || '未知'}）。`)
    if (code === 'EBUSY' || code === 'EPERM') {
      console.error('   这通常是**受限沙箱**拦截了子进程（Agent 沙箱常见）。')
      console.error('   请在普通终端 / 项目根目录直接运行本脚本。')
    }
    if (out.trim()) {console.error('\n--- 子进程输出 ---\n' + out.slice(-1500))}
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch { /* ignore */ }
    server.close(); process.exit(1)
  }
  if (process.env.E2E_DEBUG) {console.log('--- 子进程输出 ---\n' + out.slice(-2500))}

  // ── 2) 断言 ─────────────────────────────────────────────────
  console.log('【回复链路】')
  ok(out.includes(REPLY), 'mock 回复被真实渲染到输出', REPLY.slice(0, 14) + '…')
  ok(!/❌ 错误/.test(out), '本轮没有报错')

  console.log('\n【消息装配（P2-9：不得重复）】')
  const cc = requests.filter(q => String(q.url).includes('chat/completions'))
  ok(cc.length > 0, `发生了 chat/completions 请求`, `${cc.length} 次`)
  const anyDup = cc.some(q => {
    const u = (q.body?.messages || []).filter(m => m.role === 'user')
    return u.length > 1 && u[0].content === u[1].content
  })
  ok(!anyDup, '发给模型的 messages 里没有重复的同一句 user 消息')
  const carried = cc.some(q => (q.body?.messages || []).some(
    m => m.role === 'user' && String(m.content).includes(USER_TEXT),
  ))
  ok(carried, '用户原话确实到达了模型')

  console.log('\n【上下文窗口下发（运行时验证发现的 bug）】')
  const mProfile = out.match(/profile 匹配:[^\n]*context=(\d+)(\(用户设置\))?/)
  ok(!!mProfile, 'AgentRunner 打印了 profile 匹配行')
  if (mProfile) {
    ok(Number(mProfile[1]) === CTX_WINDOW, `profile 匹配用的就是用户配置的窗口`, mProfile[1])
    ok(!!mProfile[2], '被识别为「用户设置」而非 profile 兜底猜测')
  }
  const mCtx = out.match(/上下文:([\d.]+)k/)
  ok(!!mCtx, 'LLM 调用日志打印了上下文窗口')
  if (mCtx) {
    const k = Math.round(Number(mCtx[1]) * 1000)
    ok(Math.abs(k - CTX_WINDOW) < 1200, '两处日志的上下文窗口一致（不再一处 32768、一处 256.0k）', `${mCtx[1]}k`)
  }

  try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch { /* ignore */ }

  console.log(`\n${failures === 0 ? '✅ 端到端验证全部通过' : `❌ 有 ${failures} 项失败`}\n`)
  server.close()
  process.exit(failures === 0 ? 0 : 1)
}

server.listen(PORT, '127.0.0.1', () => {
  if (!fs.existsSync(MAIN)) {
    console.error(`❌ 找不到构建产物 ${MAIN}\n   请先执行：npx electron-vite build`)
    server.close(); process.exit(1)
  }
  try { run() } catch (e) {
    console.error('❌ 验证脚本异常:', e)
    server.close(); process.exit(1)
  }
})
