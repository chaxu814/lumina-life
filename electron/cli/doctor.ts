// ============================================================
// cli/doctor.ts — 系统诊断命令 (v2.0)
//
// 🔐 v2.0: 新增 LLM 连接测试, SSL 安全, 工具完整性,
//           磁盘空间, 日志错误检查
// ============================================================

import { execSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

export async function handleDoctor(_args: string[]): Promise<{ ok: boolean; data?: any; error?: string }> {
  const checks: { name: string; pass: boolean; detail: string }[] = []

  // ═══════════════════════════════════════════════════════════
  // 1. 运行时版本
  // ═══════════════════════════════════════════════════════════
  checks.push({
    name: 'Node.js 版本',
    pass: process.versions.node ? true : false,
    detail: process.versions.node || '未知',
  })
  checks.push({
    name: 'Electron 版本',
    pass: process.versions.electron ? true : false,
    detail: process.versions.electron || '未知',
  })

  // ═══════════════════════════════════════════════════════════
  // 2. 系统信息
  // ═══════════════════════════════════════════════════════════
  const platform = os.platform()
  const release = os.release()
  const totalMem = (os.totalmem() / 1024 / 1024 / 1024).toFixed(1)
  const freeMem = (os.freemem() / 1024 / 1024 / 1024).toFixed(1)
  checks.push({
    name: '操作系统',
    pass: true,
    detail: `${platform} ${release} | 内存 ${freeMem}GB / ${totalMem}GB`,
  })

  // ═══════════════════════════════════════════════════════════
  // 3. 工作目录
  // ═══════════════════════════════════════════════════════════
  try {
    const cwd = process.cwd()
    const exists = fs.existsSync(cwd)
    let writable = false
    if (exists) {
      try {
        const probe = path.join(cwd, '.doctor_probe')
        fs.writeFileSync(probe, 'probe')
        fs.unlinkSync(probe)
        writable = true
      } catch { /* 不可写 */ }
    }
    checks.push({
      name: '工作目录',
      pass: exists && writable,
      detail: exists ? `${cwd}${writable ? '' : ' ⚠️ 不可写'}` : '❌ 不存在',
    })
  } catch (err: any) {
    checks.push({ name: '工作目录', pass: false, detail: err.message })
  }

  // ═══════════════════════════════════════════════════════════
  // 4. 磁盘空间
  // ═══════════════════════════════════════════════════════════
  try {
    const drive = path.parse(process.cwd()).root || '/'

    // 跨平台磁盘空间检测：优先 Node.js 18+ fs.statfs，降级到 platform-specific
    let freeBytes = 0
    try {
      // Node.js 18+ native
      // @ts-ignore — fs.statfs 在 ESNext 下可能无类型
      if (typeof fs.statfs === 'function') {
        const s = fs.statfsSync(drive)
        freeBytes = Number(s.bfree) * Number(s.bsize)
      }
    } catch { /* 降级 */ }

    if (freeBytes === 0) {
      // fs.statfs 不可用，走平台命令
      if (process.platform === 'win32') {
        const freeMatch = execSync(`fsutil volume diskfree "${drive}" 2>nul`, { timeout: 3000 })
          .toString().match(/([\d]+)\s*免费.*字节/i)
        if (freeMatch) freeBytes = parseInt(freeMatch[1].replace(/,/g, ''), 10)
      } else {
        const dfOut = execSync(`df -k "${drive}" 2>/dev/null | tail -1`, { timeout: 3000 })
          .toString().trim()
        if (dfOut) {
          const parts = dfOut.split(/\s+/)
          if (parts.length >= 4) freeBytes = parseInt(parts[3], 10) * 1024
        }
      }
    }

    const freeGB = (freeBytes / 1024 / 1024 / 1024).toFixed(1)
    checks.push({
      name: '磁盘空间',
      pass: freeBytes > 500 * 1024 * 1024, // 500MB+
      detail: `${drive} 可用 ${freeGB}GB`,
    })
  } catch {
    checks.push({ name: '磁盘空间', pass: true, detail: '无法检测' })
  }

  // ═══════════════════════════════════════════════════════════
  // 5. .env 配置
  // ═══════════════════════════════════════════════════════════
  try {
    const envPath = path.join(process.cwd(), '.env')
    const exists = fs.existsSync(envPath)
    let keyCount = 0
    if (exists) {
      const content = fs.readFileSync(envPath, 'utf-8')
      keyCount = content.split('\n').filter(l => l.includes('=') && !l.startsWith('#') && !l.startsWith('\n')).length
    }
    checks.push({
      name: '.env 配置文件',
      pass: exists,
      detail: exists ? `${keyCount} 个有效键值对` : '未找到（可选项，非必须）',
    })
  } catch (err: any) {
    checks.push({ name: '.env 配置文件', pass: false, detail: err.message })
  }

  // ═══════════════════════════════════════════════════════════
  // 6. 🆕 SSL 安全配置检查
  // ═══════════════════════════════════════════════════════════
  const allowInsecure = process.env.LUMINA_ALLOW_INSECURE_SSL === '1'
  const oldEnvVar = process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0'
  checks.push({
    name: 'SSL 证书验证',
    pass: !allowInsecure && !oldEnvVar,
    detail: allowInsecure
      ? '⚠️ LUMINA_ALLOW_INSECURE_SSL=1 已设置 — 关闭了 SSL 验证'
      : oldEnvVar
        ? '⚠️ NODE_TLS_REJECT_UNAUTHORIZED=0 — 关闭了 SSL 验证'
        : '已启用（安全）',
  })

  // ═══════════════════════════════════════════════════════════
  // 7. Agent 配置
  // ═══════════════════════════════════════════════════════════
  try {
    const { getAgentConfig } = await import('../agentConfig')
    const config = getAgentConfig()
    const statuses = config.getAllStatus()
    const configured = statuses.filter(s => s.configured)
    checks.push({
      name: 'Agent 配置',
      pass: configured.length > 0,
      detail: `${configured.length}/${statuses.length} 个已配置 (${configured.map(s => s.id).join(', ') || '无'})`,
    })
  } catch (err: any) {
    checks.push({ name: 'Agent 配置', pass: false, detail: err.message })
  }

  // ═══════════════════════════════════════════════════════════
  // 8. 🆕 LLM 连接测试（只做配置检查，不做真实请求以免耗时）
  // ═══════════════════════════════════════════════════════════
  try {
    const { getAgentConfig } = await import('../agentConfig')
    const config = getAgentConfig()
    const statuses = config.getAllStatus()
    const configured = statuses.filter(s => {
      try {
        const cfg = config.get(s.id)
        return cfg?.provider && cfg?.model
      } catch { return false }
    })
    // 检查是否有 provider 设置但 model 为空
    const partial = statuses.filter(s => {
      try {
        const cfg = config.get(s.id)
        return cfg?.provider && !cfg?.model
      } catch { return false }
    })
    checks.push({
      name: 'LLM 配置',
      pass: configured.length > 0,
      detail: configured.length > 0
        ? `${configured.map(s => `${s.id}(${config.get(s.id)?.model || '?'})`).join(', ')}`
        : partial.length > 0
          ? `⚠️ ${partial.map(s => s.id).join(', ')} 有 provider 但 model 为空`
          : '❌ 未配置任何 LLM',
    })
  } catch (err: any) {
    checks.push({ name: 'LLM 配置', pass: false, detail: err.message })
  }

  // ═══════════════════════════════════════════════════════════
  // 9. 审批服务
  // ═══════════════════════════════════════════════════════════
  try {
    const { getApprovalService } = await import('../approvalService')
    const svc = getApprovalService()
    const cfg = svc.getConfig()
    checks.push({
      name: '审批服务',
      pass: true,
      detail: `级别: ${cfg.executionLevel} | 超时: ${cfg.defaultTimeoutMs / 1000}s | 心跳: ${cfg.heartbeatIntervalMs / 1000}s`,
    })
  } catch (err: any) {
    checks.push({ name: '审批服务', pass: false, detail: err.message })
  }

  // ═══════════════════════════════════════════════════════════
  // 10. 记忆系统
  // ═══════════════════════════════════════════════════════════
  try {
    const { getMemoryStore } = await import('../memory/memoryStore')
    const store = getMemoryStore()
    const facts = store.getFacts()
    checks.push({
      name: '记忆系统',
      pass: true,
      detail: `已加载，${facts.length} 条事实`,
    })
  } catch (err: any) {
    checks.push({ name: '记忆系统', pass: false, detail: err.message })
  }

  // ═══════════════════════════════════════════════════════════
  // 11. 🆕 工具加载完整性
  // ═══════════════════════════════════════════════════════════
  try {
    const toolsDir = path.join(__dirname, '..', 'tools', 'impl')
    let implFiles: string[] = []
    try { implFiles = fs.readdirSync(toolsDir).filter(f => f.endsWith('.ts') && !f.includes('.bak')) } catch { /*无目录*/ }

    // 主要工具列表（不强制全部存在，只检查核心）
    const coreTools = ['shell.ts', 'webSearch.ts', 'webFetch.ts', 'contentCollector.ts',
      'browser.ts', 'memory.ts', 'fileReadWrite.ts', 'cron.ts', 'git.ts']
    const missing = coreTools.filter(t => !implFiles.includes(t))
    const found = coreTools.filter(t => implFiles.includes(t))

    checks.push({
      name: '工具完整性',
      pass: missing.length === 0,
      detail: `${found.length}/${coreTools.length} 核心工具就绪${missing.length ? ` ❌ 缺失: ${missing.join(', ')}` : ''}`,
    })
  } catch (err: any) {
    checks.push({ name: '工具完整性', pass: true, detail: `检查跳过: ${err.message}` })
  }

  // ═══════════════════════════════════════════════════════════
  // 12. 定时任务
  // ═══════════════════════════════════════════════════════════
  try {
    const { getCronStats } = await import('../tools/impl/cron')
    const stats = getCronStats()
    checks.push({
      name: '定时任务',
      pass: true,
      detail: `${stats.entryCount} 个任务${stats.running ? ' (运行中)' : ' (未启动)'}`,
    })
  } catch (err: any) {
    checks.push({ name: '定时任务', pass: true, detail: '0 个 (服务不可用)' })
  }

  // ═══════════════════════════════════════════════════════════
  // 13. 🆕 日志与错误检查
  // ═══════════════════════════════════════════════════════════
  try {
    const logDir = path.join(process.cwd(), 'logs')
    const exists = fs.existsSync(logDir)
    let recentErrors = 0
    let lastModified = ''
    if (exists) {
      const files = fs.readdirSync(logDir)
        .filter(f => f.endsWith('.log') || f.endsWith('.txt'))
        .map(f => ({ name: f, mtime: fs.statSync(path.join(logDir, f)).mtime }))
        .sort((a, b) => b.mtime.getTime() - a.mtime.getTime())
      if (files.length > 0) {
        const latest = path.join(logDir, files[0].name)
        const content = fs.readFileSync(latest, 'utf-8').slice(-10000)
        recentErrors = (content.match(/\berror\b/gi) || []).length
        lastModified = files[0].mtime.toISOString().slice(0, 19)
      }
    }
    checks.push({
      name: '日志状态',
      pass: recentErrors < 5,
      detail: exists
        ? `最近日志 ${lastModified}，近期错误 ${recentErrors} 条${recentErrors >= 5 ? ' ⚠️ 建议检查' : ''}`
        : '无日志目录（正常）',
    })
  } catch {
    checks.push({ name: '日志状态', pass: true, detail: '检查跳过' })
  }

  // ═══════════════════════════════════════════════════════════
  // 14. 委托管理器
  // ═══════════════════════════════════════════════════════════
  try {
    const { getDelegationManager } = await import('../delegationManager')
    const dm = getDelegationManager()
    const teamStatus = dm.getTeamConfigStatus()
    const registered = teamStatus.filter(s => s.configured)
    const isCLI = process.env.LUMINA_CLI_MODE === '1' || process.argv.includes('--cli')
    checks.push({
      name: '委托管理器',
      pass: isCLI || registered.length > 0,
      detail: isCLI
        ? `CLI 模式跳过 (${teamStatus.length} 个 Agent 可配置)`
        : `${registered.length}/${teamStatus.length} 个已注册${registered.length ? ` (${registered.map(s => `${s.icon}${s.memberId}`).join(', ')})` : ''}`,
    })
  } catch (err: any) {
    checks.push({ name: '委托管理器', pass: true, detail: `不可用: ${err.message}` })
  }

  // ═══════════════════════════════════════════════════════════
  // ═══ 输出 ═══
  // ═══════════════════════════════════════════════════════════
  const passCount = checks.filter(c => c.pass).length
  const failCount = checks.filter(c => !c.pass).length
  const warnCount = checks.filter(c => c.pass && c.detail.includes('⚠️')).length

  const lines = checks.map(c =>
    `  ${c.pass ? '✅' : '❌'} ${c.name.padEnd(18)} ${c.detail}`
  )

  const summary = `
╔══════════════════════════════════════╗
║   🔍 Lumina 系统诊断报告 (v2.0)     ║
╚══════════════════════════════════════╝

${lines.join('\n')}

📊 总计: ${passCount}/${checks.length} 项通过
${failCount > 0 ? `⚠️   ${failCount} 项失败` : ''}
${warnCount > 0 ? `⚠️   ${warnCount} 项有警告` : ''}
`

  return { ok: true, data: summary }
}
