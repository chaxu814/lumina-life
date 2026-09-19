// ============================================================
// live2dWiring.test.ts — 🔌 Live2D「AI 驱动身体」端到端接线契约
//
// 防的是「AI 输出了动作/表情，但模型没反应」这一类最伤体感的断裂：
//   ① generator 能输出的每个动作，渲染层 execIntent 都必须有 case 接住；
//   ② 渲染层 FACE_EXPR_MAP 引用的每个 exp_XX，模型 json 里必须真实存在；
//   ③ emotionCore 的每个情绪标签，渲染层都必须有 mood→表情 映射；
//   ④ 模型自带动作组要被检测到（动作系统不是空壳）。
//
// execIntent 写在 pet-live2d.html 的内联 JS 里（无法直接 import），
// 因此这里用静态契约：读取源文件 + 模型 json，做跨文件一致性断言。
// ============================================================
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { VISIBLE_ACTIONS, ACTIONS } from '../electron/proactive/generator'
import { MOOD_COORDS } from '../electron/pet/life/emotionCore'

const PET_DIR = path.join(__dirname, '..', 'electron', 'pet')
const html = fs.readFileSync(path.join(PET_DIR, 'pet-live2d.html'), 'utf8')
const modelJson = JSON.parse(
  fs.readFileSync(path.join(PET_DIR, 'assets', 'Mao', 'mao_pro.model3.json'), 'utf8'),
)

/** 提取 execIntent 函数体内的所有 case 动作名 */
function execIntentCases(): Set<string> {
  const start = html.indexOf('function execIntent')
  expect(start).toBeGreaterThan(-1)
  // execIntent 后面紧跟 startAutonomyLoop，以此为函数块结束边界
  const end = html.indexOf('startAutonomyLoop', start)
  const body = html.slice(start, end)
  const set = new Set<string>()
  for (const m of body.matchAll(/case\s+'([a-z-]+)'\s*:/g)) set.add(m[1])
  return set
}

/** 提取 FACE_EXPR_MAP：{ 语义名: exp_XX } */
function faceExprMap(): Record<string, string> {
  const m = html.match(/const FACE_EXPR_MAP\s*=\s*\{([^}]*)\}/)
  expect(m, 'FACE_EXPR_MAP 应存在').toBeTruthy()
  const map: Record<string, string> = {}
  for (const p of (m as RegExpMatchArray)[1].matchAll(/(\w+)\s*:\s*'(exp_\d+)'/g)) {
    map[p[1]] = p[2]
  }
  return map
}

/** 提取 applyMoodExpression 里 mood 标签 → 表情语义名 的映射 key */
function moodExpressionKeys(): Set<string> {
  const start = html.indexOf('function applyMoodExpression')
  expect(start).toBeGreaterThan(-1)
  const end = html.indexOf('naturalMicroExpression', start)
  const body = html.slice(start, end)
  const set = new Set<string>()
  for (const m of body.matchAll(/'([^']+)\s*[^']*'\s*:\s*'[a-z]+'/g)) set.add(m[1].trim())
  return set
}

