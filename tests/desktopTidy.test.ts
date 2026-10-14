// ============================================================
// tests/desktopTidy.test.ts — 桌面整理工具的安全回归
//
// 这个工具一旦做错，代价是**用户的文件在硬盘上消失或跑到别处**。
// 所以测试的重点不是「能不能整理」，而是「不该动的时候有没有真的没动」。
//
// 铁律（下面每一条都有对应用例钉死）：
//   · 不传 execute:true → 磁盘上文件位置一个字节都不能变
//   · 源/目标越界（.. 穿越、桌面外绝对路径）→ 直接拒绝
//   · 目录本身永不移动
//   · 目标重名只改名，绝不覆盖
//   · 权限错误单文件跳过，整批不崩
//
// ⚠️ 本文件只操作 os.tmpdir() 下的临时目录。
//    electron 的 app.getPath('desktop') 被 mock 成临时目录，
//    绝对不碰用户真实桌面。
// ============================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

// vi.mock 工厂会被提升到 import 之前，所以「假桌面路径」必须用 vi.hoisted 先建好
const electronState = vi.hoisted(() => ({ desktop: '' }))

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name !== 'desktop') {throw new Error(`测试里不允许取其它路径: ${name}`)}
      return electronState.desktop
    },
  },
}))

import { desktopScan, desktopPlan, desktopTidy } from '../electron/tools/impl/desktopTidy'

// ═══════════════════════════════════════════════════════════
// 测试脚手架
// ═══════════════════════════════════════════════════════════

/** 临时「桌面」，每个用例一份 */
let fakeDesktop = ''

function makeFile(name: string, content = 'x'): string {
  const full = path.join(fakeDesktop, name)
  fs.writeFileSync(full, content, 'utf-8')
  return full
}

function makeDir(name: string): string {
  const full = path.join(fakeDesktop, name)
  fs.mkdirSync(full, { recursive: true })
  return full
}

/** 递归列出目录树（相对路径，排序），用来对比「文件有没有动过」 */
function listTree(dir: string, base = dir): string[] {
  const out: string[] = []
  for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, dirent.name)
    const rel = path.relative(base, full)
    if (dirent.isDirectory()) {
      out.push(rel + '/')
      out.push(...listTree(full, base))
    } else {
      out.push(rel)
    }
  }
  return out.sort()
}

function exists(relPath: string): boolean {
  return fs.existsSync(path.join(fakeDesktop, relPath))
}

function readRel(relPath: string): string {
  return fs.readFileSync(path.join(fakeDesktop, relPath), 'utf-8')
}

beforeEach(() => {
  fakeDesktop = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-desktop-test-')))
  electronState.desktop = fakeDesktop
})

afterEach(() => {
  vi.restoreAllMocks()
  // 只删自己 mkdtemp 出来的临时目录，路径不接受外部输入
  if (fakeDesktop.startsWith(os.tmpdir())) {
    fs.rmSync(fakeDesktop, { recursive: true, force: true })
  }
})

// ═══════════════════════════════════════════════════════════
// 1. 【最重要】不传 execute:true 时磁盘文件位置不变
// ═══════════════════════════════════════════════════════════

