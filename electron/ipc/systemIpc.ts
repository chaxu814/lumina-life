// ============================================================
// ipc/systemIpc.ts — Hearing / TTS / LLM / Update / Crash IPC
// v2.5 重构: 从 main.ts (1065行) 提取
// ============================================================

import { ipcMain, BrowserWindow } from 'electron'
// 🔧 2026-10-04：原为多处 `require('../agentTeamPersonas')`。
//   打包器把模块压平进 out/main/index.js 后，该相对路径必然解析失败并抛错，
//   而 agentTeamPersonas 正是三 Agent 人格与团队状态表的定义模块 ——
//   团队提示词会直接缺失。已确认与本文件不构成循环依赖，改回静态 import。
import { TEAM_PERSONAS } from '../agentTeamPersonas'
import { spawn, ChildProcess } from 'child_process'
import { resolvePython } from '../pythonBin'
import { join } from 'path'
import fs from 'fs'
import { app } from 'electron'
import { replaceAllCronEntries } from '../tools/impl/cron'
import {
  onDecisionEvent, submitDecisionAnswer, cancelDecision,
  cancelAllDecisions, getPendingDecisions, getDecisionConfig, setDecisionConfig,
} from '../decisionService'
import { stateFilePath } from '../core/pathsFallback'
import { collectAll } from '../tools/impl/newsCollector'
import { filterWithLLM } from '../tools/impl/newsFilter'
import { deduplicate, assembleDigestBody } from '../tools/impl/newsDigest'
import { enrichItemsBackground } from '../tools/impl/newsEnricher'
import { type NewsItem } from '../tools/impl/newsCollector'
import { sendMail } from '../mailStore'
import { getProviderManager, ProviderManager } from '../core/providerManager'
import { LLMProvider } from '../core/llmProvider'
import { buildPromptEnhancementMessages, trimToBudget } from '../core/promptEnhancer'
import { getNewsDigestScheduler } from '../newsDigestScheduler'
import { getSystemNotifier } from '../proactive/systemNotifier'

// 持久化路径
// ⚠️ 同 loopIpc/memoryIpc：模块顶层不能直接调 app.getPath()，app 尚未就绪会抛错。
const configPath = stateFilePath('lumina-config.json')

// ── 外部进程 ──────────────────────────────────────────

const PYTHON_NODE_PORT = 18925  // Plan C: 统一 Node 端口

let edgeTtsProcess: ChildProcess | null = null
let sttProcess: ChildProcess | null = null

const EDGE_TTS_PORT = 18089  // 旧服务端口（已停用）
const STT_PORT = 18090

/** Windows 兼容的进程终止 */
function killProcess(proc: ChildProcess | null): void {
  if (!proc || proc.killed) {return}
  try {
    if (process.platform === 'win32') {
      // Windows: 用 taskkill 强制终止进程树
      spawn('taskkill', ['/pid', String(proc.pid), '/f', '/t'], { stdio: 'ignore' })
    } else {
      proc.kill('SIGTERM')
    }
  } catch {
    // 最后的兜底
    try { proc.kill() } catch {}
  }
}

function startEdgeTts(serverPath: string, cwd: string): Promise<{ ok: boolean; port?: number; detail?: string }> {
  return new Promise(async (resolve) => {
    try {
      // 如果服务器已健康运行，直接返回
      if (edgeTtsProcess && !edgeTtsProcess.killed) {
        try {
          const res = await fetch('http://127.0.0.1:' + EDGE_TTS_PORT + '/health', { signal: AbortSignal.timeout(500) })
          if (res.ok) {return resolve({ ok: true, port: EDGE_TTS_PORT })}
        } catch {}
        // 进程存在但服务尚未响应 → 等待它就绪
        for (let i = 0; i < 20; i++) {
          await new Promise(r => setTimeout(r, 300))
          try {
            const res = await fetch('http://127.0.0.1:' + EDGE_TTS_PORT + '/health', { signal: AbortSignal.timeout(500) })
            if (res.ok) {return resolve({ ok: true, port: EDGE_TTS_PORT })}
          } catch {}
        }
        // 等待超时 → 进程可能僵死
        console.log('[EdgeTTS] 进程存在但 6s 内未就绪，kill 重启')
        killProcess(edgeTtsProcess)
        edgeTtsProcess = null
      }

      // ── 启动前检查端口是否已被旧实例占用 ──
      try {
        const legacyCheck = await fetch('http://127.0.0.1:' + EDGE_TTS_PORT + '/health', { signal: AbortSignal.timeout(300) })
        if (legacyCheck.ok) {
          console.log('[EdgeTTS] 端口已被旧实例占用，直接复用')
          return resolve({ ok: true, port: EDGE_TTS_PORT })
        }
      } catch {}

      // ── 确定 Python 可执行文件名 ──
      // 先试 python3 再试 python，并检查 edge-tts 是否安装
      const pythonBin = await findPython()
      if (!pythonBin) {
        return resolve({ ok: false, detail: '未找到 Python。请安装 Python 3.8+ 并确保在 PATH 中' })
      }

      // ── 检查 edge-tts 是否已安装 ──
      try {
        const { execSync } = await import('child_process')
        execSync(`"${pythonBin}" -c "import edge_tts"`, { timeout: 5000, windowsHide: true })
      } catch {
        console.log('[EdgeTTS] edge-tts 未安装，尝试自动安装...')
        try {
          const { execSync } = await import('child_process')
          execSync(`"${pythonBin}" -m pip install edge-tts -q`, { timeout: 30000, windowsHide: true })
          console.log('[EdgeTTS] edge-tts 安装完成')
        } catch (installErr: any) {
          return resolve({ ok: false, detail: `edge-tts 包未安装且自动安装失败。请手动运行: ${pythonBin} -m pip install edge-tts` })
        }
      }

      // ── 启动 Python 服务 ──
      // v6.0: shell:false + 数组参数，避免 DEP0190 警告
      console.log(`[EdgeTTS] 启动: ${pythonBin} ${serverPath} --port ${EDGE_TTS_PORT}`)
      edgeTtsProcess = spawn(pythonBin, [serverPath, '--port', String(EDGE_TTS_PORT)], {
        cwd,
        stdio: 'pipe',
        shell: false,
        windowsHide: true,
      })

      // 捕获 stderr 用于诊断启动失败
      let stderrBuf = ''
      let processExited = false
      let processExitCode: number | null = null
      edgeTtsProcess.stderr?.on('data', (data: Buffer) => {
        stderrBuf += data.toString()
      })

      edgeTtsProcess.on('error', (err) => {
        console.error(`[EdgeTTS] spawn 错误:`, err.message)
        edgeTtsProcess = null
        resolve({ ok: false, detail: `进程启动失败: ${err.message}` })
      })

      edgeTtsProcess.on('close', (code) => {
        processExited = true
        processExitCode = code
        console.log(`[EdgeTTS] 进程退出, code=${code}`)
        if (code !== 0 && stderrBuf) {
          console.error(`[EdgeTTS] stderr: ${stderrBuf.slice(0, 500)}`)
        }
        // 不在这里设置 edgeTtsProcess = null — 等待循环会处理
      })

      // 等待服务真正就绪（health 端点可用）
      // 延长等待时间至 15s（edge-tts 首次启动可能下载模型）
      let ready = false
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 500))
        if (processExited && processExitCode !== 0) {
          // 进程已退出且有错误 → 不用再等
          const detail = stderrBuf
            ? `Python 启动失败 (code=${processExitCode}): ${stderrBuf.slice(0, 300)}`
            : `Python 进程意外退出 (code=${processExitCode})，可能是 edge-tts 未安装或 Python 版本问题`
          return resolve({ ok: false, detail })
        }
        try {
          const res = await fetch('http://127.0.0.1:' + EDGE_TTS_PORT + '/health', { signal: AbortSignal.timeout(500) })
          if (res.ok) { ready = true; break }
        } catch {}
      }

      if (!ready) {
        console.error(`[EdgeTTS] 15s 内未就绪，清理进程${stderrBuf ? ', stderr: ' + stderrBuf.slice(0, 300) : ''}`)
        killProcess(edgeTtsProcess)
        edgeTtsProcess = null
        // kill 后等 1 秒释放端口，避免下次启动端口冲突
        await new Promise(r => setTimeout(r, 1000))
      }

      resolve({ ok: ready, port: EDGE_TTS_PORT, detail: ready ? undefined : (stderrBuf ? `启动失败: ${stderrBuf.slice(0, 300)}` : '服务启动超时（未在15秒内就绪，EdgeTTS可能需要下载语音模型）') })
    } catch (err: any) {
      resolve({ ok: false, detail: err.message })
    }
  })
}

/** 🔧 v2.9: 查找可用的 Python 可执行文件 */
async function findPython(): Promise<string | null> {
  const { execSync } = await import('child_process')
  const candidates = ['python3', 'python', 'py']
  for (const bin of candidates) {
    try {
      const result = execSync(`"${bin}" --version`, { timeout: 3000, windowsHide: true })
      const version = result.toString().trim()
      console.log(`[EdgeTTS] 找到 Python: ${bin} → ${version}`)
      return bin
    } catch {}
  }
  return null
}

/** 供 main.ts 在应用启动时自动启动 Edge TTS
 *  Plan C Phase 2：统一走 Python Node (port 18925)，不再独立启动旧服务 */
export async function autoStartEdgeTts(): Promise<void> {
  console.log('[EdgeTTS] 已迁移至 Python Node (port 18925)，跳过旧服务自动启动')
}

// ── 崩溃标记 ──────────────────────────────────────────

