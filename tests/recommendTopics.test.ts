// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// tests/recommendTopics.test.ts — 「为你推荐」话题画像
// ============================================================
// 背景：2026-10-20 用户发现「选代码开发」和「选情报监控」看到的是同一批热榜。
// 修复方式是把 7 个任务类型映射成「分类偏好 + 兴趣描述」，并用 ALIAS 把
// Agent 角色 id 与任务卡 id 归一。这些映射是纯查表逻辑，错一个用户就会
// 看到「文不对题」的推荐，所以用单测把表钉住。
import { describe, it, expect } from 'vitest'
import {
  RECOMMEND_TOPICS,
  resolveRecommendTopic,
  topicCacheKey,
} from '../electron/news/recommendTopics'

const TASK_IDS = ['chat', 'learn', 'write', 'code', 'design', 'intel', 'work']

describe('RECOMMEND_TOPICS 表完整性', () => {
  it('7 个任务类型都有画像', () => {
    for (const id of TASK_IDS) {
      expect(RECOMMEND_TOPICS[id], `缺少任务类型 ${id}`).toBeTruthy()
    }
  })

  it('每项都有非空 label / categories / interests', () => {
    for (const [id, t] of Object.entries(RECOMMEND_TOPICS)) {
      expect(t.label.length, `${id} 缺 label`).toBeGreaterThan(0)
      expect(t.categories.length, `${id} 缺 categories`).toBeGreaterThan(0)
      expect(t.interests.length, `${id} 缺 interests`).toBeGreaterThan(0)
    }
  })

  it('「代码开发」与「情报监控」的分类偏好必须不同（本次修复的核心）', () => {
    const code = RECOMMEND_TOPICS.code
    const intel = RECOMMEND_TOPICS.intel
    expect(code.label).not.toBe(intel.label)
    expect(code.categories.join(',')).not.toBe(intel.categories.join(','))
    expect(code.interests).not.toBe(intel.interests)
  })
})

describe('resolveRecommendTopic：任务卡 id 直接命中', () => {
  it('code → 代码开发', () => {
    expect(resolveRecommendTopic('code')?.label).toBe('代码开发')
  })

  it('intel → 情报监控', () => {
    expect(resolveRecommendTopic('intel')?.label).toBe('情报监控')
  })
})

describe('resolveRecommendTopic：Agent 角色 id 经 ALIAS 归一', () => {
  it.each([
    ['general', '日常聊天'],
    ['learner', '学习辅导'],
    ['writer', '写作创作'],
    ['developer', '代码开发'],
    ['colleague', '职场办公'],
  ])('%s → %s', (roleId, label) => {
    expect(resolveRecommendTopic(roleId)?.label).toBe(label)
  })

  it('未知 id / 空值 返回 null（调用方走全局推荐）', () => {
    expect(resolveRecommendTopic('nope')).toBeNull()
    expect(resolveRecommendTopic('')).toBeNull()
    expect(resolveRecommendTopic(undefined)).toBeNull()
    expect(resolveRecommendTopic(null)).toBeNull()
  })
})

describe('topicCacheKey：缓存必须按话题分开', () => {
  it('同一话题的不同写法得到同一个 key（否则会重复抓取）', () => {
    expect(topicCacheKey('developer')).toBe(topicCacheKey('code'))
    expect(topicCacheKey('general')).toBe(topicCacheKey('chat'))
  })

  it('不同话题的 key 不同（否则切角色会看到上一个角色的榜单）', () => {
    const keys = new Set(TASK_IDS.map(id => topicCacheKey(id)))
    expect(keys.size).toBe(TASK_IDS.length)
  })

  it('无话题时回落到 _all', () => {
    expect(topicCacheKey(undefined)).toBe('_all')
    expect(topicCacheKey(null)).toBe('_all')
  })
})
