// ============================================================
// tests/clarifyScope.test.ts — 模糊任务「先问再做」的行为边界
//
// 【这个测试最在意的两件事】
// ① 该问的确实问了（「优化一下这个项目」是评测里点名的危险问法）
// ② **不该问的绝对不问** —— 一个逢事先问一句的 Agent 比不問的还烦。
//    过度打扰会把用户逼到放弃，所以「不打扰」和「会问」同等重要。
// ============================================================

import { describe, it, expect } from 'vitest'
import { analyzeClarity } from '../electron/orchestration/clarifyScope'

describe('该问的确实问了', () => {
  const vague = [
    '优化一下这个项目',
    '优化下这个工程',
    '帮我改进一下代码',
    '整理一下这个仓库',
    '看看这个项目',
    '完善一下这个系统',
    '搞一下这个模块',
  ]

  for (const t of vague) {
    it(`「${t}」→ 判定为模糊并给出追问建议`, () => {
      const r = analyzeClarity(t)
      expect(r.kind).toBe('vague')
      expect(r.hint.length).toBeGreaterThan(10)
      expect(r.questions.length).toBeGreaterThanOrEqual(2)
    })
  }
})

describe('不该问的绝对不问 —— 这一半更重要', () => {
  const clearCases: Array<[string, string]> = [
    ['具体到文件', '优化一下 src/panels/ChatPanel.tsx 里的消息渲染'],
    ['具体到函数', '优化一下 fetchUserData() 这个函数'],
    ['带行号', '优化一下 L120:30 附近那段逻辑'],
    ['带报错', '这个报错 Error: cannot read property of undefined 怎么修'],
    ['带链接', '看看 https://example.com/issue/123 这个怎么解决'],
    ['纯答疑', '优化是什么意思'],
    ['纯答疑2', '为什么 tsc 报这个错'],
    ['纯答疑3', '解释一下这个配置文件的 algorithm 字段'],
    ['具体任务动词', '帮我把这个函数改成异步的'],
    ['具体任务动词2', '把 README 里的安装步骤补全'],
    ['长句且具体', '这个项目最近启动特别慢，帮我看看是不是 electron 主进程初始化那里有同步阻塞的问题，重点看 main.ts'],
  ]

  for (const [name, text] of clearCases) {
    it(`${name}：不注入提示（kind != vague）`, () => {
      const r = analyzeClarity(text)
      expect(r.kind).not.toBe('vague')
      expect(r.hint).toBe('')
    })
  }

  it('空输入不炸且不提示', () => {
    expect(analyzeClarity('').kind).toBe('clear')
    expect(analyzeClarity('   ').kind).toBe('clear')
  })

  it('纯答疑单独归类，方便调用方决定要不要完全跳过流程', () => {
    expect(analyzeClarity('解释一下这段代码').kind).toBe('answer_only')
    expect(analyzeClarity('这个函数是干什么的').kind).toBe('answer_only')
  })

  it('含泛动词但没有工作量暗示 → 不问（「优化一下这个算法」够具体）', () => {
    // 有动词无工作量信号，指向明确
    const r = analyzeClarity('优化一下这个排序算法')
    expect(r.kind).not.toBe('vague')
  })

  it('有工作量暗示但无泛动词 → 不问（「这个项目报错了」是具体问题）', () => {
    const r = analyzeClarity('这个项目启动就报错了')
    expect(r.kind).not.toBe('vague')
  })
})

describe('提示语本身的质量', () => {
  it('提示语里点明了「方向可以差很远」，而不是空泛地说要澄清', () => {
    const r = analyzeClarity('优化一下这个项目')
    expect(r.hint).toContain('笼统')
    expect(r.hint).toContain('验收')
  })

  it('建议问题覆盖 目标 / 范围 / 验收 三个维度', () => {
    const r = analyzeClarity('优化一下这个项目')
    const joined = r.questions.join(' ')
    expect(joined).toContain('哪一类问题')  // 目标
    expect(joined).toContain('范围')        // 范围
    expect(joined).toContain('算完成')      // 验收
  })

  it('提示语里包含用户原话，便于模型确认自己没理解错', () => {
    const r = analyzeClarity('整理一下这个仓库')
    expect(r.hint).toContain('整理一下这个仓库')
  })

  it('超长输入被截断，不会把整句话塞进 system prompt', () => {
    const long = '优化一下这个项目'.repeat(50)
    const r = analyzeClarity(long)
    // 超 40 字 → 直接判 clear，不注入
    expect(r.hint).toBe('')
  })
})
