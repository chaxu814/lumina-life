// ============================================================
// pet/mmd/mmdRenderer.ts — MMD 桌宠渲染器入口（安全加固 P1-4）
//
// 从 pet-mmd.html 的内联脚本抽成可 bundle 入口：
//   - three / OrbitControls / MMDLoader 由 esbuild 内联打包（assets/pet-mmd.js）
//   - IPC 只经 window.petAPI.ipc（petPreload 白名单桥），不再 require('electron')
//   - 模型文件大小检查改走主进程 'pet:models:stat'，不再 require('fs')
// ============================================================

import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { MMDLoader } from 'three/examples/jsm/loaders/MMDLoader.js'

interface PetIpcBridge {
  invoke(channel: string, ...args: unknown[]): Promise<any>
  send(channel: string, ...args: unknown[]): void
}

const ipc: PetIpcBridge | null =
  (typeof window !== 'undefined' && (window as any).petAPI && (window as any).petAPI.ipc) || null
const HAS_IPC = !!ipc

const statusEl = document.getElementById('status') as HTMLElement
const bubbleEl = document.getElementById('bubble') as HTMLElement

function setStatus(msg: string) {
  statusEl.textContent = msg
  statusEl.style.display = msg ? 'block' : 'none'
}

function say(text: string) {
  bubbleEl.textContent = text
  bubbleEl.classList.add('show')
  const bubbleAny = bubbleEl as any
  if (bubbleAny._t) clearTimeout(bubbleAny._t)
  bubbleAny._t = setTimeout(() => bubbleEl.classList.remove('show'), 2000)
}

if (HAS_IPC) {
  ipc!.invoke('pet:startup-progress', { progress: 30, stage: '初始化 MMD 渲染器…' }).catch(() => {})
}

// ── 读取当前模型路径 ──
async function getModelUrl(): Promise<string | null> {
  // 先从 query param 读
  try {
    const params = new URLSearchParams(location.search)
    const m = params.get('model')
    if (m) return decodeURIComponent(m)
  } catch (e) {}
  // 从 IPC 读
  if (HAS_IPC) {
    try {
      const cm = await ipc!.invoke('pet:models:current')
      if (cm && cm.url && cm.kind === 'mmd') return cm.url
    } catch (e) {}
  }
  return null
}

// ── three.js 初始化 ──
let renderer: THREE.WebGLRenderer
let scene: THREE.Scene
let camera: THREE.PerspectiveCamera
let mmdModel: any = null
let clock: THREE.Clock
let controls: OrbitControls | null = null

function initThree() {
  const canvas = document.getElementById('mmd') as HTMLCanvasElement
  renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.setSize(window.innerWidth, window.innerHeight)
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap

  scene = new THREE.Scene()
  // 渐变背景（透明舞台用暗色渐变）
  const bgCanvas = document.createElement('canvas')
  bgCanvas.width = 2; bgCanvas.height = 256
  const bgCtx = bgCanvas.getContext('2d')!
  const grad = bgCtx.createLinearGradient(0, 0, 0, 256)
  grad.addColorStop(0, '#2a2540')
  grad.addColorStop(1, '#1a1828')
  bgCtx.fillStyle = grad
  bgCtx.fillRect(0, 0, 2, 256)
  const bgTex = new THREE.CanvasTexture(bgCanvas)
  scene.background = bgTex

  camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 100)
  camera.position.set(0, 1.5, 5)

  // 灯光
  const ambient = new THREE.AmbientLight(0xffffff, 0.6)
  scene.add(ambient)
  const dirLight = new THREE.DirectionalLight(0xffffff, 1.2)
  dirLight.position.set(3, 5, 4)
  dirLight.castShadow = true
  dirLight.shadow.mapSize.set(1024, 1024)
  scene.add(dirLight)

  // 地面阴影
  const groundGeo = new THREE.PlaneGeometry(20, 20)
  const groundMat = new THREE.ShadowMaterial({ opacity: 0.3 })
  const ground = new THREE.Mesh(groundGeo, groundMat)
  ground.rotation.x = -Math.PI / 2
  ground.position.y = 0
  ground.receiveShadow = true
  scene.add(ground)

  clock = new THREE.Clock()

  // OrbitControls
  try {
    controls = new OrbitControls(camera, canvas)
    controls.target.set(0, 1.0, 0)
    controls.enableDamping = true
    controls.dampingFactor = 0.05
    controls.minDistance = 2
    controls.maxDistance = 15
  } catch (e) { console.warn('OrbitControls 加载失败:', e) }

  window.addEventListener('resize', onResize)
  animate()
}

