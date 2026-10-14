// ============================================================
// cuVerify.ts — Computer Use 动作后验证 (v3.20, 同类工程实践：动作后验证)
//
// 同类项目在每个写入动作后会截图比对：预期画面变化却没有变化 → 判定动作
// 可能未命中（点到空白、按钮被遮挡、目标没响应），要求 agent 重新看屏幕。
//
// 本模块用 dHash（9×8 灰度相邻亮度比较）量化前后两帧的差异，纯函数可单测；
// 截图解码用 Electron nativeImage（零新依赖，与 pet/lifeServices 同一套做法）。
// ============================================================

import { nativeImage } from 'electron'
import { dhash, hammingDistance } from '../../pet/vision/screenAwareness'

export const DHASH_W = 9
export const DHASH_H = 8

/** 从 BGRA/RGBA 原始像素（每像素 4 字节）取灰度数组 */
export function grayFromBmp(bmp: Buffer, w: number, h: number): number[] {
  const n = w * h
  const gray: number[] = new Array(n)
  for (let i = 0; i < n; i++) {
    const o = i * 4
    gray[i] = (bmp[o] + bmp[o + 1] + bmp[o + 2]) / 3
  }
  return gray
}

/** 对任意尺寸的 PNG/JPEG 截图算 dHash（64bit） */
export function computeDhashFromImage(buffer: Buffer): boolean[] {
  const img = nativeImage.createFromBuffer(buffer)
  if (img.isEmpty()) {throw new Error('截图为空，无法计算 dHash')}
  const small = img.resize({ width: DHASH_W, height: DHASH_H, quality: 'good' })
  // 🔧 2026-10-10：`getBitmap()` 已废弃（会刷 DeprecationWarning），改用 `toBitmap()`
  const bmp = small.toBitmap()
  const gray = grayFromBmp(bmp, DHASH_W, DHASH_H)
  return dhash(gray, DHASH_W, DHASH_H)
}

/** 两帧差异分数（0~1，越大变化越明显） */
export function changeScoreBetween(a: boolean[], b: boolean[]): number {
  if (a.length === 0 || b.length === 0) {return 1}
  return hammingDistance(a, b) / Math.max(a.length, b.length)
}

export interface VerifyResult {
  /** 动作是否引起了画面变化（或无法判定时按通过处理） */
  changed: boolean
  /** 0~1 差异分数 */
  score: number
  /** 判定阈值 */
  threshold: number
  /** 给 agent 的中文提示（未变化时非空） */
  hint: string
}

/**
 * 动作前后验证（纯函数）。
 *
 * @param before    动作前 dHash
 * @param after     动作后 dHash
 * @param threshold 低于该分数判为「无变化」
 */
export function verifyChange(
  before: boolean[],
  after: boolean[],
  threshold: number,
): VerifyResult {
  const score = changeScoreBetween(before, after)
  const changed = score > threshold
  return {
    changed,
    score,
    threshold,
    hint: changed
      ? ''
      : '⚠️ 动作后画面无变化（dHash 差异分数 ' + score.toFixed(3) + '），可能未命中目标或目标未响应。请先 desktop_see 重新观察屏幕，确认目标位置/状态后再决定下一步。',
  }
}
