#!/usr/bin/env node
// ============================================================
// scripts/make-sprite-template.mjs — 生成 8×9 精灵表空白模板
//
// 用法：
//   node scripts/make-sprite-template.mjs                  → examples/sprites/TEMPLATE/sheet-template.png
//   node scripts/make-sprite-template.mjs --out my.png --frame 192
//
// 【为什么自己写 PNG 编码器而不用 sharp】
// sharp 在本项目里是为 Electron 运行时重建过的（npmRebuild: true），
// 在系统 Node 下 require 会直接抛错。作为一个**给用户用的模板生成器**，
// 它必须做到「克隆下来就能跑」—— 所以这里用 Node 内置的 zlib 手写 PNG。
// PNG 本身很简单：signature + IHDR + IDAT + IEND，zlib 是内置的，没有理由引依赖。
//
// 【模板里画了什么】
//   · 8×9 网格线（2px）
//   · 每行左侧的动作名与帧数（用 5×7 点阵字，避免引字体）
//   · 每行的有效帧格子打浅色底，未使用的列留白 —— 一眼看出「哪些格子要填」
//   · 每个有效帧的序号
//
// 这样用户拿到的是一张**能直接照着画**的图，而不是一张空白网格。
// ============================================================

import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

// ── 参数 ──────────────────────────────────────────────────
const COLS = 8
const ROWS = 9
/** 与 electron/pet/spriteSheet.ts 的 SPRITE_ACTIONS 保持一致 */
const ACTIONS = [
  { row: 1, id: 'idle',      frames: 6, label: 'IDLE' },
  { row: 2, id: 'run-right', frames: 8, label: 'RUN-R' },
  { row: 3, id: 'wave',      frames: 4, label: 'WAVE' },
  { row: 4, id: 'jump',      frames: 5, label: 'JUMP' },
  { row: 5, id: 'fail',      frames: 8, label: 'FAIL' },
  { row: 6, id: 'wait',      frames: 6, label: 'WAIT' },
  { row: 7, id: 'work',      frames: 8, label: 'WORK' },
  { row: 8, id: 'look-up',   frames: 8, label: 'LOOKU' },
  { row: 9, id: 'look-down', frames: 8, label: 'LOOKD' },
]

function parseArgs() {
  const a = process.argv.slice(2)
  const get = (k, d) => { const i = a.indexOf(k); return i >= 0 && a[i + 1] ? a[i + 1] : d }
  return {
    out: resolve(ROOT, get('--out', 'examples/sprites/TEMPLATE/sheet-template.png')),
    frame: Math.max(32, parseInt(get('--frame', '256'), 10) || 256),
  }
}

// ── 5×7 点阵字体（大写字母 + 数字 + 少量符号）──────────────
const FONT = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01111', '10000', '10000', '10000', '10000', '10000', '01111'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  G: ['01111', '10000', '10000', '10111', '10001', '10001', '01111'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
  J: ['00111', '00010', '00010', '00010', '00010', '10010', '01100'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  W: ['10001', '10001', '10001', '10101', '10101', '11011', '10001'],
  X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
  0: ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  2: ['01110', '10001', '00001', '00110', '01000', '10000', '11111'],
  3: ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
  4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  5: ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  6: ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  9: ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
  '.': ['00000', '00000', '00000', '00000', '00000', '01100', '01100'],
  '/': ['00001', '00010', '00010', '00100', '01000', '01000', '10000'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
}

// ── 画布 ──────────────────────────────────────────────────
class Canvas {
  constructor(w, h, bg = [255, 255, 255]) {
    this.w = w; this.h = h
    this.data = new Uint8Array(w * h * 3)
    for (let i = 0; i < w * h; i++) {
      this.data[i * 3] = bg[0]
      this.data[i * 3 + 1] = bg[1]
      this.data[i * 3 + 2] = bg[2]
    }
  }
  set(x, y, c) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) {return}
    const i = (y * this.w + x) * 3
    this.data[i] = c[0]; this.data[i + 1] = c[1]; this.data[i + 2] = c[2]
  }
  rect(x, y, w, h, c) {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.set(x + i, y + j, c)
  }
  frame(x, y, w, h, c, t = 1) {
    this.rect(x, y, w, t, c); this.rect(x, y + h - t, w, t, c)
    this.rect(x, y, t, h, c); this.rect(x + w - t, y, t, h, c)
  }
  text(s, x, y, c, scale = 2) {
    let cx = x
    for (const ch of s.toUpperCase()) {
      const g = FONT[ch] || FONT[' ']
      for (let r = 0; r < 7; r++) for (let q = 0; q < 5; q++) {
        if (g[r][q] === '1') this.rect(cx + q * scale, y + r * scale, scale, scale, c)
      }
      cx += 6 * scale
    }
  }
}

