// ============================================================
// pet/vrm/vrmRenderer.ts — VRM 3D 桌宠渲染器（three.js + @pixiv/three-vrm）
//
// 以 IIFE 打包成 assets/pet-vrm.js（全局名 LuminaVRM），由 pet-vrm.html 调用。
// 透明背景、正交相机（1 world unit = 1 CSS px，便于和 setShape 矩形对齐），
// 自带：眨眼（状态机）、呼吸、待机体摇摆、说话口型（aa）、基础表情。
// ============================================================

import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { VRMLoaderPlugin, VRMUtils, type VRM } from '@pixiv/three-vrm'
import { centeredBottomRect, characterPixelSize, toPhysicalRect } from './vrmLayout'

export interface VrmMountOptions {
  canvas: HTMLCanvasElement
  url: string
  onBounds?: (rect: { x: number; y: number; width: number; height: number }) => void
  onProgress?: (pct: number) => void
  onReady?: (meta: { name: string; height: number; aspect: number }) => void
  onError?: (msg: string) => void
  /** 目标高度占比等布局参数（透传给纯计算） */
  layout?: { heightRatio?: number; bottomGapRatio?: number; maxWidthRatio?: number }
}

/**
 * F3：连续情绪输入（对应 emotionCore 的五维 / drives 的疲劳精力）。
 * 与 Live2D 的 PetPerformanceEngine.setMood 同源——上层把 CoreEmotion 折算成这几个标量喂进来。
 * 未配置/未开 flag 时不调用本方法，渲染器退化为旧的一次性 setExpression。
 */
export interface VrmEmotionInput {
  /** 效价 -1(极糟) ~ +1(极好) */
  valence: number
  /** 唤醒度 0~1 */
  arousal: number
  /** 焦虑 0~1 */
  anxiety: number
  /** 疲劳 0~1 */
  fatigue: number
  /** 精力 0~1（缺省时用 1-fatigue 估） */
  energy?: number
}

export interface VrmHandle {
  setTalkLevel: (v: number) => void
  setExpression: (name: string) => void
  /** F3：连续情绪驱动（平滑过渡到目标表情 + 疲劳/精力影响身体动作） */
  setEmotionCore: (s: VrmEmotionInput) => void
  dispose: () => void
}

declare global {
  interface Window { LuminaVRM?: typeof mountApi }
}

