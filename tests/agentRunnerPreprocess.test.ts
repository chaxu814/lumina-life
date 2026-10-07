// tests/agentRunnerPreprocess.test.ts
//
// 检索预处理模块的拆分回归测试。
//
// 【这个文件在防什么】
// 2026-10-05 把检索预处理（约 280 行）从 agentRunner.ts（4041 行）拆到
// agentRunner.preprocess.ts。这是一次**纯搬运**重构，目标是把单文件体积降下来，
// 而不是改行为。
//
// 纯搬运最典型的翻车方式是「看起来能跑、其实某个调用点断了」：
//   · re-export 写成了 `export {...} from`，没写配套 import —— 对外能拿到符号，
//     但 agentRunner.ts 内部调用全断
//   · 搬走的块用到了 agentRunner 顶部 import 的某个工具函数，新文件没补 import
//   · 导出可见性收窄，外部调用点编译不过
//
// 下面三条用例分别钉住这三种翻车方式。
import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '.', getName: () => 'Lumina Life', getVersion: () => '0-test' },
  BrowserWindow: class { constructor() {} },
  ipcMain: { on: () => {}, handle: () => {}, removeHandler: () => {} },
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 } }), on: () => {} },
  globalShortcut: { register: () => true, unregister: () => {}, unregisterAll: () => {} },
  desktopCapturer: { getSources: async () => [] },
  clipboard: { writeText: () => {} },
  shell: { openExternal: async () => {} },
}))

describe('检索预处理模块拆分', () => {
  it('预处理模块自己导出了四个符号（不靠 agentRunner 转发）', async () => {
    const m = await import('../electron/agentRunner.preprocess')
    expect(typeof m.preProcessMessage).toBe('function')
    expect(typeof m.preExecuteSearch).toBe('function')
    expect(typeof m.preExecuteCollect).toBe('function')
    expect(typeof m.isCompanionChat).toBe('function')
  })

  it('agentRunner 仍然转出同样四个符号（既有调用点不必改）', async () => {
    const m = await import('../electron/agentRunner')
    expect(typeof m.preProcessMessage).toBe('function')
    expect(typeof m.preExecuteSearch).toBe('function')
    expect(typeof m.preExecuteCollect).toBe('function')
    expect(typeof m.isCompanionChat).toBe('function')
  })

  it('⚠️ re-export 与本地绑定是同一份实现，不是两份拷贝', async () => {
    // 如果 agentRunner.ts 只写了 `export {...} from` 而没写配套 import，
    // 这里的调用会在运行时炸 "preProcessMessage is not a function"；
    // 如果两边各自复制了实现，行为会悄悄分叉。
    // 断言两者引用相等，是这两类翻车的共同解药。
    const runner = await import('../electron/agentRunner')
    const pre = await import('../electron/agentRunner.preprocess')
    expect(runner.preProcessMessage).toBe(pre.preProcessMessage)
    expect(runner.isCompanionChat).toBe(pre.isCompanionChat)
  })

  it('isCompanionChat：陪伴/自我指涉语句判定为不自动联网', async () => {
    const { isCompanionChat } = await import('../electron/agentRunner.preprocess')
    expect(isCompanionChat('你是谁')).toBe(true)
    expect(isCompanionChat('陪我聊会儿天')).toBe(true)
    // 明确的检索意图不应被判成陪伴闲聊
    expect(isCompanionChat('帮我查一下今天上海的天气')).toBe(false)
  })
})
