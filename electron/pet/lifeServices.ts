// ============================================================
// pet/lifeServices.ts — 🔌 v0.2 生命感服务装配（主进程接线层）
//
// 把已单测覆盖的纯逻辑模块与 Electron 能力桥接起来，对渲染页暴露 IPC：
//   📚 模型库：pet:models:list / current / select / remove / import（UGC 闭环）
//   👁 屏幕节流：decideScreenCapture()（dHash 帧差，稳定画面不花钱问 VLM）
//      + rememberScreenEpisode()（把看到的情节写回长期记忆）
//   📷 在场隐私：pet:presence:status/authorize/sample-tick/detection（默认关、显式授权、仅本地）
//   🎙 唤醒词：pet:wake:status/enable/feed（STT 文本门控，本地热词模型留适配点）
//   🗣 全双工：pet:live-speech:event（VAD/STT/TTS 管线以事件注入，复用 LiveSpeechDirector）
//
// 边界（需真实硬件/在线模型，已留注入适配点）：
//   - 摄像头采集与「人脸检测」结果由渲染页/未来本地模型通过 detection 事件喂入；
//   - 流式 STT partial、TTS 播放完成由语音管线通过 live-speech:event 喂入；
//   - 本文件只负责状态机、持久化、安全门控与 IPC，不绑定具体供应商。
// 纯逻辑均可在 lifeServices 之外单测；此处仅做薄接线，任何失败都安全降级、不阻塞桌宠。
// ============================================================

import { app, ipcMain, dialog, BrowserWindow, type NativeImage } from 'electron'
import { promises as fsp, readFileSync, writeFileSync, mkdirSync } from 'fs'
import path from 'path'
import { pathToFileURL } from 'url'

import { ModelLibrary, type ModelEntry } from './modelLibrary'
import { importLive2dModel, type ModelImporterFs } from './modelImporter'
import { ScreenAwareness, type CaptureDecision, type SceneKind } from './vision/screenAwareness'
import { PresenceMonitor, type DetectionResult } from './vision/presence'
import { WakeWordGate } from '../whisper/wakeWord'
import { LiveSpeechDirector, type DirectorAction } from './lifeSpeech/liveSpeechDirector'
import { recordObservedEpisode } from './petMemoryBridge'
import { getMemoryStore } from '../memory/memoryStore'

// ═══════════════════════════════════════════════════════════
// 单例
// ═══════════════════════════════════════════════════════════

let screenGate: ScreenAwareness | null = null
let presence: PresenceMonitor | null = null
let wake: WakeWordGate | null = null
let director: LiveSpeechDirector | null = null
let library: ModelLibrary | null = null

export function getScreenGate(): ScreenAwareness {
  if (!screenGate) {screenGate = new ScreenAwareness()}
  return screenGate
}
export function getPresence(): PresenceMonitor {
  if (!presence) {presence = new PresenceMonitor({ localOnly: true })}
  return presence
}
export function getWakeGate(): WakeWordGate {
  if (!wake) {wake = new WakeWordGate({ enabled: false })}
  return wake
}
export function getLiveDirector(): LiveSpeechDirector {
  if (!director) {director = new LiveSpeechDirector()}
  return director
}

// ═══════════════════════════════════════════════════════════
// 📚 模型库持久化 + UGC 导入
// ═══════════════════════════════════════════════════════════

function modelsRoot(): string {
  return path.join(app.getPath('userData'), 'pet-models')
}
function libraryJsonPath(): string {
  return path.join(app.getPath('userData'), 'pet-model-library.json')
}

function loadLibrary(): ModelLibrary {
  if (library) {return library}
  let data: unknown = null
  try {
    data = JSON.parse(readFileSync(libraryJsonPath(), 'utf8'))
  } catch { /* 首次运行无清单文件 */ }
  library = ModelLibrary.deserialize(data)
  return library
}

function saveLibrary(): boolean {
  if (!library) {return false}
  try {
    mkdirSync(path.dirname(libraryJsonPath()), { recursive: true })
    writeFileSync(libraryJsonPath(), JSON.stringify(library.serialize(), null, 2), 'utf8')
  } catch (e) {
    console.warn('[LifeServices] 模型库持久化失败:', (e as Error)?.message || e)
    return false
  }
  return true
}

