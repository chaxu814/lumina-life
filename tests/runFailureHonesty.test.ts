// ============================================================
// runFailureHonesty.test.ts — 失败文案必须如实归因（2026-10-07）
//
// 【怎么发现的】端到端实测用例 T3「帮我写个爬虫，然后让团队审一下」：
//   真实原因 = delegate_to 报「Yak 📊 未配置 LLM」+ file_write 参数非法。
//   而用户看到的兜底文案 = 「这次没能完成，是模型服务返回了一个无法识别的错误」。
//
//   **把「团队没配好」「工具被拦」伪装成了「模型服务出问题」。**
//   后果很具体：用户会朝完全错误的方向排查 —— 反复重启 LM Studio、
//   换模型、调参数，而真正的问题（给 Yak 配个模型）一直没人碰。
//
// 【本文件守的】
//   1. 工具层 / 团队层的失败必须单独识别，给出**能行动**的建议
//   2. 兜底文案**不得**一口咬定是模型服务的问题
// ============================================================

import { describe, it, expect } from 'vitest'
import { describeRunFailure } from '../electron/agentRunner'

describe('失败归因：工具层 / 团队层的失败必须单独识别', () => {
  it('团队成员没配 LLM → 提示去配置，不要甩锅给模型服务', () => {
    const msg = describeRunFailure('Yak 📊 未配置 LLM，暂时不可用。请先在设置中为该 Agent 配置 LLM。')
    expect(msg).toContain('大模型')
    expect(msg).toContain('Yak')
    expect(msg, '不该把「队友没配 LLM」说成模型服务错误').not.toContain('模型服务')
  })

  it('权限档位拦截 → 提示需要批准', () => {
    const msg = describeRunFailure('🔐 权限档位要求确认（目标在工作区外…）请回复 /approve apr_xxx 批准')
    expect(msg).toContain('批准')
    expect(msg, '不该把「权限拦截」说成模型服务错误').not.toContain('模型服务返回')
  })

  it('工具参数非法 → 提示是工具没执行成功', () => {
    const msg = describeRunFailure('⛔ 未执行成功（原因：工具 "file_write" 的参数不是合法 JSON，无法解析，未执行）')
    expect(msg).toContain('工具')
    expect(msg).toContain('没能执行成功')
  })

  it('工具本轮未加载 → 也归入工具失败，不说成模型错误', () => {
    const msg = describeRunFailure('工具 "calendar_add" 本轮未加载')
    expect(msg).toContain('工具')
    expect(msg).not.toContain('模型服务返回')
  })
})

describe('兜底文案：不得谎报成因', () => {
  it('未知原因时不许一口咬定「是模型服务返回的错误」', () => {
    const msg = describeRunFailure('something completely unclassifiable')
    expect(
      msg,
      `兜底文案不该把锅全甩给模型服务 —— 实测证明工具层失败也会走到这里。\n实际文案：${msg}`,
    ).not.toContain('是模型服务返回了一个无法识别的错误')
  })

  it('未知原因时要给出可排查的方向', () => {
    const msg = describeRunFailure('zzz')
    // 至少要提到「工具」这个可能性，否则用户只会朝模型服务方向排查
    expect(msg, `兜底文案应提示多种可能，实际：${msg}`).toContain('工具')
  })

  it('已知的几类失败仍然正确识别（没有把老规则改坏）', () => {
    expect(describeRunFailure('request timeout')).toContain('超时')
    expect(describeRunFailure('401 unauthorized')).toContain('鉴权')
    expect(describeRunFailure('429 rate limit')).toContain('频率')
    expect(describeRunFailure('econnrefused')).toContain('连不上')
    expect(describeRunFailure('maximum context length exceeded')).toContain('上下文')
    expect(describeRunFailure('用户取消了')).toContain('中止')
  })
})

// ============================================================
// 本地 vs 云端的文案区分（2026-10-10）
//
// 【问题】旧 describeRunFailure 对所有 401/403 一律回「请检查 API Key / 账户余额」。
//   本地 LM Studio / Ollama 没有「账户余额」概念，用户照着这条建议去翻
//   OpenAI/DeepSeek 后台找余额，方向完全错。真实原因通常是：
//     · LM Studio 开了 Require Authentication
//     · 用户在设置里误填了一个占位 key
// 【本文件守的】
//   isLocal=true 时，auth 文案必须提到「本地」「LM Studio / Ollama」，
//   且不得出现「账户余额」这类云端专属词。
// ============================================================
describe('本地 vs 云端：auth 文案必须区分', () => {
  it('本地 401 → 提示 LM Studio / Ollama 鉴权，不提账户余额', () => {
    const msg = describeRunFailure('LLM 返回 401: Unauthorized', { isLocal: true })
    expect(msg, '本地 auth 文案应提到「本地」').toContain('本地')
    expect(msg, '本地 auth 文案应提到 LM Studio 或 Ollama').toMatch(/LM Studio|Ollama/)
    expect(msg, '本地没有「账户余额」概念，不该出现').not.toContain('账户余额')
    expect(msg, '不该说成「模型服务」（本地推理是用户自己的服务）').not.toContain('模型服务')
  })

  it('云端 401 → 仍保留「请检查 API Key / 账户余额」（向后兼容）', () => {
    const msg = describeRunFailure('401 unauthorized', { isLocal: false })
    expect(msg).toContain('鉴权')
    expect(msg).toContain('API Key')
  })

  it('不传 isLocal → 默认按云端处理（向后兼容老调用方）', () => {
    const msg = describeRunFailure('401 unauthorized')
    expect(msg).toContain('API Key')
  })
})

// ============================================================
// 模型名对不上：不能照抄服务端那句「你还没加载模型」（2026-10-16）
//
// 【怎么发现的】用户把 LM Studio 界面上的显示名「QwenPaw Flash 4B Q4」
//   填进了 Model 一栏（服务端的模型 ID 其实是 qwenpaw-flash-4b@q4_k_m）。
//   调用返回 400，body 是 LM Studio 的原文：
//     "No models loaded. Please load a model in the developer page…"
//   这句话把人指向「去加载模型」，而模型其实早就加载好了 —— 名字写错而已。
//
// 【本文件守的】模型名类失败必须单列，且文案要点出「用模型 ID 而不是显示名」，
//   否则用户会照着服务端原文反复重装/重载模型，永远修不好。
// ============================================================
describe('模型名对不上：文案必须点破「ID ≠ 显示名」', () => {
  it('LM Studio 的 "No models loaded" → 指向模型名而不是「去加载模型」', () => {
    const msg = describeRunFailure(
      '{"error":{"message":"No models loaded. Please load a model in the developer page or use the \'lms load\' command.","param":"model"}}',
    )
    expect(msg, '要点出是模型名的问题').toMatch(/模型名|模型 ID|显示名/)
    expect(msg, '要给出可抄的正确形态').toContain('@')
    expect(msg, '不能跟着服务端说「去加载模型」').not.toMatch(/加载模型/)
  })

  it('model not found / 模型不存在 → 同样归类', () => {
    for (const raw of ['model "foo" not found', 'The model does not exist', '模型不存在']) {
      const msg = describeRunFailure(raw)
      expect(msg, raw).toMatch(/模型名|模型 ID|显示名/)
    }
  })

  it('鉴权失败不会被误判成模型名问题', () => {
    const msg = describeRunFailure('401 Unauthorized', { isLocal: true })
    expect(msg).toMatch(/鉴权/)
  })
})
