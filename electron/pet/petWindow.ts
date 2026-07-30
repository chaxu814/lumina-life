// ============================================================
// pet/petWindow.ts — 桌宠模式 v2.0 (Plan C Phase 2)
//
// 在桌面创建一个透明、置顶的副窗口，显示 Lumina 桌宠
//
// Plan C 架构:
//   - 独立进程（副 BrowserWindow）与主进程通过 IPC 通信
//   - 崩溃自动恢复（主进程心跳感知后重启）
//   - 鼠标穿透模式切换（交互/观赏模式）
//   - 统一事件通道: pet:event / pet:command
// ============================================================

import { BrowserWindow, app, screen, ipcMain } from 'electron'
import * as path from 'path'
import * as fs from 'fs'

// ═══════════════════════════════════════════════════════════
// 接口 & 类型
// ═══════════════════════════════════════════════════════════

export interface PetConfig {
  clickThrough: boolean   // 鼠标穿透模式（观赏用）
  autoRestart: boolean    // 崩溃后自动恢复
  opacity: number         // 透明度 0~1
  scale: number           // 缩放 0.5~2.0
}

export interface PetEvent {
  type: 'click' | 'double-click' | 'drag-end' | 'idle-long' | 'mouse-enter' | 'mouse-leave'
  timestamp: number
  data?: any
}

// ═══════════════════════════════════════════════════════════
// 状态管理
// ═══════════════════════════════════════════════════════════

let petWindow: BrowserWindow | null = null
let petEnabled = false
let petMainWindow: BrowserWindow | null = null  // 主窗口引用，用于转发事件

const PET_WINDOW_WIDTH = 160
const PET_WINDOW_HEIGHT = 200
const MAX_RESTART_ATTEMPTS = 3
const RESTART_COOLDOWN_MS = 2000
const IDLE_THRESHOLD_MS = 60_000  // 1 分钟无交互视为"久置"

let config: PetConfig = {
  clickThrough: false,
  autoRestart: true,
  opacity: 1.0,
  scale: 1.0,
}
let restartAttempts = 0
let crashRecoveryTimer: ReturnType<typeof setTimeout> | null = null
let lastInteractionTime = Date.now()

// ═══════════════════════════════════════════════════════════
// 生成桌宠 HTML（动态注入配置）
// ═══════════════════════════════════════════════════════════

function generatePetHtml(): string {
  const ctMode = config.clickThrough
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
* { margin: 0; padding: 0; box-sizing: border-box; user-select: none; }
html, body {
  width: 100%; height: 100%;
  overflow: hidden;
  background: transparent;
  -webkit-app-region: no-drag;
}
body {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  font-family: 'Segoe UI', sans-serif;
  cursor: ${ctMode ? 'default' : 'pointer'};
  opacity: ${config.opacity};
}

/* ===== 桌宠容器 ===== */
#pet-container {
  display: flex; flex-direction: column; align-items: center;
  -webkit-app-region: ${ctMode ? 'no-drag' : 'drag'};
  transform: scale(${config.scale});
  transition: transform 0.3s ease;
}