function setCrashFlag(): void {
  try { fs.writeFileSync(join(app.getPath('userData'), '.lumina-crashed'), Date.now().toString()) } catch {}
}

function clearCrashFlag(): void {
  try {
    const path = join(app.getPath('userData'), '.lumina-crashed')
    if (fs.existsSync(path)) {fs.unlinkSync(path)}
  } catch {}
}

// ── 配置读写 ──────────────────────────────────────────

function loadConfig(): Record<string, any> {
  if (!fs.existsSync(configPath)) {return {} }   // 首次启动：空配置是正常的
  const raw = fs.readFileSync(configPath, 'utf-8')
  try {
    return JSON.parse(raw)
  } catch (e) {
    // 🔧 配置损坏时**抛出**而非静默返回 {}
    //
    // 原因：调用方拿到 {} 后会往里塞一项再写回，
    // 于是一份损坏的文件被「修复」成了「只剩那一项」——
    // 用户的其他配置（主题、功能开关、角色配置）全部消失，
    // 而且没有任何提示。整份配置被静默清空比报错糟糕得多。
    //
    // 抛出后由调用方的 try/catch 兜住：文件保持原样，
    // 用户至少还能手动抢救，也让开发者看得到日志。
    const err = new Error(`配置文件已损坏，已拒绝写入以免覆盖：${configPath} — ${(e as Error)?.message}`);
    console.error('[Config] 配置文件解析失败：', (e as Error)?.message)
    throw err
  }
}

function saveConfig(config: Record<string, any>): void {
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')
}