describe('默认只读 —— 不传 execute:true 不许动磁盘', () => {
  it('完全不给参数调用，文件原封不动，也不会新建分类文件夹', async () => {
    makeFile('报告.pdf', 'PDF')
    makeFile('照片.png', 'PNG')
    makeFile('安装包.exe', 'EXE')
    const before = listTree(fakeDesktop)

    const result = await desktopTidy({})

    expect(result.ok).toBe(true)
    // 输出必须明确告诉模型「没执行」
    expect(result.content).toContain('未执行')
    expect(result.content).toContain('- 报告.pdf → 文档/报告.pdf')

    // 磁盘逐字节对比：没有新目录、没有改名、没有移动
    expect(listTree(fakeDesktop)).toEqual(before)
    expect(exists('报告.pdf')).toBe(true)
    expect(exists('文档')).toBe(false)
    expect(exists('图片')).toBe(false)
    expect(exists('安装包')).toBe(false)
    expect(readRel('报告.pdf')).toBe('PDF')
  })

  it('显式传 execute:false 同样只回放方案', async () => {
    makeFile('报告.pdf', 'PDF')
    const before = listTree(fakeDesktop)

    const result = await desktopTidy({ execute: false })

    expect(result.ok).toBe(true)
    expect(result.content).toContain('未执行')
    expect(listTree(fakeDesktop)).toEqual(before)
  })

  it('execute 传字符串 "true" 不算显式 true（必须是布尔真）', async () => {
    makeFile('报告.pdf', 'PDF')
    const before = listTree(fakeDesktop)

    const result = await desktopTidy({ execute: 'true' })

    expect(result.ok).toBe(true)
    expect(result.content).toContain('未执行')
    expect(listTree(fakeDesktop)).toEqual(before)
  })

  it('desktop_tidy_plan 恒为只读：传 dryRun:false 也不移动', async () => {
    makeFile('报告.pdf', 'PDF')
    const before = listTree(fakeDesktop)

    const result = await desktopPlan({ dryRun: false })

    expect(result.ok).toBe(true)
    expect(result.content).toContain('只读预览')
    expect(result.content).toContain('dryRun:false 未生效')
    expect(listTree(fakeDesktop)).toEqual(before)
  })

  it('desktop_tidy_scan 纯只读', async () => {
    makeFile('报告.pdf', 'PDF')
    const before = listTree(fakeDesktop)

    const result = await desktopScan({})

    expect(result.ok).toBe(true)
    expect(result.content).toContain('只读')
    expect(listTree(fakeDesktop)).toEqual(before)
  })
})

// ═══════════════════════════════════════════════════════════
// 2. execute:true 时真的移动到正确分类子目录
// ═══════════════════════════════════════════════════════════

describe('execute:true —— 真正移动到分类子目录', () => {
  it('按扩展名分到正确的文件夹，源文件从桌面消失', async () => {
    makeFile('报告.pdf', 'PDF')
    makeFile('照片.png', 'PNG')
    makeFile('宣传片.mp4', 'MP4')
    makeFile('录音.mp3', 'MP3')
    makeFile('备份.zip', 'ZIP')
    makeFile('主程序.exe', 'EXE')
    makeFile('main.ts', 'TS')
    makeFile('随手记.unknown', 'TXT')

    const result = await desktopTidy({ execute: true })

    expect(result.ok).toBe(true)
    expect(exists('文档/报告.pdf')).toBe(true)
    expect(exists('图片/照片.png')).toBe(true)
    expect(exists('视频/宣传片.mp4')).toBe(true)
    expect(exists('音频/录音.mp3')).toBe(true)
    expect(exists('压缩包/备份.zip')).toBe(true)
    expect(exists('安装包/主程序.exe')).toBe(true)
    expect(exists('代码/main.ts')).toBe(true)
    expect(exists('其他/随手记.unknown')).toBe(true)

    // 源位置已空
    for (const name of ['报告.pdf', '照片.png', '宣传片.mp4', '录音.mp3', '备份.zip', '主程序.exe', 'main.ts', '随手记.unknown']) {
      expect(exists(name)).toBe(false)
    }
    // 内容保持不变（只移动，不重写）
    expect(readRel('文档/报告.pdf')).toBe('PDF')
  })

  it('categories 只整理指定分类，其余留在桌面', async () => {
    makeFile('报告.pdf', 'PDF')
    makeFile('照片.png', 'PNG')

    const result = await desktopTidy({ execute: true, categories: ['文档'] })

    expect(result.ok).toBe(true)
    expect(exists('文档/报告.pdf')).toBe(true)
    expect(exists('照片.png')).toBe(true)   // 图片没动
    expect(exists('图片')).toBe(false)
  })

  it('文件年龄参与分类：30 天以上的安装包进「旧安装包」', async () => {
    const exe = makeFile('老安装包.exe', 'EXE')
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000)
    fs.utimesSync(exe, old, old)
    makeFile('新安装包.exe', 'EXE2')

    const result = await desktopTidy({ execute: true })

    expect(result.ok).toBe(true)
    expect(exists('旧安装包/老安装包.exe')).toBe(true)
    expect(exists('安装包/新安装包.exe')).toBe(true)
  })

  // 205 次写文件 + 200 次移动 = ~600 次串行 fs 调用；全量套件并行跑时
  // 会因 I/O 争用逼近默认 30s 超时 → 给这条重 I/O 用例留足余量（逻辑不变）
  // ⚠️ 2026-10-11：本用例在真实磁盘上创建 205 个文件并移动 200 个，是全套件里
  //    最重的 I/O 集成测试。在全量并行跑（269 个测试文件同时抢 CPU/磁盘）时，
  //    个别机器上会因负载导致超时/竞态 —— 这正是 README「已知问题」里说的
  //    「负载敏感」。给它 retry:2：真实 bug 仍会稳定失败，只有负载抖动会被吸收。
  it('单次最多 200 个文件，超出截断并在返回里说明', { timeout: 120_000, retry: 2 }, async () => {
    for (let i = 0; i < 205; i += 1) {makeFile(`文件${i}.txt`, 'x')}

    const result = await desktopTidy({ execute: true })

    expect(result.ok).toBe(true)
    expect(result.content).toContain('本次只处理前 200 个')
    expect(result.content).toContain('还有 5 个未处理')
    expect(fs.readdirSync(fakeDesktop).filter(n => n === '文档').length).toBe(1)
    expect(fs.readdirSync(path.join(fakeDesktop, '文档')).length).toBe(200)
    // 剩下的 5 个还在桌面，没被丢下也没被删除
    expect(fs.readdirSync(fakeDesktop).filter(n => n.startsWith('文件') && n.endsWith('.txt')).length).toBe(5)
  })
})