export function mountVrm(opts: VrmMountOptions): VrmHandle {
  const canvas = opts.canvas
  const renderer = new THREE.WebGLRenderer({
    canvas,
    alpha: true,
    antialias: true,
    preserveDrawingBuffer: false,
    powerPreference: 'high-performance',
  })
  renderer.setClearColor(0x000000, 0)
  renderer.outputColorSpace = THREE.SRGBColorSpace

  const scene = new THREE.Scene()
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100)
  camera.position.set(0, 0, 10)

  // 光照（VRM 用标准材质，无灯全黑）
  scene.add(new THREE.AmbientLight(0xffffff, 1.05))
  const key = new THREE.DirectionalLight(0xffffff, 1.15)
  key.position.set(1, 2, 3)
  scene.add(key)
  const fill = new THREE.DirectionalLight(0xc9d8ff, 0.5)
  fill.position.set(-2, 1, -1)
  scene.add(fill)
  const rim = new THREE.DirectionalLight(0xffffff, 0.35)
  rim.position.set(0, 1.5, -3)
  scene.add(rim)

  const root = new THREE.Object3D()
  scene.add(root)

  let vrm: VRM | null = null
  let disposed = false
  let talkLevel = 0
  let emotionOverride = ''
  let emotionUntil = 0
  const clock = new THREE.Clock()
  let bounds: { x: number; y: number; width: number; height: number } | null = null

  // ── F3：连续情绪状态（平滑逼近目标，逐帧 lerp，避免表情跳变）──
  // target：上层 setEmotionCore 给的目标；cur：当前实际 blendShape 权重（0..1）
  const clamp01 = (x: number) => Math.max(0, Math.min(1, x))
  const target = { happy: 0, sad: 0, angry: 0, surprised: 0, relaxed: 0, valence: 0, arousal: 0.4, anxiety: 0, fatigue: 0.2, energy: 0.7 }
  const cur = { happy: 0, sad: 0, angry: 0, surprised: 0, relaxed: 0 }
  // 一次性表情的「峰值」衰减：setExpression 抬到 1，随时间衰减回连续值
  const peak = { happy: 0, sad: 0, angry: 0, surprised: 0, relaxed: 0 }
  let breathPhase = 0

  /** 五维情绪 → 五个 VRM 标准 blendShape 目标（happy/sad/angry/surprised/relaxed） */
  function emotionToBlendTargets(s: VrmEmotionInput) {
    const v = Math.max(-1, Math.min(1, s.valence))
    const a = clamp01(s.arousal)
    const anx = clamp01(s.anxiety)
    const fatigue = clamp01(s.fatigue)
    return {
      happy: v > 0 ? clamp01(v) * (1 - fatigue * 0.4) : 0,
      sad: v < 0 ? clamp01(-v) : 0,
      angry: clamp01(anx * 0.55 + (v < -0.3 ? 0.35 : 0) - fatigue * 0.2),
      surprised: clamp01((a - 0.62) * 1.5),
      relaxed: clamp01((1 - a) * 0.85) * (v > -0.2 ? 1 : 0.4),
    }
  }

  // ── 眨眼状态机 ──
  let blink = 0
  let nextBlink = 2 + Math.random() * 3
  let blinkTimer = 0
  function updateBlink(dt: number, t: number) {
    if (!vrm?.expressionManager) {return}
    blinkTimer += dt
    if (blinkTimer > nextBlink) {
      // 一次眨眼 ~0.16s，用正弦在 0..1..0 间闭合
      const into = blinkTimer - nextBlink
      const dur = 0.16
      blink = into < dur ? Math.sin((into / dur) * Math.PI) : 0
      if (into > dur) { blink = 0; blinkTimer = 0; nextBlink = 2.2 + Math.random() * 3.4 }
    }
    vrm.expressionManager.setValue('blink', blink)
  }

  function resize() {
    const w = window.innerWidth
    const h = window.innerHeight
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    renderer.setPixelRatio(dpr)
    renderer.setSize(w, h, false)
    camera.left = -w / 2; camera.right = w / 2; camera.top = h / 2; camera.bottom = -h / 2
    camera.updateProjectionMatrix()
    if (vrm) {placeAndReport(w, h, dpr)}
  }

  function placeAndReport(viewW: number, viewH: number, dpr: number) {
    if (!vrm) {return}
    const box = new THREE.Box3().setFromObject(vrm.scene)
    const size = new THREE.Vector3()
    box.getSize(size)
    if (!size.y || !size.x) {return}
    const aspect = size.x / size.y
    const px = characterPixelSize(aspect, viewW, viewH, opts.layout)
    const scale = px.height / size.y
    // 把模型缩放到目标高度，再把包围盒中心移到 root 原点
    vrm.scene.scale.setScalar(scale)
    const box2 = new THREE.Box3().setFromObject(vrm.scene)
    const center = new THREE.Vector3()
    box2.getCenter(center)
    vrm.scene.position.sub(center.multiplyScalar(1))
    const rect = centeredBottomRect(px.width, px.height, viewW, viewH, opts.layout)
    root.position.set(rect.x + rect.width / 2 - viewW / 2, rect.y + rect.height / 2 - viewH / 2, 0)
    bounds = toPhysicalRect(rect, dpr)
    opts.onBounds?.(bounds)
    opts.onReady?.({ name: (vrm.meta as { name?: string; title?: string })?.name || (vrm.meta as { title?: string })?.title || 'VRM', height: px.height, aspect })
  }

  // ── 加载模型 ──
  const loader = new GLTFLoader()
  loader.register((parser) => new VRMLoaderPlugin(parser))
  loader.load(
    opts.url,
    (gltf) => {
      if (disposed) {return}
      vrm = gltf.userData.vrm as VRM
      if (!vrm) { opts.onError?.('文件不是有效的 VRM 模型'); return }
      VRMUtils.removeUnnecessaryVertices(gltf.scene)
      // VRM 0.x 朝向修正；VRM 1.0 加载器已转正
      if ((vrm as any).meta?.specVersion?.startsWith?.('0')) {VRMUtils.rotateVRM0(vrm)}
      root.add(gltf.scene)
      resize()
    },
    (ev) => {
      if (ev.total > 0) {opts.onProgress?.(Math.round((ev.loaded / ev.total) * 100))}
    },
    (err: any) => {
      opts.onError?.(String(err?.message || err || 'VRM 加载失败'))
    },
  )

  // ── 主循环 ──
  let raf = 0
  function tick() {
    raf = requestAnimationFrame(tick)
    if (disposed) {return}
    const dt = Math.min(clock.getDelta(), 0.05)
    const t = clock.elapsedTime
    if (vrm) {
      // ── F3：疲劳/精力影响身体动作 ─────────────────────
      // 呼吸：越累越慢、越深沉；精力足时更轻快
      const fatigue = target.fatigue
      const energy = target.energy ?? 1 - fatigue
      const breathRate = 1.6 * (1 - fatigue * 0.45) * (0.7 + energy * 0.5)
      breathPhase += dt * breathRate
      const breathAmp = 0.012 * (1 + fatigue * 0.6)
      const breath = Math.sin(breathPhase) * breathAmp + breathAmp
      const chest = vrm.humanoid?.getNormalizedBoneNode?.('chest')
      const spine = vrm.humanoid?.getNormalizedBoneNode?.('spine')
      const bone = chest || spine
      if (bone) {bone.scale.set(1 + breath, 1 + breath * 0.4, 1 + breath)}
      // 待机摇摆：精力低 → 幅度更小更懒；疲劳 → 头微垂
      const swayAmp = 0.015 * (0.4 + energy * 0.6)
      root.rotation.z = Math.sin(breathPhase * 0.35) * swayAmp
      const head = vrm.humanoid?.getNormalizedBoneNode?.('head')
      if (head) {
        head.rotation.y = Math.sin(breathPhase * 0.25) * 0.12 * (0.5 + energy * 0.5)
        head.rotation.x = Math.sin(breathPhase * 0.18 + 1) * 0.03 + fatigue * 0.12 // 累了低头
      }
      // 说话口型（aa），带衰减
      talkLevel = Math.max(0, talkLevel - dt * 2.2)
      vrm.expressionManager?.setValue('aa', talkLevel)

      // ── F3：连续表情平滑逼近目标 + 一次性峰值衰减 ──
      const step = Math.min(1, dt * 3.0) // 约 0.3s 收敛，自然不僵
      for (const k of ['happy', 'sad', 'angry', 'surprised', 'relaxed'] as const) {
        peak[k] = Math.max(0, peak[k] - dt * 1.4) // 一次性峰值 ~0.7s 衰减完
        cur[k] += (target[k] - cur[k]) * step
        const total = clamp01(cur[k] + peak[k])
        vrm.expressionManager?.setValue(k, total)
      }
      // 旧的限时一次性覆盖：仍兼容（开启旧路径时用）
      if (emotionOverride && t < emotionUntil) {
        vrm.expressionManager?.setValue(emotionOverride, 0.9)
      }
      updateBlink(dt, t)
      vrm.update(dt)
    }
    renderer.render(scene, camera)
  }

  window.addEventListener('resize', resize)
  resize()
  tick()

  const handle: VrmHandle = {
    setTalkLevel(v: number) { talkLevel = Math.max(0, Math.min(1, v)) },
    setExpression(name: string) {
      emotionOverride = ['happy', 'sad', 'angry', 'surprised', 'relaxed'].includes(name) ? name : ''
      emotionUntil = emotionOverride ? clock.elapsedTime + 2.2 : 0
      // 同时把对应表情的一次性峰值抬起来（连续路径开着时也能立刻看到反应）
      if (emotionOverride) { peak[emotionOverride as keyof typeof peak] = 1 }
    },
    // TODO: VRM parity with Live2D — 已做到：连续五维情绪→5 个标准 blendShape 平滑过渡、
    //       疲劳/精力→呼吸频率与幅度、头微垂、待机摇摆幅度；一次性 setExpression 保留为峰值。
    //       还差：Live2D 的五元音口型(A/I/U/E/O)、视线跟随(focus/gaze)、分层动作混合器
    //       (gaze/action 层)、brow/cheek 等细粒度面部通道。VRM 模型自带的表情就这 5 个预设，
    //       细粒度只能靠模型自带 blendShape，暂不做自动发现。
    setEmotionCore(s: VrmEmotionInput) {
      const tgt = emotionToBlendTargets(s)
      target.happy = tgt.happy
      target.sad = tgt.sad
      target.angry = tgt.angry
      target.surprised = tgt.surprised
      target.relaxed = tgt.relaxed
      target.valence = Math.max(-1, Math.min(1, s.valence))
      target.arousal = clamp01(s.arousal)
      target.anxiety = clamp01(s.anxiety)
      target.fatigue = clamp01(s.fatigue)
      target.energy = s.energy === undefined ? 1 - clamp01(s.fatigue) : clamp01(s.energy)
    },
    dispose() {
      disposed = true
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
      vrm?.scene?.traverse((o: any) => {
        if (o.geometry) {o.geometry.dispose?.()}
        if (o.material) {
          const mats = Array.isArray(o.material) ? o.material : [o.material]
          mats.forEach((m: any) => m.dispose?.())
        }
      })
      renderer.dispose()
    },
  }
  return handle
}

// 暴露给 IIFE 全局
export const mountApi = {
  mount(opts: VrmMountOptions): VrmHandle { return mountVrm(opts) },
}
if (typeof window !== 'undefined') {
  window.LuminaVRM = mountApi as typeof mountApi
}