export function registerSystemIpc(mainWindow: BrowserWindow): void {
  // v5.0: 启动时恢复已保存的 per-agent LLM 配置
  (() => {
    try {
      const config = loadConfig()
      if (config.agentLlmConfigs) {
        for (const [id, cfg] of Object.entries(config.agentLlmConfigs) as any) {
          if (TEAM_PERSONAS[id]) {
            TEAM_PERSONAS[id].llmConfig = { ...TEAM_PERSONAS[id].llmConfig, ...cfg }
            console.log(`[AgentLLM] 📂 已恢复 ${TEAM_PERSONAS[id].name}(${id}) LLM 配置`)
          }
        }
      }
    } catch (e) { /* 静默 */ }
  })()

  // ─── Mail SMTP 配置 ──────────────────────────────

  ipcMain.handle('mail:smtp:get', async () => {
    try {
      const { getSmtpConfig } = require('../mailStore')
      return getSmtpConfig()
    } catch (e: any) {
      return { error: e.message }
    }
  })

  ipcMain.handle('mail:smtp:set', async (_event, patch: Record<string, any>) => {
    try {
      const { setSmtpConfig } = require('../mailStore')
      const next = setSmtpConfig(patch || {})
      return { ok: true, config: next }
    } catch (e: any) {
      return { ok: false, error: e.message }
    }
  })

  ipcMain.handle('mail:smtp:reset', async () => {
    try {
      const { resetSmtpConfig } = require('../mailStore')
      return { ok: true, config: resetSmtpConfig() }
    } catch (e: any) {
      return { ok: false, error: e.message }
    }
  })

  // ─── Edge-TTS (Plan C: 统一走 Python Node) ────────────

  ipcMain.handle('edge-tts:start', async () => {
    // Plan C: TTS 已随 Python Node 启动，只需检查 Node 健康状态
    try {
      const res = await fetch(`http://127.0.0.1:${PYTHON_NODE_PORT}/health`, { signal: AbortSignal.timeout(2000) })
      const data = await res.json()
      const ttsReady = data?.services?.tts?.ready
      if (ttsReady) {
        console.log('[EdgeTTS] Python Node TTS 就绪')
        return { ok: true, port: PYTHON_NODE_PORT }
      } else {
        console.warn('[EdgeTTS] Python Node 运行中但 TTS 未就绪:', data?.services?.tts?.error)
        return { ok: false, detail: 'TTS 服务未就绪，请等待 Python Node 完全启动' }
      }
    } catch (e: any) {
      console.error('[EdgeTTS] Python Node 未响应:', e.message)
      return { ok: false, detail: 'Python Node 未运行，请先启动 Lumina' }
    }
  })

  ipcMain.handle('edge-tts:stop', async () => {
    // Plan C: Python Node 是全局服务，不单独停止 TTS
    console.log('[EdgeTTS] stop 请求已忽略（TTS 由 Python Node 统一管理）')
    return
  })

  ipcMain.handle('edge-tts:status', async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${PYTHON_NODE_PORT}/health`, { signal: AbortSignal.timeout(1500) })
      const data = await res.json()
      const ttsReady = data?.services?.tts?.ready
      return { running: ttsReady, port: PYTHON_NODE_PORT }
    } catch {
      return { running: false, port: PYTHON_NODE_PORT }
    }
  })

  ipcMain.handle('edge-tts:port', () => PYTHON_NODE_PORT)

  ipcMain.handle('edge-tts:speak', async (_event, params: {
    text: string; voice?: string; speed?: number; volume?: number
  }) => {
    try {
      const url = `http://127.0.0.1:${PYTHON_NODE_PORT}/tts`
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 30000)
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: params.text,
          voice: params.voice || 'zh-CN-XiaoxiaoNeural',
          speed: params.speed ?? 1.0,
        }),
        signal: controller.signal,
      })
      clearTimeout(timeout)
      if (!res.ok) {return { error: `TTS 服务返回: ${res.status}` }}
      // Plan C: Python Node 返回 hex 编码的 MP3（{"audio": "<hex>", "format": "mp3"}）
      const data = await res.json()
      const hexStr = typeof data.audio === 'string' ? data.audio : ''
      const audioBuffer = Buffer.from(hexStr, 'hex')
      if (audioBuffer.length < 100) {
        console.warn(`[TTS:IPC] 音频数据过短 (${audioBuffer.length} bytes)`)
        return { error: 'TTS 返回数据过短或格式异常' }
      }
      const base64 = audioBuffer.toString('base64')
      const audioDataUrl = `data:audio/mpeg;base64,${base64}`
      return { audio: audioDataUrl }
    } catch (err: any) { return { error: err.message } }
  })

  // ─── GTP-SoVITS ─────────────────────────────────

  ipcMain.handle('tts:sovits-speak', async (_event, params: {
    text: string; refAudioPath?: string; refText?: string
  }) => {
    try {
      const config = loadConfig()
      const sovitsUrl = config.tts?.sovitsUrl || 'http://localhost:9880'
      const res = await fetch(sovitsUrl + '/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: params.text,
          text_language: 'zh',
          ref_audio_path: params.refAudioPath || '',
          prompt_text: params.refText || '',
        }),
      })
      if (!res.ok) {return { ok: false, detail: `SoVITS error: ${res.status}` }}
      const data = await res.json()
      const audioPath = data.audio_path || data.file_path
      if (audioPath) {mainWindow?.webContents.send('audio:play', audioPath)}
      return { ok: true, path: audioPath }
    } catch (err: any) { return { ok: false, detail: err.message } }
  })

  // ─── LLM ─────────────────────────────────────────

  ipcMain.handle('llm:chat', async (_event, params: {
    provider: string; apiKey: string; baseUrl: string; model: string
    messages: Array<{ role: string; content: string }>
    temperature?: number; maxTokens?: number
  }) => {
    try {
      console.log('[llm:chat]', JSON.stringify({ baseUrl: params.baseUrl, model: params.model, hasApiKey: !!params.apiKey }))
      const response = await fetch(`${params.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${params.apiKey}`,
        },
        body: JSON.stringify({
          model: params.model,
          messages: params.messages,
          temperature: params.temperature ?? 0.7,
          max_tokens: params.maxTokens ?? 4096,
        }),
        signal: AbortSignal.timeout(120000),  // 🔧 v2.19: 120s 超时（日报生成需要更多时间）
      })
      if (!response.ok) {return { error: `HTTP ${response.status}` }}
      const data = await response.json()
      return { content: data.choices?.[0]?.message?.content || '' }
    } catch (err: any) { return { error: err.message } }
  })

  // ── 增强群聊草稿提示词（只改写草稿，不执行/发送用户任务）──
  //
  // v2：加入「输出长度预算」并把预算写进提示词；返回后按预算做兜底裁剪，
  //     确保弱模型/不听话的模型也不会返回一大坨。
  ipcMain.handle('llm:enhance-prompt', async (_event, params: {
    baseUrl: string; apiKey?: string; model: string; text: string
  }) => {
    const baseUrl = String(params?.baseUrl || '').trim().replace(/\/+$/, '')
    const model = String(params?.model || '').trim()
    if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) {return { error: '模型服务地址无效，请检查当前供应商配置。' }}
    if (!model) {return { error: '请先选择一个模型。' }}
    const built = buildPromptEnhancementMessages(params?.text)
    if (!built.ok) {return { error: built.error }}

    try {
      const provider = new LLMProvider({
        baseUrl,
        apiKey: String(params.apiKey || ''),
        model,
        maxContextTokens: 16384,
      })
      const result = await provider.call({
        messages: built.messages,
        // 改写任务要"忠于原文"，温度调低减少发挥；上限按预算给，避免长输出被截断
        temperature: 0.3,
        maxTokens: Math.min(4096, Math.max(512, built.budget)),
        signal: AbortSignal.timeout(90_000),
      })
      if (result.error) {return { error: result.error }}
      const raw = String(result.text || '').trim()
      if (!raw) {return { error: '模型没有返回增强后的提示词，请稍后重试。' }}
      const content = trimToBudget(raw, built.budget)
      return {
        content,
        budget: built.budget,
        originalChars: built.messages[1].content.length,
        enhancedChars: content.length,
        // 供 UI 提示：模型超预算被裁剪过
        trimmed: content.length < raw.length,
      }
    } catch (err) {
      const e = err as { name?: string; message?: string }
      return { error: e?.name === 'TimeoutError' || e?.name === 'AbortError'
        ? '提示词增强等待超时；草稿未更改，请稍后重试。'
        : (e?.message || '提示词增强失败，草稿未更改。') }
    }
  })

  // ─── 🔧 v2.18: 增强的LLM模型列表获取 ─────────────────

  ipcMain.handle('llm:fetchModels', async (_event, params: {
    baseUrl: string; apiKey: string
  }) => {
    try {
      console.log('[llm:fetchModels]', JSON.stringify({ baseUrl: params.baseUrl, hasApiKey: !!params.apiKey }))
      
      // 增强的模型识别 - 特别优化LM Studio和本地服务
      let models: Array<{ id: string; multimodal?: boolean; vision?: boolean }> = []
      
      // 首先检测是否是LM Studio、Ollama或本地服务
      const isLMStudio = params.baseUrl.includes('127.0.0.1:1234') || params.baseUrl.includes('localhost:1234') || params.baseUrl.includes(':1234')
      const isOllama = params.baseUrl.includes('127.0.0.1:11434') || params.baseUrl.includes('localhost:11434') || params.baseUrl.includes(':11434')
      const isLocalService = params.baseUrl.includes('127.0.0.1') || params.baseUrl.includes('localhost')
      
      if (isLMStudio) {
        console.log('[llm:fetchModels] 检测到LM Studio，使用增强识别')
        return await handleLMStudioModels(params)
      }

      if (isOllama) {
        console.log('[llm:fetchModels] 检测到Ollama，使用Ollama API获取模型')
        try {
          const resp = await fetch(params.baseUrl.replace('/v1', '') + '/api/tags', {
            method: 'GET',
            signal: AbortSignal.timeout(10000),
          })
          if (resp.ok) {
            const data = await resp.json()
            if (data.models && Array.isArray(data.models)) {
              const models = data.models.map((m: any) => {
                const id = m.name || m.model || ''
                return { id, multimodal: false, vision: false }
              }).filter((m: any) => !!m.id)
              console.log(`[llm:fetchModels] Ollama 找到 ${models.length} 个模型`)
              return { models }
            }
          }
        } catch (e: any) {
          console.log('[llm:fetchModels] Ollama API失败，回退标准模式:', e.message)
        }
        // 回退到标准 OpenAI 兼容端点
      }
      
      try {
        // 尝试 OpenAI 兼容格式
        const response = await fetch(params.baseUrl + '/models', {
          method: 'GET',
          headers: {
            'Authorization': 'Bearer ' + (params.apiKey || ''),
            'Content-Type': 'application/json',
          },
          signal: AbortSignal.timeout(10000),
        })
        
        if (response.ok) {
          const data = await response.json()
          
          // 处理不同API格式
          if (Array.isArray(data)) {
            // 格式1: 直接数组 [{id: 'model1'}, {id: 'model2'}]
            models = data.map((m: any) => {
              const id = m.id || m.model || m.name || ''
              return extractModelCapabilities(id)
            })
          } else if (data.data && Array.isArray(data.data)) {
            // 格式2: OpenAI格式 {data: [{id: 'model1'}, ...]}
            models = data.data.map((m: any) => {
              const id = m.id || m.model || m.name || ''
              return extractModelCapabilities(id)
            })
          } else if (data.models && Array.isArray(data.models)) {
            // 格式3: {models: [{id: 'model1'}, ...]}
            models = data.models.map((m: any) => {
              const id = m.id || m.model || m.name || ''
              return extractModelCapabilities(id)
            })
          } else if (isLocalService) {
            // 本地服务可能返回特殊格式
            console.log('[llm:fetchModels] 本地服务返回未知格式，尝试提取')
            models = extractModelsFromUnknownFormat(data)
            
            // 如果提取不到模型，尝试其他端点
            if (models.length === 0) {
              return await tryAlternativeLocalEndpoints(params)
            }
          } else {
            // 未知格式，尝试提取所有可能的模型ID
            models = extractModelsFromUnknownFormat(data)
          }
          
          // 检查是否为空数组（常见于LM Studio未加载模型）
          if (models.length === 0 && isLocalService) {
            console.log('[llm:fetchModels] 模型列表为空，尝试获取加载状态')
            return await handleEmptyLocalModels(params)
          }
        } else {
          // API可能不兼容/models端点，尝试/chat/completions端点获取能力
          return await tryChatEndpointForCapabilities(params)
        }
      } catch (error: any) {
        console.log('[llm:fetchModels] 主要API失败:', error.message)
        // 降级方案：针对本地服务特别处理
        if (isLocalService) {
          return await handleLocalServiceFallback(params)
        }
        // 降级方案：尝试其他端点或返回默认模型
        return await fallbackModelDetection(params)
      }
      
      // 过滤无效模型并排序
      const validModels = models
        .filter((m: any) => !!m.id && m.id.trim())
        .sort((a: any, b: any) => a.id.localeCompare(b.id))
      
      console.log(`[llm:fetchModels] 找到 ${validModels.length} 个模型`)
      return { models: validModels }
      
    } catch (err: any) { 
      console.error('[llm:fetchModels] 错误:', err.message)
      return { error: `获取模型失败: ${err.message}` } 
    }
  })

  // ─── v2.17: LLM 连接测试 ────────────────────────

  ipcMain.handle('llm:testConnection', async (_event, params: {
    baseUrl: string; apiKey: string; model: string
  }) => {
    const startTime = Date.now()
    
    try {
      console.log('[llm:testConnection]', JSON.stringify({ 
        baseUrl: params.baseUrl, 
        model: params.model,
        hasApiKey: !!params.apiKey 
      }))
      
      // 🔧 本地服务（LM Studio / Ollama 等）特殊处理
      // LM Studio 本地服务器默认不需要 Authorization，但某些版本接受任意非空 Bearer
      // 策略：先尝试带 key，若 401 则去掉 Authorization 重试
      const isLocal = params.baseUrl.includes('127.0.0.1') || params.baseUrl.includes('localhost')
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (params.apiKey) {
        headers['Authorization'] = 'Bearer ' + params.apiKey
      }
      
      let response = await fetch(params.baseUrl + '/chat/completions', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: params.model,
          messages: [{ role: 'user', content: 'Hello' }],
          max_tokens: 10,
        }),
        signal: AbortSignal.timeout(8000),
      })
      
      // 本地服务 401 → 去掉 Authorization 重试
      if (isLocal && response.status === 401) {
        console.log('[llm:testConnection] 本地服务 401，去掉 Authorization 重试')
        response = await fetch(params.baseUrl + '/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: params.model,
            messages: [{ role: 'user', content: 'Hello' }],
            max_tokens: 10,
          }),
          signal: AbortSignal.timeout(8000),
        })
      }
      
      const endTime = Date.now()
      const latency = endTime - startTime
      
      if (response.ok) {
        const data = await response.json()
        const usage = data.usage || {}
        return { 
          success: true, 
          latency,
          usage: {
            prompt_tokens: usage.prompt_tokens || 0,
            completion_tokens: usage.completion_tokens || 0,
            total_tokens: usage.total_tokens || 0,
          },
          model: data.model || params.model
        }
      } else {
        const errorText = await response.text()
        return { 
          success: false, 
          error: `HTTP ${response.status}: ${errorText.slice(0, 200)}`,
          latency
        }
      }
    } catch (err: any) {
      console.error('[llm:testConnection] 错误:', err.message)
      const latency = Date.now() - startTime
      return { 
        success: false, 
        error: `连接失败: ${err.message}`,
        latency
      }
    }
  })

  // ─── v2.17: 多模态能力测试 ──────────────────────

  ipcMain.handle('llm:testMultimodal', async (_event, params: {
    baseUrl: string; apiKey: string; model: string
  }) => {
    try {
      console.log('[llm:testMultimodal]', JSON.stringify({ 
        baseUrl: params.baseUrl, 
        model: params.model,
        hasApiKey: !!params.apiKey 
      }))
      
      // v2.18: 增强的多模态检测
      const modelInfo = extractModelCapabilities(params.model)
      
      let message = ''
      const isLMStudio = params.baseUrl.includes('lmstudio') || params.baseUrl.includes('127.0.0.1:1234') || 
                        params.baseUrl.includes('localhost:1234')
      
      if (isLMStudio) {
        message = 'LM Studio本地服务检测 - 建议实际测试文件上传功能'
      } else if (modelInfo.multimodal) {
        message = '基于模型名称检测到多模态能力'
      } else if (modelInfo.vision) {
        message = '基于模型名称检测到视觉能力'
      } else {
        message = '模型名称未包含多模态标识 - 可能需要手动测试'
      }
      
      // 尝试实际的图像理解测试（对于非本地服务）
      let practicalTestSuccess = false
      let practicalTestError = ''
      
      if (!isLMStudio) {
        try {
          const imageResponse = await fetch(params.baseUrl + '/chat/completions', {
            method: 'POST',
            headers: {
              'Authorization': 'Bearer ' + (params.apiKey || ''),
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              model: params.model,
              messages: [
                {
                  role: 'user',
                  content: [
                    { type: 'text', text: '描述这张图片' },
                    { type: 'image_url', image_url: { 
                      url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
                      detail: 'low'
                    } }
                  ]
                }
              ],
              max_tokens: 20
            }),
            signal: AbortSignal.timeout(8000),
          })
          
          if (imageResponse.ok) {
            practicalTestSuccess = true
            console.log('[llm:testMultimodal] 图像测试通过')
            message += '\n• 图像API测试: 通过'
          } else {
            const errorText = await imageResponse.text()
            practicalTestError = `HTTP ${imageResponse.status}: ${errorText.slice(0, 100)}`
            console.log('[llm:testMultimodal] 图像测试失败:', practicalTestError)
            message += `\n• 图像API测试: 失败 (${practicalTestError})`
          }
        } catch (imageErr: any) {
          practicalTestError = imageErr.message
          console.log('[llm:testMultimodal] 图像测试异常:', imageErr.message)
          message += `\n• 图像API测试: 异常 (${imageErr.message.slice(0, 80)})`
        }
      }
      
      return {
        success: true,
        multimodal: modelInfo.multimodal,
        vision: modelInfo.vision,
        audio: modelInfo.multimodal && (params.model.toLowerCase().includes('whisper') || params.model.toLowerCase().includes('audio')),
        message: message,
        model: params.model,
        detectedCapabilities: modelInfo,
        isLMStudio: isLMStudio,
        practicalTestPassed: practicalTestSuccess,
        practicalTestError: practicalTestError
      }
      
    } catch (err: any) {
      console.error('[llm:testMultimodal] 错误:', err.message)
      return { 
        success: false,
        multimodal: false,
        vision: false,
        audio: false,
        error: `多模态测试失败: ${err.message}`,
        message: '多模态测试过程中发生错误'
      }
    }
  })

  // ─── v5.0: Per-Agent 独立 LLM 配置 ──────────────

  /**
   * 获取指定 agent 的 LLM 配置
   * 入参: { agentId: 'lumina' | 'recha' | 'yak' }
   */
  ipcMain.handle('agent-llm:get-config', async (_event, params: { agentId: string }) => {
    try {
      const persona = TEAM_PERSONAS[params.agentId]
      if (!persona) {return { error: 'Agent 不存在' }}
      return { config: persona.llmConfig || { enabled: false } }
    } catch (err: any) { return { error: err.message } }
  })

  /**
   * 设置指定 agent 的 LLM 配置
   * 入参: { agentId, config: { enabled, provider, model, endpoint, apiKey, timeout, fallbackStrategy } }
   */
  ipcMain.handle('agent-llm:set-config', async (_event, params: {
    agentId: string
    config: {
      enabled?: boolean
      provider?: string
      model?: string
      endpoint?: string
      apiKey?: string
      timeout?: number
      fallbackStrategy?: string
    }
  }) => {
    try {
      const persona = TEAM_PERSONAS[params.agentId]
      if (!persona) {return { error: 'Agent 不存在' }}

      // 合并配置
      persona.llmConfig = {
        ...persona.llmConfig,
        ...params.config,
      } as any

      // 🔧 2026-10-04：llmConfig 是可选字段。此前 persona 来自 require()（any），
      //   类型检查形同虚设；改回静态 import 后这个真实的可选性暴露出来。
      //   语义不变：没配独立 LLM 就是「全局共用」。
      console.log(
        `[AgentLLM] 💾 ${persona.name}(${params.agentId}) LLM: ` +
        `${persona.llmConfig?.enabled ? '独立 ' + persona.llmConfig.provider + '/' + persona.llmConfig.model : '全局共用'}`,
      )

      // 持久化到 lumina-config.json
      // 🔧 try/catch：loadConfig 在配置损坏时会抛错（防止把损坏文件
      // 「修复」成只剩这一项，导致用户其他配置被清空）。
      // 这里接住它，明确告知失败，文件保持原样。
      try {
        const config = loadConfig()
        config.agentLlmConfigs = config.agentLlmConfigs || {}
        config.agentLlmConfigs[params.agentId] = persona.llmConfig
        saveConfig(config)
      } catch (e: any) {
        console.error('[AgentLLM] 持久化失败：', e?.message)
        return { ok: false, error: e?.message || '配置文件损坏，未保存（已保留原文件）' }
      }

      // v5.0: 通知 AgentPool 热更新该 agent 的 LLM（如果池已初始化）
      try {
        const { getAgentPool } = require('../agentPool')
        const pool = getAgentPool()
        if (pool) {pool.reconfigureAgent(params.agentId)}
      } catch { /* pool not initialized yet — fine */ }

      return { ok: true, config: persona.llmConfig }
    } catch (err: any) { return { error: err.message } }
  })

  /**
   * 获取所有 3 个 agent 的 LLM 配置（供设置页加载）
   */
  ipcMain.handle('agent-llm:get-all-configs', async () => {
    try {
      const result: Record<string, any> = {}
      for (const [id, persona] of Object.entries(TEAM_PERSONAS) as any) {
        result[id] = persona?.llmConfig || { enabled: false }
      }

      // 从持久化文件覆盖（运行时可被用户改过）
      try {
        const config = loadConfig()
        if (config.agentLlmConfigs) {
          for (const [id, cfg] of Object.entries(config.agentLlmConfigs)) {
            if (result[id] && cfg && typeof cfg === 'object') {
              result[id] = { ...result[id], ...(cfg as Record<string, any>) }
            }
          }
        }
      } catch {}

      return { configs: result }
    } catch (err: any) { return { error: err.message } }
  })

  // ─── Hearing (STT server) ─────────────────────────

  const STT_PORT = 18090

  ipcMain.handle('hearing:start', async (_event, { source }: { source: string }) => {
    try {
      if (sttProcess && !sttProcess.killed) {
        sttProcess.kill('SIGTERM')
        sttProcess = null
      }
      const serverPath = join(__dirname, '..', '..', 'stt-server', 'stt_server.py')
      // 🆕 启动前先检测：stt-server/ 在 .gitignore 中但运行时被引用，
      // 用户没拉全（含 Python 依赖、Whisper 模型）就直接 spawn 必然 ENOENT。
      // 这里前置 existsSync + 友好降级，避免静默崩溃。
      if (!fs.existsSync(serverPath)) {
        return {
          ok: false,
          detail:
            `STT 服务脚本不存在: ${serverPath}。` +
            `语音听写需要 Python + Whisper/Vosk 环境，请参考 docs/INSTALL.md 装好后重试。` +
            `未启动时仍可使用打字输入/键盘快捷键。`,
        }
      }
      sttProcess = spawn(resolvePython(), [serverPath, '--port', String(STT_PORT)], {
        cwd: join(__dirname, '..', '..', 'stt-server'),
        stdio: 'pipe',
      })
      sttProcess.on('close', (code) => {
        console.log(`[STT] 进程退出, code=${code}`)
        sttProcess = null
      })
      await new Promise((resolve) => setTimeout(resolve, 2000))
      mainWindow?.webContents.send('hearing:transcription', {
        text: '(听觉已启动 — 说话试试)',
        isFinal: true,
      })
      return { ok: true, detail: `STT 已启动 (port ${STT_PORT})` }
    } catch (err: any) { return { ok: false, detail: err.message } }
  })

  ipcMain.handle('hearing:stop', async () => {
    if (sttProcess && !sttProcess.killed) {
      sttProcess.kill('SIGTERM')
      sttProcess = null
    }
    mainWindow?.webContents.send('hearing:transcription', {
      text: '(听觉已停止)',
      isFinal: true,
    })
    return { ok: true }
  })

  ipcMain.handle('hearing:status', async () => ({
    running: sttProcess !== null && !sttProcess.killed,
    source: 'mic',
  }))

  // ─── STT (v2.11) ───────────────────────────────
  // stt:check — 检查语音识别可用性
  ipcMain.handle('stt:check', async () => {
    // 主窗口连续听写默认走 Chromium 内置 Web Speech（开箱即用，需联网）；
    // 同时上报「内置离线中文模型」就绪状态（桌宠全双工在模型就绪后可完全离线）。
    let offline: any = null
    try {
      const { getOfflineStatus } = require('../whisper/sttModelIpc')
      offline = getOfflineStatus()
    } catch { offline = null }
    // 主窗口连续识别链路：若离线模型已就绪则优先离线（whisper），否则用内置 Web Speech
    if (offline?.modelReady) {
      return { available: true, engine: 'whisper', offline }
    }
    return { available: true, engine: 'web-speech', offline }
  })

  // ═══ STT 相关 handler 移至 bridgeIpc.ts ═══

  // ─── Update ──────────────────────────────────────

  ipcMain.handle('update:check', async () => {
    try {
      const { checkForUpdates } = require('../autoUpdater')
      const result = await checkForUpdates()
      return { ok: true, ...result }
    } catch (err: any) { return { ok: false, error: err.message } }
  })

  ipcMain.handle('update:status', async () => {
    try {
      const { getUpdateStatus } = require('../autoUpdater')
      return { ok: true, status: getUpdateStatus() }
    } catch { return { ok: true, status: 'idle' } }
  })

  // ─── Crash / Proactive ──────────────────────────

  ipcMain.handle('system:crashed', async () => {
    const path = join(app.getPath('userData'), '.lumina-crashed')
    try {
      if (fs.existsSync(path)) {return { crashed: true, timestamp: fs.readFileSync(path, 'utf-8') }}
    } catch {}
    return { crashed: false }
  })

  // 启动时设置崩溃标记，正常退出时清除
  setCrashFlag()

  // ─── Proactive Init ─────────────────────────────

  try {
    const { getProactiveEngine } = require('../proactiveEngine')
    const engine = getProactiveEngine()
    if (engine) {
      engine.on('trigger', (msg: string) => {
        mainWindow?.webContents.send('proactive:trigger', { message: msg })
      })
    }
  } catch {}

  // 主动引擎 IPC 处理器 (之前缺失！)
  try {
    const { getProactiveEngine } = require('../proactiveEngine')

    // ── 获取引擎状态 ──────────────────────────
    ipcMain.handle('proactive:status', async () => {
      try {
        const engine = getProactiveEngine()
        if (!engine) {return { running: false, triggers: [], config: {}, dailyCount: 0 }}
        return engine.getStatus()
      } catch { return { running: false, triggers: [], config: {}, dailyCount: 0 } }
    })

    // ── 更新引擎配置 ──────────────────────────
    ipcMain.handle('proactive:update-config', async (_e, config: Record<string, any>) => {
      try {
        const engine = getProactiveEngine()
        if (!engine) {return { ok: false }}
        engine.updateConfig(config)
        return { ok: true }
      } catch { return { ok: false } }
    })

    // ── 更新单个触发器 ────────────────────────
    ipcMain.handle('proactive:update-trigger', async (_e, id: string, updates: Record<string, any>) => {
      try {
        const engine = getProactiveEngine()
        if (!engine) {return { ok: false }}
        engine.updateTrigger(id, updates)
        return { ok: true }
      } catch { return { ok: false } }
    })

    // ── 获取所有触发器 ────────────────────────
    ipcMain.handle('proactive:get-triggers', async () => {
      try {
        const engine = getProactiveEngine()
        if (!engine) {return []}
        return engine.getTriggers()
      } catch { return [] }
    })

    // ── 心跳（标记用户活跃）───────────────────
    ipcMain.handle('proactive:heartbeat', async () => {
      try {
        const engine = getProactiveEngine()
        if (!engine) {return { ok: false }}
        engine.heartbeat()
        return { ok: true }
      } catch { return { ok: false } }
    })

    // ── 测试触发 ──────────────────────────────
    ipcMain.handle('proactive:test-trigger', async (_e, id: string) => {
      try {
        const engine = getProactiveEngine()
        if (!engine) {return { ok: false, error: '引擎未启动' }}
        await engine.testTrigger(id)
        return { ok: true }
      } catch (err: any) { return { ok: false, error: err.message } }
    })

    // ── 🔧 v2.16: 补全缺失的 proactive handlers ──
    ipcMain.handle('proactive:setNotify', async (_e, enabled: boolean) => {
      try {
        const engine = getProactiveEngine()
        if (!engine) {return { ok: false, error: '引擎未启动' }}
        engine.setNotify(enabled)
        return { ok: true }
      } catch (err: any) { return { ok: false, error: err.message } }
    })

    ipcMain.handle('proactive:screen-context', async () => {
      try {
        const engine = getProactiveEngine()
        if (!engine) {return null}
        return engine.getScreenContext?.() ?? null
      } catch { return null }
    })

    ipcMain.handle('proactive:user-message', async () => {
      try {
        const engine = getProactiveEngine()
        if (!engine) {return { ok: false }}
        engine.onUserMessage?.()
        return { ok: true }
      } catch { return { ok: false } }
    })
  } catch {}

  // ─── Splash ─────────────────────────────────────

  ipcMain.handle('splash:ready', async () => {
    mainWindow?.show()
    mainWindow?.focus()
    return { ok: true }
  })

  // 注册孤儿 handler（cron / news / news-digest / news-mcp 共 20+ 通道）。
  // 以前它们写在模块顶层，会在 app 初始化前就执行而崩溃；
  // 顺带修好一个隐性 bug —— 这些通道此前从未真正注册，
  // preload.ts 里的 invoke 会一直 noSuchHandler 失败。
  try {
    registerOrphanIpcHandlers()
    registerDecisionIpc()
  } catch (err: any) {
    // 单个通道注册失败（如同名重复注册）不应拖垮整个应用
    console.warn('[SystemIpc] 部分 IPC 通道注册失败:', err?.message || err)
  }
}

