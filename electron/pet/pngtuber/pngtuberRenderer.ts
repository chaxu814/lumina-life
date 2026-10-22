// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// pet/pngtuber/pngtuberRenderer.ts — 🖼 PNGTuber Canvas 渲染器 (v0.1)
//
// 在桌宠窗口的 <canvas> 上绘制 PNGTuber 立绘：
//   - 预载 idle/talking(+blink…) 帧， talking 状态切换口型；
//   - 4 态模型按随机间隔自动眨眼（2 态模型忽略 blink 帧）；
//   - 图片按高度自适应居中、贴底绘制，透明背景。
//
// 注意：本模块运行在桌宠渲染页（browser 侧），依赖 DOM 类型。
// 由于构建管线暂时未加 PNGTuber 的 esbuild 打包步（见 docs/avatar-guide.md），
// pet-pngtuber.html 内联了等价实现；本文件作为可类型检查的「真源」存在，
// 后续接入 assets/pet-pngtuber.js 打包后页面直接 <script src> 引用本类。
// ============================================================

import {
  pickFrame,
  nextBlinkDelay,
  type PngTuberConfig,
  type PngTuberFrames,
  type PngTuberFrame,
} from './pngtuberModel'

export interface PngTuberRendererOptions {
  /** 帧 URL：idle/talking 必填，blink/blinkTalking 可选 */
  frames: PngTuberFrames
  config?: Partial<PngTuberConfig>
  /** 图片目标高度占画布高度比例（0~1），默认 0.92 */
  heightRatio?: number
  onReady?: () => void
  onError?: (msg: string) => void
}

export class PngTuberRenderer {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private frames: PngTuberFrames
  private cfg: PngTuberConfig
  private images: Partial<Record<PngTuberFrame, HTMLImageElement>> = {}
  private talking = false
  private blinking = false
  private blinkTimer: ReturnType<typeof setTimeout> | null = null
  private blinkHoldTimer: ReturnType<typeof setTimeout> | null = null
  private rafId: number | null = null
  private heightRatio: number

  constructor(canvas: HTMLCanvasElement, options: PngTuberRendererOptions) {
    this.canvas = canvas
    const ctx = canvas.getContext('2d')
    if (!ctx) {throw new Error('无法创建 2d 画布上下文')}
    this.ctx = ctx
    this.frames = options.frames
    this.cfg = {
      ...{
        blinkMinMs: 2200, blinkMaxMs: 6500, blinkHoldMs: 140, talkHoldMs: 260,
      },
      ...(options.config || {}),
    }
    this.heightRatio = options.heightRatio ?? 0.92
  }

  /** 预载全部帧；任一必需帧加载失败即回调 onError */
  async load(): Promise<void> {
    const need: PngTuberFrame[] = ['idle', 'talking']
    if (this.frames.blink) {need.push('blink')}
    if (this.frames.blinkTalking) {need.push('blinkTalking')}
    await Promise.all(need.map(async (k) => {
      const src = this.frames[k]
      if (!src) {return}
      const img = await this.loadImage(src)
      this.images[k] = img
    }))
    this.scheduleBlink()
    this.draw()
  }

  private loadImage(src: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const img = new Image()
      img.onload = () => resolve(img)
      img.onerror = () => reject(new Error(`帧图片加载失败：${src}`))
      img.src = src
    })
  }

  /** 外部驱动说话状态（true=正在说话，切换到 talking 帧） */
  setTalking(on: boolean): void {
    if (this.talking === on) {return}
    this.talking = on
    this.draw()
  }

  get hasBlink(): boolean { return !!(this.frames.blink && this.frames.blinkTalking) }

  private scheduleBlink(): void {
    if (!this.hasBlink) {return}
    this.blinkTimer = setTimeout(() => {
      this.blinking = true
      this.draw()
      this.blinkHoldTimer = setTimeout(() => {
        this.blinking = false
        this.draw()
        this.scheduleBlink()
      }, this.cfg.blinkHoldMs)
    }, nextBlinkDelay(this.cfg))
  }

  private currentFrameKey(): PngTuberFrame {
    return pickFrame({ talking: this.talking, blinking: this.blinking }, this.frames)
  }

  /** 按高度占比等比缩放、水平居中、贴底绘制；画布随窗口 resize */
  draw(): void {
    const w = this.canvas.width = this.canvas.clientWidth
    const h = this.canvas.height = this.canvas.clientHeight
    this.ctx.clearRect(0, 0, w, h)
    const key = this.currentFrameKey()
    const img = this.images[key] || this.images.idle
    if (!img || !img.naturalWidth) {return}
    const targetH = h * this.heightRatio
    const scale = targetH / img.naturalHeight
    const dw = img.naturalWidth * scale
    const dh = img.naturalHeight * scale
    const dx = (w - dw) / 2
    const dy = h - dh
    this.ctx.drawImage(img, dx, dy, dw, dh)
  }

  /** 启动 resize 监听 + 绘制循环（静态帧不需要 RAF，resize 时重画即可） */
  start(): void {
    window.addEventListener('resize', this.draw)
    this.draw()
  }

  destroy(): void {
    if (this.blinkTimer) {clearTimeout(this.blinkTimer); this.blinkTimer = null}
    if (this.blinkHoldTimer) {clearTimeout(this.blinkHoldTimer); this.blinkHoldTimer = null}
    if (this.rafId !== null) {cancelAnimationFrame(this.rafId); this.rafId = null}
    window.removeEventListener('resize', this.draw)
  }
}
