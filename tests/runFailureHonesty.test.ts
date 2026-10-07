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
