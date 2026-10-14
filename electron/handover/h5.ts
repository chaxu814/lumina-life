// ============================================================
// handover/h5.ts — 交班 H5 页面 + 局域网路由描述符
//
// 【安全模型】
//   · 二维码只带交换码；手机拉到的是「密文容器」，口令在手机页面输入、
//     用浏览器 WebCrypto（PBKDF2-SHA256 + AES-GCM，与 Node 侧同参数）
//     在本地解密 —— 口令与明文卡片都不过服务器、不进服务器日志。
//   · 仅「本机密钥」模式例外：卡片以明文存在内存，页面直接渲染；
//     该模式与现有 /m 遥控页同一安全假设（明文 HTTP 局域网链路），
//     页面底部有安全提示。
//   · 卡片内容一律经 textContent 渲染（HTML 转义），交换码条目过期即销毁。
//
// 【接线】集成阶段在 api/server.ts 的 ROUTES 数组中追加
//   ...getHandoverRoutes()（见文件尾注释）。
// ============================================================

import type { IncomingMessage, ServerResponse } from 'http'
import * as url from 'url'
import { lookupExchange, type ExchangeEntry } from './handoverExchange'
import { isHandoverExpired, type HandoverCard } from './handoverTypes'
import type { HandoverContainer } from './handoverCrypto'

/** 把 JSON 安全嵌入 <script>：转义 </script>  breakout 与 < */
function embedJson(obj: unknown): string {
  return JSON.stringify(obj).replace(/</g, '\\u003c')
}

export interface HandoverPageInput {
  state: 'ok-container' | 'ok-plain' | 'expired' | 'unknown'
  container?: HandoverContainer
  card?: HandoverCard
}

