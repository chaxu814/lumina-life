// tests/memoryStore.test.ts — MemoryStore 单元测试
// ⚠️ better-sqlite3 二进制由 electron-rebuild 编译，仅 Electron 进程可用。
//    系统 Node.js 下无法运行，跳过测试。使用 `npm run test:electron` 运行。
import { describe, it } from 'vitest'

describe('MemoryStore', () => {
  it.skip('requires Electron runtime — better-sqlite3 binary is compiled for Electron, not system Node', () => {})

  // 如需在 CI 中运行，先在 CI 环境执行:
  //   npm rebuild better-sqlite3 --build-from-source
  // 然后取消 skip:
  //   import { MemoryStore } from '../electron/memory/memoryStore'
  //   const store = new MemoryStore(':memory:')
  //   store.saveUserProfile({ name: 'Test' })
  //   expect(store.getUserProfile()?.name).toBe('Test')
  //   store.db.close()  // MemoryStore.db is private; add public close() if needed
})
