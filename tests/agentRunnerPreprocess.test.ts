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

// ============================================================
// 查询提取（2026-10-13）
//
// 【要防的真实故障】实测日志：
//   用户问「使命召唤23什么时候发布」→ 实际搜索的查询是 **「发布」**
//     —— 主体整个丢掉，搜出来全是"发布"这个词本身的结果。
//   用户问「帮我查一下量子纠缠的由来」→ 查询是「量子纠缠的」
//     —— 末尾悬空一个「的」。
//
// 根因：`SEARCH_INTENT_PATTERNS` 里「事实」那条把**问词写在前面**：
//   /(?:什么时候|在哪里|…) \s* (.+)/ —— 中文里这类问句的主语在问词**之前**，
//   于是捕获组只拿到问词后面的残句。
//
// 本测试锁住：提取出来的查询必须包含"主体"，且不能是纯命令/纯噪声。
// ============================================================
describe('matchSearchIntent — 提取的查询必须含主体（不能只剩问词尾巴）', () => {
  it('「X 什么时候 Y」要拿到 X，而不是 Y', async () => {
    const { matchSearchIntent } = await import('../electron/agentRunner.preprocess')
    expect(matchSearchIntent('使命召唤23什么时候发布')?.query).toBe('使命召唤23')
    expect(matchSearchIntent('量子纠缠什么时候发现的')?.query).toBe('量子纠缠')
  })

  it('「X 是什么」这种主语在前的写法也要触发（原来完全不搜）', async () => {
    const { matchSearchIntent } = await import('../electron/agentRunner.preprocess')
    expect(matchSearchIntent('尼古喵喵是什么')?.query).toBe('尼古喵喵')
    expect(matchSearchIntent('量子纠缠是什么意思')?.query).toBe('量子纠缠')
  })

  it('「X 怎么样」也要触发', async () => {
    const { matchSearchIntent } = await import('../electron/agentRunner.preprocess')
    expect(matchSearchIntent('A股怎么样')?.query).toBe('A股')
    expect(matchSearchIntent('今天天气怎么样')?.query).toBe('天气')
  })

  it('问词在前的老写法不能被破坏', async () => {
    const { matchSearchIntent } = await import('../electron/agentRunner.preprocess')
    expect(matchSearchIntent('什么是量子纠缠')?.query).toBe('量子纠缠')
    expect(matchSearchIntent('介绍一下量子纠缠')?.query).toBe('量子纠缠')
  })

  it('「X 多少钱 / 在哪里」同样拿到主体', async () => {
    const { matchSearchIntent } = await import('../electron/agentRunner.preprocess')
    expect(matchSearchIntent('特斯拉股价多少')?.query).toBe('特斯拉')
    expect(matchSearchIntent('故宫在哪里')?.query).toBe('故宫')
  })

  it('纯命令（没有检索对象）不搜索 —— 否则会把"帮我查一下"本身拿去搜', async () => {
    const { matchSearchIntent } = await import('../electron/agentRunner.preprocess')
    expect(matchSearchIntent('帮我查一下')).toBeNull()
    expect(matchSearchIntent('搜索一下')).toBeNull()
    expect(matchSearchIntent('这个是什么')).toBeNull()
  })
})
