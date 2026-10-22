// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
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
// 工具完整性检查改为查**注册表**而不是查文件名。
// 旧实现按 `impl/` 目录里是否存在 webSearch.ts / memory.ts / fileReadWrite.ts 判断，
// 而这些文件早已改名/拆分（fileReadWrite → fileRead + fileWrite，memory → memory_v2），
// 于是 139 个工具全部注册通过的同时，诊断报告却打印「0/9 核心工具就绪」——
// 诊断工具自己先坏了。注册表才是「工具是否可用」的唯一事实源。
import { getToolNames, validateToolRegistry } from '../tools/registry'

export async function handleDoctor(_args: string[]): Promise<{ ok: boolean; data?: any; error?: string }> {
  const checks: { name: string; pass: boolean; detail: string }[] = []
  // ══════════════════════════════════════════════════════════════
  // 1. 运行时版本
  // ══════════════════════════════════════════════════════════════
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
  // ══════════════════════════════════════════════════════════════
  // 2. 系统信息
  // ══════════════════════════════════════════════════════════════
  const platform = os.platform()
  const release = os.release()
  const totalMem = (os.totalmem() / 1024 / 1024 / 1024).toFixed(1)
  const freeMem = (os.freemem() / 1024 / 1024 / 1024).toFixed(1)
  checks.push({
    name: '操作系统',
    pass: true,
    detail: `${platform} ${release} | 内存 ${freeMem}GB / ${totalMem}GB`,
  })
  // ══════════════════════════════════════════════════════════════
  // 3. 工作目录
  // ══════════════════════════════════════════════════════════════
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
  // ══════════════════════════════════════════════════════════════
  // 4. 磁盘空间
  // ══════════════════════════════════════════════════════════════
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
        if (freeMatch) {freeBytes = parseInt(freeMatch[1].replace(/,/g, ''), 10)}
      } else {
        const dfOut = execSync(`df -k "${drive}" 2>/dev/null | tail -1`, { timeout: 3000 })
          .toString().trim()
        if (dfOut) {
          const parts = dfOut.split(/\s+/)
          if (parts.length >= 4) {freeBytes = parseInt(parts[3], 10) * 1024}
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
  // ══════════════════════════════════════════════════════════════
  // 5. .env 配置
  // ══════════════════════════════════════════════════════════════
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
  // ══════════════════════════════════════════════════════════════
  // 6. 🆕 SSL 安全配置检查
  // ══════════════════════════════════════════════════════════════
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
  // ══════════════════════════════════════════════════════════════
  // 7. Agent 配置
  // ══════════════════════════════════════════════════════════════
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
  // ══════════════════════════════════════════════════════════════
  // 7b. 生效的配置文件路径（2026-10-20 新增）
  //     「改了配置不生效」绝大多数是改错了文件：仓库内有一份同名 json，
  //     userData 又有 Lumina Life / lumina-life 两个目录。直接报绝对路径。
  // ══════════════════════════════════════════════════════════════
  try {
    const { getAgentConfig } = await import('../agentConfig')
    const p = getAgentConfig().getConfigPath()
    const exists = p ? fs.existsSync(p) : false
    checks.push({
      name: '生效配置路径',
      pass: true,
      detail: exists ? p : `${p}（文件尚未生成，保存一次模型配置后创建）`,
    })
  } catch (err: any) {
    checks.push({ name: '生效配置路径', pass: true, detail: `读取失败: ${err.message}` })
  }
  // ══════════════════════════════════════════════════════════════
  // 8. 🆕 LLM 连接测试（只做配置检查，不做真实请求以免耗时）
  // ══════════════════════════════════════════════════════════════
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
  // ══════════════════════════════════════════════════════════════
  // 9. 审批服务
  // ══════════════════════════════════════════════════════════════
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
  // ══════════════════════════════════════════════════════════════
  // 10. 记忆系统
  // ══════════════════════════════════════════════════════════════
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
  // ══════════════════════════════════════════════════════════════
  // 11. 🆕 工具加载完整性（按注册表校验，2026-10-19 修正）
  // ══════════════════════════════════════════════════════════════
  try {
    const names = getToolNames()
    // 核心工具按**工具名**校验：这些是 agent 档日常可用的底线能力
    const coreTools = [
      'shell_exec', 'web_search', 'web_fetch', 'browser', 'memory_search',
      'file_read', 'file_write', 'cron_schedule', 'git_status',
    ]
    const missing = coreTools.filter(t => !names.has(t))
    const registry = validateToolRegistry()
    const registryIssue = [...registry.missingDefs, ...registry.missingImpls]

    checks.push({
      name: '工具完整性',
      pass: missing.length === 0 && registry.ok,
      detail: `核心 ${coreTools.length - missing.length}/${coreTools.length} 就绪 · 注册表 ${names.size} 个工具`
        + (missing.length ? ` ❌ 缺失: ${missing.join(', ')}` : '')
        + (!registry.ok ? ` ❌ 注册表异常: ${registryIssue.join(', ')}` : ''),
    })
  } catch (err: any) {
    checks.push({ name: '工具完整性', pass: false, detail: `检查异常: ${err.message}` })
  }
  // ══════════════════════════════════════════════════════════════
  // 12. v3.34: agent.json 工具白名单是否真的生效
  // ══════════════════════════════════════════════════════════════
  //
  // 【为什么要这项检查】agent.json 的 tools.whitelist 在 v3.34 之前是死字段 ——
  // 用户改了半天以为在收窄权限，实际什么都没发生。这是最容易骗过人的一种配置。
  // v3.34 把它接上了，但默认不启用（enforceWhitelist 默认 false），
  // 因为仓库里三个 agent.json 的 whitelist 是当文档写的，内容与 rolePolicy
  // 差距很大；突然生效会让 yak 丢掉十几个工具。
  //
  // 所以这里显式报出来：「你写了白名单，但它当前不生效」—— 杜绝静默陷阱。
  try {
    const notes: string[] = []
    for (const id of ['lumina', 'yak', 'recha']) {
      const p = path.join(process.cwd(), 'agents', id, 'agent.json')
      if (!fs.existsSync(p)) {continue}
      let cfg: any
      try { cfg = JSON.parse(fs.readFileSync(p, 'utf-8')) } catch {continue}
      const wl: string[] = cfg?.tools?.whitelist ?? []
      if (wl.length === 0) {continue}
      const enforced = cfg?.tools?.enforceWhitelist === true
      notes.push(
        enforced
          ? `${id}: 白名单已启用（${wl.length} 项）`
          : `${id}: 白名单写了 ${wl.length} 项但**未生效**（加 "enforceWhitelist": true 启用）`,
      )
    }
    checks.push({
      name: 'agent 工具白名单',
      pass: true,
      detail: notes.length ? notes.join(' | ') : '未配置白名单（正常）',
    })
  } catch (err: any) {
    checks.push({ name: 'agent 工具白名单', pass: true, detail: `检查跳过: ${err.message}` })
  }
  // ══════════════════════════════════════════════════════════════
  // 13. 定时任务
  // ══════════════════════════════════════════════════════════════
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
  // ══════════════════════════════════════════════════════════════
  // 14. 🆕 日志与错误检查
  // ══════════════════════════════════════════════════════════════
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
  // ══════════════════════════════════════════════════════════════
  // 15. 委托管理器
  // ══════════════════════════════════════════════════════════════
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
  // ══════════════════════════════════════════════════════════════
  // ═══ 输出 ═══
  // ══════════════════════════════════════════════════════════════
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
