// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// api/mobilePage.ts — 手机远程访问 H5 页面 (v1.0)
//
// 【为什么做这个】
//   Lumina 的核心形态是「桌宠常驻电脑」，所以「人不在电脑前也能管它」
//   是刚需。业界 H5 远程访问与 30+ 渠道的成熟实现证明这条路可行。
//   本页复用已有的 REST API（/api/chat · /api/health · /api/approvals），
//   不需要原生 App、不需要上架商店 —— 手机浏览器扫码即用。
//
// 【安全】
//   · 默认 API 只监听 127.0.0.1（手机访问不到）。要远程访问必须显式把
//     host 改成 0.0.0.0（见 server.ts 的 LAN 提示）。
//   · 若配置了 apiKey，本页会把用户填的 key 存 localStorage 并随请求发送。
//   · 页面自身与 API 同源，不产生跨域问题。
//
// 【零依赖】
//   纯手写 HTML/CSS/JS 字符串，不引入任何前端框架或外部资源。
// ============================================================

/** 转义嵌入到 <script> 里的字符串，避免 </script> 提前闭合 */
function esc(s: string): string {
  return s.replace(/<\//g, '<\\/')
}

export function renderMobilePage(opts: { version?: string } = {}): string {
  const version = esc(opts.version || '0.1.0')
  // ⚠️ 页面内联脚本**不使用模板字符串**（避免与外层反引号冲突），
  //    全部用字符串拼接，安全且易读。
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<meta name="theme-color" content="#0d1117">
<meta name="apple-mobile-web-app-capable" content="yes">
<title>Lumina · 手机遥控</title>
<style>
  :root{
    --bg:#0d1117;--card:#161d27;--card2:#1b2430;--line:#242e3b;
    --txt:#e6edf3;--txt2:#9fb0c0;--txt3:#6b7c8f;
    --pink:#ec4899;--cyan:#22d3ee;--green:#3fb950;--amber:#e3b341;--red:#f85149;
  }
  *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
  html,body{margin:0;height:100%}
  body{background:var(--bg);color:var(--txt);display:flex;flex-direction:column;
    font-family:-apple-system,"PingFang SC","Microsoft YaHei",system-ui,sans-serif;
    font-size:16px;overscroll-behavior:none}
  header{display:flex;align-items:center;gap:10px;padding:12px 14px;
    padding-top:calc(12px + env(safe-area-inset-top));
    background:var(--card);border-bottom:1px solid var(--line);position:sticky;top:0;z-index:10}
  header .logo{font-weight:800;font-size:17px;
    background:linear-gradient(135deg,#ec4899,#a371f7 55%,#22d3ee);
    -webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}
  .pill{font-size:11.5px;padding:3px 10px;border-radius:999px;border:1px solid var(--line);color:var(--txt3)}
  .pill.ok{color:var(--green);border-color:rgba(63,185,80,.4)}
  .pill.bad{color:var(--red);border-color:rgba(248,81,73,.4)}
  header .sp{flex:1}
  header button{background:none;border:1px solid var(--line);color:var(--txt2);
    border-radius:8px;padding:6px 10px;font-size:13px}
  #settings{display:none;padding:12px 14px;background:var(--card2);border-bottom:1px solid var(--line);gap:8px;flex-direction:column}
  #settings.show{display:flex}
  #settings label{font-size:12.5px;color:var(--txt3)}
  #settings input{width:100%;background:var(--bg);border:1px solid var(--line);border-radius:9px;
    color:var(--txt);padding:10px 12px;font-size:15px}
  #stream{flex:1;overflow-y:auto;padding:14px 12px 8px;display:flex;flex-direction:column;gap:10px}
  .msg{max-width:86%;padding:10px 13px;border-radius:14px;line-height:1.55;white-space:pre-wrap;
    word-break:break-word;font-size:15px}
  .msg.me{align-self:flex-end;background:linear-gradient(135deg,#ec4899,#a371f7);color:#fff;border-bottom-right-radius:5px}
  .msg.ai{align-self:flex-start;background:var(--card);border:1px solid var(--line);border-bottom-left-radius:5px}
  .msg.sys{align-self:center;background:transparent;color:var(--txt3);font-size:12.5px;text-align:center;max-width:92%}
  .msg.think{align-self:flex-start;color:var(--txt3);font-size:13px;background:transparent;padding:4px 6px}
  #approvals{margin:0 12px;display:none;flex-direction:column;gap:8px}
  #approvals.show{display:flex}
  .appr{background:rgba(227,179,65,.08);border:1px solid rgba(227,179,65,.35);border-radius:12px;padding:12px}
  .appr .t{font-weight:700;color:var(--amber);font-size:14px;margin-bottom:4px}
  .appr .d{font-size:13px;color:var(--txt2);word-break:break-all;margin-bottom:10px}
  .appr .row{display:flex;gap:8px}
  .appr button{flex:1;padding:10px;border-radius:9px;border:none;font-size:14px;font-weight:650}
  .appr .ok{background:var(--green);color:#04220c}
  .appr .no{background:var(--red);color:#2a0605}
  footer{border-top:1px solid var(--line);padding:8px 12px;padding-bottom:calc(8px + env(safe-area-inset-bottom));
    background:var(--card)}
  .quick{display:flex;gap:6px;overflow-x:auto;padding-bottom:8px}
  .quick button{white-space:nowrap;background:var(--card2);border:1px solid var(--line);color:var(--txt2);
    border-radius:999px;padding:6px 12px;font-size:12.5px}
  .compose{display:flex;gap:8px;align-items:flex-end}
  .compose textarea{flex:1;background:var(--bg);border:1px solid var(--line);border-radius:12px;
    color:var(--txt);padding:11px 13px;font-size:16px;resize:none;max-height:120px;line-height:1.4;
    font-family:inherit}
  .compose button{width:46px;height:46px;flex:none;border-radius:50%;border:none;
    background:linear-gradient(135deg,#ec4899,#a371f7);color:#fff;font-size:20px;font-weight:700}
  .compose button:disabled{opacity:.4}
</style>
</head>
<body>
<header>
  <span class="logo">Lumina</span>
  <span class="pill" id="status">连接中…</span>
  <span class="sp"></span>
  <button id="btnSettings">⚙︎</button>
</header>

<div id="settings">
  <label>API Key（仅当电脑端开启了认证时需要）</label>
  <input id="apiKey" type="password" placeholder="留空表示未开启认证" autocomplete="off">
  <div style="font-size:12px;color:var(--txt3)">
    本页通过电脑上的 Lumina REST API 通信，数据不出你的局域网。
  </div>
</div>

<div id="approvals"></div>
<div id="stream"></div>

<footer>
  <div class="quick">
    <button data-cmd="/help">/help</button>
    <button data-cmd="/agents">/agents</button>
    <button data-cmd="/yak ">/yak</button>
    <button data-cmd="/recha ">/recha</button>
    <button data-cmd="/stats">/stats</button>
  </div>
  <div class="compose">
    <textarea id="input" rows="1" placeholder="跟 Lumina 说点什么…"></textarea>
    <button id="send" disabled>↑</button>
  </div>
</footer>

<script>
(function(){
  var VERSION = "${version}";
  var stream = document.getElementById('stream');
  var input = document.getElementById('input');
  var sendBtn = document.getElementById('send');
  var statusEl = document.getElementById('status');
  var apprEl = document.getElementById('approvals');
  var keyInput = document.getElementById('apiKey');
  var settings = document.getElementById('settings');

  keyInput.value = localStorage.getItem('lumina_api_key') || '';
  keyInput.addEventListener('input', function(){
    localStorage.setItem('lumina_api_key', keyInput.value.trim());
    ping();
  });
  document.getElementById('btnSettings').onclick = function(){
    settings.classList.toggle('show');
  };

  function headers(){
    var h = { 'Content-Type': 'application/json' };
    var k = keyInput.value.trim();
    if (k) h['X-API-Key'] = k;
    return h;
  }

  function addMsg(kind, text){
    var d = document.createElement('div');
    d.className = 'msg ' + kind;
    d.textContent = text;
    stream.appendChild(d);
    stream.scrollTop = stream.scrollHeight;
    return d;
  }

  // ── 健康检查 / 连接状态 ──
  function ping(){
    fetch('/api/health', { headers: headers() })
      .then(function(r){ return r.ok ? r.json() : Promise.reject(r.status); })
      .then(function(d){
        statusEl.textContent = '已连接 · ' + (d.platform || '');
        statusEl.className = 'pill ok';
      })
      .catch(function(e){
        statusEl.textContent = (e === 401) ? '需要 API Key' : '未连接';
        statusEl.className = 'pill bad';
      });
  }
  ping();
  setInterval(ping, 15000);

  // ── 发送消息 ──
  var sending = false;
  function send(text){
    text = (text || '').trim();
    if (!text || sending) return;
    sending = true;
    sendBtn.disabled = true;
    addMsg('me', text);
    var thinking = addMsg('think', '…思考中');

    fetch('/api/chat', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ message: text, agent_id: 'lumina', mode: 'agent' }),
    })
      .then(function(r){ return r.json().then(function(j){ return { ok: r.ok, j: j }; }); })
      .then(function(res){
        thinking.remove();
        if (res.ok && res.j && res.j.content){
          addMsg('ai', res.j.content);
        } else {
          addMsg('sys', '⚠️ ' + ((res.j && (res.j.error || res.j.message)) || '无返回内容'));
        }
      })
      .catch(function(e){
        thinking.remove();
        addMsg('sys', '⚠️ 请求失败：' + e + '（确认手机与电脑在同一局域网，且电脑端已开启 API 并允许局域网访问）');
      })
      .then(function(){
        sending = false;
        sendBtn.disabled = !input.value.trim();
      });
  }

  input.addEventListener('input', function(){
    sendBtn.disabled = !input.value.trim() || sending;
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  });
  input.addEventListener('keydown', function(e){
    if (e.key === 'Enter' && !e.shiftKey){ e.preventDefault(); send(input.value); input.value=''; input.style.height='auto'; sendBtn.disabled = true; }
  });
  sendBtn.onclick = function(){ send(input.value); input.value=''; input.style.height='auto'; sendBtn.disabled = true; };

  Array.prototype.forEach.call(document.querySelectorAll('.quick button'), function(b){
    b.onclick = function(){
      var c = b.getAttribute('data-cmd');
      if (c.slice(-1) === ' '){ input.value = c; input.focus(); }
      else { send(c); }
    };
  });

  // ── 待审批权限（手机上也能批准 / 拒绝）──
  function renderApprovals(list){
    apprEl.innerHTML = '';
    if (!list || !list.length){ apprEl.classList.remove('show'); return; }
    apprEl.classList.add('show');
    list.forEach(function(a){
      var box = document.createElement('div');
      box.className = 'appr';
      var t = document.createElement('div');
      t.className = 't';
      t.textContent = '⚠️ 待你批准：' + (a.toolName || a.title || '未知操作');
      var d = document.createElement('div');
      d.className = 'd';
      d.textContent = (a.reason || a.description || a.detail || '') + (a.riskLevel ? '（风险：' + a.riskLevel + '）' : '');
      var row = document.createElement('div');
      row.className = 'row';
      var ok = document.createElement('button'); ok.className='ok'; ok.textContent='允许';
      var no = document.createElement('button'); no.className='no'; no.textContent='拒绝';
      ok.onclick = function(){ decide(a.id, true); };
      no.onclick = function(){ decide(a.id, false); };
      row.appendChild(ok); row.appendChild(no);
      box.appendChild(t); box.appendChild(d); box.appendChild(row);
      apprEl.appendChild(box);
    });
  }
  function decide(id, allow){
    var url = '/api/approvals/' + encodeURIComponent(id) + (allow ? '/approve' : '/deny');
    fetch(url, { method: 'POST', headers: headers(), body: JSON.stringify({ note: '来自手机端' }) })
      .then(function(){ addMsg('sys', allow ? '✅ 已允许该操作' : '⛔ 已拒绝该操作'); pollApprovals(); })
      .catch(function(){ addMsg('sys', '⚠️ 审批请求失败'); });
  }
  function pollApprovals(){
    fetch('/api/approvals', { headers: headers() })
      .then(function(r){ return r.ok ? r.json() : null; })
      .then(function(d){ if (d) renderApprovals(d.pending || d.approvals || []); })
      .catch(function(){});
  }
  pollApprovals();
  setInterval(pollApprovals, 5000);

  addMsg('sys', 'Lumina 手机遥控 v' + VERSION + ' · 与电脑端同一局域网即可使用');
})();
</script>
</body>
</html>`
}