const nodeFs: ModelImporterFs = {
  readText: async p => await fsp.readFile(p, 'utf8'),
  fileExists: async p => { try { await fsp.access(p); return true } catch { return false } },
  ensureDir: async p => { await fsp.mkdir(p, { recursive: true }) },
  copyFile: async (from, to) => {
    await fsp.mkdir(path.dirname(to), { recursive: true })
    await fsp.copyFile(from, to)
  },
}

/** 模型条目 → 渲染页可直接喂给 Live2DModel.from 的定位符 */
function modelUrl(e: ModelEntry): string {
  if (e.builtin) {return 'assets/' + e.entryRel.replace(/^\/+/, '')}
  return pathToFileURL(path.join(modelsRoot(), e.entryRel)).href
}
function modelDto(e: ModelEntry) {
  return { id: e.id, name: e.name, builtin: e.builtin, hasFiveVowel: !!e.hasFiveVowel, kind: e.kind || 'live2d', url: modelUrl(e) }
}

// ═══════════════════════════════════════════════════════════
// 👁 屏幕节流决策 + 视觉情节记忆
// ═══════════════════════════════════════════════════════════

const SCENE_CN: Record<SceneKind, string> = {
  game: '玩游戏', video: '看视频', code: '写代码',
  doc: '看文档/网页', social: '社交聊天', idle: '发呆/桌面', other: '用电脑',
}

/**
 * 喂入一帧屏幕缩略图 + 当前活动窗口，返回是否值得截图问 VLM。
 * 稳定画面 / 未到间隔 → capture:false（省 token、省电）。
 */
export function decideScreenCapture(
  img: NativeImage,
  windowTitle?: string | null,
  appName?: string | null,
  now: number = Date.now(),
): CaptureDecision {
  const gate = getScreenGate()
  try {
    const small = img.resize({ width: 16, height: 16, quality: 'good' })
    // Electron 40 的 d.ts 把 getBitmap 误标为 void，运行时实际返回原始像素 Buffer（每像素 4 字节，BGRA/RGBA，帧差对通道顺序不敏感）
    const bmp = small.getBitmap() as unknown as Buffer
    const gray: number[] = new Array(256)
    for (let i = 0; i < 256; i++) {
      const o = i * 4
      gray[i] = (bmp[o] + bmp[o + 1] + bmp[o + 2]) / 3
    }
    gate.noteFrame(gray, 16, 16, now)
  } catch (e) {
    console.warn('[LifeServices] 屏幕 dHash 计算失败，放行本次感知:', (e as Error)?.message || e)
  }
  gate.noteWindow(windowTitle, appName)
  return gate.decide(now)
}

/** 把「看到用户在做什么」写回长期记忆（视觉情节记忆） */
export function rememberScreenEpisode(scene: SceneKind, windowTitle?: string | null, reaction?: string): boolean {
  try {
    const parts: string[] = [`看到用户在${SCENE_CN[scene] || '用电脑'}`]
    if (windowTitle) {parts.push(`活动窗口「${String(windowTitle).slice(0, 60)}」`)}
    if (reaction) {parts.push(`Lumina 当时的反应：${String(reaction).slice(0, 60)}`)}
    return recordObservedEpisode(getMemoryStore(), parts.join('，'), 0.5)
  } catch { return false }
}

// ═══════════════════════════════════════════════════════════
// IPC 注册
// ═══════════════════════════════════════════════════════════

let registered = false