/* ===== 猫咪角色 ===== */
.cat-body {
  position: relative;
  width: 80px; height: 80px;
  border-radius: 50%;
  background: linear-gradient(135deg, #FF6B6B, #FF8E53);
  display: flex; align-items: center; justify-content: center;
  font-size: 40px;
  box-shadow: 0 4px 20px rgba(255, 107, 107, 0.4);
  transition: transform 0.3s, box-shadow 0.3s;
  cursor: pointer;
}
.cat-body:hover {
  transform: scale(1.08);
}
.cat-body:active {
  transform: scale(0.95);
}
.cat-ear {
  position: absolute; font-size: 16px; top: -8px;
}
.cat-ear-l { left: 6px; }
.cat-ear-r { right: 6px; }
.cat-face {
  position: relative;
  transition: transform 0.3s;
}
.cat-eye {
  display: inline-block;
  animation: blink 4s ease-in-out infinite;
}
.cat-mouth {
  position: absolute;
  bottom: 2px; left: 50%;
  transform: translateX(-50%);
  font-size: 8px;
  opacity: 0.6;
}

/* ===== 情绪气泡 ===== */
.emotion-bubble {
  position: absolute;
  top: -30px; left: 50%;
  transform: translateX(-50%);
  padding: 3px 10px;
  border-radius: 12px;
  background: rgba(0,0,0,0.6);
  backdrop-filter: blur(4px);
  color: #fff;
  font-size: 10px;
  font-weight: 600;
  white-space: nowrap;
  opacity: 0;
  transition: opacity 0.4s ease, transform 0.4s ease;
  pointer-events: none;
}
.emotion-bubble.show {
  opacity: 1;
  transform: translateX(-50%) translateY(-4px);
}

/* ===== 对话气泡 ===== */
.speech-bubble {
  position: absolute;
  bottom: 100%; left: 50%;
  transform: translateX(-50%);
  margin-bottom: 8px;
  padding: 6px 12px;
  border-radius: 12px;
  background: rgba(0,0,0,0.75);
  backdrop-filter: blur(6px);
  color: #fff; font-size: 11px;
  max-width: 140px;
  text-align: center;
  white-space: nowrap;
  opacity: 0;
  transition: opacity 0.3s ease, transform 0.3s ease;
  pointer-events: none;
  line-height: 1.4;
}
.speech-bubble::after {
  content: '';
  position: absolute;
  top: 100%; left: 50%;
  transform: translateX(-50%);
  border: 5px solid transparent;
  border-top-color: rgba(0,0,0,0.75);
}
.speech-bubble.show {
  opacity: 1;
  transform: translateX(-50%) translateY(-2px);
}

/* ===== 名称标签 ===== */
.name-tag {
  margin-top: 6px;
  padding: 2px 12px;
  border-radius: 10px;
  background: rgba(0,0,0,0.25);
  backdrop-filter: blur(4px);
  font-size: 11px;
  color: #fff;
  text-shadow: 0 1px 4px rgba(0,0,0,0.3);
  white-space: nowrap;
  transition: opacity 0.5s;
}
.name-tag.idle { opacity: 0.5; }
.name-tag.hidden { opacity: 0; }
.status-dot {
  width: 8px; height: 8px;
  border-radius: 50%;
  background: #10b981;
  display: inline-block;
  margin-right: 4px;
  animation: pulse 2s ease-in-out infinite;
}

/* ===== 行走动画 ===== */
@keyframes walk-cycle {
  0% { transform: scale(1); }
  25% { transform: scale(1.02) translateX(2px); }
  50% { transform: scale(1) translateX(0); }
  75% { transform: scale(0.98) translateX(-2px); }
  100% { transform: scale(1) translateX(0); }
}
@keyframes walk-bounce {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-3px); }
}
.walking {
  animation: walk-cycle 0.6s ease-in-out infinite, walk-bounce 0.3s ease-in-out infinite;
}

/* ===== 情绪表情映射 ===== */
.mood-happy .cat-eye { content: '😊'; }
.mood-sad .cat-eye { content: '😢'; }
.mood-excited .cat-eye { content: '🤩'; }
.mood-tired .cat-eye { content: '😴'; }

/* ===== 待机动画 ===== */
@keyframes float {
  0%, 100% { transform: translateY(0) scale(${config.scale}); }
  50% { transform: translateY(-8px) scale(${config.scale}); }
}
@keyframes blink {
  0%, 90%, 100% { transform: scaleY(1); }
  95% { transform: scaleY(0.1); }
}
@keyframes pulse {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.08); }
}
@keyframes sparkle {
  0%, 100% { opacity: 0; transform: scale(0); }
  50% { opacity: 1; transform: scale(1); }
}
@keyframes tail-wag {
  0%, 100% { transform: rotate(0deg); }
  25% { transform: rotate(5deg); }
  75% { transform: rotate(-5deg); }
}

/* ===== 穿透模式提示 ===== */
.ct-hint {
  position: absolute; top: 4px; right: 4px;
  font-size: 8px; color: rgba(255,255,255,0.35);
  pointer-events: none;
}
</style>
</head>
<body>
${ctMode ? '<div class="ct-hint">👆 穿透模式</div>' : ''}