describe('Live2D AI 驱动身体 · 端到端接线契约', () => {
  const cases = execIntentCases()
  const faceMap = faceExprMap()

  it('1. 模型 json 至少声明 8 个表情文件（Mao 实测 8 个）', () => {
    const exprs: Array<{ Name: string; File: string }> = modelJson.FileReferences.Expressions
    expect(Array.isArray(exprs)).toBe(true)
    expect(exprs.length).toBeGreaterThanOrEqual(8)
    for (const e of exprs) {
      expect(e.Name).toMatch(/^exp_\d+$/)
      const file = path.join(PET_DIR, 'assets', 'Mao', e.File)
      expect(fs.existsSync(file), `表情文件应存在: ${e.File}`).toBe(true)
    }
  })

  it('2. FACE_EXPR_MAP 引用的每个表情，模型 json 都真实存在', () => {
    const modelExprs = new Set(modelJson.FileReferences.Expressions.map((e: any) => e.Name))
    const required = ['happy', 'sad', 'angry', 'joy', 'blush', 'surprise', 'calm', 'shy', 'sleepy']
    for (const key of required) {
      const exp = faceMap[key]
      expect(exp, `FACE_EXPR_MAP 应包含 ${key}`).toBeTruthy()
      expect(modelExprs.has(exp), `${key}→${exp} 必须是模型真实表情`).toBe(true)
    }
  })

  it('3. generator 每个「可见动作」都能被 execIntent 接住（不会发出模型不认识的动作）', () => {
    for (const action of VISIBLE_ACTIONS) {
      expect(cases.has(action), `execIntent 缺少动作 case: ${action}`).toBe(true)
    }
  })

  it('4. 主动台词 ACTIONS 全集（含 say/blink/idle）都能被 execIntent 接住', () => {
    for (const action of ACTIONS.split('/')) {
      expect(cases.has(action), `execIntent 缺少动作 case: ${action}`).toBe(true)
    }
  })

  it('5. 对话 prompt 列出的动作也都在 execIntent 中（含 emote 降级动作）', () => {
    for (const action of ['walk', 'emote', 'say', 'idle', 'perform']) {
      expect(cases.has(action), `execIntent 缺少动作 case: ${action}`).toBe(true)
    }
  })

  it('6. emotionCore 的每个情绪标签，渲染层都有 mood→表情 映射', () => {
    const mapped = moodExpressionKeys()
    for (const mood of Object.keys(MOOD_COORDS)) {
      expect(mapped.has(mood), `applyMoodExpression 缺少情绪映射: ${mood}`).toBe(true)
    }
  })

  it('7. 模型声明了 Idle 与无名组动作（空闲动作循环有素材可用）', () => {
    const groups = Object.keys(modelJson.FileReferences.Motions)
    expect(groups).toContain('Idle')
    const idleCount = modelJson.FileReferences.Motions.Idle.length
    expect(idleCount).toBeGreaterThanOrEqual(1)
    // 无名组 6 个（mtn_02/03/04 + special_01/02/03）是 idle 循环与情绪动作的素材
    const free = modelJson.FileReferences.Motions[''] || []
    expect(free.length).toBeGreaterThanOrEqual(6)
  })

  it('9. AI 情绪动作在缺少 TapBody 组时回退到模型自带 special 动作（真的会抬手/带特效）', () => {
    const fnBody = (name: string): string => {
      const m = html.match(new RegExp(`function ${name}\\s*\\([\\s\\S]*?\\n}`))
      expect(m, `应找到函数 ${name}`).toBeTruthy()
      return m![0]
    }
    // Mao 无名组固定顺序：0=mtn_02,1=mtn_03(招手),2=mtn_04,3=special_01(爱心),4=special_02(爆炸),5=special_03(光环)
    expect(fnBody('doWave')).toContain('playSpecial(1)')
    expect(fnBody('doHappy')).toContain('playSpecial(3)')
    expect(fnBody('doDance')).toContain('playSpecial(4)')
    expect(fnBody('doClap')).toContain('playSpecial(5)')
  })

  it('8. 每个情绪类动作最终都会设置对应表情（happy/sad/angry/surprised）', () => {
    const body = html.slice(html.indexOf('function execIntent'), html.indexOf('startAutonomyLoop'))
    // 取 case 体；若它调用 doXxx()（表情在 doXxx 内部），把该函数体也并入检查
    const actionBody = (action: string): string => {
      const seg = body.match(new RegExp(`case '${action}':([\\s\\S]*?)(?=case '|default:)`))
      expect(seg, `应找到 ${action} 分支`).toBeTruthy()
      let b = seg![1]
      const fn = b.match(/(do[A-Z][A-Za-z]*)\s*\(/)
      if (fn) {
        const fnBody = html.match(new RegExp(`function ${fn[1]}\\s*\\([\\s\\S]*?\\n}`))
        if (fnBody) b += '\n' + fnBody[0]
      }
      return b
    }
    // 这些动作分支体内必须设置对应表情，避免「跳了但脸没变化」
    const mustSetFace: Array<[string, string]> = [
      ['happy', 'joy'],
      ['sad', 'sad'],
      ['angry', 'angry'],
      ['surprised', 'surprise'],
    ]
    for (const [action, face] of mustSetFace) {
      expect(actionBody(action)).toContain(`setFace('${face}')`)
    }
  })
})