export function cleanupSystemProcesses(): void {
  clearCrashFlag()
  if (edgeTtsProcess && !edgeTtsProcess.killed) {
    killProcess(edgeTtsProcess)
    edgeTtsProcess = null
  }
  if (sttProcess && !sttProcess.killed) {
    killProcess(sttProcess)
    sttProcess = null
  }
}

// ============================================================
// v2.17: LLM 模型识别辅助函数
// ============================================================

/** 从模型ID提取能力信息 - v2.18增强版 */
function extractModelCapabilities(modelId: string): { 
  id: string; 
  multimodal: boolean; 
  vision: boolean 
} {
  const id = modelId.trim()
  
  // 常见本地模型的多模态能力映射
  const localModelCapabilities: Record<string, { multimodal: boolean; vision: boolean }> = {
    // Llama系列
    'llama-3.1-70b-instruct': { multimodal: false, vision: false },
    'llama-3.1-8b-instruct': { multimodal: false, vision: false },
    'llama-3.2-1b': { multimodal: false, vision: false },
    'llama-3.2-3b': { multimodal: false, vision: false },
    'llama-3.2-7b': { multimodal: false, vision: false },
    'llama-3.2-11b': { multimodal: false, vision: false },
    'llama-3.2-90b': { multimodal: false, vision: false },
    
    // Qwen系列
    'qwen2.5-7b-instruct': { multimodal: false, vision: false },
    'qwen2.5-14b-instruct': { multimodal: false, vision: false },
    'qwen2.5-32b-instruct': { multimodal: false, vision: false },
    'qwen2.5-72b-instruct': { multimodal: false, vision: false },
    'qwen2.5-vl-7b-instruct': { multimodal: true, vision: true },
    'qwen2.5-vl-32b-instruct': { multimodal: true, vision: true },
    'qwen2.5-vl-72b-instruct': { multimodal: true, vision: true },
    
    // Mixtral系列
    'mixtral-8x7b-instruct': { multimodal: false, vision: false },
    'mixtral-8x22b-instruct': { multimodal: false, vision: false },
    
    // Mistral系列
    'mistral-7b-instruct': { multimodal: false, vision: false },
    'mistral-8x7b-instruct': { multimodal: false, vision: false },
    'mistral-large': { multimodal: false, vision: false },
    
    // 通义千问VL系列
    'qwen-vl': { multimodal: true, vision: true },
    'qwen-vl-chat': { multimodal: true, vision: true },
    'qwen-vl-max': { multimodal: true, vision: true },
    
    // 智谱GLM系列
    'glm-4': { multimodal: false, vision: false },
    'glm-4v': { multimodal: true, vision: true },
    
    // DeepSeek系列
    'deepseek-v2': { multimodal: false, vision: false },
    'deepseek-v2-chat': { multimodal: false, vision: false },
    'deepseek-vl': { multimodal: true, vision: true },
    'deepseek-vl-chat': { multimodal: true, vision: true },
    
    // LLaVA系列
    'llava': { multimodal: true, vision: true },
    'llava-1.5': { multimodal: true, vision: true },
    'llava-1.6': { multimodal: true, vision: true },
    
    // 其他常见模型
    'phi-3': { multimodal: false, vision: false },
    'phi-3.5': { multimodal: false, vision: false },
    'phi-3-vision': { multimodal: true, vision: true },
    'phi-3.5-vision': { multimodal: true, vision: true },
    'cogview': { multimodal: true, vision: true },
    'cogview-3': { multimodal: true, vision: true },
  }
  
  // 首先检查本地模型映射
  const lowerId = id.toLowerCase()
  for (const [key, capabilities] of Object.entries(localModelCapabilities)) {
    if (lowerId.includes(key.toLowerCase())) {
      console.log(`[extractModelCapabilities] 识别到本地模型: ${key}`)
      return { id, ...capabilities }
    }
  }
  
  // 多模态模型标识
  const multimodalPatterns = [
    /vision/i, /gpt-4o/i, /claude/i, /gemini/i, /glm-4v/i, /cogview/i,
    /qwen-vl/i, /vl/i, /mini.*max/i, /step.*v/i, /deepseek-vl/i,
    /chatglm.*vision/i, /llava/i, /instructblip/i, /blip/i,
    /phi.*vision/i, /video/i, /image/i, /visual/i, /multimodal/i
  ]
  
  // 视觉专用模型标识
  const visionPatterns = [
    /vision/i, /gpt-4o/i, /claude-3/i, /gemini.*vision/i, /glm-4v/i,
    /cogview/i, /qwen-vl/i, /deepseek-vl/i, /llava/i, /instructblip/i,
    /phi.*vision/i, /video/i, /image/i, /visual/i
  ]
  
  // 音频模型标识
  const audioPatterns = [
    /whisper/i, /asr/i, /speech/i, /audio/i, /tts/i, /voice/i
  ]
  
  const isMultimodal = multimodalPatterns.some(pattern => pattern.test(id))
  const isVision = visionPatterns.some(pattern => pattern.test(id))
  const isAudio = audioPatterns.some(pattern => pattern.test(id))
  
  return {
    id,
    multimodal: isMultimodal || isVision || isAudio,
    vision: isVision
  }
}