<div id="pet-container">
  <!-- 情绪气泡 -->
  <div class="emotion-bubble" id="emotion-bubble"></div>

  <!-- 对话气泡 -->
  <div class="speech-bubble" id="speech-bubble"></div>

  <!-- 猫咪角色 -->
  <div class="cat-body" id="cat-body">
    <span class="cat-ear cat-ear-l">🐱</span>
    <span class="cat-ear cat-ear-r">🐱</span>
    <span class="cat-face" id="cat-face">
      <span class="cat-eye" id="cat-eye">😺</span>
      <span class="cat-mouth">ω</span>
    </span>
  </div>

  <!-- 名称标签 -->
  <div class="name-tag" id="name-tag">
    <span class="status-dot"></span>
    Lumina
    <span id="idle-msg" style="margin-left:4px;font-size:10px;opacity:0.7;">| ฅ^•ﻌ•^ฅ</span>
  </div>
</div>

<script>
const { ipcRenderer } = require('electron');

// ═══════════════════════════════════
// 状态
// ═══════════════════════════════════
let currentEmotion = '平静';
let currentMood = 0;
let currentEnergy = 0.5;
let isWalking = false;
let walkInterval = null;
let idleTimer = null;
let speechTimer = null;
let msgIdx = 0;

const IDLE_MS = ${IDLE_THRESHOLD_MS};
const SPEECH_DURATION = 5000;

const EMOTION_CONFIG = {
  '低落 😔':   { emoji: '😿', color: '#6b7280', bg: 'linear-gradient(135deg, #6b7280, #9ca3af)' },
  '难过 😢':   { emoji: '😢', color: '#60a5fa', bg: 'linear-gradient(135deg, #60a5fa, #93c5fd)' },
  '疲惫 😩':   { emoji: '😩', color: '#a78bfa', bg: 'linear-gradient(135deg, #a78bfa, #c4b5fd)' },
  '闷闷不乐 😕': { emoji: '😕', color: '#f59e0b', bg: 'linear-gradient(135deg, #f59e0b, #fbbf24)' },
  '平静 😐':   { emoji: '😺', color: '#10b981', bg: 'linear-gradient(135deg, #10b981, #34d399)' },
  '开心 😊':   { emoji: '😊', color: '#f97316', bg: 'linear-gradient(135deg, #f97316, #fb923c)' },
  '兴奋 🤩':   { emoji: '🤩', color: '#ec4899', bg: 'linear-gradient(135deg, #ec4899, #f472b6)' },
  '超开心 🎉':  { emoji: '🎉', color: '#f59e0b', bg: 'linear-gradient(135deg, #f59e0b, #ef4444)' },
  '幸福 💖':   { emoji: '🥰', color: '#ec4899', bg: 'linear-gradient(135deg, #ec4899, #f9a8d4)' },
};

const IDLE_MESSAGES = [
  'ฅ^•ﻌ•^ฅ', '₍˄·͈༝·͈˄₎ฅ˒˒', '(=^･ω･^=)',
  '发呆中...', '等你回家~', '(ﾉ◕ヮ◕)ﾉ*:･ﾟ✧',
  '呼噜呼噜...', '(∪｡∪)｡｡｡zzz', '盯——👀',
  '尾巴摇啊摇~', '今天想我了吗?', 'ε٩( ºωº )۶з',
  '✨', 'ᓚᘏᗢ', '敲敲...有人吗?'
];

const SPEECH_POOL = [
  '今天过得怎么样？', '喵~想你啦！', '要一起玩吗？',
  '好无聊哦...', '你是我的光！', '要不要喝热茶？',
  '刚才做了个好梦~', '你的心跳我听到了', '悄悄话……',
  '吃饱了就想你~',
];

// ═══════════════════════════════════
// 工具函数
// ═══════════════════════════════════

function sendEvent(type, data) {
  ipcRenderer.send('pet:event', { type, timestamp: Date.now(), data });
}

function getEmotionConfig(label) {
  return EMOTION_CONFIG[label] || EMOTION_CONFIG['平静 😐'];
}

// ═══════════════════════════════════
// 情绪更新 API（由主进程或定时器调用）
// ═══════════════════════════════════

function setEmotion(emotion) {
  if (!emotion) return;
  const label = emotion.label || '平静 😐';
  currentEmotion = label;
  currentMood = emotion.mood || 0;
  currentEnergy = emotion.energy || 0.5;

  const cfg = getEmotionConfig(label);
  const catBody = document.getElementById('cat-body');
  const emotionBubble = document.getElementById('emotion-bubble');
  const catEye = document.getElementById('cat-eye');

  // 更新角色颜色
  if (catBody) {
    catBody.style.background = cfg.bg;
    catBody.style.boxShadow = '0 4px 20px ' + cfg.color + '66';
  }

  // 更新表情
  if (catEye) catEye.textContent = cfg.emoji;

  // 显示情绪气泡
  if (emotionBubble) {
    emotionBubble.textContent = label;
    emotionBubble.classList.add('show');
    clearTimeout(window._emotionBubbleTimer);
    window._emotionBubbleTimer = setTimeout(() => {
      emotionBubble.classList.remove('show');
    }, 3000);
  }
}

