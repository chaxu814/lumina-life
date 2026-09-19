// ============================================================
// pet/vision/screenAwareness.ts — 👁️ 事件化屏幕感知 (v0.2)
//
// 旧实现：自主心跳里「每帧截图 → 整张丢给多模态 LLM」，低频、贵、面板一开就停。
// 这里改为事件驱动：
//   1) 对降采样灰度缩略图算差异哈希(dHash)，帧间汉明距离量化「画面变了多少」；
//   2) 用活动窗口标题/进程把场景分为 游戏/视频/代码/文档/社交/发呆；
//   3) 仅在「画面显著变化 / 场景切换 / 低频兜底」时才决定截图问 VLM，稳定画面不花钱。
// 缩略图降采样与 desktopCapturer 在接线层完成；本模块纯 TS、可单测。
// ============================================================

export type SceneKind = 'game' | 'video' | 'code' | 'doc' | 'social' | 'idle' | 'other'

/** dHash：对 w×h 灰度（标准 9×8=64bit）按相邻亮度比较生成位序列 */
export function dhash(gray: ArrayLike<number>, w: number, h: number): boolean[] {
  const bits: boolean[] = []
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w - 1; x++) {
      const i = y * w + x
      bits.push((gray[i] ?? 0) > (gray[i + 1] ?? 0))
    }
  }
  return bits
}

/** 汉明距离（长度不一致按全异计） */
export function hammingDistance(a: boolean[], b: boolean[]): number {
  let n = Math.abs(a.length - b.length)
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i++) {if (a[i] !== b[i]) {n++}}
  return n
}

/** 画面变化分数 0~1 */
export function changeScore(a: boolean[] | null, b: boolean[]): number {
  if (!a || a.length === 0) {return 1}
  return hammingDistance(a, b) / Math.max(a.length, b.length, 1)
}

const SCENE_KEYWORDS: Array<[SceneKind, string[]]> = [
  ['game', ['steam', 'epic games', 'genshin', '原神', '崩坏', '英雄联盟', 'league of legends', 'minecraft', '我的世界', 'riot', '育碧', 'uplay', 'battle.net', '战网', 'switch', '游戏', '永劫', '王者', '蛋仔']],
  ['video', ['bilibili', 'b站', 'youtube', '优酷', '爱奇艺', '腾讯视频', 'netflix', 'twitch', '抖音', '快手', 'vlc', 'potplayer', 'mpv', '播放器', '视频', '番剧', '动画']],
  ['code', ['visual studio code', 'vscode', 'code.exe', 'intellij', 'idea', 'webstorm', 'pycharm', 'terminal', '终端', 'powershell', 'cmd.exe', 'git', 'github', 'neovim', 'vim', 'cursor', '代码', '编程', 'docker', 'wsl']],
  ['doc', ['word', 'notion', 'obsidian', 'wps', 'acrobat', '.pdf', 'excel', 'powerpoint', '文档', '阅读', 'confluence', '飞书文档', '语雀']],
  ['social', ['wechat', '微信', 'qq', 'discord', 'telegram', 'slack', 'feishu', 'lark', '飞书', '钉钉', 'teams', '消息']],
]

/** 根据活动窗口标题/进程名分类场景 */
export function classifyScene(windowTitle?: string | null, appName?: string | null): SceneKind {
  const text = `${windowTitle ?? ''} ${appName ?? ''}`.toLowerCase()
  if (!text.trim()) {return 'idle'}
  for (const [scene, kws] of SCENE_KEYWORDS) {
    if (kws.some(k => text.includes(k.toLowerCase()))) {return scene}
  }
  if (/^(desktop|桌面|program manager|explorer|任务栏)/.test(text.trim())) {return 'idle'}
  return 'other'
}

export interface AwarenessConfig {
  /** 触发 VLM 的画面变化阈值 */
  changeThreshold?: number
  /** 两次 VLM 询问的最小间隔 ms */
  minIntervalMs?: number
  /** 场景切换后的最小间隔 ms */
  sceneSwitchIntervalMs?: number
  /** 低频兜底间隔 ms（即使没变化也偶尔看一眼） */
  idlePollMs?: number
}

export interface CaptureDecision {
  capture: boolean
  reason: 'change' | 'scene_change' | 'interval' | 'stable' | 'first'
  scene: SceneKind
  change: number
}

/** 屏幕感知节流决策器 */
export class ScreenAwareness {
  private prevHash: boolean[] | null = null
  private lastCaptureAt: number | null = null
  private lastWindowKey: string | null = null
  scene: SceneKind = 'idle'
  private lastChange = 0
  private cfg: Required<AwarenessConfig>

  constructor(cfg: AwarenessConfig = {}) {
    this.cfg = {
      changeThreshold: cfg.changeThreshold ?? 0.32,
      minIntervalMs: cfg.minIntervalMs ?? 15_000,
      sceneSwitchIntervalMs: cfg.sceneSwitchIntervalMs ?? 4_000,
      idlePollMs: cfg.idlePollMs ?? 120_000,
    }
  }

  /** 喂入一帧降采样灰度图 */
  noteFrame(gray: ArrayLike<number>, w: number, h: number, now: number): number {
    const hash = dhash(gray, w, h)
    this.lastChange = changeScore(this.prevHash, hash)
    this.prevHash = hash
    return this.lastChange
  }

  /** 喂入当前活动窗口 */
  noteWindow(windowTitle?: string | null, appName?: string | null): boolean {
    const scene = classifyScene(windowTitle, appName)
    const key = `${scene}:${(appName ?? windowTitle ?? '').toLowerCase().trim()}`
    const switched = key !== this.lastWindowKey
    this.lastWindowKey = key
    this.scene = scene
    if (switched) {this.pendingSwitch = true}
    return switched
  }

  /** 决定此刻是否要截图问 VLM */
  decide(now: number): CaptureDecision {
    const since = this.lastCaptureAt === null ? Infinity : now - this.lastCaptureAt
    const windowSwitched = this._windowSwitchedAndConsume()

    if (this.lastCaptureAt === null) {
      this.lastCaptureAt = now
      return { capture: true, reason: 'first', scene: this.scene, change: this.lastChange }
    }
    if (windowSwitched && since >= this.cfg.sceneSwitchIntervalMs) {
      this.lastCaptureAt = now
      return { capture: true, reason: 'scene_change', scene: this.scene, change: this.lastChange }
    }
    if (this.lastChange >= this.cfg.changeThreshold && since >= this.cfg.minIntervalMs) {
      this.lastCaptureAt = now
      return { capture: true, reason: 'change', scene: this.scene, change: this.lastChange }
    }
    if (since >= this.cfg.idlePollMs) {
      this.lastCaptureAt = now
      return { capture: true, reason: 'interval', scene: this.scene, change: this.lastChange }
    }
    return { capture: false, reason: 'stable', scene: this.scene, change: this.lastChange }
  }

  private pendingSwitch = false
  private _windowSwitchedAndConsume(): boolean {
    const v = this.pendingSwitch
    this.pendingSwitch = false
    return v
  }

  /** 由 noteWindow 内部调用改为标记；保留覆写钩子 */
  markSceneSwitch(): void { this.pendingSwitch = true }
}
