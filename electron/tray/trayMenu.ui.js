// ============================================================
// trayMenu.js — 托盘浮层菜单的交互脚本
//
// 为什么是独立文件而不是内联 <script>：
//   trayMenu.html 的 CSP 是 `script-src 'self'`，内联脚本会被直接拦掉。
//   拦掉的后果不是报错，而是「静默失效」——菜单照样渲染出��，
//   但状态永远停在 HTML 里的硬编码默认值（永远显示"显示 Lumina"、
//   开关永远是关的），而且点任何一项都没有任何反应。
//   独立成 js 文件后由 `script-src 'self'` 正常放行，CSP 也不用放开。
//
// 由 electron.vite.config.ts 的 copyPetAssets 拷进 out/main。
// ============================================================

// 由 trayMenuPreload 注入
var api = window.trayMenuAPI;

function setText(id, text) {
  var el = document.getElementById(id);
  if (el) { el.textContent = text || ''; }
}

function applyState(s) {
  if (!s) { return; }

  // 顶部状态点 + 文案
  var dot = document.getElementById('statusDot');
  if (dot) {
    dot.style.background = s.moodColor || '#4ade80';
    dot.style.color = s.moodColor || '#4ade80';
  }
  setText('statusText', s.mood || '在线');
  setText('headerBadge', s.statusText || (s.online ? '在线' : '离线'));

  // 显示/隐藏 Lumina
  setText('toggleMainLabel', s.windowVisible ? '隐藏 Lumina' : '显示 Lumina');

  // 游戏陪伴开关
  var toggle = document.getElementById('gameToggle');
  if (toggle) { toggle.classList.toggle('on', !!s.gameEnabled); }
  var itemGame = document.getElementById('itemToggleGame');
  if (itemGame) { itemGame.setAttribute('aria-checked', s.gameEnabled ? 'true' : 'false'); }
  setText('gameStateText', s.gameEnabled ? '已开启' : '已关闭');

  // 任务工作区：显示待办数量
  setText('taskCount', typeof s.pendingTasks === 'number' && s.pendingTasks > 0 ? (s.pendingTasks + ' 待办') : '');
}

function fire(el) {
  var action = el.getAttribute('data-action');
  if (action && api) { api.menuClick(action); }
}

document.querySelectorAll('.item').forEach(function (el) {
  el.addEventListener('click', function () { fire(el); });
  // 键盘可达：Enter / Space 等同点击
  el.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fire(el);
    }
  });
});

if (api) {
  api.onState(applyState);
  api.getState().then(applyState).catch(function () {});
}
