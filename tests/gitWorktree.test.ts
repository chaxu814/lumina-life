// ============================================================
// tests/gitWorktree.test.ts — worktree 隔离工作区纯函数测试 (v3.20)
// ============================================================

import { describe, it, expect } from 'vitest'
import {
  parseWorktreePorcelain, sanitizeName,
} from '../electron/team/gitWorktree'

describe('parseWorktreePorcelain', () => {
  it('解析主工作区 + 分支', () => {
    const text = [
      'worktree K:/2/Lumina AI',
      'HEAD abc123def456',
      'branch refs/heads/main',
      '',
    ].join('\n')
    const list = parseWorktreePorcelain(text)
    expect(list).toHaveLength(1)
    expect(list[0].path).toBe('K:/2/Lumina AI')
    expect(list[0].head).toBe('abc123def456')
    expect(list[0].branch).toBe('main')
    expect(list[0].detached).toBe(false)
  })

  it('解析多个 worktree，含 detached', () => {
    const text = [
      'worktree /repo/main',
      'HEAD 111',
      'branch refs/heads/main',
      '',
      'worktree /repo/.lumina-worktrees/wt_x',
      'HEAD 222',
      'detached',
      '',
      'worktree /repo/.lumina-worktrees/wt_y',
      'HEAD 333',
      'branch refs/heads/lumina/review_1',
      '',
    ].join('\n')
    const list = parseWorktreePorcelain(text)
    expect(list).toHaveLength(3)
    expect(list[1].detached).toBe(true)
    expect(list[1].branch).toBeNull()
    expect(list[2].branch).toBe('lumina/review_1')
  })

  it('畸形/空输入返回空数组', () => {
    expect(parseWorktreePorcelain('')).toHaveLength(0)
    expect(parseWorktreePorcelain('HEAD orphan\n')).toHaveLength(0)
  })

  it('兼容 CRLF 换行', () => {
    const text = 'worktree C:/repo\r\nHEAD 9\r\nbranch refs/heads/dev\r\n'
    const list = parseWorktreePorcelain(text)
    expect(list[0].path).toBe('C:/repo')
    expect(list[0].branch).toBe('dev')
  })
})

describe('sanitizeName', () => {
  it('只保留字母数字下划线横线，其余替换', () => {
    expect(sanitizeName('code review/2026')).toBe('code_review_2026')
    expect(sanitizeName('a@#$b')).toBe('a___b')
  })
  it('保留合法名', () => {
    expect(sanitizeName('tmp_research_1')).toBe('tmp_research_1')
  })
  it('截断到 60 字符', () => {
    expect(sanitizeName('a'.repeat(100))).toHaveLength(60)
  })
  it('斜杠等非法字符替换为下划线（结果非空）', () => {
    expect(sanitizeName('///')).toBe('___')
  })

  it('空字符串给 wt_ 兜底名', () => {
    const name = sanitizeName('')
    expect(name.length).toBeGreaterThan(0)
    expect(name.startsWith('wt_')).toBe(true)
  })
})