// 从后端读取情绪
function fetchEmotion() {
  ipcRenderer.invoke('gamification:getEmotionXp').then(res => {
    if (res && res.success && res.label) {
      setEmotion({ label: res.label, mood: res.emotion.mood, energy: res.emotion.energy });
    }
  }).catch(() => {});
}

// ═══════════════════════════════════
// 行走动画
// ═══════════════════════════════════

function startWalking() {
  if (isWalking) return;
  isWalking = true;
  const container = document.getElementById('pet-container');
  container.classList.add('walking');
  // 随机移动
  let dir = 1;
  let pos = 0;
  if (walkInterval) clearInterval(walkInterval);
  walkInterval = setInterval(() => {
    pos += dir * 1.5;
    if (Math.abs(pos) > 15) dir *= -1;
    container.style.transform = 'scale(' + ${config.scale} + ') translateX(' + pos + 'px)';
  }, 100);
  sendEvent('walk-start');
}

function stopWalking() {
  if (!isWalking) return;
  isWalking = false;
  const container = document.getElementById('pet-container');
  container.classList.remove('walking');
  if (walkInterval) {
    clearInterval(walkInterval);
    walkInterval = null;
  }
  container.style.transform = 'scale(' + ${config.scale} + ') translateX(0)';
  sendEvent('walk-stop');
}

function toggleWalk() {
  if (isWalking) stopWalking();
  else startWalking();
}

// ═══════════════════════════════════
// 说话气泡
// ═══════════════════════════════════

function showSpeech(text) {
  const bubble = document.getElementById('speech-bubble');
  if (!bubble) return;
  bubble.textContent = text;
  bubble.classList.add('show');
  clearTimeout(speechTimer);
  speechTimer = setTimeout(() => {
    bubble.classList.remove('show');
  }, SPEECH_DURATION);
}

function randomSpeech() {
  const idx = Math.floor(Math.random() * SPEECH_POOL.length);
  showSpeech(SPEECH_POOL[idx]);
}

// ═══════════════════════════════════
// 闲时管理
// ═══════════════════════════════════

function resetIdle() {
  if (idleTimer) clearTimeout(idleTimer);
  document.getElementById('name-tag').classList.remove('idle');
  stopWalking();
  idleTimer = setTimeout(() => {
    document.getElementById('name-tag').classList.add('idle');
    sendEvent('idle-long');
    // 久置后自动行走
    if (Math.random() > 0.5) startWalking();
  }, IDLE_MS);
}
resetIdle();

// ═══════════════════════════════════
// 闲时消息轮播
// ═══════════════════════════════════

setInterval(() => {
  msgIdx = (msgIdx + 1) % IDLE_MESSAGES.length;
  const el = document.getElementById('idle-msg');
  if (el) el.textContent = '| ' + IDLE_MESSAGES[msgIdx];
}, 8000);

// ═══════════════════════════════════
// 交互事件
// ═══════════════════════════════════

document.getElementById('pet-container').addEventListener('click', (e) => {
  resetIdle();
  // 冒爱心
  const catBody = document.querySelector('.cat-body');
  if (catBody) {
    catBody.style.transform = 'scale(1.15)';
    setTimeout(() => { catBody.style.transform = 'scale(1)'; }, 300);
  }
  // 随机说话
  randomSpeech();
  sendEvent('click', { x: e.clientX, y: e.clientY });
});

document.getElementById('pet-container').addEventListener('dblclick', (e) => {
  toggleWalk();
  sendEvent('double-click', { x: e.clientX, y: e.clientY });
});

document.getElementById('pet-container').addEventListener('mouseenter', () => {
  resetIdle();
  sendEvent('mouse-enter');
});

document.getElementById('pet-container').addEventListener('mouseleave', () => {
  sendEvent('mouse-leave');
});

// ═══════════════════════════════════
// 定时读取情绪
// ═══════════════════════════════════

setInterval(fetchEmotion, 15000);
fetchEmotion();