/** 从未知API格式中提取模型 */
function extractModelsFromUnknownFormat(data: any): Array<{ id: string; multimodal?: boolean; vision?: boolean }> {
  const models: Array<{ id: string; multimodal?: boolean; vision?: boolean }> = []
  
  try {
    // 尝试递归查找所有可能的模型ID
    const findModelIds = (obj: any, path: string[] = []): void => {
      if (typeof obj === 'string') {
        // 检查是否是模型ID格式
        if (obj.length > 3 && !obj.includes('http') && !obj.includes('://')) {
          models.push(extractModelCapabilities(obj))
        }
      } else if (Array.isArray(obj)) {
        obj.forEach((item, index) => findModelIds(item, [...path, `[${index}]`]))
      } else if (obj && typeof obj === 'object') {
        // 检查常见字段名
        const modelFields = ['id', 'model', 'name', 'model_id', 'model_name']
        for (const field of modelFields) {
          if (obj[field] && typeof obj[field] === 'string') {
            models.push(extractModelCapabilities(obj[field]))
          }
        }
        // 递归检查所有属性
        Object.keys(obj).forEach(key => findModelIds(obj[key], [...path, key]))
      }
    }
    
    findModelIds(data)
  } catch (error) {
    console.error('[extractModelsFromUnknownFormat] 错误:', error)
  }
  
  // 去重
  const seen = new Set<string>()
  return models.filter(model => {
    if (seen.has(model.id)) {return false}
    seen.add(model.id)
    return true
  })
}