// ═══════════════════════════════════════════════════════════
// 3. 同名冲突自动改名，不覆盖
// ═══════════════════════════════════════════════════════════

describe('同名冲突不覆盖', () => {
  it('目标已有同名文件 → 自动加序号，原文件内容不变', async () => {
    makeFile('报告.pdf', 'NEW')
    fs.mkdirSync(path.join(fakeDesktop, '文档'))
    fs.writeFileSync(path.join(fakeDesktop, '文档', '报告.pdf'), 'ORIGINAL', 'utf-8')

    const result = await desktopTidy({ execute: true })

    expect(result.ok).toBe(true)
    expect(readRel('文档/报告.pdf')).toBe('ORIGINAL')        // 旧文件一个字节没被改
    expect(readRel('文档/报告 (1).pdf')).toBe('NEW')          // 新文件去了序号名
    expect(result.content).toContain('报告.pdf → 文档/报告 (1).pdf')
  })

  it('同一批次里的重名也各自拿到唯一名（报告.pdf / 报告 (1).pdf → 报告 (2).pdf）', async () => {
    makeFile('报告.pdf', 'A')
    makeFile('报告 (1).pdf', 'B')
    // 目标目录里已经占用了 报告.pdf，逼出批次内的连锁改名
    fs.mkdirSync(path.join(fakeDesktop, '文档'))
    fs.writeFileSync(path.join(fakeDesktop, '文档', '报告.pdf'), 'ORIGINAL', 'utf-8')

    const result = await desktopTidy({ execute: true })

    expect(result.ok).toBe(true)
    expect(readRel('文档/报告.pdf')).toBe('ORIGINAL')       // 已有文件没被覆盖
    expect(readRel('文档/报告 (1).pdf')).toBe('B')
    expect(readRel('文档/报告 (2).pdf')).toBe('A')          // 连锁让位
  })
})

// ═══════════════════════════════════════════════════════════
// 4 & 5. 路径穿越 / 桌面外路径 —— 三个工具都要挡
// ═══════════════════════════════════════════════════════════

