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

import { BrowserWindow, app, screen, ipcMain, desktopCapturer, globalShortcut } from 'electron'
import { pushThemeToWindow } from '../ipc/themeIpc'
import { registerLifeServicesIpc, decideScreenCapture, rememberScreenEpisode, loadLibrary } from './lifeServices'
import { describeScreenViaVlm } from './vision/screenVision'
import * as path from 'path'
import * as fs from 'fs'
import { getAgentConfig } from '../agentConfig'
import { LLMProvider } from '../core/llmProvider'
import { detectScene } from '../sceneDetector'
import { getProviderManager } from '../core/providerManager'
import { currentPlatformCaps } from './platformCaps'
import { isEnabled as isFlagEnabled, allFlags as allPetFlags } from '../core/featureFlags'
import type { AvatarKind } from './modelLibrary'
import { BUILTIN_MODELS, getActiveModel, setActiveModel } from './modelLibrary'
import { getRendererForKind, fallbackToBuiltin, guessKindFromEntry } from './avatarRenderer'
import { detectEdge, calcPeekPosition, shouldSlideOut, resetPosition, DEFAULT_EDGE_SNAP, type EdgeSnapConfig } from './edgeSnap'
import { getComputerUse } from '../computerUse'  // 已在主 bundle，静态引用消除 vite 重复 import 告警

/**
 * 桌宠"大脑"LLM 配置解析：
 *   1) 优先 Lumina Team 成员 lumina 的独立配置；
 *   2) 没配时兜底到设置页的"全局激活供应商"（很多用户只配了全局，之前这里直接放弃，
 *      导致意图系统/主动秘书全部静默降级成本地写死规则——表现为"LLM 没有驱动身体"）。
 * 返回 null 表示确实一处都没配。
 */
export function resolvePetBrainConfig(): { endpoint: string; model: string; apiKey: string; maxContextTokens?: number; source: 'team' | 'global' } | null {
  try {
    const ac = getAgentConfig()
    if (ac.isConfigured('lumina')) {
      const c = ac.get('lumina')
      if (c.endpoint && c.model) {
        return { endpoint: c.endpoint, model: c.model, apiKey: c.apiKey || '', maxContextTokens: c.maxContextTokens, source: 'team' }
      }
    }
    const active = getProviderManager().getActiveConfig()?.config
    if (active && active.baseUrl && active.model && active.enabled) {
      return { endpoint: active.baseUrl, model: active.model, apiKey: active.apiKey || '', maxContextTokens: active.maxContextTokens, source: 'global' }
    }
  } catch (e: any) {
    console.warn('[PetBrain] 配置解析失败:', e?.message || e)
  }
  return null
}

/** 构造一个桌宠用 LLMProvider（社交模式：短超时、轻量） */
export function createPetLLM(cfg: { endpoint: string; model: string; apiKey: string; maxContextTokens?: number }): LLMProvider {
  return new LLMProvider({
    baseUrl: cfg.endpoint,
    apiKey: cfg.apiKey || '',
    model: cfg.model,
    maxContextTokens: cfg.maxContextTokens || 4096,
    socialMode: true,
    personaId: 'lumina',
  } as any)
}

// ═══════════════════════════════════════════════════════════
// 接口 & 类型
// ═══════════════════════════════════════════════════════════