/** 尝试通过/chat/completions端点获取能力（仅GET探测，不发POST以免触发LM Studio加载模型） */
async function tryChatEndpointForCapabilities(params: { baseUrl: string; apiKey: string }): Promise<{ models?: Array<{ id: string; multimodal?: boolean; vision?: boolean }>; error?: string }> {
  console.log('[tryChatEndpointForCapabilities] /models 接口不可用，尝试 /chat/completions 探测')
  
  try {
    const response = await fetch(params.baseUrl + '/chat/completions', {
      method: 'GET',
      signal: AbortSignal.timeout(5000),
    })
    
    if (response.ok) {
      // 端点可达，但不应随意发POST（可能触发模型加载）
      console.log('[tryChatEndpointForCapabilities] /chat/completions 可达')
      return { error: '服务器已连接但未返回模型列表，请检查模型是否已加载或手动输入模型名称' }
    }
  } catch (error) {
    console.error('[tryChatEndpointForCapabilities] 探测错误:', error)
  }
  
  return { error: '无法连接 API 服务，请检查地址和 API Key 是否正确' }
}

/** 降级模型检测（当所有正常获取方式都失败时） */
async function fallbackModelDetection(params: { baseUrl: string; apiKey: string }): Promise<{ models?: Array<{ id: string; multimodal?: boolean; vision?: boolean }>; error?: string }> {
  console.log('[fallbackModelDetection] 无法获取模型列表，返回错误')
  return { error: '无法获取模型列表，请检查 API 地址和 API Key 是否正确' }
}

/** 处理LM Studio模型识别 */
async function handleLMStudioModels(params: { baseUrl: string; apiKey: string }): Promise<{ models?: Array<{ id: string; multimodal?: boolean; vision?: boolean }>; error?: string }> {
  console.log('[handleLMStudioModels] 处理LM Studio连接')

  // 构造多个 URL 变体：兼容 baseUrl 是否已带 /v1
  const raw = params.baseUrl.replace(/\/+$/, '')
  const baseVariants: string[] = [raw]
  // 如果 baseUrl 以 /v1 结尾，额外试去掉 /v1 的版本
  if (raw.endsWith('/v1')) {
    baseVariants.push(raw.slice(0, -3))
  } else {
    baseVariants.push(raw + '/v1')
  }
  // 去重
  const uniqueBases = [...new Set(baseVariants)]

  const pathVariants = ['/models', '/v1/models', '/api/models']

  // 两种 auth 策略：先试带 key，如果 401 再试无 key
  const authVariants = (apiKey: string): Array<string | null> => {
    const arr: Array<string | null> = [apiKey || null]
    if (apiKey) {arr.push(null)} // 带 key 时也试无 key 兜底
    return arr
  }

  for (const base of uniqueBases) {
    for (const path of pathVariants) {
      for (const key of authVariants(params.apiKey)) {
        const url = base + path
        try {
          const headers: Record<string, string> = {}
          if (key) {headers['Authorization'] = 'Bearer ' + key}
          // 不发送 Content-Type 给 GET 请求，避免有些服务拒绝

          const response = await fetch(url, {
            method: 'GET',
            headers,
            signal: AbortSignal.timeout(8000),
          })

          console.log(`[handleLMStudio] GET ${url} auth=${!!key} → ${response.status}`)

          if (response.ok) {
            const data = await response.json()
            console.log(`[handleLMStudio] ${url} 响应:`, JSON.stringify(data).slice(0, 262))

            let models: Array<{ id: string; multimodal?: boolean; vision?: boolean }> = []

            if (Array.isArray(data)) {
              models = data.map((m: any) => {
                const id = m.id || m.model || m.name || ''
                return extractModelCapabilities(id)
              })
            } else if (data.data && Array.isArray(data.data)) {
              models = data.data.map((m: any) => {
                const id = m.id || m.model || m.name || ''
                return extractModelCapabilities(id)
              })
            } else if (data.models && Array.isArray(data.models)) {
              models = data.models.map((m: any) => {
                const id = m.id || m.model || m.name || ''
                return extractModelCapabilities(id)
              })
            }

            const validModels = models.filter((m: any) => !!m.id && m.id.trim())
            if (validModels.length > 0) {
              console.log(`[handleLMStudio] ✅ 通过 ${url} 找到 ${validModels.length} 个模型`)
              return { models: validModels }
            }
          } else if (response.status === 401 && key) {
            // 401 → 跳过当前 key，下一个 key（null）会试无 auth
            console.log(`[handleLMStudio] ${url} 401，尝试无 Authorization`)
          }
        } catch (error: any) {
          console.log(`[handleLMStudio] ${url} 异常:`, error.message)
        }
      }
    }
  }

  // 全都失败 → 尝试 chat/completions 探测（GET，仅用于验证端点可达）
  console.log('[handleLMStudio] 所有端点失败，尝试 fallback 探测')
  return await tryChatEndpointForCapabilities(params)
}

/** 获取LM Studio服务器状态和加载的模型 */
async function getLMStudioServerStatus(params: { baseUrl: string; apiKey: string }): Promise<{ models?: Array<{ id: string; multimodal?: boolean; vision?: boolean }>; error?: string }> {
  console.log('[getLMStudioServerStatus] 尝试获取LM Studio状态')
  
  try {
    const healthResponse = await fetch(params.baseUrl + '/health', {
      method: 'GET',
      signal: AbortSignal.timeout(5000),
    })
    
    if (healthResponse.ok) {
      console.log('[getLMStudioServerStatus] LM Studio健康检查通过，但未返回模型列表')
      return { error: '服务器运行但未加载模型，请在LM Studio中先加载模型' }
    }
  } catch (error: any) {
    console.log('[getLMStudioServerStatus] 健康检查失败:', error.message)
  }
  
  return { error: '无法连接LM Studio，请检查API地址和端口是否正确，并确认LM Studio已启动' }
}

/** 处理本地服务回退 */
async function handleLocalServiceFallback(params: { baseUrl: string; apiKey: string }): Promise<{ models?: Array<{ id: string; multimodal?: boolean; vision?: boolean }>; error?: string }> {
  console.log('[handleLocalServiceFallback] 本地服务回退处理 — 无法获取模型列表')
  
  // 再尝试一次标准模型端点（有无 apiKey 都试试）
  try {
    const response = await fetch(params.baseUrl + '/models', {
      method: 'GET',
      headers: {
        'Authorization': 'Bearer ' + (params.apiKey || ''),
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(5000),
    })
    
    if (response.ok) {
      const data = await response.json()
      const models = extractModelsFromUnknownFormat(data)
      if (models.length > 0) {
        return { models }
      }
    }
  } catch (error) {
    // 继续
  }
  
  return { error: '无法获取模型列表，请检查服务是否运行且支持 /v1/models 接口' }
}

/** 尝试替代本地端点 */
async function tryAlternativeLocalEndpoints(params: { baseUrl: string; apiKey: string }): Promise<{ models?: Array<{ id: string; multimodal?: boolean; vision?: boolean }>; error?: string }> {
  console.log('[tryAlternativeLocalEndpoints] 尝试替代端点')
  
  const alternativeEndpoints = [
    '/api/v1/models',
    '/v1/chat/completions',
    '/health',
    '/v1/models',
    '/api/models',
    '/models'
  ]
  
  for (const endpoint of alternativeEndpoints) {
    try {
      const response = await fetch(params.baseUrl + endpoint, {
        method: 'GET',
        signal: AbortSignal.timeout(3000),
      })
      
      if (response.ok) {
        console.log('[tryAlternativeLocalEndpoints] ' + endpoint + ' 有响应')
        return { error: '服务器已连接但未返回模型列表，请检查模型是否已加载' }
      }
    } catch (error) {
      // 继续尝试下一个端点
    }
  }
  
  return { error: '本地服务无响应，请确认服务正在运行且地址正确' }
}

/** 处理空的本地模型列表 */
async function handleEmptyLocalModels(params: { baseUrl: string; apiKey: string }): Promise<{ models?: Array<{ id: string; multimodal?: boolean; vision?: boolean }>; error?: string }> {
  console.log('[handleEmptyLocalModels] 处理空模型列表情况')
  return { error: '服务器已连接但模型列表为空，请先在服务中加载模型' }
}

// ─── 🆕 v1.1: Cron 任务同步 ─────────────────────────
//
// 🔧 启动崩溃修复（2026-10-03）
//
// 【原 bug】L1386 往后有 20+ 个 `ipcMain.handle(...)` 写在**模块顶层**。
//   `registerSystemIpc()` 在 L1020 就已经闭合，这些 handler 属于孤儿：
//   它们在主进程加载时立即执行，而那一刻 Electron 的 ipcMain 尚未初始化，
//   于是 `npm run dev` 崩在：
//     TypeError: Cannot read properties of undefined (reading 'handle')
//       at ipcMain.handle("cron:sync-all", …)
//   —— 报错指向 cron，但根因是**整段孤儿代码**，不只是那一个 handler。
//
// 【修法】把整段包进 registerOrphanIpcHandlers()，由 registerSystemIpc() 调用。
//   这样注册时机与其它 handler 一致（在 app ready 之后），全部 20+ 个
//   cron / news / news-digest / news-mcp 通道才会真正生效。
//   顺带修好一个隐性 bug：这些通道此前**注册了但没人调用**，
//   preload.ts 里的 invoke 会一直 noSuchHandler 失败。
function registerOrphanIpcHandlers(): void {
  ipcMain.handle('cron:sync-all', async (_event, entries: Array<{
  name: string; schedule: string; action: string; enabled: boolean
}>) => {
  try {
    replaceAllCronEntries(entries)
    return { ok: true, count: entries.length }
  } catch (e: any) {
    console.error('[cron:sync-all] 失败:', e.message)
    return { ok: false, error: e.message }
  }
})

// ─── 🆕 v1.1: 新闻采集与推送 ────────────────────────
// （原先这里的 7 个 import 写在文件中部；包成函数后 import 不能再出现在
//   函数体内，故已上移到文件顶部。行为不变，只是位置合法了。）

// 新闻采集并筛选（UI 展示：不使用指纹去重，保留全部新闻供展示）
ipcMain.handle('news:collect', async () => {
  try {
    const allItems = await collectAll()
    const newItems = allItems  // UI 展示不去重，去重只用于邮件推送

    // 尝试用 LLM 筛选
    const pm = getProviderManager?.()
    const activeConfig = pm?.getActiveConfig?.()
    let items = newItems

    if (activeConfig && activeConfig.config && activeConfig.config.baseUrl) {
      try {
        const provider = new LLMProvider({
          baseUrl: activeConfig.config.baseUrl,
          apiKey: activeConfig.config.apiKey || '',
          model: activeConfig.config.model,
          maxContextTokens: activeConfig.config.maxContextTokens || 256000,
        })
        const llmCall = async (systemPrompt: string, userContent: string) => {
          const res = await provider.call({
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userContent },
            ],
            maxTokens: 4096,
            temperature: 0.3,
          })
          return res.text || ''
        }
        // 从用户配置中读取兴趣偏好
        let userInterests = '科技、AI、财经股市、热搜、开源、综合'
        try {
          const scheduler = getNewsDigestScheduler()
          if (scheduler?.getConfig?.()?.interests) {
            userInterests = scheduler.getConfig().interests
          }
        } catch {}
        const filtered = await filterWithLLM(newItems, llmCall, { interests: userInterests, maxItems: 20, minScore: 50 })
        items = filtered.map(f => f.item)
      } catch (e) {
        console.warn('[news:collect] LLM 筛选失败，使用热度降级:', e)
      }
    }

    return {
      items: items.map(item => ({
        id: item.id,
        title: item.title,
        url: item.url,
        source: item.source,
        category: item.category,
        pubDate: item.pubDate,
        summary: item.summary,
        hotScore: item.hotScore,
      })),
      totalCollected: allItems.length,
      filteredCount: items.length,
      date: new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' }),
    }
  } catch (err: any) {
    console.error('[news:collect] 失败:', err.message)
    return { items: [], totalCollected: 0, filteredCount: 0, date: '', error: err.message }
  }
})

