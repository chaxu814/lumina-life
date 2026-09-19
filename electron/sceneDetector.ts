// ============================================================
// sceneDetector.ts — 场景检测引擎 (v1.0)
//
// 通过 PowerShell 检测当前活跃窗口的标题和进程名，
// 结合规则 + LLM 判断用户处于哪种场景：
//   工作 · 学习 · 娱乐 · 空闲
//
// 仅在 Windows 上生效；macOS/Linux 返回 fallback。
// ============================================================

import { execFile } from 'child_process'
import os from 'os'

// ═══════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════

export type SceneType = 'work' | 'study' | 'fun' | 'idle'

export interface SceneInfo {
  /** 场景分类 */
  scene: SceneType
  /** 可信度 0-100 */
  confidence: number
  /** 窗口标题 */
  windowTitle: string
  /** 进程名 */
  processName: string
  /** 检测时间 */
  detectedAt: number
  /** 判断依据 */
  reason: string
}

// ═══════════════════════════════════════════════════════════
// 场景关键特征库（关键词 → 场景映射）
// ═══════════════════════════════════════════════════════════

interface SceneKeywordRule {
  keywords: string[]
  scene: SceneType
  weight: number  // 匹配权重
}

const TITLE_RULES: SceneKeywordRule[] = [
  // ── 工作 ──
  { keywords: ['visual studio code', 'vscode', 'code -', 'webstorm', 'intellij', 'pycharm', 'goland', 'sublime',
    'vim', 'neovim', 'emacs', 'xcode', 'android studio'],
    scene: 'work', weight: 30 },
  { keywords: ['excel', 'word -', 'powerpoint', 'outlook', 'teams', 'slack', 'discord', '钉钉', '企业微信',
    '飞书', 'notion', 'todoist', 'linear', 'jira', 'confluence', 'trello', 'asana'],
    scene: 'work', weight: 25 },
  { keywords: ['terminal', 'cmd', 'powershell', 'windows terminal', 'iterm', 'putty', 'ssh',
    'docker', 'kubernetes', 'jenkins', 'gitlab', 'github'],
    scene: 'work', weight: 20 },
  { keywords: ['chrome', 'edge', 'firefox', 'brave', 'opera', 'safari -'],
    scene: 'work', weight: 5 },  // 浏览器需要结合 URL 判断，给低权重
  // ── 学习 ──
  { keywords: ['pdf', 'acrobat', 'reader', '电子书', 'kindle', 'calibre',
    'coursera', 'udemy', 'bilibili', '学堂在线', '慕课', 'mooc',
    'wikipedia', '词典', 'translate', 'deepl'],
    scene: 'study', weight: 25 },
  // ── 娱乐 ──
  { keywords: ['youtube', 'bilibili', 'netflix', 'hbo', 'disney+', 'spotify', 'music',
    'steam', 'epic', 'battle.net', '游戏', 'game', 'play',
    '直播', '斗鱼', '虎牙', '抖音', 'tiktok',
    'manga', 'comic', 'anime', 'movie', 'video'],
    scene: 'fun', weight: 25 },
  // idle 由进程名规则和超时逻辑处理
]

const PROCESS_RULES: SceneKeywordRule[] = [
  // ── 工作 ──
  { keywords: ['code.exe', 'idea*.exe', 'pycharm*.exe', 'webstorm*.exe', 'goland*.exe',
    'sublime_text.exe', 'vim.exe', 'xcode.exe',
    'WINWORD.EXE', 'EXCEL.EXE', 'POWERPNT.EXE', 'OUTLOOK.EXE',
    'Teams.exe', 'Slack.exe', 'notion.exe',
    'chrome.exe', 'msedge.exe', 'firefox.exe', 'brave.exe',
    'DingTalk.exe', 'WeCom.exe', 'Feishu.exe',
    'WindowsTerminal.exe', 'cmd.exe', 'powershell.exe',
    'git-bash.exe', 'putty.exe', 'mstsc.exe'],
    scene: 'work', weight: 20 },
  // ── 学习 ──
  { keywords: ['Acrobat.exe', 'AcroRd32.exe', 'kindle.exe', 'calibre.exe',
    'bilibili.exe'],
    scene: 'study', weight: 20 },
  // ── 娱乐 ──
  { keywords: ['chrome.exe', 'msedge.exe', 'firefox.exe',
    'Spotify.exe', 'Music.exe', 'wmplayer.exe',
    'steam.exe', 'epicgameslauncher.exe', 'Battle.net.exe',
    'LOL.exe', 'dota2.exe', 'overwatch.exe'],
    scene: 'fun', weight: 15 },
]

