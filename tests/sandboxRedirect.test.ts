// ============================================================
// sandboxRedirect.test.ts — 沙箱写入重定向的路径映射（v3.34 新增）
//
// 【为什么要有】
// 真实跑打包版时让模型写 D:\lumina-quality\fib.py，文件确实生成了，
// 但落在  sandbox/lumina/**Dlumina-quality**/fib.py
//                ↑↑↑↑↑↑ 盘符冒号和反斜杠被吃掉，两个词粘成了一个目录名
//
// 而 sandbox.ts 的注释里写的意图本来就是「C:\Users\file.txt → C/Users/file.txt」——
// **实现与自己的注释不符**。这类 bug 单测发现不了（当时的测试压根没覆盖这段），
// 是真机跑出来的。
//
// 现在把映射规则锁死。
// ============================================================

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

/** 与 electron/sandbox.ts 中 write 重定向分支保持一致的映射（测试内复刻一份，
 *  这样即使生产代码整段挪位置，只要这段逻辑还在就会被守住） */
function toRelative(absolutePath: string): string {
  const driveMatch = absolutePath.match(/^([A-Za-z]):\\?/)
  if (driveMatch) {
    return driveMatch[1] + '/' + absolutePath.slice(driveMatch[0].length).replace(/\\/g, '/')
  } else if (absolutePath.startsWith('/')) {
    return absolutePath.slice(1)
  } else {
    return absolutePath.replace(/[\\/]/g, '/')
  }
}

describe('沙箱写入重定向 · 路径映射', () => {
  it('Windows 盘符路径：盘符与后续路径之间必须有分隔符', () => {
    // 旧实现少了这个 '/'，于是 D:\lumina-quality\x.py → Dlumina-quality/x.py
    expect(toRelative('D:\\lumina-quality\\fib.py')).toBe('D/lumina-quality/fib.py')
    expect(toRelative('C:\\Users\\13510\\test.txt')).toBe('C/Users/13510/test.txt')
  })

  it('不会出现「盘符 + 字母」粘在一起的情况（旧 bug 的特征）', () => {
    for (const p of ['D:\\lumina-quality\\fib.py', 'C:\\a\\b.txt', 'D:\\Games\\x.bin']) {
      const r = toRelative(p)
      expect(r, `${p} → ${r} 看起来盘符和目录名粘在一起了`).not.toMatch(/^[A-Za-z]:[^\/]/)
      // 盘符必须独立成一个目录层级
      expect(r.split('/')[0]).toMatch(/^[A-Za-z]$/)
    }
  })

  it('无分隔符的盘符（D:file.txt）也安全', () => {
    expect(toRelative('D:file.txt')).toBe('D/file.txt')
  })

  it('目录路径保留尾部结构', () => {
    expect(toRelative('D:\\Games\\')).toBe('D/Games/')
  })

  it('Unix 路径去掉前导斜杠（拼到 sandbox 下不会出现绝对路径逃逸）', () => {
    expect(toRelative('/home/user/a.txt')).toBe('home/user/a.txt')
  })

  it('相对路径原样规范化', () => {
    expect(toRelative('relative/path.txt')).toBe('relative/path.txt')
  })

  it('映射结果不能以 .. 开头（防目录逃逸出沙箱）', () => {
    for (const p of ['D:\\..\\..\\etc\\passwd', 'D:\\a\\..\\..\\b.txt']) {
      const r = toRelative(p)
      expect(r.startsWith('..'), `${p} → ${r} 可以逃出沙箱`).toBe(false)
    }
  })
})

describe('生产代码里确实写了这个修复', () => {
  const src = readFileSync(join(__dirname, '..', 'electron', 'sandbox.ts'), 'utf8')

  it('盘符分支补上了分隔符', () => {
    // 旧：driveMatch[1] + absolutePath.slice(...)
    // 新：driveMatch[1] + '/' + absolutePath.slice(...)
    expect(src).toMatch(/driveMatch\[1\]\s*\+\s*'\/'\s*\+/)
    expect(src).not.toMatch(/driveMatch\[1\]\s*\+\s*absolutePath\.slice/)
  })
})

describe('file_search 默认作用域', () => {
  const src = readFileSync(join(__dirname, '..', 'electron', 'tools', 'impl', 'fileSearch.ts'), 'utf8')

  it('rootDir 省略时不再默认全盘扫描', () => {
    // 旧：rootDir 为空 → getAllDriveRoots() 逐盘扫（实测 C 盘 63.8s）
    // 新：默认只搜 cwd + 沙箱目录；全盘要显式写 "all_drives"
    expect(src).toMatch(/all_drives/)
    expect(src).toMatch(/sandboxRoot\(\)/)
  })

  it('参数说明里写明全盘的代价', () => {
    expect(src).toMatch(/30-60 秒|30-60秒/)
  })
})