export interface PetConfig {
  clickThrough: boolean   // 鼠标穿透模式（观赏用）
  autoRestart: boolean    // 崩溃后自动恢复
  opacity: number         // 透明度 0~1
  scale: number           // 缩放 0.5~2.0
  auto: 'off' | 'light' | 'heavy'  // 自主行为级别：off 关闭 / light 轻度 / heavy 重度
  x?: number              // compact 小窗口模式下记住的窗口左上角屏幕坐标（DIP）
  y?: number
  chatX?: number          // 独立聊天窗口记住的左上角屏幕坐标（DIP）
  chatY?: number
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

const MAX_RESTART_ATTEMPTS = 3
const RESTART_COOLDOWN_MS = 2000
const IDLE_THRESHOLD_MS = 60_000  // 1 分钟无交互视为"久置"

let config: PetConfig = {
  clickThrough: true,   // 全屏舞台默认鼠标穿透，仅在模型/菜单区域唤醒，不打扰桌面操作
  autoRestart: true,
  opacity: 1.0,
  scale: 1.0,
  auto: 'light',
}

// ── 桌宠设置持久化（重启不丢配置 / 记住上次模型）──────────────
function petStatePath(): string {
  return path.join(app.getPath('userData'), 'pet-config.json')
}
function readPersistedPetState(): { config?: Partial<PetConfig>; model?: string; prefs?: Partial<PetPrefs> } {
  try {
    const p = petStatePath()
    if (!fs.existsSync(p)) {return {}}
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch (e) {
    console.warn('[PetWindow] 读取 pet-config.json 失败:', e)
    return {}
  }
}
function writePersistedPetState(next: { config?: Partial<PetConfig>; model?: string; prefs?: Partial<PetPrefs> }): void {
  try {
    fs.writeFileSync(petStatePath(), JSON.stringify(next, null, 2))
  } catch (e) {
    console.warn('[PetWindow] 写入 pet-config.json 失败:', e)
  }
}

// ── N.E.K.O 风格偏好（对话/动画/声音/Pet Handling/人格）──────
export interface PetPrefs {
  persona?: string            // 人格 id（'' = 默认猫娘）
  onboardingDone?: boolean    // 新手引导已完成
  bubbles?: boolean           // 表情/对话气泡
  nekoSounds?: boolean        // 猫猫音效（句尾喵）
  proactive?: boolean         // 主动搭话
  allowInterrupt?: boolean    // 允许打断
  maxTokens?: number          // 回复长度上限
  mouseTrack?: boolean        // 眼神/头部跟踪鼠标
  fullscreenTrack?: boolean   // 全屏跟踪（鼠标在屏幕任何位置都跟踪）
  fps?: number                // 帧率（0 = 无限制/VSync）
  quality?: 'high' | 'low'    // 画质
  voiceOn?: boolean           // AI 语音开关
  volume?: number             // 音量 0-100
  spatial?: boolean           // 空间音频（按模型位置声像）
  breathing?: boolean         // 呼吸动画（ParamBreath）
  hoverFade?: boolean         // 锁定悬停淡化（鼠标离开时模型半透明）
  dropEffects?: boolean       // 掉券动画与音效
  naturalExpression?: boolean // 自然表达（随机微表情）
  autoTransform?: boolean     // 自动变猫
  mergeMessages?: boolean     // 合并消息
  focusMode?: boolean         // 凝神模式（专注时不打扰）
  privacyMode?: boolean       // 隐私模式（不截屏/不记录）
  screenShare?: boolean       // 屏幕分享
  voiceRecognition?: boolean  // 语音识别
  micDevice?: string          // 麦克风设备 ID
  playbackDevice?: string     // 播放设备 ID
  ttsEngine?: 'edge-tts' | 'indextts'  // TTS 引擎选择
  life?: {                    // v0.2 生命感增强开关（隐私默认保守）
    screenGate?: boolean      // 屏幕感知节流（dHash 帧差，稳定画面不问 VLM，省 token）
    presence?: boolean        // 摄像头在场感知（默认关，需显式授权、仅本地、指示灯）
    wakeWord?: boolean        // 唤醒词门控（默认关，连续聆听时才生效）
    fullDuplex?: boolean      // 全双工实时对话（默认关，依赖流式 STT/TTS 适配）
  }
  catpaw?: {                  // Lumina Pet Handling（电脑权限）
    master?: boolean; kbm?: boolean; browser?: boolean; perception?: boolean; hud?: boolean
    desktop?: boolean; plugins?: boolean
  }
  secretary?: {               // 主动秘书（N.E.K.O 式主动搭话：观察用户在做什么并主动评价/建议/问话）
    enabled?: boolean         // 主动搭话总开关
    minIntervalSec?: number   // 两次主动搭话的最低间隔（秒）
    sources?: {               // 触发源（对应主动搭话设置面板的勾选项）
      screen?: boolean        // 屏幕观察（截屏 + 多模态理解）
      window?: boolean        // 当前活动窗口 / 应用
      news?: boolean          // 新闻 / 热点
      video?: boolean         // 视频网站
      personal?: boolean      // 个人动态
      music?: boolean         // 音乐推荐
    }
  }
}
const DEFAULT_PREFS: PetPrefs = {
  persona: '', onboardingDone: true,
  bubbles: true, nekoSounds: true, proactive: true, allowInterrupt: true, maxTokens: 300,
  mouseTrack: true, fullscreenTrack: true, fps: 30, quality: 'high',
  voiceOn: false, volume: 100, spatial: true,
  breathing: false, hoverFade: false, dropEffects: true, naturalExpression: true,
  autoTransform: true, mergeMessages: false, focusMode: true, privacyMode: false,
  screenShare: false, voiceRecognition: false, micDevice: '', playbackDevice: '',
  ttsEngine: 'edge-tts',
  life: { screenGate: true, presence: false, wakeWord: false, fullDuplex: false },
  catpaw: { master: false, kbm: false, browser: false, perception: true, hud: true, desktop: false, plugins: false },
  secretary: {
    enabled: true, minIntervalSec: 45,
    sources: { screen: true, window: true, news: false, video: true, personal: false, music: false },
  },
}
export function getPetPrefs(): PetPrefs {
  const saved = readPersistedPetState().prefs || {}
  const merged = {
    ...DEFAULT_PREFS, ...saved,
    catpaw: { ...DEFAULT_PREFS.catpaw, ...(saved.catpaw || {}) },
    life: { ...DEFAULT_PREFS.life, ...(saved.life || {}) },
    secretary: {
      ...DEFAULT_PREFS.secretary, ...(saved.secretary || {}),
      sources: { ...DEFAULT_PREFS.secretary!.sources, ...((saved.secretary || {}).sources || {}) },
    },
  }
  // 用户明确不需要鼠标离开变淡效果，强制关闭（覆盖旧版本保存的 true）
  merged.hoverFade = false
  // 帧率：旧版存 0(不限速)，统一归一为 30（省电默认），封顶 60；让设置页与运行时一致
  merged.fps = (!merged.fps || merged.fps <= 0) ? 30 : Math.min(merged.fps, 60)
  return merged
}
export function updatePetPrefs(patch: Partial<PetPrefs>): PetPrefs {
  const s = readPersistedPetState()
  const cur = getPetPrefs()
  const next: PetPrefs = {
    ...cur, ...patch,
    catpaw: { ...cur.catpaw, ...(patch.catpaw || {}) },
    life: { ...cur.life, ...(patch.life || {}) },
    secretary: {
      ...cur.secretary, ...(patch.secretary || {}),
      sources: { ...(cur.secretary?.sources || {}), ...((patch.secretary || {}).sources || {}) },
    },
  }
  s.prefs = next
  writePersistedPetState(s)
  if (petWindow && !petWindow.isDestroyed()) {petWindow.webContents.send('pet:prefs-changed', next)}
  return next
}
let petConfigLoaded = false
function ensurePetConfigLoaded(): void {
  if (petConfigLoaded) {return}
  petConfigLoaded = true
  const saved = readPersistedPetState().config || {}
  if (typeof saved.clickThrough === 'boolean') {config.clickThrough = saved.clickThrough}
  if (typeof saved.opacity === 'number') {config.opacity = saved.opacity}
  if (typeof saved.scale === 'number') {config.scale = saved.scale}
  if (typeof saved.autoRestart === 'boolean') {config.autoRestart = saved.autoRestart}
  if (saved.auto === 'off' || saved.auto === 'light' || saved.auto === 'heavy') {config.auto = saved.auto}
  if (typeof saved.x === 'number') {config.x = saved.x} // v6.4 compact 记住窗口位置
  if (typeof saved.y === 'number') {config.y = saved.y}
  if (typeof saved.chatX === 'number') {config.chatX = saved.chatX} // 独立聊天窗口记住位置
  if (typeof saved.chatY === 'number') {config.chatY = saved.chatY}
}
function persistPetConfig(): void {
  const s = readPersistedPetState()
  s.config = config
  writePersistedPetState(s)
}
function loadPersistedPetModel(): 'Mao' | null {
  const s = readPersistedPetState()
  if (s.model === 'Hiyori') { s.model = 'Mao'; writePersistedPetState(s) }  // Hiyori（桃濑日和）已移除，历史选择自动迁移到 Mao
  return s.model === 'Mao' ? s.model : null
}
function persistPetModel(model: string): void {
  const s = readPersistedPetState()
  s.model = model
  writePersistedPetState(s)
}
let restartAttempts = 0
let crashRecoveryTimer: ReturnType<typeof setTimeout> | null = null
let lastInteractionTime = Date.now()
// 👀 v6.2 全屏注视（fullscreenTrack）：桌宠窗口透明置顶、鼠标绝大多数时间在别的应用上，
// 仅靠窗口内 document.mousemove 拿不到坐标，她的眼睛只在鼠标划过角色时才动。
// 主进程每 100ms 读一次全局鼠标（screen.getCursorScreenPoint），换算成相对桌宠窗口的
// CSS 像素坐标推给渲染层 driveGaze，让她在 compact 小窗口里也能"一直看着"鼠标。
let cursorFollowTimer: ReturnType<typeof setInterval> | null = null
let lastCursor = { x: 0, y: 0, sent: false }

/** 启动全局鼠标注视推送（幂等；窗口关闭时由 closed 清理） */
function startCursorFollow(): void {
  if (cursorFollowTimer) {return}
  cursorFollowTimer = setInterval(() => {
    try {
      const win = petWindow
      if (!win || win.isDestroyed()) {return}
      const prefs = getPetPrefs()
      const deactivate = () => {
        if (lastCursor.sent) {win.webContents.send('pet:cursor', { x: 0, y: 0, inWindow: false, active: false }); lastCursor.sent = false}
      }
      // 鼠标追踪总开关关闭 → 回正并停推
      if (prefs.mouseTrack === false) {deactivate(); return}
      // 全屏追踪（默认开）；fullscreenTrack===false 时只跟窗口内（由 document.mousemove 负责）
      if (prefs.fullscreenTrack === false) {deactivate(); return}
      const pt = screen.getCursorScreenPoint()
      const b = win.getBounds()
      const cx = pt.x - b.x
      const cy = pt.y - b.y
      const inWindow = pt.x >= b.x && pt.x <= b.x + b.width && pt.y >= b.y && pt.y <= b.y + b.height
      // 鼠标在窗口内时，渲染层 document.mousemove 已负责，避免重复
      if (inWindow) {deactivate(); return}
      win.webContents.send('pet:cursor', { x: cx, y: cy, inWindow: false, active: true })
      lastCursor.sent = true
    } catch { /* 窗口销毁瞬间忽略 */ }
  }, 100)
}

/** 停止全局鼠标注视推送 */
function stopCursorFollow(): void {
  if (cursorFollowTimer) {clearInterval(cursorFollowTimer); cursorFollowTimer = null}
  lastCursor.sent = false
}

// ── 互动历史（LLM 自主思考心跳的上下文）─────────────────────
const recentEvents: Array<{ type: string; ts: number }> = []
export function getPetRecentEvents(): Array<{ type: string; ts: number }> {
  return recentEvents.slice()
}
export function getPetLastInteraction(): number {
  return lastInteractionTime
}

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
  background: var(--bubble-bg, rgba(0,0,0,0.6));
  backdrop-filter: blur(4px);
  color: var(--bubble-text, #fff);
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
  background: var(--bubble-bg, rgba(0,0,0,0.75));
  backdrop-filter: blur(6px);
  color: var(--bubble-text, #fff); font-size: 11px;
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
  border-top-color: var(--bubble-bg, rgba(0,0,0,0.75));
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
  if (!fs.existsSync(dir)) {fs.mkdirSync(dir, { recursive: true })}
  const petHtmlPath = path.join(dir, 'pet.html')
  const src = findPetSourceDir()
  if (src) {
    const srcHtml = path.join(src, 'pet-live2d.html')
    const srcExists = fs.existsSync(srcHtml)
    const dstExists = fs.existsSync(petHtmlPath)
    // dev 模式强制刷新：git checkout/分支切换会重置源码 mtime，导致旧副本永不更新
    const isDev = !app.isPackaged || !!process.env.ELECTRON_RENDERER_URL
    let needCopy = isDev
    if (!needCopy && srcExists && dstExists) {
      const srcStat = fs.statSync(srcHtml)
      const dstStat = fs.statSync(petHtmlPath)
      // 不仅比 mtime：文件大小不同说明内容一定变了（git 回退后 mtime 可能更旧但内容不同）
      needCopy = dstStat.mtimeMs < srcStat.mtimeMs || dstStat.size !== srcStat.size
    } else if (!dstExists) {
      needCopy = true
    }
    if (needCopy) {
      try { copyPetAssets(dir) } catch (e: any) {
        console.warn('[PetWindow] 复制 pet-assets 失败:', e?.message || e)
      }
    }
  }
  return petHtmlPath
}

/** 读取当前选中模型的形态（内置 Mao=live2d / Cat=cat；其余从库记录推断） */
function currentModelKind(): AvatarKind {
  try {
    const id = getActiveModel(app.getPath('userData'))
    // 内置模型优先判断
    const builtin = BUILTIN_MODELS.find(b => b.id === id)
    if (builtin) {return (builtin.kind as AvatarKind) || 'live2d'}
    const libPath = path.join(app.getPath('userData'), 'pet-model-library.json')
    if (!fs.existsSync(libPath)) {return 'live2d'}
    const data = JSON.parse(fs.readFileSync(libPath, 'utf8'))
    const entry = Array.isArray(data?.custom) ? data.custom.find((c: any) => c.id === id) : null
    if (entry?.kind) {return entry.kind as AvatarKind}
    if (entry?.entryRel) {return guessKindFromEntry(entry.entryRel)}
    return 'live2d'
  } catch {
    return 'live2d'
  }
}

/** 获取当前模型的 entryRel（相对 pet-assets 或 pet-models 的入口路径） */
function currentModelEntryRel(): string {
  try {
    const id = getActiveModel(app.getPath('userData'))
    const builtin = BUILTIN_MODELS.find(b => b.id === id)
    if (builtin) {return builtin.entryRel}
    const libPath = path.join(app.getPath('userData'), 'pet-model-library.json')
    if (!fs.existsSync(libPath)) {return 'Mao/mao_pro.model3.json'}
    const data = JSON.parse(fs.readFileSync(libPath, 'utf8'))
    const entry = Array.isArray(data?.custom) ? data.custom.find((c: any) => c.id === id) : null
    return entry?.entryRel || 'Mao/mao_pro.model3.json'
  } catch {
    return 'Mao/mao_pro.model3.json'
  }
}

/**
 * 返回桌宠渲染页的**纯文件路径**（不含 query string）。
 * live2d 页拷贝到 userData 时固定命名为 pet.html；其余渲染页用原名。
 * 注意：不要再往这个路径上拼 `?model=...` —— Electron 的 loadFile() 会把整个
 * 字符串当文件路径，内部转 file URL 时把 `?` 编码成 %3F，导致 ERR_FAILED 白屏。
 * 加载请统一用 loadPetHtml()，它通过 loadFile 的 options.query 正确传 model 参数。
 */
function getRendererHtmlFilePath(): string {
  const live2d = getPetHtmlPath() // 同时确保资源已复制
  const dir = path.dirname(live2d)
  const kind = currentModelKind()
  const info = getRendererForKind(kind)
  const htmlFile = info.htmlFile

  if (kind === 'live2d') {
    return live2d
  }
  const candidate = path.join(dir, htmlFile)
  if (fs.existsSync(candidate)) {return candidate}
  console.warn('[PetWindow] 渲染页 ' + htmlFile + ' 未找到，回退 Live2D 页')
  return live2d
}

/** 当前模型的 entryRel（live2d 渲染页通过 query 读取，如 Mao/mao_pro.model3.json） */
function getRendererModelParam(): string {
  return currentModelEntryRel()
}

/**
 * 正确地把渲染页加载进 petWindow。
 *
 * Electron 的 loadFile(filePath, options) 会自己把 options.query 拼成
 * `file:///.../pet.html?model=Mao%2Fmao_pro.model3.json`（正确编码 `/`），
 * 而不是把整个带 `?` 的字符串当路径再二次编码成 %3F。
 *
 * 只有 live2d 渲染页（文件名 pet.html）需要 model query；
 * 其余形态（vrm/pngtuber/mmd/cat）不读这个参数，直接 loadFile 纯路径。
 */
/**
 * 纯函数：决定 loadFile 的参数（纯文件路径 + 可选 query）。
 * 抽出便于单测——测试无需构造真实 BrowserWindow 即可断言"路径不含 ?、query 正确"。
 * live2d 页（pet.html）带 query.model；其余形态不带 query。
 */
export function resolvePetLoadTarget(): { filePath: string; query?: { model: string; solid?: string } } {
  const filePath = getRendererHtmlFilePath()
  if (path.basename(filePath) === 'pet.html') {
    const query: { model: string; solid?: string } = { model: getRendererModelParam() }
    // 仅当平台能力判定透明被关闭时，才让渲染层施加实色兜底（正常透明路径零底色）
    if (!currentPlatformCaps().transparent) { query.solid = '1' }
    return { filePath, query }
  }
  return { filePath }
}

export async function loadPetHtml(): Promise<void> {
  if (!petWindow || petWindow.isDestroyed()) {
    throw new Error('[PetWindow] petWindow 不存在或已销毁')
  }
  const { filePath, query } = resolvePetLoadTarget()
  if (query) {
    await petWindow.loadFile(filePath, { query })
  } else {
    await petWindow.loadFile(filePath)
  }
  // theme skin: inject current theme vars into pet window (bubbles follow theme)
  try { pushThemeToWindow(petWindow) } catch { /* ignore */ }
}

/** 测试钩子：注入 mock BrowserWindow，验证 loadFile 的实参。 */
export function __setPetWindowForTest(win: BrowserWindow | null): void {
  petWindow = win
}

/**
 * @deprecated 旧实现把 `?model=entryRel` 直接拼进文件路径再传给 loadFile()，
 * 导致 Electron 把 `?` 编码成 %3F、Live2D 页面 ERR_FAILED 白屏。
 * 现已拆分为 getRendererHtmlFilePath()（纯路径）+ getRendererModelParam()（query 值），
 * 加载请统一用 loadPetHtml()。本函数仅保留以防外部残留引用断裂，不要再使用。
 */
function getRendererHtmlPath(): string {
  const filePath = getRendererHtmlFilePath()
  if (path.basename(filePath) === 'pet.html') {
    return filePath + '?model=' + encodeURIComponent(getRendererModelParam())
  }
  return filePath
}

/**
 * 把 Live2D 桌宠渲染器（pet-live2d.html）与 assets/ 拷贝到用户数据目录。
 * 源文件位于 petWindow.js 同级的 pet-live2d.html 与 assets/，
 * 需在构建时一并打包（electron-vite / electron-builder 配置）。
 */
function findPetSourceDir(): string | null {
  // 运行时 __dirname 可能是 out/main 或 out/main/chunks（被 rollup 拆 chunk），
  // 逐个候选查找 pet-live2d.html，保证 dev / build / 打包后都能找到。
  const candidates = [
    __dirname,
    path.join(__dirname, '..'),
    path.join(__dirname, '..', '..'),
    path.join(process.resourcesPath || '', 'pet'),          // 打包后：resources/pet（extraResources）
    path.join(app.getAppPath(), 'electron', 'pet'),
    path.join(process.cwd(), 'electron', 'pet'),
  ]
  for (const c of candidates) {
    if (c && fs.existsSync(path.join(c, 'pet-live2d.html'))) {return c}
  }
  return null
}

function copyPetAssets(dir: string): void {
  const src = findPetSourceDir()
  if (!src) {
    console.warn('[PetWindow] 未找到 pet-live2d.html 源，桌宠将不可用')
    return
  }
  try {
    fs.copyFileSync(path.join(src, 'pet-live2d.html'), path.join(dir, 'pet.html'))
    const assetsSrc = path.join(src, 'assets')
    if (fs.existsSync(assetsSrc)) {
      fs.cpSync(assetsSrc, path.join(dir, 'assets'), { recursive: true })
    }
    // 复制设置面板
    const settingsSrc = path.join(src, 'settings.html')
    if (fs.existsSync(settingsSrc)) {
      fs.copyFileSync(settingsSrc, path.join(dir, 'settings.html'))
    }
    // 复制新手引导页
    const onboardSrc = path.join(src, 'onboarding.html')
    if (fs.existsSync(onboardSrc)) {
      fs.copyFileSync(onboardSrc, path.join(dir, 'onboarding.html'))
    }
    // 复制 VRM 3D 渲染页（assets/pet-vrm.js 随 assets 目录一并复制）
    const vrmSrc = path.join(src, 'pet-vrm.html')
    if (fs.existsSync(vrmSrc)) {
      fs.copyFileSync(vrmSrc, path.join(dir, 'pet-vrm.html'))
    }
    // 复制 PNGTuber 立绘渲染页（自包含 canvas，无需额外 JS 包）
    const pngSrc = path.join(src, 'pet-pngtuber.html')
    if (fs.existsSync(pngSrc)) {
      fs.copyFileSync(pngSrc, path.join(dir, 'pet-pngtuber.html'))
    }
    // 独立聊天窗口页（可拖到屏幕任意位置）
    const chatSrc = path.join(src, 'pet-chat.html')
    if (fs.existsSync(chatSrc)) {
      fs.copyFileSync(chatSrc, path.join(dir, 'pet-chat.html'))
    }
    // MMD 3D 渲染页（beta，three.js MMDLoader）
    const mmdSrc = path.join(src, 'pet-mmd.html')
    if (fs.existsSync(mmdSrc)) {
      fs.copyFileSync(mmdSrc, path.join(dir, 'pet-mmd.html'))
    }
    // 程序化猫宠渲染页（Canvas 2D，无外部素材）
    const catSrc = path.join(src, 'pet-cat.html')
    if (fs.existsSync(catSrc)) {
      fs.copyFileSync(catSrc, path.join(dir, 'pet-cat.html'))
    }
  } catch (e: any) {
    console.error('[PetWindow] copyPetAssets error:', e)
  }
}

function resolvePreloadPath(): string {
  const candidates = [
    path.join(__dirname, '..', 'preload', 'index.js'),
    path.join(__dirname, '..', '..', 'preload', 'index.js'),
    path.join(__dirname, 'preload', 'index.js'),
  ]
  for (const c of candidates) {if (fs.existsSync(c)) {return c}}
  return path.join(__dirname, '..', 'preload', 'index.js')
}

function setWindowClickThrough(enable: boolean): void {
  if (!petWindow || petWindow.isDestroyed()) {return}
  // 全屏舞台始终保持「穿透+转发」：桌面永远可操作；
  // 渲染页通过 pet:set-ignore-mouse 在悬停模型/菜单/聊天时动态接管鼠标。
  // clickThrough 开关只影响唤醒区域宽度（窄=仅模型，宽=模型周围一圈）。
  petWindow.setIgnoreMouseEvents(true, { forward: true })
  // 同步穿透状态到渲染页（页面据此选择唤醒区域宽度）
  petWindow.webContents.send('pet:command', { type: 'set-click-through', value: enable })
  // 更新 HTML 中的样式
  // 注意：全屏舞台绝不能设置 -webkit-app-region: drag，
  // 否则整个屏幕变成原生窗口拖拽手柄，吞掉所有点击/右键事件
  petWindow.webContents.executeJavaScript(`
    document.body.style.cursor = '${enable ? "default" : "pointer"}';
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
// ── v6.4 compact 物理小窗口（AIRI 式）：根治 Windows 全屏透明置顶窗压制 MPO 导致后方视频黑屏 ──
// 旧模式是覆盖整屏的 layered 透明舞台，其全屏合成表面会让 DWM 退出硬件叠加（MPO），
// 浏览器/播放器的硬件加速视频因此黑屏；SetWindowRgn(setShape) 对 Electron 的
// DirectComposition 透明窗不可靠。新模式把窗口物理尺寸收缩到只包住角色，移动由主进程
// setBounds 完成，小窗口不触发 MPO 退出。
//   LUMINA_PET_WINDOW=fullscreen  回退旧全屏舞台；LUMINA_PET_WINDOW=compact 强制小窗口
// 默认 Windows 用 compact；macOS/Linux 保持全屏（无该黑屏问题）。
export const PET_WINDOW_W = 460
export const PET_WINDOW_H = 720

export function compactPetWindowEnabled(): boolean {
  const mode = (process.env.LUMINA_PET_WINDOW || '').toLowerCase()
  if (mode === 'fullscreen' || mode === 'legacy' || mode === '0') return false
  if (mode === 'compact' || mode === '1') return true
  return process.platform === 'win32'
}

/** 小窗口模式下把目标左上角钳制到显示器工作区内（避免拖出屏幕找不回），坐标为 DIP */
function clampWindowPos(x: number, y: number, w: number, h: number): { x: number; y: number } {
  const d = screen.getDisplayMatching({ x, y, width: w, height: h })
  const a = d.workArea || d.bounds
  return {
    x: Math.round(Math.min(a.x + a.width - 60, Math.max(a.x - w + 60, x))),
    y: Math.round(Math.min(a.y + a.height - 60, Math.max(a.y, y))),
  }
}

/** 透明窗在高频移动后可能停止呈现：用 1px 的 setBounds 轻推 DComp 重新合成（30ms 后归位，肉眼几乎无感） */
function nudgeRepaint(win: BrowserWindow): void {
  try {
    if (!win || win.isDestroyed()) return
    const b = win.getBounds()
    win.setBounds({ x: b.x, y: b.y + 1, width: b.width, height: b.height })
    setTimeout(() => { if (!win.isDestroyed()) win.setBounds(b) }, 30)
  } catch { /* noop */ }
}

/** 把模型 entryRel 转成渲染页可直接加载的 URL（builtin=相对路径，custom=file:// URL） */
function resolveModelUrlForRenderer(modelId: string, entryRel: string): string {
  const builtin = BUILTIN_MODELS.find(b => b.id === modelId)
  if (builtin) {return 'assets/' + builtin.entryRel.replace(/^\/+/, '')}
  const { pathToFileURL } = require('url')
  const modelsRoot = path.join(app.getPath('userData'), 'pet-models')
  return pathToFileURL(path.join(modelsRoot, entryRel)).href
}

// ── 屏幕边缘吸附 + 窥视状态 ──────────────────────────────────
let edgeSnapConfig: EdgeSnapConfig = { ...DEFAULT_EDGE_SNAP }
let peekState: { active: boolean; edge: string | null } = { active: false, edge: null }
let edgeSnapTimer: ReturnType<typeof setInterval> | null = null

/** 拖拽结束后检测边缘并吸附 */
function handleEdgeSnapOnMoveEnd(): void {
  if (!petWindow || petWindow.isDestroyed()) {return}
  if (!edgeSnapConfig.enabled) {return}
  // Wayland/Linux 受限环境检测（X11 下 screen API 可用）
  const display = screen.getDisplayMatching(petWindow.getBounds())
  const wa = display.workArea || display.bounds
  const [w, h] = petWindow.getSize()
  const [x, y] = petWindow.getPosition()
  const edge = detectEdge(x, y, w, h, wa.width, wa.height, wa.x, wa.y)
  if (edge) {
    const pos = calcPeekPosition(edge, w, h, wa.width, wa.height, wa.x, wa.y, edgeSnapConfig.peekWidth)
    petWindow.setBounds({ x: pos.x, y: pos.y, width: w, height: h })
    peekState = { active: true, edge }
    startEdgeSnapWatch()
    nudgeRepaint(petWindow)
  } else {
    peekState = { active: false, edge: null }
    stopEdgeSnapWatch()
  }
}

/** 鼠标靠近时滑出，离开时缩回窥视态 */
function startEdgeSnapWatch(): void {
  if (edgeSnapTimer) {return}
  edgeSnapTimer = setInterval(() => {
    if (!petWindow || petWindow.isDestroyed() || !peekState.active) {return}
    try {
      const pt = screen.getCursorScreenPoint()
      const b = petWindow.getBounds()
      const display = screen.getDisplayMatching(b)
      const wa = display.workArea || display.bounds
      const hovering = shouldSlideOut(pt.x, pt.y, b.x, b.y, b.width, b.height, edgeSnapConfig.mouseThreshold)
      if (hovering && peekState.active) {
        // 滑出到完整位置（屏幕中央偏侧边）
        const fullX = peekState.edge === 'left' ? wa.x + 12
          : peekState.edge === 'right' ? wa.x + wa.width - b.width - 12
          : b.x
        const fullY = peekState.edge === 'top' ? wa.y + 12
          : peekState.edge === 'bottom' ? wa.y + wa.height - b.height - 12
          : b.y
        petWindow.setPosition(fullX, fullY)
        peekState.active = false
      } else if (!hovering && !peekState.active) {
        // 鼠标远离，缩回窥视态
        const [w, h] = petWindow.getSize()
        const pos = calcPeekPosition(peekState.edge as any, w, h, wa.width, wa.height, wa.x, wa.y, edgeSnapConfig.peekWidth)
        petWindow.setPosition(pos.x, pos.y)
        peekState.active = true
      }
    } catch { /* ignore */ }
  }, 200)
}
function stopEdgeSnapWatch(): void {
  if (edgeSnapTimer) {clearInterval(edgeSnapTimer); edgeSnapTimer = null}
}

/** 双击/快捷键复位到屏幕中央 */
function resetPetToCenter(): void {
  if (!petWindow || petWindow.isDestroyed()) {return}
  const [w, h] = petWindow.getSize()
  const display = screen.getDisplayMatching(petWindow.getBounds())
  const wa = display.workArea || display.bounds
  const pos = resetPosition(w, h, wa.width, wa.height, wa.x, wa.y)
  petWindow.setPosition(pos.x, pos.y)
  peekState = { active: false, edge: null }
  stopEdgeSnapWatch()
}

export function createPetWindow(mainWin?: BrowserWindow | null): BrowserWindow | null {
  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.show()
    return petWindow
  }

  if (mainWin) {petMainWindow = mainWin}
  ensurePetConfigLoaded()

  const display = screen.getPrimaryDisplay()
  // v6.4：Windows 默认 compact 物理小窗口（只包住角色，不压制 MPO，后方视频不黑屏）；其余平台仍是全屏舞台
  // compact 目前只适配 Live2D（pet-live2d.html）；自定义 VRM 形态暂回退全屏，避免小窗口布局错乱
  const isCompact = compactPetWindowEnabled() && currentModelKind() !== 'vrm' && currentModelKind() !== 'mmd'
  // 小屏（如 1366x768）保护：紧凑尺寸不超过工作区
  const _wa = display.workArea
  const winW = isCompact ? Math.min(PET_WINDOW_W, _wa.width - 20) : display.bounds.width
  const winH = isCompact ? Math.min(PET_WINDOW_H, _wa.height - 20) : display.bounds.height
  let winX = display.bounds.x
  let winY = display.bounds.y
  if (isCompact) {
    const wa = display.workArea
    const defX = wa.x + wa.width - PET_WINDOW_W - 36
    const defY = wa.y + wa.height - PET_WINDOW_H - 36
    winX = Number.isFinite(config.x) ? (config.x as number) : defX
    winY = Number.isFinite(config.y) ? (config.y as number) : defY
    const cPos = clampWindowPos(winX, winY, winW, winH)
    winX = cPos.x; winY = cPos.y
    console.log('[' + 'PetWindow' + '] compact 小窗口模式 ' + winW + 'x' + winH + '（不压制后方视频）；回退设 LUMINA_PET_WINDOW=fullscreen')
  }
  // 全屏舞台（非 compact）：覆盖整个屏幕（含任务栏区域），桌宠可在整块屏幕上活动
  const { x: workX, y: workY, width: screenWidth, height: screenHeight } = display.bounds

  const petCaps = currentPlatformCaps()
  if (petCaps.note) {console.log('[PetWindow] 平台能力：', petCaps.label, '-', petCaps.note)}
  petWindow = new BrowserWindow({
    width: winW,
    height: winH,
    x: winX,
    y: winY,
    transparent: petCaps.transparent,
    frame: false,
    alwaysOnTop: petCaps.alwaysOnTop,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    focusable: true,
    backgroundColor: petCaps.backgroundColor,
    webPreferences: {
      preload: resolvePreloadPath(),
      sandbox: false,
      contextIsolation: false,
      nodeIntegration: true,
      backgroundThrottling: true, // 窗口隐藏/被遮挡时暂停 RAF 与定时器，省 CPU/内存
      spellcheck: false,
    },
  })
  // 调试用：自动打开开发者工具（正式发布前注释掉）
  // petWindow.webContents.openDevTools({ mode: 'detach' })

  // 🎙 全双工语音需要麦克风权限：桌宠页是本地可信内容，自动授予媒体采集。
  try {
    const petSession = petWindow.webContents.session
    petSession.setPermissionRequestHandler((wc, permission, callback) => {
      if (permission === 'media') {
        let url = ''
        try { url = wc?.getURL() || '' } catch { /* noop */ }
        return callback(url.includes('pet') || url.startsWith('file://'))
      }
      return callback(true)
    })
    petSession.setPermissionCheckHandler((wc, permission) => {
      if (permission === 'media') {
        let url = ''
        try { url = wc?.getURL() || '' } catch { /* noop */ }
        return url.includes('pet') || url.startsWith('file://')
      }
      return true
    })
  } catch (e) { console.warn('[PetWindow] 媒体权限处理器设置失败:', e) }

  // 加载生成的 HTML（按当前模型形态选择 Live2D / VRM 渲染页）
  loadPetHtml().then(() => {
    setWindowClickThrough(config.clickThrough)
    startCursorFollow() // 👀 v6.2 全屏注视推送
  }).catch(err => {
    console.error('[PetWindow] loadFile failed:', err)
  })

  // ── 窗口事件 ──────────────────────────────────────
  petWindow.on('closed', () => {
    console.log('[PetWindow] 🐱 桌宠窗口已关闭')
    stopCursorFollow()
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
    if (moveTimer) {clearTimeout(moveTimer)}
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
  // 桌宠整体退出时，一并关闭独立聊天窗
  closePetChatWindow()
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
    broadcastPetProgress(5, '正在创建窗口…')
    createPetWindow(mainWin)
    petEnabled = true
    broadcastPetProgress(15, '正在加载渲染器…')
  } else {
    closePetWindow()
    petEnabled = false
  }
  // 广播状态，侧栏开关即时同步
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) {w.webContents.send('pet:state', petEnabled)}
  }
  return petEnabled
}

/**
 * 桌宠是否开启
 */
export function isPetEnabled(): boolean {
  return petEnabled && petWindow !== null && !petWindow.isDestroyed()
}

/** 广播启动进度到所有窗口（用于 UI 进度条） */
function broadcastPetProgress(progress: number, stage: string): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) {w.webContents.send('pet:startup-progress', { progress, stage })}
  }
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
  persistPetConfig()
  if (partial.clickThrough !== undefined && petWindow && !petWindow.isDestroyed()) {
    setWindowClickThrough(config.clickThrough)
  }
  if (partial.opacity !== undefined && petWindow && !petWindow.isDestroyed()) {
    petWindow.webContents.executeJavaScript(`document.body.style.opacity = ${config.opacity}`)
  }
  if (partial.scale !== undefined && petWindow && !petWindow.isDestroyed()) {
    sendPetCommand({ type: 'set-scale', value: config.scale })
  }
  if (partial.auto !== undefined && petWindow && !petWindow.isDestroyed()) {
    sendPetCommand({ type: 'set-auto', value: config.auto })
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
  registerLifeServicesIpc() // 🫀 v0.2：模型库 / 屏幕节流 / 在场 / 唤醒 / 全双工 IPC
  // ── 开关 ────────────────────────────────────────
  // F3：渲染页查询功能开关（VRM 连续情绪等 beta 能力由 flag 门控）
  ipcMain.handle('pet:get-feature-flags', () => ({ vrmExpressive: isFlagEnabled('pet.vrmExpressive'), all: allPetFlags() }))
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

  // ── 穿透唤醒（渲染页悬停模型时接管/释放鼠标）────────────
  ipcMain.on('pet:set-ignore-mouse', (e, ignore: boolean) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (win && !win.isDestroyed()) {
      win.setIgnoreMouseEvents(!!ignore, { forward: true })
    }
  })
  // ── v6.4 compact 小窗口：渲染层查询窗口模式（compact 时拖拽/移动走 setBounds）──
  ipcMain.handle('pet:window-mode', () => {
    // 与 createPetWindow 保持一致：VRM 形态暂回退全屏（compact 仅适配 Live2D）
    return (compactPetWindowEnabled() && currentModelKind() !== 'vrm') ? 'compact' : 'fullscreen'
  })
  // compact 拖拽：渲染层给光标屏幕坐标 + 抓取点在窗口内偏移，主进程 setBounds（节流到约 1 帧；钳制工作区）
  let dragPending: { x: number; y: number } | null = null
  let dragTrailing: ReturnType<typeof setTimeout> | null = null
  let dragLastAt = 0
  const applyDragBounds = (win: BrowserWindow, x: number, y: number): void => {
    const [w, h] = win.getSize()
    const c = clampWindowPos(Math.round(x), Math.round(y), w, h)
    // 设计要求移动走 setBounds（原子更新，透明 DComp 窗不丢呈现面，且不触发 MPO 退出）
    win.setBounds({ x: c.x, y: c.y, width: w, height: h })
  }
  ipcMain.on('pet:window-move', (e, payload: { screenX?: number; screenY?: number; grabX?: number; grabY?: number }) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win || win.isDestroyed() || !compactPetWindowEnabled()) return
    const sx = Number(payload?.screenX), sy = Number(payload?.screenY)
    const gx = Number(payload?.grabX) || 0, gy = Number(payload?.grabY) || 0
    if (!Number.isFinite(sx) || !Number.isFinite(sy)) return
    const [w, h] = win.getSize()
    const c = clampWindowPos(Math.round(sx - gx), Math.round(sy - gy), w, h)
    dragPending = c
    const now = Date.now()
    if (now - dragLastAt >= 16) {
      win.setBounds({ x: c.x, y: c.y, width: w, height: h })
      dragLastAt = now
      dragPending = null
    } else if (!dragTrailing) {
      // 合并一帧内的多次 mousemove，尾帧必落地
      dragTrailing = setTimeout(() => {
        dragTrailing = null
        if (petWindow && !petWindow.isDestroyed() && dragPending) {
          applyDragBounds(petWindow, dragPending.x, dragPending.y)
          dragLastAt = Date.now()
          dragPending = null
        }
      }, 17)
    }
  })
  /** 透明窗在高频移动后可能停止呈现：模块级 nudgeRepaint 已在 clampWindowPos 后定义 */
  // compact 拖拽结束：落最终位置 + 持久化 + 边缘吸附 + 强制重绘
  ipcMain.on('pet:window-move-end', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win || win.isDestroyed() || !compactPetWindowEnabled()) return
    if (dragTrailing) { clearTimeout(dragTrailing); dragTrailing = null }
    if (dragPending) { applyDragBounds(win, dragPending.x, dragPending.y); dragPending = null }
    const [x, y] = win.getPosition()
    updatePetConfig({ x, y })
    // 边缘吸附（拖拽结束时检测）
    handleEdgeSnapOnMoveEnd()
    nudgeRepaint(win)
  })

  // 边缘吸附配置开关
  ipcMain.handle('pet:edge-snap', (_e, cfg?: Partial<EdgeSnapConfig>) => {
    if (cfg) {
      edgeSnapConfig = { ...edgeSnapConfig, ...cfg }
    }
    return { ok: true, config: { ...edgeSnapConfig } }
  })

  // 复位桌宠位置到屏幕中央
  ipcMain.handle('pet:reset-position', () => {
    resetPetToCenter()
    return { ok: true }
  })
  // compact 小窗口：定期把窗口位置写回配置（走路/边缘钳制等非拖拽场景也能记住位置）
  ipcMain.on('pet:window-sync-pos', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win || win.isDestroyed() || !compactPetWindowEnabled()) return
    const [x, y] = win.getPosition()
    if (config.x !== x || config.y !== y) { config.x = x; config.y = y; persistPetConfig() }
  })
  // ── v6.2 窗口物理裁剪(setShape)：渲染页上报模型/UI 包围盒(物理像素)，把全屏透明舞台收缩到实际内容，
  //    避免全屏透明 WebGL 置顶窗占用 Windows 硬件叠加(MPO/DComp)，导致其后方视频/图片画面黑屏、花屏或不刷新。
  //    区域外窗口不渲染、不参与合成、不接收鼠标。macOS 不支持 setShape，直接忽略。
  ipcMain.on('pet:set-shape', (e, rects: Array<{ x: number; y: number; width: number; height: number }>) => {
    try {
      if (compactPetWindowEnabled()) {return} // v6.4 compact 物理小窗口本就只包住角色，无需 SetWindowRgn（且对 DComp 透明窗不可靠）
      if (!currentPlatformCaps().setShape) {return} // 仅 Windows 支持 setShape；macOS/Linux 不裁剪
      const win = BrowserWindow.fromWebContents(e.sender)
      if (!win || win.isDestroyed()) {return}
      const valid = Array.isArray(rects)
        ? rects.filter(r => r && Number.isFinite(r.x) && Number.isFinite(r.y) && r.width > 0 && r.height > 0)
        : []
      if (!valid.length) {
        // 安全兜底：恢复整窗(物理像素)，绝不允许窗口被裁空
        const b = win.getBounds()
        const sf = screen.getDisplayMatching(b).scaleFactor || 1
        win.setShape([{ x: 0, y: 0, width: Math.round(b.width * sf), height: Math.round(b.height * sf) }])
        return
      }
      win.setShape(valid)
      try {
        const b0 = win.getBounds()
        const sf0 = screen.getDisplayMatching(b0).scaleFactor || 1
        const r0 = valid[0]
        const isFull = valid.length === 1 && r0.x === 0 && r0.y === 0 && r0.width >= b0.width * sf0 * 0.98 && r0.height >= b0.height * sf0 * 0.98
        const wasCompact = (win as any).__shapeCompact === true
        ;(win as any).__shapeCompact = !isFull
        if (!isFull && !wasCompact) {console.log('[PetWindow] setShape 已生效：窗口物理裁剪到角色区域，后方视频/图片不再被全屏透明层覆盖')}
      } catch { /* 日志失败不影响裁剪 */ }
    } catch (err) {
      console.warn('[PetWindow] set-shape failed:', err)
    }
  })


  // ── 启动进度（渲染页加载 PIXI/模型时上报，转发给主窗口显示进度条）──
  ipcMain.on('pet:startup-progress', (_e, data: { progress: number; stage: string }) => {
    broadcastPetProgress(data.progress, data.stage)
    if (data.progress >= 100) {
      // 模型加载完成，广播运行状态
      setTimeout(() => {
        for (const w of BrowserWindow.getAllWindows()) {
          if (!w.isDestroyed()) {w.webContents.send('pet:state', true)}
        }
      }, 300)
    }
  })

  // ── 聊天同步：pet / 独立聊天窗 ↔ 主窗口 Lumina Agent ──────────────
  ipcMain.on('pet:sync-send', (_e, data: { text: string }) => {
    // 桌宠或独立聊天窗发消息 → 转发给主窗口注入聊天
    let target = petMainWindow
    if (!target || target.isDestroyed()) {
      // 排除桌宠窗与独立聊天窗，避免把聊天窗误判为主窗口
      target = BrowserWindow.getAllWindows()
        .find(w => !w.isDestroyed() && w !== petWindow && w !== petChatWindow) || null
    }
    if (target && !target.isDestroyed()) {
      target.webContents.send('pet:sync-message', { text: data.text, from: 'pet' })
    }
  })
  ipcMain.on('pet:sync-reply', (_e, data: { text: string; role: string }) => {
    // 主窗口 Agent 回复 → 独立聊天窗打开时只送独立窗；否则送桌宠窗（面板或气泡）
    if (petChatWindow && !petChatWindow.isDestroyed()) {
      petChatWindow.webContents.send('pet:sync-reply', data)
    } else if (petWindow && !petWindow.isDestroyed()) {
      petWindow.webContents.send('pet:sync-reply', data)
    }
  })
  // 历史记录请求方（桌宠窗或独立聊天窗），回复时定向送回
  let historyRequester: BrowserWindow | null = null
  // 桌宠/聊天窗请求历史记录 → 转发给主窗口
  ipcMain.on('pet:sync-history-request', (e) => {
    const sender = BrowserWindow.fromWebContents(e.sender) || null
    historyRequester = sender
    let target = petMainWindow
    if (!target || target.isDestroyed()) {
      target = BrowserWindow.getAllWindows()
        .find(w => !w.isDestroyed() && w !== petWindow && w !== petChatWindow) || null
    }
    if (target && !target.isDestroyed()) {
      target.webContents.send('pet:sync-history-request')
    }
  })
  // 主窗口返回历史记录 → 优先送回请求方；请求方已关闭则按 聊天窗 > 桌宠窗 兜底
  ipcMain.on('pet:sync-history-reply', (_e, messages: Array<{ role: string; content: string }>) => {
    if (historyRequester && !historyRequester.isDestroyed()) {
      historyRequester.webContents.send('pet:sync-history-reply', messages)
      return
    }
    if (petChatWindow && !petChatWindow.isDestroyed()) {
      petChatWindow.webContents.send('pet:sync-history-reply', messages)
    } else if (petWindow && !petWindow.isDestroyed()) {
      petWindow.webContents.send('pet:sync-history-reply', messages)
    }
  })

  // ── 独立聊天窗口：打开 / 关闭（桌宠工具栏按钮触发）──────────────
  ipcMain.handle('pet:open-chat-window', () => openPetChatWindow())
  ipcMain.on('pet:chat-window-close', () => closePetChatWindow())

  // ── 读取持久化模型（渲染页启动时调用）────────────
  ipcMain.handle('pet:get-model', () => {
    return loadPersistedPetModel()
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
    // 记录互动历史（LLM 自主思考上下文）
    recentEvents.push({ type: event.type, ts: Date.now() })
    if (recentEvents.length > 12) {recentEvents.shift()}
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
  ipcMain.handle('pet:send-command', (_e, cmd: any) => {
    const ok = sendPetCommand(cmd)
    return { ok }
  })

  // ── 设置面板（主进程 → 独立窗口）─────────────
  ipcMain.handle('pet:open-settings', () => {
    try {
      const settingsPath = path.join(path.dirname(getPetHtmlPath()), 'settings.html')
      if (!fs.existsSync(settingsPath)) {
        return { ok: false, error: 'settings.html not found' }
      }
      const settingsWin = new BrowserWindow({
        width: 560,
        height: 780,
        title: 'Lumina 桌宠设置',
        alwaysOnTop: true,
        resizable: true,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        webPreferences: {
          preload: resolvePreloadPath(),
          sandbox: false,
          contextIsolation: false,
          nodeIntegration: true,
        },
      })
      settingsWin.loadFile(settingsPath)
      settingsWin.on('closed', () => {})
      return { ok: true }
    } catch (e: any) {
      return { ok: false, error: String(e) }
    }
  })

  // ── 模型切换（任意 modelId，持久化 + 同 kind 热切换 / 跨 kind 重载窗口）──
  ipcMain.handle('pet:set-model', async (_e, modelId: string) => {
    try {
      if (typeof modelId !== 'string' || !modelId.trim()) {
        return { ok: false, error: 'modelId 不能为空' }
      }
      modelId = modelId.trim()
      const userDataDir = app.getPath('userData')
      const prevKind = currentModelKind()
      // 持久化当前模型选择
      const ok = setActiveModel(userDataDir, modelId)
      if (!ok) {
        return { ok: false, error: '模型不存在于库中: ' + modelId }
      }
      persistPetModel(modelId) // 旧版配置同步
      const newKind = currentModelKind()
      const entryRel = currentModelEntryRel()
      if (petWindow && !petWindow.isDestroyed()) {
        if (newKind !== prevKind) {
          // 跨形态：重载整个渲染页
          await loadPetHtml()
          setWindowClickThrough(config.clickThrough)
        } else {
          // 同形态（如 live2d→live2d）：向渲染页发热切换命令
          const modelUrl = resolveModelUrlForRenderer(modelId, entryRel)
          petWindow.webContents.send('pet:load-model', { modelId, entryRel, url: modelUrl, kind: newKind })
        }
      }
      return { ok: true, kind: newKind, modelId }
    } catch (e: any) {
      return { ok: false, error: String(e) }
    }
  })

  // 渲染页上报模型加载失败：主进程安全回退到内置 Mao
  ipcMain.on('pet:model-load-failed', (_e, info: { modelId?: string; error?: string }) => {
    try {
      console.warn('[PetWindow] 模型加载失败，回退 Mao:', info?.modelId, info?.error)
      setActiveModel(app.getPath('userData'), 'Mao')
      persistPetModel('Mao')
      if (petWindow && !petWindow.isDestroyed()) {
        loadPetHtml().then(() => setWindowClickThrough(config.clickThrough)).catch(() => {})
      }
    } catch (e) { console.warn('[PetWindow] 模型加载失败回退异常:', e) }
  })

  // 查询所有已安装模型（供设置面板模型管理 UI）
  ipcMain.handle('pet:get-models', () => {
    try {
      const lib = loadLibrary()
      const current = lib.current()
      const models = lib.list().map(e => ({
        id: e.id, name: e.name, kind: e.kind || 'live2d',
        entryRel: e.entryRel, builtin: e.builtin, current: e.id === current.id,
      }))
      return { ok: true, models, current: current.id }
    } catch (e: any) {
      return { ok: false, error: String(e), models: [] }
    }
  })

  // 切换到不同形态模型后，在同一桌宠窗口重载对应渲染页
  ipcMain.handle('pet:reopen', async () => {
    try {
      if (petWindow && !petWindow.isDestroyed()) {
        await loadPetHtml()
        setWindowClickThrough(config.clickThrough)
      } else {
        createPetWindow(petMainWindow)
      }
      return { ok: true, kind: currentModelKind() }
    } catch (e: any) {
      return { ok: false, error: String(e) }
    }
  })

  // ── 屏幕感知 tick（精彩瞬间快速通道，v6.2）─────────────
  // 与主动秘书 secretary（45s 工作卡片）/ runScreenWatch（120s 编排表演）分工：
  //   本条路径复用统一视觉模块 describeScreenViaVlm（截图→dHash 节流→VLM 看懂→安全降级），
  //   只在她真看清画面、且 VLM 判定"很精彩"（worthComment≥0.7：游戏翻车/搞笑视频/报错卡住）
  //   时立刻插一句带动作的即时反应，形成 N.E.K.O 式"哎？！这个！"的实时感；
  //   普通画面交给另两条路径，不重复花 token、不抢话。
  ipcMain.handle('pet:perception:tick', async () => {
    try {
      const prefs = getPetPrefs()
      const cp = prefs.catpaw || {}
      if (prefs.privacyMode) {return { ok: true, skipped: true }}  // 隐私模式：不截屏
      if (cp.perception === false) {return { ok: true, skipped: true }}  // Pet Handling - 屏幕感知关闭

      // 统一视觉：内含 dHash 节流，画面稳定时 captured=false，直接返回不花钱
      const vision = await describeScreenViaVlm(false, Date.now())
      if (!vision.captured) {
        return { ok: true, skipped: true, reason: 'stable', scene: vision.scene, change: vision.change }
      }

      // 高 worth 门槛：只对精彩瞬间立即插话（saw=false 表示没看清，交给秘书/编排器）
      const WORTH_FAST_REACT = 0.7
      if (!vision.saw || vision.worthComment < WORTH_FAST_REACT) {
        return { ok: true, skipped: true, reason: 'low_worth', scene: vision.scene, worth: vision.worthComment }
      }

      const cfg = resolvePetBrainConfig()
      if (!cfg) {return { ok: true, skipped: true, reason: 'no-llm' }}
      const provider = createPetLLM(cfg)
      let speech = ''
      try {
        const res = await provider.call({
          messages: [
            { role: 'system', content: '你是桌宠 Lumina，刚偷瞄到主人屏幕上一个很精彩/有趣/翻车/卡住的瞬间。用一句 20 字以内、带情绪的可爱短句立刻反应（像"哎？！""这操作！""哈哈哈哈""等等！"这种即时感），不要复述画面，只输出 JSON：{"speech":"..."}' },
            { role: 'user', content: `你看到的画面：${vision.detail}（场景：${vision.scene}）。请用 JSON 回一句即时反应。` },
          ],
          temperature: 0.95, maxTokens: 100,
        } as any)
        try { const obj = JSON.parse(res?.text || '{}'); if (obj && typeof obj.speech === 'string') {speech = obj.speech.trim()} } catch {}
      } catch (e) {
        console.warn('[Pet] 精彩瞬间反应生成失败:', (e as Error)?.message || e)
      }
      if (!speech) {return { ok: true, skipped: true, reason: 'no-speech' }}

      // 带动作：游戏精彩→开心，其他→惊讶；走 intent 让 Live2D 同时有表情/动作/口型
      const action = vision.scene === 'game' ? 'happy' : 'surprised'
      const mood = vision.scene === 'game' ? '兴奋 🤩' : '超开心 🎉'
      sendPetCommand({ type: 'intent', intent: { action, speech, mood } })
      rememberScreenEpisode(vision.scene, vision.windowTitle || null, speech)
      return { ok: true, speech, worth: vision.worthComment, detail: vision.detail }
    } catch (e: any) {
      return { ok: false, error: String(e) }
    }
  })

  // 🤵 主动秘书：定时心跳（最低间隔由主进程节流）
  ipcMain.handle('pet:secretary:tick', async () => runSecretaryTick({ force: false }))
  // 🤵 主动秘书：立即搭话一次（跳过间隔，设置面板按钮用）
  ipcMain.handle('pet:secretary:now', async () => runSecretaryTick({ force: true }))
  // 🌸 桌宠 → 唤起主窗口的 朋友圈 / 剧场 / 日报
  ipcMain.handle('pet:open-life', async (_e, target: 'moments' | 'theater' | 'daily' | 'news') => {
    try {
      const wins = BrowserWindow.getAllWindows()
      const main = wins.find(w => !w.isDestroyed() && w !== petWindow) || wins.find(w => !w.isDestroyed())
      if (!main) {return { ok: false, error: '主窗口未打开' }}
      if (!main.isVisible()) {main.show()}
      main.focus()
      main.webContents.send('life:open', { target })
      return { ok: true }
    } catch (e: any) { return { ok: false, error: String(e) } }
  })

  // 🌸 桌宠生活视图数据桥：桌宠请求 → 向主窗口要同一 store 的数据 → 回传（独立视图、数据互通）
  const lifeWaiters = new Map<string, { resolve: (v: any) => void; timer: ReturnType<typeof setTimeout> }>()
  ipcMain.on('life:data-response', (_e, payload: { reqId: string; items?: any[] }) => {
    const w = lifeWaiters.get(payload?.reqId)
    if (w) {w.resolve({ items: Array.isArray(payload?.items) ? payload.items : [] })}
  })
  ipcMain.handle('pet:life-data', async (_e, target: string) => {
    return await new Promise((resolve) => {
      try {
        const wins = BrowserWindow.getAllWindows()
        const main = wins.find(w => !w.isDestroyed() && w !== petWindow) || wins.find(w => !w.isDestroyed())
        if (!main) {return resolve({ items: [] })}
        const reqId = 'life_' + Date.now() + '_' + Math.floor(Math.random() * 1e6)
        const timer = setTimeout(() => { lifeWaiters.delete(reqId); resolve({ items: [] }) }, 3000)
        lifeWaiters.set(reqId, {
          resolve: (data: any) => { clearTimeout(timer); lifeWaiters.delete(reqId); resolve(data) }, timer,
        })
        main.webContents.send('life:data-request', { reqId, target })
      } catch { resolve({ items: [] }) }
    })
  })

  // ── 设置面板 IPC（设置页 → 桌宠 / 主进程）─────────────
  ipcMain.handle('pet:settings', (_e, cfg: any) => {
    try {
      if (cfg?.model) {
        sendPetCommand({ type: 'set-model', model: cfg.model })
      }
      if (typeof cfg?.scale === 'number') {
        const wins = BrowserWindow.getAllWindows()
        const mainWin = wins.find(w => !w.isDestroyed() && w !== petWindow) || null
        updatePetConfig({ scale: cfg.scale }, mainWin)
      }
      if (typeof cfg?.penetrate === 'boolean') {
        const partial: any = { clickThrough: cfg.penetrate }
        const wins = BrowserWindow.getAllWindows()
        const mainWin = wins.find(w => !w.isDestroyed() && w !== petWindow) || null
        updatePetConfig(partial, mainWin)
      }
      if (cfg?.auto === 'off' || cfg?.auto === 'light' || cfg?.auto === 'heavy') {
        const wins = BrowserWindow.getAllWindows()
        const mainWin = wins.find(w => !w.isDestroyed() && w !== petWindow) || null
        updatePetConfig({ auto: cfg.auto }, mainWin)
      }
      return { ok: true }
    } catch (e: any) {
      return { ok: false, error: String(e) }
    }
  })

  // ── N.E.K.O 风格偏好读写 ─────────────
  ipcMain.handle('pet:prefs', () => getPetPrefs())
  ipcMain.handle('pet:update-prefs', (_e, patch: Partial<PetPrefs>) => {
    try {
      return { ok: true, prefs: updatePetPrefs(patch || {}) }
    } catch (e: any) {
      return { ok: false, error: String(e) }
    }
  })
  ipcMain.handle('pet:set-persona', (_e, params: { persona?: string; skip?: boolean }) => {
    const patch: Partial<PetPrefs> = { onboardingDone: true }
    if (params?.persona) {patch.persona = params.persona}
    updatePetPrefs(patch)
    return { ok: true }
  })
  ipcMain.handle('pet:open-onboarding', () => openOnboarding())

  // ── 音频设备枚举（麦克风/扬声器列表）─────────────
  ipcMain.handle('pet:audio-devices', async () => {
    try {
      const { systemPreferences } = await import('electron')
      // 触发权限请求（macOS 需要）
      if (process.platform === 'darwin') {
        try { await systemPreferences.askForMediaAccess('microphone') } catch {}
      }
      // 通过渲染进程的 navigator.mediaDevices 枚举更可靠；
      // 这里主进程用 desktopCapturer 做兜底，返回空数组让渲染页自己枚举
      return { ok: true, devices: [] }
    } catch (e: any) {
      return { ok: false, error: String(e), devices: [] }
    }
  })

  // ── 屏幕列表（屏幕分享选择）─────────────
  ipcMain.handle('pet:screens', async () => {
    try {
      const displays = screen.getAllDisplays()
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 160, height: 90 } })
      return {
        ok: true,
        screens: displays.map((d, i) => ({
          id: String(d.id),
          label: `屏幕 ${i + 1}${d.internal ? '（主显示器）' : ''}`,
          bounds: d.bounds,
          thumb: sources[i]?.thumbnail?.toDataURL() || '',
        })),
      }
    } catch (e: any) {
      return { ok: false, error: String(e), screens: [] }
    }
  })

  // ── 打开主窗口设置（API 密钥 / 记忆浏览等）─────────────
  ipcMain.on('pet:open-main-settings', (_e, target?: string) => {
    try {
      if (petMainWindow && !petMainWindow.isDestroyed()) {
        petMainWindow.show()
        petMainWindow.focus()
        if (target === 'llm') {
          // 跳转到 LLM 模型设置
          petMainWindow.webContents.send('menu:switch-panel', 'settings')
          petMainWindow.webContents.send('settings:goto', 'llm')
        } else if (target === 'memory') {
          // 跳转到 Live2D 桌宠对话
          petMainWindow.webContents.send('pet:goto-conversation', 'conv-pet-live2d')
        } else {
          petMainWindow.webContents.send('menu:switch-panel', 'settings')
        }
      }
    } catch (e) { console.warn('[PetWindow] open-main-settings failed:', e) }
  })

  // ── 专属桌面：Windows 虚拟桌面 ─────────────────────
  ipcMain.handle('pet:virtual-desktop', async (_e, params: { enable: boolean }) => {
    if (process.platform !== 'win32') {
      return { ok: false, error: '专属桌面仅支持 Windows 10/11' }
    }
    try {
      const { execFileSync } = await import('child_process')
      if (params.enable) {
        // 创建新虚拟桌面：Ctrl+Win+D
        execFileSync('powershell.exe', [
          '-NoProfile', '-NonInteractive', '-Command',
          "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^#{D}')",
        ], { windowsHide: true, timeout: 5000 })
        return { ok: true }
      } else {
        // 关闭当前虚拟桌面：Ctrl+Win+F4
        execFileSync('powershell.exe', [
          '-NoProfile', '-NonInteractive', '-Command',
          "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^#{F4}')",
        ], { windowsHide: true, timeout: 5000 })
        return { ok: true }
      }
    } catch (e: any) {
      return { ok: false, error: `虚拟桌面操作失败: ${e.message}` }
    }
  })

  // ── 应用开发：插件系统 ─────────────────────────────
  ipcMain.handle('pet:plugins', async (_e, params: { action: string }) => {
    const path = await import('path')
    const fs = await import('fs')
    const pluginsDir = path.join(app.getPath('userData'), 'pet-plugins')
    try {
      if (!fs.existsSync(pluginsDir)) {fs.mkdirSync(pluginsDir, { recursive: true })}
    } catch {}

    if (params.action === 'open-dir') {
      try {
        const { shell } = await import('electron')
        shell.openPath(pluginsDir)
        return { ok: true }
      } catch (e: any) { return { ok: false, error: e.message } }
    }

    if (params.action === 'list' || params.action === 'reload') {
      try {
        const files = fs.readdirSync(pluginsDir).filter(f => f.endsWith('.js'))
        const plugins: any[] = []
        for (const file of files) {
          try {
            const content = fs.readFileSync(path.join(pluginsDir, file), 'utf-8')
            const nameMatch = content.match(/@name\s+(.+)/) || content.match(/name\s*:\s*['"](.+?)['"]/)
            const descMatch = content.match(/@description\s+(.+)/) || content.match(/description\s*:\s*['"](.+?)['"]/)
            plugins.push({
              name: nameMatch?.[1] || file.replace('.js', ''),
              desc: descMatch?.[1] || '',
              file,
              enabled: true,
            })
          } catch {}
        }
        // 重新加载插件到渲染进程
        if (params.action === 'reload' && petWindow && !petWindow.isDestroyed()) {
          const pluginCodes = files.map(f => {
            try { return fs.readFileSync(path.join(pluginsDir, f), 'utf-8') } catch { return '' }
          }).filter(Boolean)
          petWindow.webContents.send('pet:plugins-reload', pluginCodes)
        }
        return { ok: true, plugins }
      } catch (e: any) { return { ok: false, error: e.message, plugins: [] } }
    }

    return { ok: false, error: '未知操作' }
  })

  // 快捷键 Ctrl+Shift+R 复位桌宠到屏幕中央
  try {
    globalShortcut.register('CommandOrControl+Shift+R', () => {
      resetPetToCenter()
    })
  } catch (e) { console.warn('[PetWindow] 快捷键注册失败:', e) }

  // 注：pet:test-intent / pet:chat 由 intentDispatcher.ts 统一注册，避免重复注册抛错
}

// ═══════════════════════════════════════════════════════════
// 🤵 主动秘书：观察用户在做什么 → 评价/建议/主动问话 → 推送搭话卡片
// ═══════════════════════════════════════════════════════════
let _lastSecretaryAt = 0
let _secretaryRunning = false
let _lastSecretarySpeech = ''

const SECRETARY_SYSTEM_PROMPT = `你是住在用户电脑里、会主动开口的 AI 伙伴"Lumina"，你能看到用户当前的活动窗口（必要时还有屏幕截图）。
【核心要求】
1. 必须先"看懂"屏幕：具体点出你看到的内容——在哪个应用/网站、在写什么代码或文档、在看什么视频或页面、大概进展到哪；严禁"看起来你在忙"这类空泛套话。若看不清屏幕，就只针对窗口标题做轻量观察，绝不编造细节。
2. 再选一种最贴切的姿态开口（kind）：observe 点出观察 / suggest 给一条具体、可立刻执行的建议 / ask 主动问一个能推进对话的问题 / praise 夸一句或轻松吐槽——可以像朋友那样小小"挑刺"、调侃，但不刻薄、不说教。
3. speech 20~60 字，口语、有信息量、像真人随口搭话，不要书面腔，不要复述窗口标题原文。
4. options 给三个"用户此刻最可能想点"的回应，必须具体承接当前场景（针对这段代码/这个视频/这份文档），三个方向尽量不同（如：让你深入帮忙 / 我自己来 / 轻松岔开），各不超过 12 字，禁止"好的""谢谢""收到"这类万能空话。
只输出一行 JSON，不要 markdown、不要多余解释：
{"speech":"...","options":["...","...","..."],"kind":"observe|suggest|ask|praise"}`

async function runSecretaryTick(opts?: { force?: boolean }): Promise<{ ok: boolean; skipped?: boolean; speech?: string; reason?: string }> {
  try {
    const prefs = getPetPrefs()
    const sec = prefs.secretary || {}
    if (prefs.privacyMode) {return { ok: true, skipped: true, reason: 'privacy' }}
    if (sec.enabled === false) {return { ok: true, skipped: true, reason: 'disabled' }}
    const minMs = Math.max(10, sec.minIntervalSec || 45) * 1000
    if (!opts?.force && Date.now() - _lastSecretaryAt < minMs) {return { ok: true, skipped: true, reason: 'interval' }}
    if (_secretaryRunning) {return { ok: true, skipped: true, reason: 'busy' }}
    _secretaryRunning = true

    const sources = sec.sources || {}
    // 1) 活动窗口（轻量）
    let sceneInfo: any = null
    let windowLine = ''
    if (sources.window !== false) {
      try { sceneInfo = await detectScene(); } catch { /* ignore */ }
      if (sceneInfo && sceneInfo.windowTitle) {
        windowLine = `活动窗口："${String(sceneInfo.windowTitle).slice(0, 80)}"（进程 ${sceneInfo.processName || '未知'}，场景 ${sceneInfo.scene}）。`
      }
    }
    // 2) 屏幕截图（多模态）
    let dataUrl: string | undefined
    if (sources.screen !== false) {
      try {
        const srcs = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1280, height: 720 } })
        if (srcs[0]) {dataUrl = srcs[0].thumbnail.toDataURL()}
      } catch { /* ignore */ }
    }
    // 3) 触发源提示
    const srcTags: string[] = []
    if (sources.news) {srcTags.push('可结合近期科技/新闻热点')}
    if (sources.video) {srcTags.push('若在看视频可一起聊或提醒时长')}
    if (sources.music) {srcTags.push('若在听音乐可聊聊音乐')}
    if (sources.personal) {srcTags.push('可结合用户个人动态主动关心')}

    const cfg = resolvePetBrainConfig()
    if (!cfg) { _secretaryRunning = false; return { ok: true, skipped: true, reason: 'no-llm' } }
    console.log('[Secretary] brain source:', cfg.source, cfg.model, '@', cfg.endpoint, dataUrl ? '(with-screen)' : '(text-only)')

    const nowD = new Date()
    const avoidLine = _lastSecretarySpeech ? `你上一次搭话说的是"${_lastSecretarySpeech.slice(0, 60)}"，这次换个角度、不要重复意思。` : ''
    const userContent = `现在 ${nowD.getHours()}:${String(nowD.getMinutes()).padStart(2, '0')}。${windowLine}${srcTags.length ? '提示：' + srcTags.join('；') + '。' : ''}${dataUrl ? '附带当前屏幕截图，请先看清屏幕里的具体内容。' : ''}${avoidLine}请观察并主动搭话。`
    const messages: any[] = [
      { role: 'system', content: SECRETARY_SYSTEM_PROMPT },
      { role: 'user', content: userContent, ...(dataUrl ? { images: [dataUrl] } : {}) },
    ]

    const provider = createPetLLM(cfg)
    let res = await provider.call({ messages, temperature: 0.95, maxTokens: 260 } as any)
    // 纯文本模型看不懂截图（会报错或说胡话）：调用失败或输出不是 JSON 时，去掉截图、只凭活动窗口文本重试一次
    const looksBroken = (r: any) => !!(r?.error) || !((r?.text || '').includes('{') && (r?.text || '').includes('}'))
    if (dataUrl && looksBroken(res)) {
      console.warn('[Secretary] vision call failed (model may be text-only), fallback to window-title text. reason:', String(res?.error || 'not-json').slice(0, 160))
      const textMessages: any[] = [
        { role: 'system', content: SECRETARY_SYSTEM_PROMPT },
        { role: 'user', content: `现在 ${nowD.getHours()}:${String(nowD.getMinutes()).padStart(2, '0')}。${windowLine || '暂时读不到活动窗口标题。'}${srcTags.length ? '提示：' + srcTags.join('；') + '。' : ''}${avoidLine}你看不到屏幕截图，请只根据活动窗口信息做轻量观察并主动搭话，不要编造屏幕细节。` },
      ]
      res = await provider.call({ messages: textMessages, temperature: 0.95, maxTokens: 260 } as any)
    }
    let speech = ''
    let options: string[] = []
    let kind = 'observe'
    // 健壮提取：兼容模型用 ```json 包裹、前后带解释文字等情况，避免"该说话时沉默"
    let parsed: any = null
    const rawText = (res?.text || '').trim()
    try { parsed = JSON.parse(rawText) } catch {
      const i = rawText.indexOf('{'), j = rawText.lastIndexOf('}')
      if (i >= 0 && j > i) { try { parsed = JSON.parse(rawText.slice(i, j + 1)) } catch { parsed = null } }
    }
    const obj = parsed || {}
    if (typeof obj.speech === 'string') {speech = obj.speech.trim().slice(0, 90)}
    if (Array.isArray(obj.options)) {options = obj.options
      .filter((x: any) => typeof x === 'string' && x.trim())
      .map((x: string) => x.trim().slice(0, 20))
      .slice(0, 3)}
    if (['observe', 'suggest', 'ask', 'praise'].includes(String(obj.kind))) {kind = String(obj.kind)}
    _secretaryRunning = false
    if (!speech) {return { ok: true, skipped: true, reason: 'parse-fail' }}

    _lastSecretaryAt = Date.now()
    _lastSecretarySpeech = speech
    sendPetCommand({
      type: 'proactive-card', text: speech, options, kind,
      scene: sceneInfo ? { scene: sceneInfo.scene, title: sceneInfo.windowTitle, process: sceneInfo.processName } : null,
    })
    return { ok: true, speech }
  } catch (e: any) {
    _secretaryRunning = false
    console.warn('[Secretary] 主动秘书 tick 失败:', e?.message || e)
    return { ok: false, reason: String(e) }
  }
}

/**
 * 向桌宠窗口发送命令（主进程 → 桌宠渲染进程）
 * 命令协议与 pet-live2d.html 的 `pet:command` 监听一致：
 *   { type: 'intent', intent: { action, speech, mood, ... } }
 *   { type: 'say', text } | { type: 'set-emotion', emotion }
 *   { type: 'walk', enable } | { type: 'set-opacity', value }
 */
export function sendPetCommand(cmd: any): boolean {
  if (!petWindow || petWindow.isDestroyed()) {
    console.warn('[PetWindow] 桌宠窗口未就绪，忽略命令:', cmd?.type || cmd?.intent?.action)
    return false
  }
  try {
    petWindow.webContents.send('pet:command', cmd)
    return true
  } catch (e: any) {
    console.error('[PetWindow] sendPetCommand 失败:', e)
    return false
  }
}

// ═══════════════════════════════════════════════════════════
// 独立聊天窗口（可拖到屏幕任意位置，不再被 compact 小窗物理边界锁死）
// ═══════════════════════════════════════════════════════════

export const PET_CHAT_WINDOW_W = 420
export const PET_CHAT_WINDOW_H = 620

let petChatWindow: BrowserWindow | null = null

export function isPetChatOpen(): boolean {
  return !!(petChatWindow && !petChatWindow.isDestroyed())
}

/** 独立聊天窗口 HTML 路径（独立检查 mtime，保证新页被复制到 userData） */
function getPetChatHtmlPath(): string {
  const dir = path.join(app.getPath('userData'), 'pet-assets')
  if (!fs.existsSync(dir)) {fs.mkdirSync(dir, { recursive: true })}
  const chatHtmlPath = path.join(dir, 'pet-chat.html')
  const src = findPetSourceDir()
  if (src) {
    const srcFile = path.join(src, 'pet-chat.html')
    const srcMtime = fs.existsSync(srcFile) ? fs.statSync(srcFile).mtimeMs : 0
    const dstMtime = fs.existsSync(chatHtmlPath) ? fs.statSync(chatHtmlPath).mtimeMs : 0
    if (dstMtime < srcMtime) {copyPetAssets(dir)}
  }
  return chatHtmlPath
}

/**
 * 创建（或聚焦）独立聊天窗口。
 * frame:false + 透明 + 置顶，页面标题栏用 -webkit-app-region:drag 由系统原生拖动，
 * 可拖到屏幕任意位置；位置写回 pet-config.json（chatX/chatY），重启恢复。
 */
export function openPetChatWindow(): { ok: boolean; error?: string } {
  if (petChatWindow && !petChatWindow.isDestroyed()) {
    petChatWindow.show()
    petChatWindow.focus()
    return { ok: true }
  }
  try {
    const chatHtml = getPetChatHtmlPath()
    if (!fs.existsSync(chatHtml)) {return { ok: false, error: 'pet-chat.html not found' }}

    const petCaps = currentPlatformCaps()
    const display = screen.getPrimaryDisplay()
    const wa = display.workArea
    const w = PET_CHAT_WINDOW_W
    const h = PET_CHAT_WINDOW_H
    let x = Number.isFinite(config.chatX) ? (config.chatX as number) : wa.x + wa.width - w - 40
    let y = Number.isFinite(config.chatY) ? (config.chatY as number) : wa.y + Math.max(40, wa.height - h - 60)
    const c = clampWindowPos(x, y, w, h)
    x = c.x; y = c.y

    petChatWindow = new BrowserWindow({
      width: w,
      height: h,
      x,
      y,
      transparent: petCaps.transparent,
      frame: false,
      alwaysOnTop: petCaps.alwaysOnTop,
      skipTaskbar: false, // 独立窗口显示在任务栏，方便找回
      resizable: true,
      minWidth: 360,
      minHeight: 420,
      hasShadow: false,
      focusable: true,
      backgroundColor: petCaps.backgroundColor,
      webPreferences: {
        preload: resolvePreloadPath(),
        sandbox: false,
        contextIsolation: false,
        nodeIntegration: true,
        backgroundThrottling: true,
        spellcheck: false,
      },
    })

    petChatWindow.loadFile(chatHtml).then(() => {
      // 通知页面聚焦输入框
      if (petChatWindow && !petChatWindow.isDestroyed()) {
        petChatWindow.webContents.send('pet:chat-window-focus')
      }
    }).catch(err => {
      console.error('[PetChatWindow] loadFile failed:', err)
    })

    // 拖拽结束（系统原生拖动）后持久化位置
    let saveTimer: ReturnType<typeof setTimeout> | null = null
    const persistPos = () => {
      if (!petChatWindow || petChatWindow.isDestroyed()) {return}
      if (saveTimer) {clearTimeout(saveTimer)}
      saveTimer = setTimeout(() => {
        if (!petChatWindow || petChatWindow.isDestroyed()) {return}
        const [cx, cy] = petChatWindow.getPosition()
        config.chatX = cx; config.chatY = cy
        persistPetConfig()
      }, 300)
    }
    petChatWindow.on('move', persistPos)
    petChatWindow.on('closed', () => {
      petChatWindow = null
      console.log('[PetChatWindow] 独立聊天窗口已关闭')
    })

    console.log('[PetChatWindow] 🐱 独立聊天窗口已创建')
    return { ok: true }
  } catch (e: any) {
    petChatWindow = null
    console.error('[PetChatWindow] 创建失败:', e)
    return { ok: false, error: String(e) }
  }
}

/** 关闭独立聊天窗口（桌宠整体退出时调用） */
export function closePetChatWindow(): void {
  if (petChatWindow && !petChatWindow.isDestroyed()) {
    petChatWindow.close()
  }
  petChatWindow = null
}

// ═══════════════════════════════════════════════════════════
// 新手引导（N.E.K.O 风格初始人格选择）
// ═══════════════════════════════════════════════════════════

let onboardingWin: BrowserWindow | null = null
export function openOnboarding(): { ok: boolean } {
  if (onboardingWin && !onboardingWin.isDestroyed()) {
    onboardingWin.focus()
    return { ok: true }
  }
  const p = path.join(path.dirname(getPetHtmlPath()), 'onboarding.html')
  if (!fs.existsSync(p)) {return { ok: false }}
  onboardingWin = new BrowserWindow({
    width: 780,
    height: 640,
    title: 'Lumina Virtual Pet · 初始人格',
    alwaysOnTop: true,
    resizable: false,
    webPreferences: {
      preload: resolvePreloadPath(),
      sandbox: false,
      contextIsolation: false,
      nodeIntegration: true,
      backgroundThrottling: true, // 窗口隐藏/被遮挡时暂停 RAF 与定时器，省 CPU/内存
      spellcheck: false,
    },
  })
  onboardingWin.loadFile(p)
  onboardingWin.on('closed', () => { onboardingWin = null })
  return { ok: true }
}
export function maybeShowOnboarding(): void {
  // 新手引导已取消自动弹出；人格选择仍可从设置中手动打开
}

// ═══════════════════════════════════════════════════════════
// Lumina Pet Handling：桌宠请求操作电脑（权限门控 + ComputerUse 执行）
// ═══════════════════════════════════════════════════════════

export async function tryPetOperate(cu: { type?: string; params?: Record<string, any> }): Promise<{ ok: boolean; error?: string }> {
  const cp = getPetPrefs().catpaw || {}
  if (!cp.master) {return { ok: false, error: 'Lumina Pet Handling 未开启' }}
  if (!cp.kbm) {return { ok: false, error: '键鼠控制未开启' }}
  const t = cu?.type
  if (!t || !['open_app', 'keypress', 'type', 'wait', 'click', 'screenshot', 'scroll'].includes(t)) {
    return { ok: false, error: '不支持的操作类型' }
  }
  const appName = String(cu.params?.app || cu.params?.text || '')
  if (!cp.browser && /chrome|edge|firefox|browser|浏览器/i.test(appName)) {
    return { ok: false, error: '浏览器控制未开启' }
  }
  try {
    const ok = await getComputerUse().executeAction({ type: t as any, params: (cu.params || {}) as Record<string, string | number> })
    return { ok }
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) }
  }
}