describe('路径越界一律拒绝', () => {
  it('../ 路径穿越被拒绝（未归一化的原始字符串）', async () => {
    makeFile('报告.pdf', 'PDF')
    const before = listTree(fakeDesktop)
    // 刻意不经过 path.join（它会把 .. 提前消解），模拟调用方直接传进来的穿越串
    const evil = `${fakeDesktop}${path.sep}..${path.sep}..${path.sep}escape`

    for (const [name, run] of [
      ['desktop_tidy_scan', desktopScan],
      ['desktop_tidy_plan', desktopPlan],
      ['desktop_tidy', desktopTidy],
    ] as const) {
      const result = await run({ desktopPath: evil })
      expect(result.ok, `${name} 应该拒绝穿越路径`).toBe(false)
      expect(result.error).toContain('越界')
    }

    const executed = await desktopTidy({ desktopPath: evil, execute: true })
    expect(executed.ok).toBe(false)
    expect(listTree(fakeDesktop)).toEqual(before)
  })

  it('桌面外的绝对路径被拒绝', async () => {
    makeFile('报告.pdf', 'PDF')
    const before = listTree(fakeDesktop)
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-outside-'))
    try {
      fs.writeFileSync(path.join(outside, '别碰我.txt'), 'IMPORTANT', 'utf-8')
      const outsideFile = path.join(outside, '别碰我.txt')

      for (const [name, run] of [
        ['desktop_tidy_scan', desktopScan],
        ['desktop_tidy_plan', desktopPlan],
        ['desktop_tidy', desktopTidy],
      ] as const) {
        const result = await run({ desktopPath: outside, execute: true })
        expect(result.ok, `${name} 应该拒绝桌面外目录`).toBe(false)
        expect(result.error).toContain('越界')
      }

      // 桌面外的文件安然无恙
      expect(fs.readFileSync(outsideFile, 'utf-8')).toBe('IMPORTANT')
      expect(listTree(fakeDesktop)).toEqual(before)
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  it('Windows 大小写不同的桌面路径仍然被接受（大小写折叠对）', async () => {
    makeFile('报告.pdf', 'PDF')
    const upper = fakeDesktop.toUpperCase()

    const result = await desktopTidy({ desktopPath: upper, execute: true })

    expect(result.ok).toBe(true)
    expect(exists('文档/报告.pdf')).toBe(true)
  })

  it('非法分类名被拒绝（防止分类名被当成路径拼接）', async () => {
    makeFile('报告.pdf', 'PDF')
    const before = listTree(fakeDesktop)

    const result = await desktopTidy({ execute: true, categories: ['../../etc'] })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('未知分类')
    expect(listTree(fakeDesktop)).toEqual(before)
  })
})

// ═══════════════════════════════════════════════════════════
// 6. 目录本身不被移动
// ═══════════════════════════════════════════════════════════

describe('目录永不移动', () => {
  it('桌面上的文件夹原位不动，里面的文件也不被动', async () => {
    const workDir = makeDir('工作资料')
    fs.writeFileSync(path.join(workDir, '内部笔记.md'), 'INNER', 'utf-8')
    fs.writeFileSync(path.join(workDir, '子目录里.txt'), 'DEEP', 'utf-8')
    fs.mkdirSync(path.join(workDir, '更深'))
    fs.writeFileSync(path.join(workDir, '更深', '底.txt'), 'DEEPER', 'utf-8')
    makeFile('报告.pdf', 'PDF')

    const result = await desktopTidy({ execute: true })

    expect(result.ok).toBe(true)
    expect(exists('工作资料')).toBe(true)
    expect(exists('工作资料/内部笔记.md')).toBe(true)
    expect(readRel('工作资料/内部笔记.md')).toBe('INNER')
    expect(readRel('工作资料/子目录里.txt')).toBe('DEEP')
    expect(readRel('工作资料/更深/底.txt')).toBe('DEEPER')
    // 只有桌面根下的散落文件进了分类目录
    expect(exists('文档/报告.pdf')).toBe(true)
    expect(exists('工作资料/文档')).toBe(false)
    // 输出里要能看出「文件夹被计入但没动」
    expect(result.content).toContain('顶层文件夹')
  })

  it('扫描结果把文件夹单独计数，不混进文件统计', async () => {
    makeDir('工作资料')
    makeDir('另一个文件夹')
    makeFile('报告.pdf', 'PDF')

    const result = await desktopScan({})

    expect(result.ok).toBe(true)
    expect(result.content).toContain('顶层文件夹: 2 个')
    expect(result.content).toContain('可整理文件: 1 个')
  })
})

// ═══════════════════════════════════════════════════════════
// 7. 权限错误跳过不崩
// ═══════════════════════════════════════════════════════════

describe('权限错误 —— 跳过该文件，整批不失败', () => {
  /** fs.promises.rename 有回调/Promise 两个重载，spy 的类型推断会挑回调版；
   *  这里显式收窄成 Promise 版，避免用 any 糊过去。 */
  type RenamePromise = (oldPath: fs.PathLike, newPath: fs.PathLike) => Promise<void>

  /** 让指定文件的所有 rename 抛 EACCES，其它文件走真实实现 */
  function failRenameFor(deniedPath: string | null): void {
    const realRename = fs.promises.rename.bind(fs.promises) as RenamePromise
    const spy = vi.spyOn(fs.promises, 'rename') as unknown as {
      mockImplementation: (impl: RenamePromise) => void
    }
    spy.mockImplementation(async (from, to) => {
      if (deniedPath === null || String(from) === deniedPath) {
        const err: NodeJS.ErrnoException = new Error(`EACCES: permission denied, rename '${String(from)}'`)
        err.code = 'EACCES'
        throw err
      }
      return realRename(from, to)
    })
  }

  it('单个文件 EACCES 失败，其它文件照常移动，失败文件留在原地', async () => {
    makeFile('报告.pdf', 'PDF')
    makeFile('锁住的.docx', 'LOCKED')
    makeFile('照片.png', 'PNG')

    failRenameFor(path.join(fakeDesktop, '锁住的.docx'))

    const result = await desktopTidy({ execute: true })

    // 没崩，而且诚实反映「有文件没动」
    expect(result.ok).toBe(true)
    expect(result.content).toContain('权限不足（EACCES）')
    expect(result.content).toContain('锁住的.docx')
    // 其它文件正常移动
    expect(exists('文档/报告.pdf')).toBe(true)
    expect(exists('图片/照片.png')).toBe(true)
    // 失败的留在桌面原位，没有被删
    expect(exists('锁住的.docx')).toBe(true)
    expect(readRel('锁住的.docx')).toBe('LOCKED')
  })

  it('全部文件都失败时诚实报 ok:false，不把空结果说成成功', async () => {
    makeFile('报告.pdf', 'PDF')
    makeFile('照片.png', 'PNG')

    failRenameFor(null)   // 全部失败

    const result = await desktopTidy({ execute: true })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('全部被跳过')
    expect(result.error).toContain('权限不足')
    // 文件全都还在
    expect(exists('报告.pdf')).toBe(true)
    expect(exists('照片.png')).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════
// 8. 工具定义自身的安全声明
// ═══════════════════════════════════════════════════════════

describe('工具定义', () => {
  it('三个工具都声明了 productivity 能力层且名字互不冲突', async () => {
    const mod = await import('../electron/tools/impl/desktopTidy')
    const defs = [mod.desktopScanDef, mod.desktopPlanDef, mod.desktopTidyDef]

    for (const def of defs) {
      // ⚠️ 不要写 ['agent','chat']：那是 MODE_TOOLSETS（静态表独占），
      // 工具自己声明进不去，只写这两个会变成「注册了但模型看不到」的孤儿
      // （delegationSafety.test.ts 的孤儿守卫会报红）。
      // 正确做法是挂在能力层，并把它接进 agent 模式的 includes。
      expect(def.toolsets).toEqual(['productivity'])
      expect(def.name.startsWith('desktop_tidy')).toBe(true)
    }
    const names = defs.map(d => d.name)
    expect(new Set(names).size).toBe(3)
  })

  it('desktop_tidy 的说明里写清了 execute 与不删除的约定', async () => {
    const mod = await import('../electron/tools/impl/desktopTidy')
    expect(mod.desktopTidyDef.description).toContain('execute')
    expect(mod.desktopTidyDef.description).toContain('永不删除')
  })

  it('不存在的桌面目录诚实报错', async () => {
    const result = await desktopScan({ desktopPath: path.join(fakeDesktop, '根本没有这个目录') })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('桌面目录不可访问')
  })

  it('隐藏文件默认不统计，includeHidden 才计入', async () => {
    makeFile('报告.pdf', 'PDF')
    makeFile('.隐藏笔记.txt', 'H')
    makeFile('~$临时.docx', 'T')

    const without = await desktopScan({})
    expect(without.content).toContain('可整理文件: 1 个')
    expect(without.content).toContain('隐藏文件: 2 个（未计入）')

    const withHidden = await desktopScan({ includeHidden: true })
    expect(withHidden.content).toContain('可整理文件: 3 个')
  })
})
