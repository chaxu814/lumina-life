// ============================================================
// tests/fixtures/artifacts/generate.mjs
//
// 一次性生成二进制示例产物（纯 Node 内置模块，无外部依赖）：
//   - sample-image.png  800x600 渐变 PNG（手写 PNG 结构 + zlib 压缩）
//   - sample-unknown.bin 1KB 随机二进制（crypto.randomBytes）
//   - sample.pdf         最小有效 PDF，含一页文字 "Lumina PDF Preview"
//
// 用法：node tests/fixtures/artifacts/generate.mjs
// ============================================================

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const outDir = __dirname

// ── 工具：写入大端无符号 32 位整数 ──
function u32(n) {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(n >>> 0, 0)
  return b
}
// PNG CRC32 表
const crcTable = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()
function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}
function chunk(type, data) {
  const len = u32(data.length)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = u32(crc32(Buffer.concat([typeBuf, data])))
  return Buffer.concat([len, typeBuf, data, crc])
}

// ── 1. 生成 800x600 渐变 PNG ──
function makePng() {
  const W = 800, H = 600
  // 原始扫描线：每行前加 filter byte 0
  const raw = Buffer.alloc(H * (1 + W * 3))
  let off = 0
  for (let y = 0; y < H; y++) {
    raw[off++] = 0 // filter: none
    for (let x = 0; x < W; x++) {
      // 水平蓝紫渐变 + 垂直亮度
      const r = Math.round(59 + (x / W) * 150)
      const g = Math.round(130 + (y / H) * 60)
      const b = Math.round(246 - (x / W) * 120)
      raw[off++] = r; raw[off++] = g; raw[off++] = b
    }
  }
  const idat = zlib.deflateSync(raw, { level: 9 })
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(W, 0)
  ihdr.writeUInt32BE(H, 4)
  ihdr[8] = 8  // bit depth
  ihdr[9] = 2  // color type: truecolor RGB
  ihdr[10] = 0 // compression
  ihdr[11] = 0 // filter
  ihdr[12] = 0 // interlace
  const png = Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ])
  fs.writeFileSync(path.join(outDir, 'sample-image.png'), png)
  console.log(`✓ sample-image.png  ${png.length} bytes  ${W}x${H}`)
}

// ── 2. 生成 1KB 随机二进制 ──
function makeBin() {
  const buf = crypto.randomBytes(1024)
  fs.writeFileSync(path.join(outDir, 'sample-unknown.bin'), buf)
  console.log(`✓ sample-unknown.bin  ${buf.length} bytes`)
}

// ── 3. 生成最小有效 PDF（一页文字） ──
function makePdf() {
  // 手写 PDF 结构：1=Catalog, 2=Pages, 3=Page, 4=Font, 5=Contents
  const text = 'Lumina PDF Preview'
  const contentStream = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET`
  const objs = []
  objs[1] = `1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`
  objs[2] = `2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n`
  objs[3] = `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n`
  objs[4] = `4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`
  objs[5] = `5 0 obj\n<< /Length ${contentStream.length} >>\nstream\n${contentStream}\nendstream\nendobj\n`

  let body = '%PDF-1.4\n'
  const offsets = [0]
  for (let i = 1; i <= 5; i++) {
    offsets.push(Buffer.byteLength(body, 'ascii'))
    body += objs[i]
  }
  const xrefPos = Buffer.byteLength(body, 'ascii')
  let xref = `xref\n0 6\n0000000000 65535 f \n`
  for (let i = 1; i <= 5; i++) {
    xref += String(offsets[i]).padStart(10, '0') + ' 00000 n \n'
  }
  const trailer = `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`
  const pdf = Buffer.from(body + xref + trailer, 'ascii')
  fs.writeFileSync(path.join(outDir, 'sample.pdf'), pdf)
  console.log(`✓ sample.pdf  ${pdf.length} bytes`)
}

makePng()
makeBin()
makePdf()
console.log('全部二进制示例生成完成 →', outDir)