function onResize() {
  if (!renderer || !camera) return
  camera.aspect = window.innerWidth / window.innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(window.innerWidth, window.innerHeight)
}

function animate() {
  requestAnimationFrame(animate)
  const delta = clock ? clock.getDelta() : 0.016
  if (mmdModel) {
    // MMD 骨骼动画更新
    if (mmdModel.mixer) mmdModel.mixer.update(delta)
    if (mmdModel.skeleton) mmdModel.skeleton.update()
  }
  if (controls) controls.update()
  renderer.render(scene, camera)
}

// ── 加载 MMD 模型 ──
async function loadMMDModel(url: string | null) {
  if (!url) {
    setStatus('未找到 MMD 模型文件。\n请通过设置面板导入 .pmx 模型后重新切换。\n（MMD 支持为 beta，暂不内置示例模型）')
    return
  }

  // 检查文件大小（>50MB 提示）—— 由主进程 pet:models:stat 代查（不再 require('fs')）
  try {
    const r = HAS_IPC ? await ipc!.invoke('pet:models:stat', url) : null
    if (r && r.ok && typeof r.size === 'number' && r.size > 50 * 1024 * 1024) {
      setStatus(`模型较大 (${(r.size / 1024 / 1024).toFixed(1)}MB)，可能卡顿…`)
    }
  } catch (e) { /* 大小检查失败不阻断 */ }

  setStatus('正在加载 MMD 模型…')
  try {
    const loader = new MMDLoader()

    loader.load(url, async (mesh) => {
      // 清理旧模型
      if (mmdModel) {
        scene.remove(mmdModel)
        mmdModel = null
      }
      mmdModel = mesh
      mesh.position.y = 0
      mesh.scale.set(0.08, 0.08, 0.08) // MMD 模型默认很大，缩小到合适尺寸
      mesh.castShadow = true
      scene.add(mesh)

      // 添加待机动作（如果没有 VMD，就静止站立）
      if (HAS_IPC) {
        try {
          const cm = await ipc!.invoke('pet:models:current')
          // 尝试加载 manifest 中指定的 idle vmd
          if (cm && cm.entryRel) {
            // vmd 路径由 manifest 指定，这里简化处理
          }
        } catch (e) {}
      }

      setStatus('')
      say('MMD 模型加载完成 (beta)')
      if (HAS_IPC) ipc!.invoke('pet:startup-progress', { progress: 100, stage: 'MMD 就绪' }).catch(() => {})
    }, (xhr) => {
      if (xhr.total) {
        const pct = Math.round((xhr.loaded / xhr.total) * 100)
        setStatus(`加载模型… ${pct}%`)
      }
    }, (err: unknown) => {
      console.error('MMD 加载失败:', err)
      const msg = err instanceof Error ? err.message : String(err)
      setStatus(`MMD 模型加载失败: ${msg.slice(0, 100)}\n请确认模型为 .pmx 格式（.pmd 暂不支持）`)
      if (HAS_IPC) ipc!.send('pet:model-load-failed', { error: String(err) })
    })
  } catch (e: any) {
    console.error('MMDLoader 初始化失败:', e)
    setStatus(`MMD 渲染器初始化失败: ${e.message}\n请确认 three.js MMDLoader 可用`)
  }
}

// ── 启动 ──
;(async function boot() {
  try {
    initThree()
    const modelUrl = await getModelUrl()
    await loadMMDModel(modelUrl)
  } catch (e: any) {
    console.error('MMD 启动失败:', e)
    setStatus(`MMD 启动失败: ${e.message}`)
  }
})()
