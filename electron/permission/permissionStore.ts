// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// permission/permissionStore.ts — 档位的持久化 + 变更广播
//
// 【为什么要放在主进程】
// 渲染进程的 Zustand 存不住「安全」——它可以被任何渲染代码改。
// 权限档位必须在主进程落盘，并且**由主进程自己读取**，
// 这样「UI 显示什么」和「实际拦什么」才是同一个真相。
// （对照：`securityConfig.sandboxMode` 就是反面教材，见 permissionTier.ts 头部。）
// ============================================================

import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { EventEmitter } from 'events'
import { stateFilePath } from '../core/pathsFallback'
import {
  PermissionTier, TIER_META, parseTier, defaultWorkspaceRoot,
} from './permissionTier'

export interface PermissionState {
  tier: PermissionTier
  /** 工作区根目录；null 表示未设置 */
  workspaceRoot: string | null
  /**
   * 可信目录白名单（额外自动放行写操作的目录）。
   * 落在这些目录内的 file_write / file_edit 等写操作免逐次审批，
   * 用于降低「我说了写文件却每次都要确认」的摩擦；凭证/外发/命令仍走硬拦截。
   * 默认运行时由 effectiveTrustedDirs() 合并 工作区 + 沙箱 + 本项。
   */
  trustedDirs: string[]
  /**
   * 用户是否已就「完全权限」做过风险确认。
   * false = 选到 FULL 时必须弹图 2 那个确认框。
   */
  fullAcknowledged: boolean
  updatedAt: number
}

const DEFAULT_STATE: PermissionState = {
  // 默认给「工作区内修改」：比只读有用，又不需要用户先理解风险。
  // 完全权限必须用户主动切 + 勾选风险确认框，不会默认给。
  tier: PermissionTier.WORKSPACE_WRITE,
  workspaceRoot: null,
  trustedDirs: [],
  fullAcknowledged: false,
  updatedAt: 0,
}

/** 沙箱根目录（写入重定向发生处），作为默认可信目录之一 */
function sandboxRoot(): string | null {
  try { return path.join(app.getPath('userData'), 'sandbox') } catch { return null }
}

class PermissionStore extends EventEmitter {
  private state: PermissionState = { ...DEFAULT_STATE }
  private loaded = false

  private file(): string {
    try {
      return path.join(app.getPath('userData'), 'lumina-permission.json')
    } catch {
      // ⚠️ 不要退回 process.cwd()：开发态 cwd 就是项目根，会把状态写进 Git 工作区
      return stateFilePath('lumina-permission.json')
    }
  }

  load(): PermissionState {
    if (this.loaded) {return this.state}
    try {
      const f = this.file()
      if (fs.existsSync(f)) {
        const raw = JSON.parse(fs.readFileSync(f, 'utf-8')) as Partial<PermissionState>
        this.state = {
          tier: parseTier(raw.tier),
          workspaceRoot: typeof raw.workspaceRoot === 'string' && raw.workspaceRoot ? raw.workspaceRoot : null,
          trustedDirs: Array.isArray(raw.trustedDirs) ? raw.trustedDirs.filter(d => typeof d === 'string') : [],
          fullAcknowledged: raw.fullAcknowledged === true,
          updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
        }
      }
    } catch {
      // 坏 JSON 不致命：回退默认（安全侧：不是 FULL）
      this.state = { ...DEFAULT_STATE }
    }
    this.loaded = true
    return this.state
  }

  private save(): void {
    try {
      const f = this.file()
      const dir = path.dirname(f)
      if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }) }
      // 原子写：先 tmp 再 rename，避免写一半断电留半截 JSON
      const tmp = f + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), 'utf-8')
      fs.renameSync(tmp, f)
    } catch {
      // 落盘失败不阻断权限切换：内存里的档位已生效，只是重启会丢。
      // 故意不 console —— 权限层失败静默比拚日志更安全（不泄露路径）。
    }
  }

  get(): PermissionState {
    return this.load()
  }

  /** 当前档位的**有效工作区**（未配置时返回默认目录而不是 null，简化调用方） */
  effectiveWorkspaceRoot(): string {
    return this.state.workspaceRoot || defaultWorkspaceRoot()
  }

  /**
   * 合并后的可信目录列表：工作区 + 沙箱 + 用户配置项（去重）。
   * 落在其中任一目录内的写操作在「工作区内修改」档下免逐次审批。
   */
  effectiveTrustedDirs(): string[] {
    const set = new Set<string>()
    const ws = this.effectiveWorkspaceRoot()
    if (ws) { set.add(ws) }
    const sb = sandboxRoot()
    if (sb) { set.add(sb) }
    for (const d of this.state.trustedDirs || []) {
      if (d && typeof d === 'string') { set.add(d) }
    }
    return [...set]
  }

  /** 设置可信目录白名单（覆盖） */
  setTrustedDirs(dirs: string[]): PermissionState {
    this.state = {
      ...this.state,
      trustedDirs: [...new Set(dirs.filter(d => typeof d === 'string' && d.trim()))],
      updatedAt: Date.now(),
    }
    this.save()
    this.emit('changed', this.snapshot())
    return this.snapshot()
  }

  /** 追加一个可信目录 */
  addTrustedDir(dir: string): PermissionState {
    if (!dir || typeof dir !== 'string' || !dir.trim()) { return this.snapshot() }
    return this.setTrustedDirs([...this.state.trustedDirs, dir.trim()])
  }

  /**
   * 切换档位。
   *
   * 切到 FULL 时**必须** acknowledged=true，否则拒绝 ——
   * 防止渲染层（或某个 bug）绕过图 2 的风险确认框直接落到完全权限。
   */
  setTier(tier: PermissionTier, acknowledged = false): PermissionState {
    const next = parseTier(tier)
    if (next === PermissionTier.FULL && !acknowledged) {
      throw new Error('启用完全权限前必须先完成风险确认')
    }
    this.state = {
      ...this.state,
      tier: next,
      // 从 FULL 切走时收回确认，避免下次直接落回完全权限
      fullAcknowledged: next === PermissionTier.FULL ? true : false,
      updatedAt: Date.now(),
    }
    this.save()
    this.emit('changed', this.snapshot())
    return this.snapshot()
  }

  setWorkspaceRoot(root: string | null): PermissionState {
    this.state = { ...this.state, workspaceRoot: root, updatedAt: Date.now() }
    this.save()
    this.emit('changed', this.snapshot())
    return this.snapshot()
  }

  /** 供 IPC 使用的完整快照（含给 UI 的展示字段） */
  snapshot(): PermissionState & {
    meta: typeof TIER_META
    /** 当前档位是否仍需要用户先过风险确认 */
    needsAcknowledgement: boolean
  } {
    return {
      ...this.state,
      meta: TIER_META,
      needsAcknowledgement: this.state.tier === PermissionTier.FULL && !this.state.fullAcknowledged,
    }
  }
}

let _instance: PermissionStore | null = null

export function getPermissionStore(): PermissionStore {
  if (!_instance) {
    _instance = new PermissionStore()
    _instance.load()
  }
  return _instance
}

/** 测试钩子 */
export function __resetPermissionStoreForTest(): void {
  _instance = null
}
