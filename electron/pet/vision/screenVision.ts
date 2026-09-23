// ============================================================
// pet/vision/screenVision.ts — 👁 真·屏幕视觉理解（v6.2 恢复）
//
// 背景：
//   v6.1 为了省 token，把"截图问 VLM"注释掉了，只保留窗口标题粗分类——
//   她只知道主人在"打游戏"，不知道在打《原神》还是《CS2》，体感很"木"。
//   本模块把眼睛接回来，但不退回"每帧截图整张丢 VLM"的老路：
//
//     活动窗口(detectScene) → 截图(captureScreenBuffer)
//       → dHash 帧差节流(decideScreenCapture，稳定画面不花钱)
//       → 画面真的变了才问 VLM：一句话描述屏幕具体内容 + 值不值得搭话
//       → 任何失败（纯文本模型/无 Key/截图失败）安全降级到窗口标题
//
// 纯视觉描述只在这里发生；要不要开口、说什么、做什么表情，
// 仍由上层 proactive/orchestrator 统一门控与生成，避免双路径抢话。
// ============================================================

import { nativeImage } from 'electron'
import { captureScreenBuffer, callVisionModel } from '../../tools/impl/cuCore'
import { detectScene } from '../../sceneDetector'
import { decideScreenCapture } from '../lifeServices'
import type { SceneKind } from './screenAwareness'

const SCENE_CN: Record<SceneKind, string> = {
  game: '玩游戏', video: '看视频', code: '写代码',
  doc: '看文档/网页', social: '社交聊天', idle: '发呆/桌面', other: '用电脑',
}

export interface ScreenVisionResult {
  /** 是否真的发起了 VLM 调用（画面稳定=false，省钱） */
  captured: boolean
  /** 场景粗分类（来自窗口标题 dHash 门控，权威） */
  scene: SceneKind
  /** 活动窗口标题（可能为空） */
  windowTitle?: string
  /** 活动窗口进程名（可能为空） */
  processName?: string
  /** 屏幕上「具体在做什么」的一句话（真看到了内容；未问 VLM 时退化为场景中文） */
  detail: string
  /** VLM 主观判断：值不值得她主动搭话 0~1（精彩/有趣/遇到问题偏高；重复操作/纯桌面偏低） */
  worthComment: number
  /** 是否真的「看见」了屏幕内容（true=VLM 有效返回；false=降级到窗口标题/场景） */
  saw: boolean
  /** 帧差变化量 0~1（稳定画面≈0，切场景≈1） */
  change: number
}

/** 稳定画面 / 未问 VLM 时的空结果 */
function staleResult(scene: SceneKind, change: number, windowTitle?: string, processName?: string): ScreenVisionResult {
  return {
    captured: false, scene, windowTitle, processName,
    detail: `屏幕场景：${SCENE_CN[scene] || '用电脑'}`,
    worthComment: 0, saw: false, change,
  }
}

/** 降级结果：问了 VLM 但失败（纯文本模型/无 Key/网络），用窗口标题拼一句 */
function fallbackResult(scene: SceneKind, windowTitle?: string, processName?: string): ScreenVisionResult {
  const sceneCn = SCENE_CN[scene] || '用电脑'
  const title = windowTitle ? `（窗口「${String(windowTitle).slice(0, 40)}」）` : ''
  return {
    captured: true, scene, windowTitle, processName,
    detail: `主人在${sceneCn}${title}`,
    worthComment: scene === 'game' || scene === 'video' ? 0.5 : 0.3,
    saw: false, change: 1,
  }
}

const VLM_SYSTEM = [
  '你是桌宠 Lumina，正悄悄看主人的电脑屏幕。',
  '你要像真人偷瞄一眼那样，用一句话说清屏幕上「具体」在发生什么，而不是笼统的分类。',
  '要点：',
  '- 尽量认出具体的游戏名、应用名、网站名、视频/番剧名、代码语言或关键界面；',
  '- 30~55 字，客观描述你看到的内容，不要编造屏幕上没有的东西；',
  '- 同时判断这个画面值不值得你（一个陪伴型猫娘）主动凑过去说句话：',
  '  游戏精彩瞬间/翻车、有趣视频、代码报错卡住、明显摸鱼 = 高分；纯桌面、重复机械操作、隐私内容 = 低分。',
  '只输出 JSON，不要任何多余文字：{"detail":"屏幕上具体内容的一句话","worth":0.0~1.0 的数字}',
].join('\n')

/** 单次 VLM 解析结果 */
interface ParsedVision { detail: string; worth: number }

