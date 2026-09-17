// ============================================================
// tests/cuSafety.test.ts — Computer Use 高危命令硬拦截
// ============================================================

import { describe, it, expect } from 'vitest'
import { destructiveReason, isDestructive } from '../electron/tools/impl/cuSafety'

describe('destructiveReason', () => {
  const blocked = [
    'format c: /q',
    'format D:',
    'sudo rm -rf /',
    'rm -rf ~',
    'mkfs.ext4 /dev/sda1',
    'diskpart',
    'shutdown /s /t 0',
    'shutdown -r now',
    'Restart-Computer -Force',
    'reg delete HKLM\\Software\\X /f',
    'Remove-Item C:\\x -Recurse -Force',
    'del /f /q C:\\Windows\\x.dll',
    'rmdir /s /q C:\\folder',
    'net user admin NewPass123 /add',
    'dd if=x of=\\\\.\\PhysicalDrive0',
    ':(){ :|:& };:',
  ]
  it.each(blocked)('blocks: %s', (cmd) => {
    expect(destructiveReason(cmd)).not.toBeNull()
    expect(isDestructive(cmd)).toBe(true)
  })

  const allowed = [
    '请帮我打开记事本',
    '在搜索框输入：今天天气不错',
    '点击右上角的关闭按钮',
    '帮我把这段话打出来：rm 是 remove 的缩写',
    'type "format the report"',
    'ctrl_c',
    '你好，世界',
    '',
    undefined,
    null,
  ]
  it.each(allowed as any[])('allows ordinary text: %s', (text) => {
    expect(destructiveReason(text)).toBeNull()
  })

  it('returns a Chinese human-readable reason', () => {
    const r = destructiveReason('format e:')
    expect(r).toContain('高危')
  })
})