// ═══════════════════════════════════
// 主进程命令
// ═══════════════════════════════════

ipcRenderer.on('pet:command', (_event, command) => {
  if (command.type === 'set-emotion') {
    setEmotion(command.emotion);
  }
  if (command.type === 'say') {
    showSpeech(command.text || '喵~');
  }
  if (command.type === 'walk') {
    if (command.enable) startWalking();
    else stopWalking();
  }
  if (command.type === 'set-opacity') {
    document.body.style.opacity = command.value;
  }
  if (command.type === 'set-tooltip') {
    showSpeech(command.text);
  }
});
</script>
</body>
</html>`
}

// ═══════════════════════════════════════════════════════════
// 窗口管理
// ═══════════════════════════════════════════════════════════

function getPetHtmlPath(): string {
  const dir = path.join(app.getPath('userData'), 'pet-assets')
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  const htmlPath = path.join(dir, 'pet.html')
  fs.writeFileSync(htmlPath, generatePetHtml(), 'utf-8')
  return htmlPath
}

function setWindowClickThrough(enable: boolean): void {
  if (!petWindow || petWindow.isDestroyed()) return
  // 开启穿透: 鼠标事件穿透窗口（但窗口仍然可以接收键盘事件）
  // 关闭穿透: 正常交互
  petWindow.setIgnoreMouseEvents(enable, { forward: true })
  // 更新 HTML 中的样式
  petWindow.webContents.executeJavaScript(`
    document.body.style.cursor = '${enable ? "default" : "pointer"}';
    document.getElementById('pet-container').style.webkitAppRegion = '${enable ? "no-drag" : "drag"}';
    document.querySelector('.ct-hint')?.remove();
    if (${enable}) {
      const hint = document.createElement('div');
      hint.className = 'ct-hint';
      hint.textContent = '👆 穿透模式';
      document.body.appendChild(hint);
    }
  `).catch(() => {})
}

/**
 * 创建桌宠窗口
 */
export function createPetWindow(mainWin?: BrowserWindow | null): BrowserWindow | null {
  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.show()
    return petWindow
  }

  if (mainWin) petMainWindow = mainWin

  const display = screen.getPrimaryDisplay()
  const { width: screenWidth, height: screenHeight } = display.workAreaSize

  petWindow = new BrowserWindow({
    width: PET_WINDOW_WIDTH,
    height: PET_WINDOW_HEIGHT,
    x: screenWidth - PET_WINDOW_WIDTH - 20,
    y: screenHeight - PET_WINDOW_HEIGHT - 60,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    focusable: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      sandbox: false,
      contextIsolation: true,
    },
  })

  // 加载生成的 HTML
  petWindow.loadFile(getPetHtmlPath())
  // 应用穿透模式
  setWindowClickThrough(config.clickThrough)

  // ── 窗口事件 ──────────────────────────────────────
  petWindow.on('closed', () => {
    console.log('[PetWindow] 🐱 桌宠窗口已关闭')
    petWindow = null
    // 自动恢复
    if (petEnabled && config.autoRestart && restartAttempts < MAX_RESTART_ATTEMPTS) {
      restartAttempts++
      console.log(`[PetWindow] 🔄 自动恢复 (${restartAttempts}/${MAX_RESTART_ATTEMPTS})`)
      crashRecoveryTimer = setTimeout(() => {
        createPetWindow(petMainWindow)
      }, RESTART_COOLDOWN_MS)
    } else if (petEnabled && restartAttempts >= MAX_RESTART_ATTEMPTS) {
      console.error('[PetWindow] ❌ 已达最大恢复次数，桌宠停止')
      petEnabled = false
    }
  })

  petWindow.on('focus', () => {
    // 桌宠获得焦点时通知（极少发生，因为 focusable: false）
  })

  // 窗口移动时保存位置
  let moveTimer: ReturnType<typeof setTimeout> | null = null
  petWindow.on('move', () => {
    if (moveTimer) clearTimeout(moveTimer)
    moveTimer = setTimeout(() => {
      if (petWindow && !petWindow.isDestroyed()) {
        const [x, y] = petWindow.getPosition()
        // 可以持久化位置
      }
    }, 500)
  })

  restartAttempts = 0
  console.log('[PetWindow] 🐱 桌宠 v2.0 已创建')
  return petWindow
}

/**
 * 关闭桌宠窗口
 */
export function closePetWindow(): void {
  if (crashRecoveryTimer) {
    clearTimeout(crashRecoveryTimer)
    crashRecoveryTimer = null
  }
  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.close()
    petWindow = null
  }
  petEnabled = false
  console.log('[PetWindow] 🐱 桌宠已关闭')
}

/**
 * 切换桌宠开关
 */
export function togglePet(enable: boolean, mainWin?: BrowserWindow | null): boolean {
  if (enable) {
    createPetWindow(mainWin)
    petEnabled = true
  } else {
    closePetWindow()
    petEnabled = false
  }
  return petEnabled
}

/**
 * 桌宠是否开启
 */
export function isPetEnabled(): boolean {
  return petEnabled && petWindow !== null && !petWindow.isDestroyed()
}

/**
 * 获取桌宠配置
 */
export function getPetConfig(): PetConfig {
  return { ...config }
}

/**
 * 更新桌宠配置
 */
export function updatePetConfig(partial: Partial<PetConfig>, mainWin?: BrowserWindow | null): PetConfig {
  config = { ...config, ...partial }
  if (partial.clickThrough !== undefined && petWindow && !petWindow.isDestroyed()) {
    setWindowClickThrough(config.clickThrough)
    // 重载 HTML 更新 UI 提示
    petWindow.loadFile(getPetHtmlPath())
  }
  if (partial.opacity !== undefined && petWindow && !petWindow.isDestroyed()) {
    petWindow.webContents.executeJavaScript(`document.body.style.opacity = ${config.opacity}`)
  }
  return config
}

// ═══════════════════════════════════════════════════════════
// IPC 注册
// ═══════════════════════════════════════════════════════════

/**
 * 注册桌宠 IPC
 * 协议:
 *   pet:toggle      → { ok, enabled }          开关桌宠
 *   pet:status      → boolean                  查询状态
 *   pet:config      → PetConfig                获取配置
 *   pet:update-config → { ok, config }         更新配置
 *   pet:event       ← (channel) PetEvent       桌宠 → 主进程事件
 *   pet:command     → (channel)                主进程 → 桌宠命令
 */
export function registerPetIpc(): void {
  // ── 开关 ────────────────────────────────────────
  ipcMain.handle('pet:toggle', (_e, enable: boolean) => {
    try {
      // 查找主窗口
      const wins = BrowserWindow.getAllWindows()
      const mainWin = wins.find(w => !w.isDestroyed() && w !== petWindow) || null
      const result = togglePet(enable, mainWin)
      return { ok: true, enabled: result }
    } catch (e: any) {
      console.error('[PetWindow] togglePet error:', e)
      return { ok: false, error: String(e) }
    }
  })

  // ── 状态 ────────────────────────────────────────
  ipcMain.handle('pet:status', () => {
    try {
      return isPetEnabled()
    } catch {
      return false
    }
  })

  // ── 配置读写 ────────────────────────────────────
  ipcMain.handle('pet:config', () => {
    return getPetConfig()
  })

  ipcMain.handle('pet:update-config', (_e, partial: Partial<PetConfig>) => {
    try {
      const wins = BrowserWindow.getAllWindows()
      const mainWin = wins.find(w => !w.isDestroyed() && w !== petWindow) || null
      const newConfig = updatePetConfig(partial, mainWin)
      return { ok: true, config: newConfig }
    } catch (e: any) {
      return { ok: false, error: String(e) }
    }
  })

  // ── 桌宠事件（桌宠 → 主进程）───────────────────
  ipcMain.on('pet:event', (_e, event: PetEvent) => {
    // 转发到主窗口渲染进程
    if (petMainWindow && !petMainWindow.isDestroyed()) {
      petMainWindow.webContents.send('pet:event', event)
    }
    // 记录交互时间（用于闲时检测）
    if (event.type === 'click' || event.type === 'double-click') {
      lastInteractionTime = Date.now()
    }
    // 特定事件处理
    if (event.type === 'double-click') {
      // 双击唤醒主窗口
      if (petMainWindow && !petMainWindow.isDestroyed()) {
        petMainWindow.show()
        petMainWindow.focus()
      }
    }
  })

  // ── 向桌宠发送命令（主进程 → 桌宠）─────────────
  // 通过 petMainWindow?.webContents.send('pet:command', cmd) 调用
}