// ═══════════════════════════════════════════════════════════
// Lumina 自身窗口识别（不应被归类为任何场景）
// ═══════════════════════════════════════════════════════════

const SELF_WINDOW_PATTERNS = [
  'lumina',           // Lumina 主窗口、桌宠、设置等
  'qwenpaw',          // QwenPaw（参考项目，同样排除）
]

const SELF_PROCESS_NAMES = [
  'lumina',           // Lumina 主进程
  'qwenpaw-desktop',  // QwenPaw
  'qwenpaw-backend',
  'qwenpaw',
]

function isSelfWindow(title: string, process: string): boolean {
  const t = title.toLowerCase()
  const p = process.toLowerCase()
  if (SELF_PROCESS_NAMES.some(name => p.includes(name))) {return true}
  if (SELF_WINDOW_PATTERNS.some(pat => t.includes(pat))) {return true}
  return false
}

// ═══════════════════════════════════════════════════════════
// Windows 活跃窗口检测（PowerShell）
// ═══════════════════════════════════════════════════════════

/** 🆕 v3.0: 窗口缓存 — 相同窗口不重复调 PowerShell */
let _lastWindowCache: { title: string; process: string; cachedAt: number } | null = null
const CACHE_TTL_MS = 30_000  // 30 秒内复用上次窗口结果（场景检测/屏幕感知共用，避免反复启动 PowerShell）

const PS_GET_ACTIVE_WINDOW = `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Diagnostics;
public class ActiveWin {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out int processId);
  public static string Get() {
    IntPtr hwnd = GetForegroundWindow();
    StringBuilder sb = new StringBuilder(512);
    GetWindowText(hwnd, sb, 512);
    int pid = 0;
    GetWindowThreadProcessId(hwnd, out pid);
    try {
      Process p = Process.GetProcessById(pid);
      return sb.ToString() + "|||" + p.ProcessName;
    } catch {
      return sb.ToString() + "|||unknown";
    }
  }
}
"@
[ActiveWin]::Get()
`

/**
 * 通过 PowerShell 获取当前活跃窗口信息（仅 Windows）
 * 🆕 v3.0: 支持缓存 — 10 秒内同一窗口直接返回，避免频繁新建 PowerShell 进程
 */
function detectActiveWindowWin32(): Promise<{ title: string; process: string } | null> {
  // 缓存命中：10 秒内同一窗口直接返回
  const now = Date.now()
  if (_lastWindowCache && (now - _lastWindowCache.cachedAt) < CACHE_TTL_MS) {
    return Promise.resolve({
      title: _lastWindowCache.title,
      process: _lastWindowCache.process,
    })
  }

  return new Promise((resolve) => {
    const b64 = Buffer.from(PS_GET_ACTIVE_WINDOW, 'utf16le').toString('base64')
    execFile('powershell', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-EncodedCommand', b64,
    ], { timeout: 5000, windowsHide: true }, (err, stdout) => {
      if (err || !stdout) {
        resolve(null)
        return
      }
      const parts = stdout.trim().split('|||')
      let winInfo: { title: string; process: string } | null = null
      if (parts.length >= 2) {
        winInfo = {
          title: parts[0].trim(),
          process: parts[1].trim().toLowerCase(),
        }
      } else {
        winInfo = { title: stdout.trim(), process: 'unknown' }
      }
      // 更新窗口缓存
      if (winInfo) {
        _lastWindowCache = { ...winInfo, cachedAt: Date.now() }
      }
      resolve(winInfo)
    })
  })
}

/**
 * 获取当前活跃窗口（跨平台）
 */
export async function detectActiveWindow(): Promise<{ title: string; process: string } | null> {
  const platform = os.platform()
  if (platform === 'win32') {
    return detectActiveWindowWin32()
  }
  // macOS / Linux 暂不支持（可后续扩展）
  console.log('[SceneDetector] 非 Windows 平台，跳过窗口检测')
  return null
}

// ═══════════════════════════════════════════════════════════
// 场景分类
// ═══════════════════════════════════════════════════════════

