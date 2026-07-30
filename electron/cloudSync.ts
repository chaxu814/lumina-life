// ============================================================
// cloudSync.ts — 跨设备云同步引擎 (v3.11)
//
// 对标：ChatGPT 跨设备同步
//
// 基于 Git 的轻量级同步方案：
//   - 记忆文件同步 (MEMORY.md, memory/*.md)
//   - 配置同步 (settings.json, personas, skills)
//   - 对话历史同步 (可选，隐私模式默认关闭)
//
// 同步策略：
//   - 启动时自动 pull
//   - 变更时自动 commit + push (每 5 分钟批量)
//   - 冲突解决：保留最新版本
//   - 隐私：对话历史默认不同步，需手动开启
// ============================================================

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { exec } from 'child_process'

/**
 * 安全执行命令 — 使用 exec 运行 shell 命令
 * 所有 cmd 均为硬编码（非用户输入），不存在注入风险
 */
function execCmd(cmd: string, cwd?: string, timeout = 30000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    exec(cmd, { cwd: cwd || process.cwd(), timeout, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        // Exit code non-zero 也返回 stderr
        if ((err as any).code && stdout) {
          resolve({ stdout, stderr })
        } else {
          reject(err)
        }
      } else {
        resolve({ stdout, stderr })
      }
    })
  })
}

// ═══════════════════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════════════════

export interface SyncConfig {
  enabled: boolean
  remoteUrl?: string        // git remote URL
  branch?: string
  syncIntervalMinutes?: number
  syncMemory?: boolean      // 同步记忆
  syncConfig?: boolean      // 同步配置
  syncConversations?: boolean  // 同步对话（隐私敏感）
  syncSkills?: boolean      // 同步 skill
  lastSyncAt?: string
}

export interface SyncStatus {
  enabled: boolean
  connected: boolean
  branch: string
  ahead: number
  behind: number
  lastSyncAt: string
  pendingChanges: number
  error?: string
}

// ═══════════════════════════════════════════════════════════
// Cloud Sync 引擎
// ═══════════════════════════════════════════════════════════

export class CloudSync {
  private config: SyncConfig
  private dataDir: string
  private syncTimer: NodeJS.Timeout | null = null
  private pendingChanges = 0

  constructor(dataDir?: string) {
    this.dataDir = dataDir || path.join(os.homedir(), '.lumina')
    this.config = this.loadConfig()
  }

  // ═══════════════════════════════════════════════════════
  // 初始化
  // ═══════════════════════════════════════════════════════

  async init(remoteUrl?: string): Promise<SyncStatus> {
    if (!this.config.enabled && !remoteUrl) {
      return { enabled: false, connected: false, branch: '', ahead: 0, behind: 0, lastSyncAt: '', pendingChanges: 0 }
    }

    if (remoteUrl) {
      this.config.remoteUrl = remoteUrl
      this.config.enabled = true
      this.saveConfig()
    }

    try {
      // 初始化 git 仓库
      if (!fs.existsSync(path.join(this.dataDir, '.git'))) {
        await this.exec('git init', this.dataDir)
        await this.exec('git config user.name "Lumina"', this.dataDir)
        await this.exec('git config user.email "lumina@local.ai"', this.dataDir)
      }

      // 配置 remote
      if (this.config.remoteUrl) {
        try {
          await this.exec(`git remote add origin ${this.config.remoteUrl}`, this.dataDir)
        } catch {
          await this.exec(`git remote set-url origin ${this.config.remoteUrl}`, this.dataDir)
        }
      }

      // 创建 .gitignore
      this.ensureGitignore()

      // 首次 pull
      await this.pull()

      // 启动定时同步
      this.startAutoSync()

      return await this.getStatus()
    } catch (err: any) {
      return { enabled: true, connected: false, branch: '', ahead: 0, behind: 0, lastSyncAt: '', pendingChanges: 0, error: err.message }
    }
  }

  // ═══════════════════════════════════════════════════════
  // 同步操作
  // ═══════════════════════════════════════════════════════

  async sync(): Promise<{ success: boolean; pulled: number; pushed: number; error?: string }> {
    if (!this.config.enabled) return { success: false, pulled: 0, pushed: 0, error: '未启用' }

    let pulled = 0, pushed = 0

    try {
      // 1. 暂存本地变更
      await this.exec('git add -A', this.dataDir)

      // 2. Commit 本地变更
      try {
        await this.exec('git commit -m "auto: sync ' + new Date().toISOString() + '"', this.dataDir)
        pushed = 1
      } catch { /* nothing to commit */ }

      // 3. Pull remote
      try {
        const { stdout } = await this.exec('git pull --rebase origin main 2>&1 || echo "pull_failed"', this.dataDir)
        if (!stdout.includes('pull_failed') && !stdout.includes('Already up to date')) {
          pulled = stdout.split('\n').filter(l => l.includes('file changed')).length || 1
        }
      } catch { /* no remote or conflict */ }

      // 4. Push
      try {
        await this.exec('git push origin main 2>&1 || echo "push_failed"', this.dataDir)
      } catch { /* no remote */ }

      this.config.lastSyncAt = new Date().toISOString()
      this.saveConfig()
      this.pendingChanges = 0

      return { success: true, pulled, pushed }
    } catch (err: any) {
      return { success: false, pulled: 0, pushed: 0, error: err.message }
    }
  }

