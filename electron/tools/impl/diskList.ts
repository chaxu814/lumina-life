// ============================================================
// impl/diskList.ts — 全盘驱动器列表 (v3.6: async I/O)
//
// 让团队 Agent 能看到电脑上所有硬盘分区（C:, D:, E: 等）
// 只读：仅列出驱动器信息，无写入能力
// ============================================================

import * as os from 'os'
import * as fs from 'fs'
import * as path from 'path'
import * as child_process from 'child_process'
import { promisify } from 'util'
import type { ToolDef, ToolResult } from '../types'

const execAsync = promisify(child_process.exec)

export const diskListDef: ToolDef = {
  name: 'disk_list',
  description:
    '列出电脑上的所有硬盘驱动器和分区（C:, D:, E: 等）。' +
    '返回每个驱动器的盘符、标签、总容量、可用空间、文件系统类型。' +
    '用于 Agent 了解可用存储位置，便于跨盘查找文件。纯只读操作。',
  params: {
    includeNetwork: {
      type: 'boolean',
      description: '是否包含网络驱动器（默认 false）',
      required: false,
    },
  },
  toolsets: ['agent', 'files'],
}

/** Windows: 通过 wmic 获取驱动器信息（比 fs 遍历更全更快） */
async function getDrivesWindows(includeNetwork: boolean): Promise<DriveInfo[]> {
  const drives: DriveInfo[] = []

  try {
    // 用 wmic logicaldisk 一次性获取所有逻辑盘信息
    const { stdout: output } = await execAsync(
      'wmic logicaldisk get DeviceID,DriveType,VolumeName,Size,FreeSpace,FileSystem /format:csv',
      { timeout: 5000, encoding: 'utf-8' }
    )

    const lines = output.split('\n').filter(l => l.trim() && !l.startsWith('Node'))
    for (const line of lines) {
      const cols = line.split(',')
      if (cols.length < 3) {continue}
      const [_, deviceId, driveType, freeSpace, volumeName, size, fsType] = cols

      // driveType: 2=Removable, 3=Fixed, 4=Network, 5=CD-ROM
      const typeNum = parseInt(driveType)
      if (typeNum === 5) {continue} // 跳过光驱
      if (typeNum === 4 && !includeNetwork) {continue} // 默认跳过网络盘

      const totalSize = parseInt(size) || 0
      const freeSize = parseInt(freeSpace) || 0

      drives.push({
        letter: (deviceId || '').trim(),
        label: (volumeName || '').trim(),
        type: driveTypeMap[typeNum] || 'unknown',
        fileSystem: (fsType || '').trim(),
        totalBytes: totalSize,
        freeBytes: freeSize,
        usedBytes: totalSize - freeSize,
        usagePercent: totalSize > 0 ? Math.round(((totalSize - freeSize) / totalSize) * 100) : 0,
      })
    }
  } catch {
    // wmic 失败 → 降级用 Node.js 枚举 A-Z
    return getDrivesFallback(includeNetwork)
  }

  return drives.length > 0 ? drives : await getDrivesFallback(includeNetwork)
}

/** 降级方案：遍历 A-Z 盘符 */
async function getDrivesFallback(includeNetwork: boolean): Promise<DriveInfo[]> {
  const drives: DriveInfo[] = []
  for (let code = 65; code <= 90; code++) {
    const letter = String.fromCharCode(code)
    const root = `${letter}:\\`
    try {
      const stat = await fs.promises.stat(root)
      if (!stat.isDirectory()) {continue}

      // 快速获取容量（Windows 上可用但可能异步阻塞）
      try {
        const total = getDiskSpace(root)
        drives.push({
          letter: root,
          label: '',
          type: 'fixed',
          fileSystem: '',
          totalBytes: total,
          freeBytes: 0,
          usedBytes: total,
          usagePercent: total > 0 ? 100 : 0,
        })
      } catch {
        drives.push({
          letter: root,
          label: '',
          type: 'fixed',
          fileSystem: '',
          totalBytes: 0,
          freeBytes: 0,
          usedBytes: 0,
          usagePercent: 0,
        })
      }
    } catch {
      // 盘符不存在，跳过
    }
  }
  return drives
}

/** 通过 os.freemem/totalmem 之外的简陋方式获取磁盘总容量 */
function getDiskSpace(root: string): number {
  // Windows 没有简单的 Node API 获取磁盘空间，返回 0 表示未知
  // 实际容量由 wmic 路径获取
  return 0
}

interface DriveInfo {
  letter: string
  label: string
  type: string
  fileSystem: string
  totalBytes: number
  freeBytes: number
  usedBytes: number
  usagePercent: number
}

const driveTypeMap: Record<number, string> = {
  2: 'removable',
  3: 'fixed',
  4: 'network',
  5: 'cdrom',
}

function formatBytes(bytes: number): string {
  if (bytes === 0) {return '未知'}
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let size = bytes
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024
    i++
  }
  return `${size.toFixed(1)} ${units[i]}`
}

const typeLabels: Record<string, string> = {
  fixed: '本地磁盘',
  removable: '可移动磁盘',
  network: '网络驱动器',
  cdrom: '光驱',
  unknown: '未知',
}

// ═══════════════════════════════════════════════════════════
// 导出执行函数
// ═══════════════════════════════════════════════════════════

export async function diskList(args: Record<string, any>): Promise<ToolResult> {
  const includeNetwork = args.includeNetwork === true
  const start = Date.now()

  try {
    const drives = await getDrivesWindows(includeNetwork)

    if (drives.length === 0) {
      return {
        callId: '',
        ok: true,
        content: '未检测到任何驱动器。',
        durationMs: Date.now() - start,
      }
    }

    const lines: string[] = ['📀 检测到的驱动器：\n']
    for (const d of drives) {
      const typeLabel = typeLabels[d.type] || d.type
      const labelStr = d.label ? ` [${d.label}]` : ''
      const fsStr = d.fileSystem ? ` ${d.fileSystem}` : ''
      const totalStr = d.totalBytes > 0 ? formatBytes(d.totalBytes) : '未知容量'
      const freeStr = d.freeBytes > 0 ? formatBytes(d.freeBytes) : '?'
      const usageBar = d.usagePercent > 0
        ? `[${'█'.repeat(Math.round(d.usagePercent / 5))}${'░'.repeat(20 - Math.round(d.usagePercent / 5))}] ${d.usagePercent}%`
        : ''

      lines.push(
        `${d.letter} ${typeLabel}${labelStr}${fsStr} | ${totalStr} | 可用 ${freeStr} | ${usageBar}`
      )
    }

    lines.push(`\n共 ${drives.length} 个驱动器。`)

    return {
      callId: '',
      ok: true,
      content: lines.join('\n'),
      durationMs: Date.now() - start,
    }
  } catch (err: any) {
    return { callId: '', ok: false, content: '', error: err.message }
  }
}