function parseVision(raw: string): ParsedVision | null {
  if (!raw) {return null}
  // 多数模型会按 JSON 模式返回；兼容被 ```json 包裹的情况
  let text = raw.trim()
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) {text = fence[1].trim()}
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) {text = text.slice(start, end + 1)}
  try {
    const obj = JSON.parse(text)
    const detail = typeof obj.detail === 'string' ? obj.detail.trim() : ''
    let worth = Number(obj.worth)
    if (!Number.isFinite(worth)) {worth = 0.4}
    worth = Math.max(0, Math.min(1, worth))
    if (detail) {return { detail: detail.slice(0, 80), worth }}
  } catch { /* 落到正则兜底 */ }
  // 正则兜底：模型没严格输出 JSON 时，把整段当 detail，worth 给中性值
  const oneLine = text.replace(/[\r\n]+/g, ' ').trim().slice(0, 80)
  if (oneLine) {return { detail: oneLine, worth: 0.4 }}
  return null
}

/**
 * 看一眼屏幕：截图 → dHash 节流 → VLM 描述。
 * 任何一步失败都安全降级，绝不抛到上层（主动引擎不能因为视觉失败而崩）。
 *
 * @param force 是否忽略 dHash 节流强制看（设置面板"立即看一眼"按钮用）
 */
export async function describeScreenViaVlm(
  force = false,
  now: number = Date.now(),
): Promise<ScreenVisionResult> {
  // 1. 读活动窗口（detectScene 内部有 30s 缓存，开销极低）
  let windowTitle: string | undefined
  let processName: string | undefined
  try {
    const si = await detectScene()
    windowTitle = si?.windowTitle || undefined
    processName = si?.processName || undefined
  } catch { /* 窗口检测失败也能继续 */ }

  // 2. 截图
  let img
  try {
    const buf = await captureScreenBuffer()
    img = nativeImage.createFromBuffer(buf)
    if (img.isEmpty()) {return staleResult('idle', 0, windowTitle, processName)}
  } catch (e) {
    console.warn('[ScreenVision] 截图失败，跳过本次视觉:', (e as Error)?.message || e)
    return staleResult('idle', 0, windowTitle, processName)
  }

  // 3. dHash 帧差节流（纯本地，零 token）
  let decision
  try {
    decision = decideScreenCapture(img, windowTitle ?? null, processName ?? null, now)
  } catch (e) {
    console.warn('[ScreenVision] 帧差节流失败，放行本次:', (e as Error)?.message || e)
    decision = { capture: true, scene: 'other' as SceneKind, change: 1, reason: 'gate_error' }
  }
  const scene: SceneKind = decision.scene || 'other'
  const change = typeof decision.change === 'number' ? decision.change : 0

  if (!force && !decision.capture) {
    // 画面稳定，不花钱问 VLM
    return staleResult(scene, change, windowTitle, processName)
  }

  // 4. 画面真的变了（或强制）→ 压缩成 JPEG 问 VLM（960px 宽、质量 70，省 token）
  let b64: string
  try {
    const resized = img.getSize().width > 960
      ? img.resize({ width: 960, quality: 'good' })
      : img
    b64 = resized.toJPEG(70).toString('base64')
  } catch (e) {
    console.warn('[ScreenVision] 截图编码失败，降级到窗口标题:', (e as Error)?.message || e)
    return fallbackResult(scene, windowTitle, processName)
  }

  const userPrompt = [
    `活动窗口标题："${windowTitle || '未知'}"`,
    `进程：${processName || '未知'}`,
    `粗分类场景：${SCENE_CN[scene] || '用电脑'}`,
    '这是主人当前屏幕截图，请按系统消息要求只输出 JSON。',
  ].join('\n')

  try {
    const raw = await callVisionModel(VLM_SYSTEM, userPrompt, b64, true, 'image/jpeg')
    const parsed = parseVision(raw)
    if (parsed) {
      return {
        captured: true, saw: true, scene, windowTitle, processName,
        detail: parsed.detail, worthComment: parsed.worth, change,
      }
    }
    return fallbackResult(scene, windowTitle, processName)
  } catch (e) {
    // 纯文本模型 / 未配置 VLM / 超时：不刷屏，降级到窗口标题即可
    console.warn('[ScreenVision] VLM 视觉理解失败（可换 Qwen2.5-VL/GPT-4o/GLM-4V）:', (e as Error)?.message || e)
    return fallbackResult(scene, windowTitle, processName)
  }
}