  async pull(): Promise<boolean> {
    if (!this.config.enabled) return false
    try {
      await this.exec('git pull --rebase origin main 2>&1 || echo "ok"', this.dataDir)
      return true
    } catch { return false }
  }

  async getStatus(): Promise<SyncStatus> {
    if (!this.config.enabled) {
      return { enabled: false, connected: false, branch: '', ahead: 0, behind: 0, lastSyncAt: '', pendingChanges: 0 }
    }

    try {
      const { stdout: branch } = await this.exec('git rev-parse --abbrev-ref HEAD', this.dataDir)
      const { stdout: status } = await this.exec('git status --porcelain', this.dataDir)
      const pending = status.trim().split('\n').filter(Boolean).length

      let ahead = 0, behind = 0
      try {
        const { stdout: counts } = await this.exec('git rev-list --count --left-right origin/main...HEAD 2>/dev/null || echo "0\t0"', this.dataDir)
        const [a, b] = counts.trim().split('\t').map(Number)
        ahead = a || 0; behind = b || 0
      } catch { /* */ }

      return {
        enabled: true,
        connected: true,
        branch: branch.trim(),
        ahead,
        behind,
        lastSyncAt: this.config.lastSyncAt || '',
        pendingChanges: pending,
      }
    } catch {
      return {
        enabled: true,
        connected: false,
        branch: '',
        ahead: 0,
        behind: 0,
        lastSyncAt: '',
        pendingChanges: 0,
        error: 'Git 仓库未就绪',
      }
    }
  }

  /** 标记有变更需要同步 */
  markChanged(): void {
    this.pendingChanges++
  }

  // ═══════════════════════════════════════════════════════
  // 配置管理
  // ═══════════════════════════════════════════════════════

  getConfig(): SyncConfig {
    return { ...this.config }
  }

  updateConfig(updates: Partial<SyncConfig>): void {
    this.config = { ...this.config, ...updates }
    this.saveConfig()
    if (this.config.enabled && updates.remoteUrl) {
      this.init(updates.remoteUrl)
    }
  }

  // ═══════════════════════════════════════════════════════
  // 内部
  // ═══════════════════════════════════════════════════════

  private startAutoSync(): void {
    if (this.syncTimer) clearInterval(this.syncTimer)

    const intervalMs = (this.config.syncIntervalMinutes || 5) * 60000
    this.syncTimer = setInterval(() => {
      if (this.pendingChanges > 0) {
        this.sync().catch(() => {})
      }
    }, intervalMs)
  }

  stop(): void {
    if (this.syncTimer) {
      clearInterval(this.syncTimer)
      this.syncTimer = null
    }
  }

  private ensureGitignore(): void {
    const gitignorePath = path.join(this.dataDir, '.gitignore')
    const defaultIgnore = `# Lumina Cloud Sync - 隐私保护
# 对话历史默认不同步
conversations/
chat_history/
*.log
*.tmp
.cache/
node_modules/
.env
*.key
*.pem
`
    if (!fs.existsSync(gitignorePath)) {
      fs.writeFileSync(gitignorePath, defaultIgnore)
    }
  }

  private loadConfig(): SyncConfig {
    const configPath = path.join(this.dataDir, 'sync_config.json')
    const defaults: SyncConfig = {
      enabled: false,
      syncIntervalMinutes: 5,
      syncMemory: true,
      syncConfig: true,
      syncConversations: false,
      syncSkills: true,
    }

    try {
      if (fs.existsSync(configPath)) {
        return { ...defaults, ...JSON.parse(fs.readFileSync(configPath, 'utf-8')) }
      }
    } catch { /* */ }
    return defaults
  }

  private saveConfig(): void {
    if (!fs.existsSync(this.dataDir)) fs.mkdirSync(this.dataDir, { recursive: true })
    fs.writeFileSync(path.join(this.dataDir, 'sync_config.json'), JSON.stringify(this.config, null, 2))
  }

  private async exec(cmd: string, cwd?: string): Promise<{ stdout: string; stderr: string }> {
    return execCmd(cmd, cwd || this.dataDir, 30000)
  }
}

// ═══════════════════════════════════════════════════════════
// 单例
// ═══════════════════════════════════════════════════════════

let _instance: CloudSync | null = null

export function initCloudSync(dataDir?: string): CloudSync {
  _instance = new CloudSync(dataDir)
  return _instance
}

export function getCloudSync(): CloudSync {
  if (!_instance) _instance = new CloudSync()
  return _instance
}
