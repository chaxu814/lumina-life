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

export interface VrmHandle {
  setTalkLevel: (v: number) => void
  setExpression: (name: string) => void
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

  // ── 眨眼状态机 ──
  let blink = 0
  let nextBlink = 2 + Math.random() * 3
  let blinkTimer = 0
  function updateBlink(dt: number, t: number) {
    if (!vrm?.expressionManager) return
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
    if (vrm) placeAndReport(w, h, dpr)
  }

  function placeAndReport(viewW: number, viewH: number, dpr: number) {
    if (!vrm) return
    const box = new THREE.Box3().setFromObject(vrm.scene)
    const size = new THREE.Vector3()
    box.getSize(size)
    if (!size.y || !size.x) return
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
      if (disposed) return
      vrm = gltf.userData.vrm as VRM
      if (!vrm) { opts.onError?.('文件不是有效的 VRM 模型'); return }
      VRMUtils.removeUnnecessaryVertices(gltf.scene)
      // VRM 0.x 朝向修正；VRM 1.0 加载器已转正
      if ((vrm as any).meta?.specVersion?.startsWith?.('0')) VRMUtils.rotateVRM0(vrm)
      root.add(gltf.scene)
      resize()
    },
    (ev) => {
      if (ev.total > 0) opts.onProgress?.(Math.round((ev.loaded / ev.total) * 100))
    },
    (err: any) => {
      opts.onError?.(String(err?.message || err || 'VRM 加载失败'))
    },
  )

  // ── 主循环 ──
  let raf = 0
  function tick() {
    raf = requestAnimationFrame(tick)
    if (disposed) return
    const dt = Math.min(clock.getDelta(), 0.05)
    const t = clock.elapsedTime
    if (vrm) {
      // 呼吸：胸部轻微缩放（无 chest 则用 spine）
      const breath = Math.sin(t * 1.6) * 0.012 + 0.012
      const chest = vrm.humanoid?.getNormalizedBoneNode?.('chest')
      const spine = vrm.humanoid?.getNormalizedBoneNode?.('spine')
      const bone = chest || spine
      if (bone) bone.scale.set(1 + breath, 1 + breath * 0.4, 1 + breath)
      // 待机：上半身轻微左右摆动 + 头部
      root.rotation.z = Math.sin(t * 0.55) * 0.015
      const head = vrm.humanoid?.getNormalizedBoneNode?.('head')
      if (head) {
        head.rotation.y = Math.sin(t * 0.4) * 0.12
        head.rotation.x = Math.sin(t * 0.3 + 1) * 0.03
      }
      // 说话口型（aa），带衰减
      talkLevel = Math.max(0, talkLevel - dt * 2.2)
      vrm.expressionManager?.setValue('aa', talkLevel)
      // 表情（限时覆盖）
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
    },
    dispose() {
      disposed = true
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
      vrm?.scene?.traverse((o: any) => {
        if (o.geometry) o.geometry.dispose?.()
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