// ── PNG 编码（零依赖）─────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}

function encodePng(cv) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(cv.w, 0)
  ihdr.writeUInt32BE(cv.h, 4)
  ihdr[8] = 8    // bit depth
  ihdr[9] = 2    // color type: truecolor RGB
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0

  // 每行前面加一个 filter byte（0 = None）
  const stride = cv.w * 3
  const raw = Buffer.alloc((stride + 1) * cv.h)
  for (let y = 0; y < cv.h; y++) {
    raw[y * (stride + 1)] = 0
    Buffer.from(cv.data.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1)
  }
  const idat = deflateSync(raw, { level: 9 })

  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))])
}

// ── 主流程 ────────────────────────────────────────────────
function build(frame) {
  const W = COLS * frame
  const H = ROWS * frame
  const cv = new Canvas(W, H, [255, 255, 255])

  const GRID = [200, 200, 210]
  const USED = [236, 240, 250]      // 有效帧的浅底色
  const UNUSED = [250, 250, 250]    // 未使用列
  const BORDER = [120, 120, 140]
  const TEXT = [90, 90, 110]

  // 逐行铺底色
  for (const a of ACTIONS) {
    const y0 = (a.row - 1) * frame
    for (let c = 0; c < COLS; c++) {
      const x0 = c * frame
      cv.rect(x0, y0, frame, frame, c < a.frames ? USED : UNUSED)
    }
  }

  // 网格线
  const lw = Math.max(1, Math.round(frame / 128))
  for (let c = 0; c <= COLS; c++) cv.rect(c * frame - lw / 2, 0, lw, H, GRID)
  for (let r = 0; r <= ROWS; r++) cv.rect(0, r * frame - lw / 2, W, lw, GRID)
  for (let c = 0; c <= COLS; c++) cv.rect(c * frame - 1, 0, 2, H, BORDER)
  for (let r = 0; r <= ROWS; r++) cv.rect(0, r * frame - 1, W, 2, BORDER)

  // 行首标签 + 帧序号
  // ⚠️ 标签画在第一格里，所以第 1 帧的序号会重叠 —— 这里直接跳过 index 0 的序号，
  //    否则用户看到「IDLE」压着一个「1」，反而不知道那格子是干嘛的。
  const scale = Math.max(1, Math.round(frame / 64))
  const pad = Math.max(4, 6 * scale)
  for (const a of ACTIONS) {
    const y0 = (a.row - 1) * frame
    cv.text(a.label, pad + 4 * scale, y0 + 10 * scale, TEXT, scale)
    cv.text(String(a.frames), pad + 4 * scale, y0 + 20 * scale, TEXT, scale)
    for (let i = 1; i < a.frames; i++) {
      cv.text(String(i + 1), i * frame + pad, y0 + 6 * scale, TEXT, scale)
    }
  }

  return encodePng(cv)
}

const { out, frame } = parseArgs()
const png = build(frame)
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, png)
console.log(`✔ 精灵表模板已生成: ${out}`)
console.log(`  尺寸 ${COLS * frame}×${ROWS * frame}（单帧 ${frame}×${frame}，${COLS} 列 × ${ROWS} 行）`)
console.log(`  共 ${ACTIONS.reduce((n, a) => n + a.frames, 0)} 个有效帧；未使用的格子为浅灰，不需要画。`)
console.log(`  画完后在 Lumina 里「设置 → 形象 → 导入」选 spritesheet 即可。`)