export function renderHandoverPage(input: HandoverPageInput): string {
  const stateEsc = embedJson(input.state)
  const containerEsc = embedJson(input.container || null)
  const cardEsc = embedJson(input.card || null)

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<meta name="theme-color" content="#0d1117">
<title>Lumina · 交班摘要</title>
<style>
  :root{
    --bg:#0d1117;--card:#161d27;--card2:#1b2430;--line:#242e3b;
    --txt:#e6edf3;--txt2:#9fb0c0;--txt3:#6b7c8f;
    --pink:#ec4899;--cyan:#22d3ee;--green:#3fb950;--amber:#e3b341;--red:#f85149;
  }
  *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
  html,body{margin:0}
  body{background:var(--bg);color:var(--txt);min-height:100vh;
    font-family:-apple-system,"PingFang SC","Microsoft YaHei",system-ui,sans-serif;
    font-size:16px;padding-bottom:env(safe-area-inset-bottom)}
  header{padding:14px 16px;padding-top:calc(14px + env(safe-area-inset-top));
    background:var(--card);border-bottom:1px solid var(--line)}
  header .logo{font-weight:800;font-size:18px;
    background:linear-gradient(135deg,#ec4899,#a371f7 55%,#22d3ee);
    -webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}
  header .sub{font-size:12.5px;color:var(--txt3);margin-top:3px}
  main{padding:14px 12px;display:flex;flex-direction:column;gap:10px;max-width:640px;margin:0 auto}
  .card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:13px 14px}
  .card h2{margin:0 0 8px;font-size:14px;color:var(--txt2);font-weight:650}
  .pill{display:inline-block;font-size:11.5px;padding:3px 10px;border-radius:999px;
    border:1px solid var(--line);color:var(--txt3);margin-right:6px}
  .pill.ok{color:var(--green);border-color:rgba(63,185,80,.4)}
  .pill.bad{color:var(--red);border-color:rgba(248,81,73,.4)}
  .pill.warn{color:var(--amber);border-color:rgba(227,179,65,.4)}
  .row{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:13.5px;color:var(--txt2);margin-top:6px}
  .row b{color:var(--txt);font-weight:650}
  ul{margin:6px 0 0;padding-left:18px;font-size:14px;color:var(--txt2)}
  li{margin:3px 0;word-break:break-word}
  .appr{background:rgba(227,179,65,.08);border:1px solid rgba(227,179,65,.35);
    border-radius:12px;padding:11px 12px;margin-top:8px}
  .appr .t{font-weight:700;color:var(--amber);font-size:13.5px;word-break:break-word}
  .appr .d{font-size:12.5px;color:var(--txt3);margin:4px 0 9px;word-break:break-all}
  .appr .row{display:flex;gap:8px;margin:0}
  .appr button{flex:1;padding:9px;border:none;border-radius:9px;font-size:14px;font-weight:650}
  .appr .ok{background:var(--green);color:#04220c}
  .appr .no{background:var(--red);color:#2a0605}
  .appr button:disabled{opacity:.35}
  input[type=password]{width:100%;background:var(--bg);border:1px solid var(--line);
    border-radius:10px;color:var(--txt);padding:11px 13px;font-size:16px;margin:8px 0}
  button.primary{width:100%;padding:12px;border:none;border-radius:11px;font-size:15px;font-weight:700;
    background:linear-gradient(135deg,#ec4899,#a371f7);color:#fff}
  .banner{border-radius:12px;padding:12px 14px;font-size:14px;border:1px solid}
  .banner.exp{background:rgba(248,81,73,.08);border-color:rgba(248,81,73,.4);color:var(--red)}
  .banner.tip{background:var(--card2);border-color:var(--line);color:var(--txt3);font-size:12.5px;line-height:1.6}
  .muted{color:var(--txt3);font-size:13px}
</style>
</head>
<body>
<header>
  <div class="logo">Lumina · 交班摘要</div>
  <div class="sub" id="sub">加载中…</div>
</header>
<main id="main">
  <div class="card">
    <div id="decryptBox">
      <div class="muted">这是一张加密交班卡片。输入电脑端设置的口令解密：</div>
      <input type="password" id="pw" placeholder="交班口令" autocomplete="off">
      <button class="primary" id="btnDecrypt">解密查看</button>
      <div class="muted" id="decErr" style="margin-top:8px"></div>
    </div>
    <div id="content" style="display:none"></div>
  </div>
  <div class="banner tip">安全提示：仅局域网内使用，请勿将端口暴露到公网。口令只在你的手机浏览器里解密，不会发给电脑。</div>
</main>
<script>
(function(){
  var STATE = ${stateEsc};
  var CONTAINER = ${containerEsc};
  var CARD = ${cardEsc};
  var sub = document.getElementById('sub');
  var content = document.getElementById('content');
  var decryptBox = document.getElementById('decryptBox');

  function el(tag, cls, text){
    var d = document.createElement('div');
    if (cls) {d.className = cls}
    if (text !== undefined) {d.textContent = text}
    return d;
  }
  function escHtml(s){ var d = document.createElement('span'); d.textContent = String(s == null ? '' : s); return d; }

  // ── WebCrypto：PBKDF2-SHA256(150000) + AES-256-GCM，与 Node 侧同参数 ──
  async function decryptWithPassword(container, password){
    var enc = new TextEncoder();
    var keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
    var key = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: hex2buf(container.salt), iterations: 150000, hash: 'SHA-256' },
      keyMaterial, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    var plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: hex2buf(container.iv), tag: hex2buf(container.tag) },
      key, b64buf(container.ct));
    return JSON.parse(new TextDecoder().decode(plain));
  }
  function hex2buf(h){ var out = new Uint8Array(h.length/2); for (var i=0;i<out.length;i++){ out[i]=parseInt(h.substr(i*2,2),16); } return out; }
  function b64buf(b){ var s = atob(b); var out = new Uint8Array(s.length); for (var i=0;i<s.length;i++){ out[i]=s.charCodeAt(i); } return out; }

  // ── 渲染卡片（全部 textContent，HTML 转义）──
  function renderCard(card, expired){
    content.innerHTML = '';
    sub.textContent = (expired ? '已过期 · ' : '有效 · ') + '生成于 ' + fmtTime(card.generatedAt);

    if (expired){
      content.appendChild(el('div','banner exp','已过期（生成于 ' + fmtTime(card.generatedAt) + '）。审批动作已锁定，请在电脑端重新生成交班卡片。'));
    }

    // 状态 pills
    var pills = el('div', null);
    pills.appendChild(el('span','pill ' + (card.agentStates.filter(function(a){return a.state==='working'||a.state==='reviewing';}).length ? 'warn' : 'ok'),
      card.agentStates.map(function(a){return a.id + ':' + a.state;}).join(' · ')));
    pills.appendChild(el('span','pill', '待审批 ' + (card.pendingApprovals||[]).length));
    content.appendChild(pills);

    // 今日摘要
    if (card.summary){
      var sc = el('div','card');
      sc.appendChild(el('h2', null, '今日摘要 · ' + card.summary.date));
      var row = el('div','row');
      [['花费(元)', card.summary.costYuan],['Prompt', card.summary.promptTokens],['完成', card.summary.completionTokens],
       ['命令', card.summary.commands],['委托', card.summary.delegates],['轮次', card.summary.turns]].forEach(function(p){
        if (p[1] === undefined || p[1] === null) {return;}
        var item = document.createElement('span');
        var b = document.createElement('b'); b.textContent = String(p[1]);
        item.appendChild(document.createTextNode(p[0] + ' ')); item.appendChild(b);
        row.appendChild(item);
      });
      sc.appendChild(row);
      if (card.summary.items && card.summary.items.length){
        var ul = document.createElement('ul');
        card.summary.items.slice(0,20).forEach(function(it){ var li = document.createElement('li'); li.textContent = '[' + it.kind + '] ' + it.title; ul.appendChild(li); });
        sc.appendChild(ul);
      }
      content.appendChild(sc);
    } else {
      content.appendChild(el('div','card muted','今日摘要：暂无数据（Day Replay 未产出）。'));
    }

    // 待办
    if (card.todos && card.todos.length){
      var tc = el('div','card');
      tc.appendChild(el('h2', null, '待办'));
      var ul2 = document.createElement('ul');
      card.todos.forEach(function(t){ var li = document.createElement('li'); li.textContent = (t.done ? '✓ ' : '□ ') + t.text; ul2.appendChild(li); });
      tc.appendChild(ul2);
      content.appendChild(tc);
    }

    // 待审批（过期时按钮禁用）
    (card.pendingApprovals||[]).forEach(function(a){
      var box = el('div','appr');
      var t = el('div','t'); t.textContent = '待你批准：' + a.title;
      var d = el('div','d'); d.textContent = (a.risk ? '风险等级：' + a.risk : '');
      var r = el('div','row');
      var ok = document.createElement('button'); ok.className='ok'; ok.textContent='允许'; ok.disabled = expired;
      var no = document.createElement('button'); no.className='no'; no.textContent='拒绝'; no.disabled = expired;
      ok.onclick = function(){ decide(a.id, true, ok, no); };
      no.onclick = function(){ decide(a.id, false, ok, no); };
      r.appendChild(ok); r.appendChild(no);
      box.appendChild(t); box.appendChild(d); box.appendChild(r);
      content.appendChild(box);
    });
  }

  function fmtTime(ts){ var d = new Date(ts); function p(n){return String(n).padStart(2,'0');}
    return (d.getMonth()+1)+'/'+d.getDate()+' '+p(d.getHours())+':'+p(d.getMinutes()); }

  function decide(id, allow, b1, b2){
    b1.disabled = b2.disabled = true;
    fetch('/api/approvals/' + encodeURIComponent(id) + (allow ? '/approve' : '/deny'), {
      method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({note:'来自交班 H5'})
    }).then(function(r){
      if (r.ok){ b1.textContent = allow ? '✅ 已允许' : '⛔ 已拒绝'; }
      else { b1.textContent = '请求失败'; b1.disabled = b2.disabled = false; }
    }).catch(function(){ b1.textContent = '网络错误'; b1.disabled = b2.disabled = false; });
  }

  function showCard(card){
    decryptBox.style.display = 'none';
    content.style.display = 'block';
    var expired = Date.now() >= card.expiresAt;
    renderCard(card, expired);
  }

  // ── 入口 ──
  if (STATE === 'unknown'){
    sub.textContent = '交换码无效或已被作废';
    content.style.display = 'block';
    content.appendChild(el('div','banner exp','交换码不存在、已过期或已作废。请在电脑端重新生成二维码。'));
    decryptBox.style.display = 'none';
  } else if (STATE === 'expired'){
    sub.textContent = '卡片已过期';
    content.style.display = 'block';
    content.appendChild(el('div','banner exp','交班卡片已过有效期。请在电脑端重新生成。'));
    decryptBox.style.display = 'none';
  } else if (STATE === 'ok-plain'){
    showCard(CARD); // 本机密钥模式：页面直接渲染（明文仅在本局域网链路）
  } else {
    document.getElementById('btnDecrypt').onclick = async function(){
      var pw = document.getElementById('pw').value;
      try { showCard(await decryptWithPassword(CONTAINER, pw)); }
      catch (e){ document.getElementById('decErr').textContent = '口令错误或卡片已被篡改。'; }
    };
  }
})();
</script>
</body>
</html>`
}

// ═══════════════════════════════════════════════════════════
// 路由描述符 —— 集成时追加到 server.ts 的 ROUTES 数组
// ═══════════════════════════════════════════════════════════

/** GET /m/handover?k=<交换码>：凭码取密文容器（明文卡片不出服务器日志） */
async function handleHandoverPage(
  req: IncomingMessage,
  res: ServerResponse,
  _match: RegExpExecArray,
  _body: unknown,
): Promise<void> {
  const k = url.parse(req.url || '', true).query.k
  const code = Array.isArray(k) ? k[0] : k
  let html: string
  if (!code) {
    html = renderHandoverPage({ state: 'unknown' })
  } else {
    const entry: ExchangeEntry | null = lookupExchange(String(code))
    if (!entry) {
      html = renderHandoverPage({ state: 'unknown' })
    } else if (isHandoverExpired({ expiresAt: entry.expiresAt })) {
      // 双保险：lookupExchange 已销毁过期条目；这里只是防御
      html = renderHandoverPage({ state: 'expired' })
    } else if (entry.payload.kind === 'plain-card') {
      html = renderHandoverPage({ state: 'ok-plain', card: entry.payload.card })
    } else {
      html = renderHandoverPage({ state: 'ok-container', container: entry.payload.container })
    }
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(html)
}

export interface HandoverRouteDescriptor {
  method: string
  path: RegExp
  handler: (req: IncomingMessage, res: ServerResponse, match: RegExpExecArray, body: unknown) => Promise<void>
}

/**
 * 集成点：server.ts 的 ROUTES 数组（L87-167）里加一行：
 *   ...getHandoverRoutes(),
 * 路由：GET /m/handover?k=...（与现有 /m 手机页同源，复用 /api/approvals 审批端点）
 */
export function getHandoverRoutes(): HandoverRouteDescriptor[] {
  return [
    { method: 'GET', path: /^\/m\/handover\/?$/, handler: handleHandoverPage },
  ]
}