function matchRules(
  text: string,
  rules: SceneKeywordRule[],
): Array<{ scene: SceneType; score: number }> {
  const lower = text.toLowerCase()
  const scores: Record<string, number> = {}

  for (const rule of rules) {
    for (const kw of rule.keywords) {
      // 支持 glob 风格通配（简单实现：* 匹配任意）
      if (kw.includes('*')) {
        const pattern = kw.replace(/\*/g, '.*').toLowerCase()
        try {
          if (new RegExp(pattern).test(lower)) {
            scores[rule.scene] = (scores[rule.scene] || 0) + rule.weight
            break
          }
        } catch { /* skip bad regex */ }
      } else if (lower.includes(kw)) {
        scores[rule.scene] = (scores[rule.scene] || 0) + rule.weight
        break
      }
    }
  }

  return Object.entries(scores).map(([scene, score]) => ({
    scene: scene as SceneType,
    score,
  })).sort((a, b) => b.score - a.score)
}

/**
 * 根据窗口信息判断场景
 */
export function classifyScene(
  windowInfo: { title: string; process: string } | null,
): SceneInfo {
  const now = Date.now()

  if (!windowInfo) {
    return {
      scene: 'idle',
      confidence: 40,
      windowTitle: '',
      processName: '',
      detectedAt: now,
      reason: '无法获取窗口信息，默认为空闲',
    }
  }

  // 🔧 FIX: Lumina 自身窗口不参与场景判定（桌宠、主界面、设置等）
  if (isSelfWindow(windowInfo.title, windowInfo.process)) {
    return {
      scene: 'idle',
      confidence: 80,
      windowTitle: windowInfo.title,
      processName: windowInfo.process,
      detectedAt: now,
      reason: `Lumina 自身窗口 "${windowInfo.title.slice(0, 30)}"，跳过场景检测`,
    }
  }

  const titleScores = matchRules(windowInfo.title, TITLE_RULES)
  const processScores = matchRules(windowInfo.process, PROCESS_RULES)

  // 合并得分
  const combined: Record<string, number> = {}
  for (const s of titleScores) {combined[s.scene] = (combined[s.scene] || 0) + s.score}
  for (const s of processScores) {combined[s.scene] = (combined[s.scene] || 0) + s.score * 0.7}

  // 如果没有匹配任何规则 → 浏览器默认工作，其他默认空闲
  // 🔧 FIX: 未知窗口不再默认"娱乐"，改为"空闲"更合理
  if (Object.keys(combined).length === 0) {
    // 浏览器类进程默认工作
    const browserProcesses = ['chrome.exe', 'msedge.exe', 'firefox.exe', 'brave.exe', 'opera.exe']
    if (browserProcesses.includes(windowInfo.process.toLowerCase())) {
      return {
        scene: 'work',
        confidence: 45,
        windowTitle: windowInfo.title,
        processName: windowInfo.process,
        detectedAt: now,
        reason: `浏览器窗口 "${windowInfo.title.slice(0, 30)}"，默认为工作场景`,
      }
    }
    return {
      scene: 'idle',
      confidence: 30,
      windowTitle: windowInfo.title,
      processName: windowInfo.process,
      detectedAt: now,
      reason: `未匹配规则的窗口 "${windowInfo.process}"，默认为空闲`,
    }
  }

  // 🐛 修复: combined 是普通对象(Record), 没有 Map 的 .entries()/.toArray() 方法
  // 改用 Object.entries() 拿到 [scene, score][] 数组后排序
  const sortedEntries = Object.entries(combined).sort((a, b) => b[1] - a[1])
  const topScene = sortedEntries[0]
  const totalScore = Object.values(combined).reduce((a, b) => a + b, 0)
  const confidence = Math.min(95, Math.round((topScene[1] / Math.max(totalScore, 1)) * 70 + 20))

  return {
    scene: topScene[0] as SceneType,
    confidence,
    windowTitle: windowInfo.title,
    processName: windowInfo.process,
    detectedAt: now,
    reason: `窗口标题匹配 "${windowInfo.title.slice(0, 30)}"，进程 "${windowInfo.process}" → ${topScene[0]}`,
  }
}

/**
 * 一次完整的场景检测
 */
export async function detectScene(): Promise<SceneInfo> {
  const windowInfo = await detectActiveWindow()
  return classifyScene(windowInfo)
}

/**
 * 判断场景是否发生了变化（比较新旧 SceneInfo）
 */
export function sceneChanged(old: SceneInfo | null, current: SceneInfo): boolean {
  if (!old) {return true}
  if (old.scene !== current.scene) {return true}
  // 置信度跨越阈值时也算变化
  if (old.confidence < 50 && current.confidence >= 50) {return true}
  if (old.confidence >= 50 && current.confidence < 50) {return true}
  return false
}
