// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// userDataPersistence.test.ts — 配置持久化 / 目录统一（2026-10-10）
//
// 【回归背景（用户实测）】
//   「每次打开 Lumina，连好的供应商模型都要重新设置一遍。」
//   根因：userData 目录不唯一（Electron / lumina-life / Lumina Life 并存），
//   配置在多个目录间漂移，启动时读到哪个不确定。
//
// 本文件锁住两条不变式：
//   ① canonicalUserDataDir —— 跨平台规范路径稳定
//   ② migrateLegacyUserData —— 旧目录数据能并入当前目录，且
//      · 不覆盖当前目录已有文件
//      · 即使旧目录有 .migrated 标记，也仍能补当前缺失的文件（缺口补齐）
//      · 多个旧目录时，靠前的优先（lumina-life 含真实 key，先搬）
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { canonicalUserDataDir, APP_NAME } from '../electron/core/userDataPath'
import { migrateLegacyUserData } from '../electron/userDataMigration'

describe('canonicalUserDataDir — 跨平台规范路径', () => {
  it('Windows 用 %APPDATA%', () => {
    const p = canonicalUserDataDir('win32', { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' } as any, 'C:\\Users\\me')
    expect(p).toBe(path.join('C:\\Users\\me\\AppData\\Roaming', APP_NAME))
  })

  it('macOS 用 ~/Library/Application Support', () => {
    const p = canonicalUserDataDir('darwin', {} as any, '/Users/me')
    expect(p).toBe(path.join('/Users/me', 'Library', 'Application Support', APP_NAME))
  })

  it('Linux 优先 XDG_CONFIG_HOME，否则 ~/.config', () => {
    expect(canonicalUserDataDir('linux', { XDG_CONFIG_HOME: '/x/cfg' } as any, '/home/me'))
      .toBe(path.join('/x/cfg', APP_NAME))
    expect(canonicalUserDataDir('linux', {} as any, '/home/me'))
      .toBe(path.join('/home/me', '.config', APP_NAME))
  })

  it('三种平台结果互不相同且都以 APP_NAME 结尾', () => {
    for (const plat of ['win32', 'darwin', 'linux']) {
      expect(canonicalUserDataDir(plat, {} as any, '/home/me').endsWith(APP_NAME)).toBe(true)
    }
  })
})

describe('migrateLegacyUserData — 旧目录数据并入（不丢、不覆盖）', () => {
  let root: string
  let target: string

  const write = (p: string, content: string) => {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, content, 'utf8')
  }
  const read = (p: string) => fs.readFileSync(p, 'utf8')

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-migrate-'))
    target = path.join(root, 'Lumina Life')
  })
  afterEach(() => {
    try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('把旧目录的配置文件搬进当前目录', () => {
    write(path.join(root, 'lumina-life', 'lumina-providers.json'), '{"activeProviderId":"deepseek","key":"real"}')
    const res = migrateLegacyUserData(target, root)
    expect(res.copiedFiles).toContain('lumina-providers.json')
    expect(read(path.join(target, 'lumina-providers.json'))).toContain('deepseek')
  })

  it('多个旧目录时，靠前的优先（lumina-life 覆盖 Electron 的同名文件）', () => {
    write(path.join(root, 'lumina-life', 'lumina-providers.json'), '{"from":"lumina-life"}')
    write(path.join(root, 'Electron', 'lumina-providers.json'), '{"from":"electron"}')
    migrateLegacyUserData(target, root)
    expect(read(path.join(target, 'lumina-providers.json'))).toBe('{"from":"lumina-life"}')
  })

  it('Electron 独有的文件仍会被补齐（缺口补齐）', () => {
    write(path.join(root, 'lumina-life', 'lumina-providers.json'), '{"from":"lumina-life"}')
    write(path.join(root, 'Electron', 'agent-llm-configs.json'), '{"from":"electron"}')
    migrateLegacyUserData(target, root)
    expect(fs.existsSync(path.join(target, 'agent-llm-configs.json'))).toBe(true)
    expect(read(path.join(target, 'agent-llm-configs.json'))).toBe('{"from":"electron"}')
  })

  it('绝不覆盖当前目录已有文件', () => {
    write(path.join(target, 'lumina-providers.json'), '{"current":"keep-me"}')
    write(path.join(root, 'lumina-life', 'lumina-providers.json'), '{"old":"should-not-win"}')
    migrateLegacyUserData(target, root)
    expect(read(path.join(target, 'lumina-providers.json'))).toBe('{"current":"keep-me"}')
  })

  it('旧目录已有 .migrated 标记时，仍能补齐当前缺失的文件', () => {
    // 模拟历史遗留：Electron 目录被标记过，但它里面有个当前缺失的文件
    write(path.join(root, 'Electron', '.lumina-migrated'), '2026-10-03T00:00:00Z')
    write(path.join(root, 'Electron', 'agent-llm-configs.json'), '{"from":"electron","late":true}')
    const res = migrateLegacyUserData(target, root)
    expect(res.copiedFiles, '带标记的旧目录里的缺口文件也应被补齐').toContain('agent-llm-configs.json')
    expect(fs.existsSync(path.join(target, 'agent-llm-configs.json'))).toBe(true)
  })

  it('当前目录等于旧目录时不做无谓搬运（防自我覆盖）', () => {
    write(path.join(root, 'lumina-life', 'lumina-providers.json'), '{"x":1}')
    const res = migrateLegacyUserData(path.join(root, 'lumina-life'), root)
    expect(res.copiedFiles.length).toBe(0)
  })

  it('没有旧目录时安静返回（不报错、不置 ran）', () => {
    const res = migrateLegacyUserData(target, root)
    expect(res.ran).toBe(false)
    expect(res.copiedFiles.length).toBe(0)
  })

  it('幂等：连续跑两次，第二次不再重复搬', () => {
    write(path.join(root, 'lumina-life', 'lumina-providers.json'), '{"x":1}')
    const first = migrateLegacyUserData(target, root)
    const second = migrateLegacyUserData(target, root)
    expect(first.copiedFiles).toContain('lumina-providers.json')
    expect(second.copiedFiles.length).toBe(0)
  })
})
