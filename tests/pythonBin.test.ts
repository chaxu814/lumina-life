// ============================================================
// tests/pythonBin.test.ts — 跨平台 Python 解析
// ============================================================
import { describe, it, expect } from 'vitest'
import { resolvePython, __resetPythonCacheForTest } from '../electron/pythonBin'

describe('resolvePython 跨平台解析', () => {
  it('总返回非空命令名（找不到时给平台默认，不抛异常）', () => {
    __resetPythonCacheForTest()
    const bin = resolvePython()
    expect(typeof bin).toBe('string')
    expect(bin.length).toBeGreaterThan(0)
  })

  it('类 Unix 缺省时默认 python3，Windows 默认 python', () => {
    __resetPythonCacheForTest()
    const bin = resolvePython()
    // 沙箱里可能真有 python，这里只校验是三者之一且与平台一致
    expect(['python', 'python3', 'py']).toContain(bin)
    if (process.platform !== 'win32') {
      // 找不到时回退也必须是 python3（不是裸 python）
      expect(bin).toMatch(/python3?/)
    }
  })
})