// ─── 「为你推荐」轻量通道（2026-10-20）───────────────────────
// 为什么单开一条：news:collect 会跑 LLM 筛选（数秒到数十秒），聊天页每次
// 打开都调它会把输入栏卡住。这里只取原始榜单 + 10 分钟缓存、不跑 LLM，
// 保证「打开就有」；需要精选时仍走 news:collect / 邮件推送那条链路。
let _recommendCache: { at: number; items: Array<{ title: string; url: string; source: string; category: string; pubDate: string; hotScore: number }> } | null = null
const RECOMMEND_TTL_MS = 10 * 60 * 1000

ipcMain.handle('news:recommend', async (_e, opts?: { limit?: number; force?: boolean }) => {
  const limit = Math.max(1, Math.min(8, opts?.limit || 5))
  const fresh = !!_recommendCache && Date.now() - _recommendCache.at < RECOMMEND_TTL_MS
  if (fresh && !opts?.force && _recommendCache) {
    return { ok: true, cached: true, items: _recommendCache.items.slice(0, limit) }
  }
  try {
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('采集超时')), 15000)
    })
    const all = await Promise.race([collectAll(), timeout])
    const items = all
      .filter((i: NewsItem) => i?.title && i?.url)
      .sort((a: NewsItem, b: NewsItem) => (b.hotScore || 0) - (a.hotScore || 0))
      .slice(0, 8)
      .map((i: NewsItem) => ({
        title: i.title,
        url: i.url,
        source: i.source,
        category: i.category,
        pubDate: i.pubDate,
        hotScore: i.hotScore,
      }))
    if (items.length) {_recommendCache = { at: Date.now(), items }}
    return { ok: true, cached: false, items: items.slice(0, limit) }
  } catch (err: any) {
    if (_recommendCache) {
      return { ok: true, cached: true, stale: true, items: _recommendCache.items.slice(0, limit) }
    }
    console.warn('[news:recommend] 采集失败:', err?.message || err)
    return { ok: false, error: err?.message || '采集失败', items: [] }
  }
})

// 推送新闻到邮箱
ipcMain.handle('news:push-to-mail', async () => {
  try {
    const allItems = await collectAll()
    const newItems = deduplicate(allItems)
    const body = assembleDigestBody(newItems.map(item => ({
      item,
      relevanceScore: item.hotScore,
      reason: '',
      oneLiner: item.summary.slice(0, 50),
      digest: item.summary,
      tags: [item.category],
    })), {
      title: `📡 Lumina 新闻早报 — ${
        new Date().toLocaleDateString('zh-CN', {
          year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
        })
      }`,
    })

    sendMail('📡 Lumina 新闻早报', body, 'normal')
    return { ok: true, count: newItems.length }
  } catch (err: any) {
    console.error('[news:push-to-mail] 失败:', err.message)
    return { ok: false, error: err.message }
  }
})

// 🆕 采集 + 推送一键完成（返回采集结果 + 同时推送邮箱）
ipcMain.handle('news:collect-and-push', async () => {
  try {
    const allItems = await collectAll()
    const newItems = deduplicate(allItems)

    // 🧠 Horizon 式增强：LLM 筛选 + 背景补充
    let filteredItems: Array<{ item: NewsItem; relevanceScore: number; reason: string; oneLiner: string; digest: string; tags: string[] }> = []
    const pm = getProviderManager?.()
    const activeConfig = pm?.getActiveConfig?.()

    if (activeConfig && activeConfig.config && activeConfig.config.baseUrl && newItems.length > 0) {
      try {
        const provider = new LLMProvider({
          baseUrl: activeConfig.config.baseUrl,
          apiKey: activeConfig.config.apiKey || '',
          model: activeConfig.config.model,
          maxContextTokens: activeConfig.config.maxContextTokens || 256000,
        })
        const llmCall = async (systemPrompt: string, userContent: string) => {
          const res = await provider.call({
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userContent },
            ],
            maxTokens: 4096,
            temperature: 0.3,
          })
          return res.text || ''
        }

        // 1st pass: LLM 筛选 + 打分（使用用户兴趣偏好）
        let userInterests = 'AI科技、财经股市、热搜、开源、综合'
        try {
          const scheduler = getNewsDigestScheduler()
          if (scheduler?.getConfig?.()?.interests) {
            userInterests = scheduler.getConfig().interests
          }
        } catch {}
        filteredItems = await filterWithLLM(newItems, llmCall, { interests: userInterests })

        // 2nd pass: AI 背景补充（enrichment）
        if (filteredItems.length > 0) {
          await enrichItemsBackground(filteredItems)
        }
      } catch (e) {
        console.warn('[news:collect-and-push] LLM 筛选失败，使用热度降级:', e)
      }
    }

    // 用筛选后的列表（或降级为全量列表）组装
    const itemsToUse = filteredItems.length > 0 ? filteredItems : newItems.map(item => ({
      item,
      relevanceScore: item.hotScore,
      reason: '',
      oneLiner: item.summary.slice(0, 50),
      digest: item.summary,
      tags: [item.category],
    }))

    // 推送邮件（包含 enrichment 后的内容）
    if (itemsToUse.length > 0) {
      const body = assembleDigestBody(itemsToUse, {
        title: `📡 Lumina 新闻早报 — ${
          new Date().toLocaleDateString('zh-CN', {
            year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
          })
        }`,
      })
      sendMail('📡 Lumina 新闻早报', body, 'normal')
    }

    return {
      items: itemsToUse.map(f => ({
        id: f.item.id,
        title: f.item.title,
        url: f.item.url,
        source: f.item.source,
        category: f.item.category,
        pubDate: f.item.pubDate,
        summary: f.item.summary,
        hotScore: f.relevanceScore,
        background: (f as any).background,
        communitySummary: (f as any).communitySummary,
        enKeywords: (f as any).enKeywords,
      })),
      totalCollected: allItems.length,
      filteredCount: itemsToUse.length,
      pushedToMail: itemsToUse.length,
      date: new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' }),
    }
  } catch (err: any) {
    console.error('[news:collect-and-push] 失败:', err.message)
    return { items: [], totalCollected: 0, filteredCount: 0, pushedToMail: 0, date: '', error: err.message }
  }
})