export function registerLifeServicesIpc(): void {
  if (registered) {return}
  registered = true

  // ── 📚 模型库 ──────────────────────────────────────────
  ipcMain.handle('pet:models:list', () => {
    try { return { ok: true, models: loadLibrary().list().map(modelDto), current: modelDto(loadLibrary().current()) } }
    catch (e: any) { return { ok: false, error: String(e?.message || e) } }
  })

  ipcMain.handle('pet:models:current', () => {
    try { return modelDto(loadLibrary().current()) }
    catch (e: any) { // 任何异常都回退内置 Mao，保证桌宠永远能加载
      return { id: 'Mao', name: 'Mao（魔法使）', builtin: true, hasFiveVowel: true, url: 'assets/Mao/mao_pro.model3.json' }
    }
  })

  ipcMain.handle('pet:models:select', (_e, params: { id: string }) => {
    try {
      const lib = loadLibrary()
      if (!lib.select(params?.id)) {return { ok: false, error: '模型不存在' }}
      saveLibrary()
      return { ok: true, current: modelDto(lib.current()) }
    } catch (e: any) { return { ok: false, error: String(e?.message || e) } }
  })

  ipcMain.handle('pet:models:remove', (_e, params: { id: string }) => {
    try {
      const lib = loadLibrary()
      const ok = lib.remove(params?.id)
      if (ok) {saveLibrary()}
      return { ok, models: lib.list().map(modelDto), current: modelDto(lib.current()) }
    } catch (e: any) { return { ok: false, error: String(e?.message || e) } }
  })

  // 从本地文件夹安全导入一个 Live2D 模型（校验 → 复制进 userData → 注册）
  ipcMain.handle('pet:models:import', async () => {
    try {
      const parent = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || undefined
      const dlg = await dialog.showOpenDialog(parent as BrowserWindow, {
        title: '选择 Live2D 模型入口文件（.model3.json）',
        filters: [{ name: 'Live2D model3', extensions: ['json'] }],
        properties: ['openFile'],
      })
      if (dlg.canceled || !dlg.filePaths[0]) {return { ok: false, canceled: true }}

      const file = dlg.filePaths[0]
      if (!/\.model3\.json$/i.test(file)) {return { ok: false, error: '请选择 *.model3.json 入口文件' }}
      const srcDir = path.dirname(file)
      const entryFile = path.basename(file)
      const suggestedName = path.basename(srcDir)
      const destRoot = modelsRoot()

      const plan = await importLive2dModel(srcDir, entryFile, destRoot, suggestedName, nodeFs)
      // 库内 entryRel 相对模型根 destRoot：<消毒后模型名>/<入口>
      const relEntry = `${plan.modelName}/${plan.entryRel}`.replace(/\\/g, '/')
      const lib = loadLibrary()
      const reg = lib.register({ name: suggestedName, entryRel: relEntry, hasFiveVowel: false }, Date.now())
      if (!reg.ok) {return { ok: false, error: reg.error || '模型注册失败' }}
      saveLibrary()
      return { ok: true, model: modelDto(lib.get(reg.id!)!), fileCount: plan.fileCount }
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e) }
    }
  })

  // 从本地安全导入一个 VRM 3D 模型（单个 .vrm 文件 → 复制进 userData → 注册 kind=vrm）
  ipcMain.handle('pet:models:import-vrm', async () => {
    try {
      const parent = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || undefined
      const dlg = await dialog.showOpenDialog(parent as BrowserWindow, {
        title: '选择 VRM 3D 模型（.vrm）',
        filters: [{ name: 'VRM', extensions: ['vrm'] }],
        properties: ['openFile'],
      })
      if (dlg.canceled || !dlg.filePaths[0]) {return { ok: false, canceled: true }}
      const file = dlg.filePaths[0]
      if (!/\.vrm$/i.test(file)) {return { ok: false, error: '请选择 *.vrm 模型文件' }}

      const baseName = path.basename(file).replace(/\.vrm$/i, '')
      // 安全目录名：仅保留字母数字下划线连字符中文
      const safeName = (baseName.replace(/[^w\u4e00-\u9fa5\-]+/g, '_') || 'vrm_model').slice(0, 48)
      const destRoot = modelsRoot()
      const destDir = path.join(destRoot, safeName)
      await fsp.mkdir(destDir, { recursive: true })
      const destFile = path.join(destDir, baseName + '.vrm')
      await fsp.copyFile(file, destFile)

      const entryRel = (safeName + '/' + baseName + '.vrm').replace(/\\/g, '/')
      const lib = loadLibrary()
      const reg = lib.register({ name: baseName, entryRel, kind: 'vrm' }, Date.now())
      if (!reg.ok) {return { ok: false, error: reg.error || '模型注册失败' }}
      saveLibrary()
      return { ok: true, model: modelDto(lib.get(reg.id!)!) }
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e) }
    }
  })

  // ── 📷 摄像头在场（隐私优先状态机；采集/人脸检测结果由渲染层喂入）──
  ipcMain.handle('pet:presence:status', () => {
    const m = getPresence()
    const now = Date.now()
    return {
      authorized: m.isAuthorized, state: m.state, indicatorOn: m.indicatorOn,
      present: m.isUserPresent(now), lookingAt: m.isLookingAt(now), expression: m.expression,
    }
  })
  ipcMain.handle('pet:presence:authorize', (_e, params: { on: boolean }) => {
    const m = getPresence()
    const now = Date.now()
    if (params?.on) { m.authorize(); m.enable(now) } else { m.revoke(); m.disable() }
    return { authorized: m.isAuthorized, state: m.state, indicatorOn: m.indicatorOn }
  })
  ipcMain.handle('pet:presence:sample-tick', () => {
    const m = getPresence()
    const now = Date.now()
    return { shouldSample: m.shouldSample(now), indicatorOn: m.indicatorOn, state: m.state }
  })
  ipcMain.handle('pet:presence:detection', (_e, r: DetectionResult) => {
    const m = getPresence()
    const now = Date.now()
    const accepted = m.feedDetection(r, now)
    if (accepted) {m.markSampled(now)}
    return { accepted, present: m.isUserPresent(now), lookingAt: m.isLookingAt(now), expression: m.expression }
  })

  // ── 🎙 唤醒词门控（STT 文本）──────────────────────────
  ipcMain.handle('pet:wake:status', () => ({ enabled: getWakeGate().enabled }))
  ipcMain.handle('pet:wake:enable', (_e, params: { on: boolean }) => {
    const g = getWakeGate()
    g.setEnabled(!!params?.on)
    return { enabled: g.enabled }
  })
  ipcMain.handle('pet:wake:feed', (_e, params: { text: string }) => {
    const g = getWakeGate()
    const text = String(params?.text || '')
    if (!g.enabled) {return { process: true, keyword: null, sessionActive: false }}
    const process = g.shouldProcess(text, Date.now())
    return { process, keyword: g.matchKeyword(text), sessionActive: g.isSessionActive(Date.now()) }
  })

  // ── 🗣 全双工语音导演（语音管线以事件注入，复用已测状态机）─────
  ipcMain.handle('pet:live-speech:event', (_e, params: { type: string; text?: string; generation?: number }) => {
    const d = getLiveDirector()
    let actions: DirectorAction[] = []
    try {
      switch (params?.type) {
        case 'user_start': actions = d.userSpeechStart(); break
        case 'user_utterance': actions = d.userUtterance(String(params.text || '')); break
        case 'assistant_chunk': actions = d.assistantChunk(String(params.text || ''), params.generation); break
        case 'assistant_end': actions = d.assistantEnd(params.generation); break
        case 'sentence_spoken': actions = d.sentenceSpoken(); break
        case 'reset': d.reset(); actions = []; break
        default: break
      }
    } catch (e) {
      console.warn('[LifeServices] live-speech event 失败:', (e as Error)?.message || e)
    }
    return { ok: true, actions, generation: d.currentGeneration, queueSize: d.queueSize }
  })

  // ── 🎙 本地 Whisper 切句兜底（Web Speech 不可用/网络不通时的离线 STT）─
  // 渲染层把 VAD 切出的一句话编码成 16k 单声道 WAV(base64) 喂进来；
  // @xenova/transformers 是可选依赖（首次自动下载 whisper-base 多语模型），
  // 未安装时返回 missingDependency=true，由 UI 给出引导，绝不阻塞主链路。
  ipcMain.handle('pet:transcribe-utterance', async (_e, params: { audioBase64?: string; model?: string }) => {
    let wavPath = ''
    try {
      const b64 = String(params?.audioBase64 || '').replace(/^data:audio\/[\w+.-]+;base64,/, '')
      if (!b64) {return { ok: false, text: '', error: '空音频' }}
      const { WhisperTranscriber } = await import('../whisper/transcriber')
      wavPath = path.join(app.getPath('temp'), `lumina-utter-${Date.now()}-${Math.floor(Math.random() * 1e6)}.wav`)
      await fsp.writeFile(wavPath, Buffer.from(b64, 'base64'))
      const modelName = params?.model || 'Xenova/whisper-base'
      const tr = WhisperTranscriber.getInstance()
      await tr.initialize({ modelName })
      const res = await tr.transcribe(wavPath, { modelName, language: 'zh' })
      return { ok: true, text: (res.text || '').trim(), model: modelName }
    } catch (e: any) {
      const msg = String(e?.message || e)
      const missingDependency = /cannot find package|@xenova|transformers|fetch failed|enotfound|network|下载|model/i.test(msg)
      return { ok: false, text: '', error: msg, missingDependency }
    } finally {
      if (wavPath) {fsp.unlink(wavPath).catch(() => {})}
    }
  })

  console.log('[LifeServices] 🫀 v0.2 生命感服务 IPC 已注册（模型库/屏幕节流/在场/唤醒/全双工）')
}
