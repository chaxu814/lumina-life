// ============================================================
// cli/index.ts — Lumina Life 命令行入口 (v8.0)
//
// 可作为 Electron headless 模式运行:
//   electron out/cli/index.js chat "你好"
//   electron out/cli/index.js tool search "天气"
//   electron out/cli/index.js --help
//
// 或通过 lumina.cmd 包装调用
// ============================================================

import { app } from 'electron'
import { initAgentConfig } from '../agentConfig'
import { initDelegationManager } from '../delegationManager'
import { initApprovalService } from '../approvalService'
import { getMemoryStore } from '../memory/memoryStore'
import { initSecurityGuard } from '../securityGuard'
import { getSessionManager } from '../sessionManager'
import { getSkillPool } from '../skillPool'
import { registerAllTools } from '../tools/index'

import { handleChat } from './chat'
import { handleTool } from './tool'
import { handleAgent } from './agent'
import { handleMemory } from './memory'
import { handleConfig } from './config'
import { handleSkill } from './skill'
import { handleCron } from './cron'
import { handleDoctor } from './doctor'

// ═══════════════════════════════════════════════════════════
// CLI 命令注册表
// ═══════════════════════════════════════════════════════════

interface CliCommand {
  name: string
  alias?: string
  description: string
  usage: string
  handler: (args: string[]) => Promise<{ ok: boolean; data?: any; error?: string }>
}

const COMMANDS: CliCommand[] = [
  {
    name: 'chat', alias: 'c',
    description: '向 Lumina 发送一条消息并获取回复',
    usage: 'lumina chat "你好" [--mode agent|chat|developer] [--agent lumina|recha|yak]',
    handler: handleChat,
  },
  {
    name: 'tool', alias: 't',
    description: '直接执行一个工具',
    usage: 'lumina tool run <toolName> --key value [--key2 value2]',
    handler: handleTool,
  },
  {
    name: 'agent', alias: 'a',
    description: '查看/管理 Agent 状态',
    usage: 'lumina agent list | lumina agent status <agentId>',
    handler: handleAgent,
  },
  {
    name: 'memory', alias: 'm',
    description: '搜索或查看记忆',
    usage: 'lumina memory search <query> | lumina memory list [--limit 10]',
    handler: handleMemory,
  },
  {
    name: 'config', alias: 'cfg',
    description: '查看/修改配置',
    usage: 'lumina config show | lumina config set <key>=<value>',
    handler: handleConfig,
  },
  {
    name: 'skill', alias: 's',
    description: '管理技能',
    usage: 'lumina skill list | lumina skill install <path>',
    handler: handleSkill,
  },
  {
    name: 'cron', alias: 'cr',
    description: '管理定时任务',
    usage: 'lumina cron list | lumina cron add --schedule "0 9 * * *" --action "道早安"',
    handler: handleCron,
  },
  {
    name: 'doctor', alias: 'd',
    description: '系统诊断',
    usage: 'lumina doctor',
    handler: handleDoctor,
  },
]

// ═══════════════════════════════════════════════════════════
// CLI 主流程
// ═══════════════════════════════════════════════════════════

async function runCLI(argv: string[]): Promise<void> {
  // 找到脚本路径的索引 (electron exe 之后、第一个非-electron-flag 参数)
  let startIdx = 1  // 默认跳过 exe 路径
  for (let i = 1; i < argv.length; i++) {
    if (argv[i].endsWith('.js') || argv[i].endsWith('.mjs') || argv[i].endsWith('.cjs')) {
      startIdx = i + 1  // 跳过脚本路径本身
      break
    }
  }
  // 过滤掉 --cli 和 --headless (它们可能在任意位置)
  const args = argv.slice(startIdx).filter(a => a !== '--cli' && a !== '--headless' && a !== '--no-sandbox')
  const startTime = Date.now()

  // --help
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    printHelp()
    return
  }

  // --version
  if (args[0] === '--version' || args[0] === '-v') {
    console.log(`Lumina Life v${require('../../package.json').version}`)
    return
  }

  // Parse command
  const cmdName = args[0].toLowerCase()
  const cmd = COMMANDS.find(c => c.name === cmdName || c.alias === cmdName)

  if (!cmd) {
    console.error(`❌ 未知命令: ${cmdName}`)
    console.error(`   可用命令: ${COMMANDS.map(c => c.name).join(', ')}`)
    console.error(`   使用 --help 查看详情`)
    process.exit(1)
  }

  // 初始化核心服务
  await initCore()

  // 执行命令
  const cmdArgs = args.slice(1)
  try {
    const result = await cmd.handler(cmdArgs)
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)

    if (result.ok) {
      if (result.data !== undefined) {
        printResult(result.data)
      }
      console.error(`✅ 完成 (${elapsed}s)`)
    } else {
      console.error(`❌ 失败: ${result.error || '未知错误'} (${elapsed}s)`)
      process.exit(1)
    }
  } catch (err: any) {
    console.error(`❌ 异常: ${err.message || err}`)
    process.exit(1)
  }
}

// ═══════════════════════════════════════════════════════════
// 核心初始化
// ═══════════════════════════════════════════════════════════

let initialized = false

async function initCore(): Promise<void> {
  if (initialized) return
  initialized = true

  registerAllTools()
  initSecurityGuard({ enabled: true })
  initApprovalService({ enabled: false }) // CLI 模式默认不审批
  initAgentConfig()
  initDelegationManager()

  // 预加载 MemoryStore
  try { getMemoryStore() } catch { /* memory store 可能依赖 window */ }
}

// ═══════════════════════════════════════════════════════════
// 输出
// ═══════════════════════════════════════════════════════════

function printHelp(): void {
  console.log(`
╔══════════════════════════════════════════╗
║   🌸 Lumina Life — 命令行工具          ║
╚══════════════════════════════════════════╝

用法: lumina <命令> [参数]

命令:
`)

  for (const cmd of COMMANDS) {
    const alias = cmd.alias ? ` (别名: ${cmd.alias})` : ''
    console.log(`  ${cmd.name.padEnd(12)} ${cmd.description}${alias}`)
    console.log(`    ${cmd.usage}`)
    console.log()
  }

  console.log('全局选项:')
  console.log('  --help, -h    显示帮助')
  console.log('  --version, -v 显示版本')
  console.log()
}

function printResult(data: any): void {
  if (typeof data === 'string') {
    console.log(data)
  } else if (Buffer.isBuffer(data)) {
    process.stdout.write(data)
  } else {
    console.log(JSON.stringify(data, null, 2))
  }
}

// ═══════════════════════════════════════════════════════════
// 导出 (供 cli-entry.ts 调用)
// ═══════════════════════════════════════════════════════════

export default runCLI