// ── 📡 v2.0「雷达」：实时行情查询 ────────────────────────
ipcMain.handle('news:fetch-quotes', async () => {
  try {
    // 复用 newsCollector 里的 collectEastMoney
    const { DEFAULT_STOCK_WATCHLIST, parseEastMoneyQuote } = await import('../tools/impl/newsCollector')
    const { httpGet } = await import('../tools/utils/httpClient')

    const codes = DEFAULT_STOCK_WATCHLIST
    const fs = codes.join(',')
    const url = `https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2&fields=f2,f3,f4,f5,f6,f12,f14,f15,f16,f17,f18&secids=${fs}`

    const res = await httpGet(url, {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/json',
      'Referer': 'https://quote.eastmoney.com/',
    }, 10000)

    if (!res.ok) {throw new Error(`HTTP ${res.status}`)}

    const data = JSON.parse(res.text)
    const rawQuotes = data?.data?.diff || []

    const quotes = rawQuotes.map((item: any) => {
      const code = item.f12 || ''
      const name = item.f14 || ''
      const price = item.f2 ?? 0
      const changePercent = item.f3 ?? 0
      const changeAmount = item.f4 ?? 0
      const high = item.f15 ?? 0
      const low = item.f16 ?? 0
      const volume = item.f5 ?? 0
      const turnover = item.f6 ?? 0
      const open = item.f17 ?? 0
      const prevClose = item.f18 ?? 0
      if (!code || !name) {return null}
      return { code, name, price, changePercent, changeAmount, high, low, volume, turnover, open, prevClose }
    }).filter(Boolean)

    // 前三条是宽基指数
    const indices = quotes.slice(0, 3)
    const stocks = quotes.slice(3)

    return {
      ok: true,
      indices,
      stocks,
      updatedAt: new Date().toISOString(),
    }
  } catch (err: any) {
    console.error('[news:fetch-quotes] 失败:', err.message)
    return { ok: false, error: err.message, indices: [], stocks: [] }
  }
})

// ── 📡 v4.0: 新闻推送配置 IPC ─────────────────────────────
// （同样从文件中部上移到顶部，理由见上方 news:collect 处注释）

ipcMain.handle('news-digest:get-config', async () => {
  const s = getNewsDigestScheduler()
  return s.getConfig()
})

ipcMain.handle('news-digest:update-config', async (_event, config: any) => {
  try {
    const s = getNewsDigestScheduler()
    s.updateConfig(config)
    return { ok: true }
  } catch (err: any) {
    console.error('[news-digest:update-config] 失败:', err.message)
    return { ok: false, error: err.message }
  }
})

ipcMain.handle('news-digest:trigger', async (_event, slot?: number) => {
  try {
    const s = getNewsDigestScheduler()
    const result = await s.triggerManualPush(slot as any)
    return result
  } catch (err: any) {
    console.error('[news-digest:trigger] 失败:', err.message)
    return { ok: false, error: err.message }
  }
})

ipcMain.handle('news-digest:reset-cooldown', async () => {
  const s = getNewsDigestScheduler()
  s.resetCooldown()
  return { ok: true }
})

// ── v2.0: 系统弹窗（通知权限） ────────────────────────────
// 权限查询：UI 用它显示「已授权 / 未授权 / 已被系统拒绝」
ipcMain.handle('news-digest:notify-permission', async () => {
  try {
    const notifier = getSystemNotifier()
    return { ok: true, permission: notifier.getPermissionStatus() }
  } catch (err: any) {
    console.error('[news-digest:notify-permission] 失败:', err.message)
    return { ok: false, permission: 'default', error: err.message }
  }
})

// 申请权限：必须由用户点击触发（自动申请在部分平台会被系统忽略）
ipcMain.handle('news-digest:notify-request-permission', async () => {
  try {
    const notifier = getSystemNotifier()
    const permission = await notifier.requestPermission()
    return { ok: true, permission }
  } catch (err: any) {
    console.error('[news-digest:notify-request-permission] 失败:', err.message)
    return { ok: false, permission: 'default', error: err.message }
  }
})

// 可用新闻源信息（给前端配置面板展示）
const NEWS_SOURCES_META = [
  { id: 'rss', label: 'RSS 新闻源', description: '通用 RSS/Atom 源（36氪、InfoQ、Solidot 等）', icon: '📡', defaultEnabled: true },
  { id: 'zhihu', label: '知乎热榜', description: '知乎每日热榜、精选话题', icon: '🔵', defaultEnabled: true },
  { id: 'finance', label: '财经资讯', description: '东财/新浪财经/华尔街见闻等财经要闻', icon: '💰', defaultEnabled: true },
  { id: 'github', label: 'GitHub Trending', description: 'GitHub 趋势仓库与开源动态', icon: '🐙', defaultEnabled: true },
]

ipcMain.handle('news-sources:get-available', async () => {
  return NEWS_SOURCES_META
})

// ─── 🆕 v3.1: MCP 新闻工具 IPC ──────────────────────
ipcMain.handle('news-mcp:collect', async () => {
  try {
    const { collectAll } = await import('../tools/impl/newsCollector')
    const { deduplicate } = await import('../tools/impl/newsDigest')
    const allItems = await collectAll()
    const items = deduplicate(allItems)
    return { ok: true, count: items.length, items: items.slice(0, 50) }
  } catch (err: any) { return { ok: false, error: err.message } }
})

ipcMain.handle('news-mcp:fetch-full', async (_e, url: string) => {
  try {
    const { extractFullText } = await import('../newstools/trafilaturaExtractor')
    return await extractFullText(url)
  } catch (err: any) { return { ok: false, error: err.message } }
})

ipcMain.handle('news-mcp:generate-digest', async (_e, maxItems?: number, includeEnglish?: boolean) => {
  try {
    const { generateBilingualDigest } = await import('../newstools/bilingualDigest')
    return await generateBilingualDigest(maxItems || 20, includeEnglish !== false)
  } catch (err: any) { return { ok: false, error: err.message } }
})

ipcMain.handle('news-mcp:manage-subscription', async (_e, action: string, email?: string) => {
  try {
    const { manageSubscription } = await import('../newstools/subscriptionManager')
    return await manageSubscription(action, email)
  } catch (err: any) { return { ok: false, error: err.message } }
})

ipcMain.handle('news-mcp:publish-site', async (_e, source: string, date?: string) => {
  try {
    const { publishToGitHubPages } = await import('../newstools/ghPagesPublisher')
    return await publishToGitHubPages(source, date)
  } catch (err: any) { return { ok: false, error: err.message } }
})

} // ← registerOrphanIpcHandlers() 结束

// ═══════════════════════════════════════════════════════════
// 🆕 v1.0 决策征询 IPC（ask_decision 的主进程侧接线）
//
// 职责很薄：把 decisionService 的事件转给渲染进程，再把 UI 的回答收回去。
// 所有业务逻辑（超时/校验/默认）都在 decisionService 里，这里不做重复判断。
//
// ⚠️ 依赖必须用**静态 import**，不能写成模块顶层的 require()：
//    electron-vite 打包时会把 systemIpc 拆进 out/main/chunks/*.js，
//    运行时 require('../decisionService') 会相对 chunk 目录解析成
//    out/main/decisionService（不存在）→ 启动即崩 "Cannot find module"。
//    本文件里其它 require('../xxx') 之所以没事，是因为它们都在**函数体内**（延后执行），
//    被 Vite 静态处理掉了；而顶层 IIFE 里的 require 不会被转换。
//
// 🔧 2026-10-03：这段**原来是顶层 IIFE**（`;(function(){…})()`），会在模块加载时
//    立即执行 → ipcMain 尚未就绪 → 又一次
//    “Cannot read properties of undefined (reading 'handle')”。
//    改为普通函数，由 registerSystemIpc() 调用。
//    静态 import 保持在文件顶部（已上移），因此仍满足上面的 chunk 解析要求。
// ═══════════════════════════════════════════════════════════
function registerDecisionIpc(): void {
  // 用 getAllWindows()[0] 而非捕获的 mainWindow 引用：窗口重建后旧引用会失效，
  // 而这个函数是模块级的，拿不到 registerSystemIpc 的 mainWindow 参数。
  // 每次发事件时现取当前窗口，比缓存引用更安全。
  const currentWindow = () => {
    try { return BrowserWindow.getAllWindows()[0] } catch { return undefined }
  }

  onDecisionEvent((ev: any) => {
    const win = currentWindow()
    if (!win) {return} // 窗口关了，决策会自己走超时兜底
    try {
      if (ev.type === 'requested') {win.webContents.send('decision:requested', ev.request)}
      else if (ev.type === 'resolved') {win.webContents.send('decision:resolved', ev)}
    } catch { /* 窗口在发送瞬间被销毁 */ }
  })

  ipcMain.handle('decision:answer', async (_e, p: { id: string; selectedIds: string[]; customText?: string; cancelled?: boolean }) => {
    try {
      const r = submitDecisionAnswer({
        id: p.id,
        selectedIds: Array.isArray(p.selectedIds) ? p.selectedIds : [],
        customText: p.customText,
        cancelled: p.cancelled,
      })
      return { ok: r.ok, error: r.error }
    } catch (err: any) { return { ok: false, error: err.message } }
  })

  ipcMain.handle('decision:cancel', async (_e, id: string) => {
    try { return { ok: cancelDecision(String(id || '')) } } catch { return { ok: false } }
  })

  ipcMain.handle('decision:cancel-all', async () => {
    try { return { ok: true, count: cancelAllDecisions() } } catch { return { ok: false, count: 0 } }
  })

  ipcMain.handle('decision:pending', async () => {
    try { return { ok: true, pending: getPendingDecisions() } } catch { return { ok: false, pending: [] } }
  })

  ipcMain.handle('decision:config', async (_e, patch?: any) => {
    try {
      return { ok: true, config: patch ? setDecisionConfig(patch) : getDecisionConfig() }
    } catch (err: any) { return { ok: false, error: err.message } }
  })
}
