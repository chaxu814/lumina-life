// ============================================================
// impl/pathResolver.ts — 智能路径解析 (v4.0.1)
//
// 问题: Agent（如热茶）可能使用错误/占位的用户名路径
//   C:\Users\some-user\Desktop\作品集网站 → 不存在
// 解决: 自动修正为真实用户路径
//   C:\Users\<真实用户名>\Desktop\摄影作品集网站
// ============================================================

import fs from 'fs'
import path from 'path'
import os from 'os'

/** 获取真实用户目录映射 */
function getUserPathMappings(): Record<string, string> {
  const home = os.homedir()
  const userProfile = process.env.USERPROFILE || home

  // Agent 可能使用的错误/占位用户名
  const commonUsernames = ['hottea', 'recha', 'lumina', 'yak', 'user', 'admin', 'default', 'owner']

  const mappings: Record<string, string> = {
    '~': home,
    '%USERPROFILE%': userProfile,
    '%HOME%': home,
  }

  for (const name of commonUsernames) {
    mappings[`C:\\Users\\${name}`] = home
    mappings[`C:/Users/${name}`] = home
  }

  return mappings
}

/**
 * 尝试解析路径中的占位用户名
 *
 * 例如:
 *   C:\Users\some-user\Desktop\作品集网站
 *   → C:\Users\<真实用户名>\Desktop\作品集网站
 */
export function resolveUserPath(rawPath: string): string {
  let resolved = rawPath

  // ~ 展开
  if (resolved.startsWith('~')) {
    resolved = path.join(os.homedir(), resolved.slice(1))
    if (resolved.endsWith('\\') || resolved.endsWith('/')) {
      resolved = resolved.slice(0, -1)
    }
  }

  // C:\Users\<错误用户名> 替换
  const mappings = getUserPathMappings()
  for (const [wrong, correct] of Object.entries(mappings)) {
    if (resolved.startsWith(wrong + '\\') || resolved.startsWith(wrong + '/')) {
      const relative = resolved.slice(wrong.length)
      resolved = correct + relative
      break
    }
    if (resolved === wrong) {
      resolved = correct
      break
    }
  }

  return resolved
}

/**
 * 尝试多种路径解析方案，找到第一个存在的路径
 * 返回 [最终路径, 是否被修正]
 */
export async function tryResolvePath(rawPath: string): Promise<[string, boolean]> {
  // 1. 原路径
  try {
    await fs.promises.stat(rawPath)
    return [rawPath, false]
  } catch {}

  // 2. 智能解析
  const resolved = resolveUserPath(rawPath)
  if (resolved !== rawPath) {
    try {
      await fs.promises.stat(resolved)
      return [resolved, true]
    } catch {}
  }

  // 3. 常见目录关键词映射
  const lower = rawPath.toLowerCase()
  const home = os.homedir()

  const keywordMappings: Array<[string[], string[]]> = [
    [['desktop', '桌面'], ['Desktop', '桌面']],
    [['documents', '文档'], ['Documents', '文档']],
    [['downloads', '下载'], ['Downloads', '下载']],
    [['pictures', '图片'], ['Pictures', '图片']],
    [['videos', '视频'], ['Videos', '视频']],
    [['music', '音乐'], ['Music', '音乐']],
  ]

  for (const [keywords, dirNames] of keywordMappings) {
    if (keywords.some(kw => lower.includes(kw))) {
      for (const dirName of dirNames) {
        const dirPath = path.join(home, dirName)
        try {
          await fs.promises.stat(dirPath)
          return [dirPath, true]
        } catch {}
      }
    }
  }

  // 4. 相对路径 → 尝试相对于项目根目录和工作目录
  //    LLM 经常传入相对路径（如 "memory/MEMORY.md"），需要尝试多个基准路径
  if (!path.isAbsolute(rawPath)) {
    const cwd = process.cwd()
    const homeDir = os.homedir()

    // 尝试 Electron 应用路径
    let appRoot = ''
    try {
      const electron = require('electron')
      appRoot = electron.app?.getAppPath() || ''
    } catch {}

    // 已知的项目根目录（按可靠性从高到低）
    //
    // 【为什么不再硬编码本机盘符】
    // 旧列表里写着 'J:\\LuminaLife2.0'（作者当时机器的安装位置）。
    // 对任何其他用户来说这个路径不存在，属于开发环境的残留，
    // 公开仓库里会被审稿人直接当成“个人项目遗留”看待。
    // 现在只保留三类：进程工作目录（开发态）、Electron 应用路径（打包后）、
    // 以及 LUMINA_PROJECT_ROOT 环境变量（需要指向别处时显式指定）。
    // homeDir 及其下的 LuminaLife2.0 是通用的合理猜测（很多人确实装在用户目录下），保留。
    const knownRoots: string[] = [
      cwd,
      appRoot,
      process.env.LUMINA_PROJECT_ROOT || '',
      homeDir,
      path.join(homeDir, 'LuminaLife2.0'),
      path.join(homeDir, 'Desktop', 'LuminaLife2.0'),
    ].filter(Boolean)

    // 去重
    const uniqueRoots = [...new Set(knownRoots)]

    for (const root of uniqueRoots) {
      try {
        const fullPath = path.resolve(root, rawPath)
        await fs.promises.stat(fullPath)
        return [fullPath, true]
      } catch {}
    }
  }

  // 都找不到，返回原路径
  return [rawPath, false]
}
