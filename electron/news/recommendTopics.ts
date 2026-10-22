// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// news/recommendTopics.ts — 「为你推荐」的话题画像（7 个任务类型）
//
// 【要解决的问题】2026-10-20 用户指出：选「代码开发」和选「情报监控」，
// 看到的推荐是同一批热榜，说明推荐跟任务类型无关。
//
// 这里把 7 个任务类型映射成「新闻分类偏好 + 兴趣描述」：
//   · categories 用于快段排序加权（同分类优先，但不排他）；
//   · interests 用于慢段 LLM 打分（给模型一个更具体的判断标准）。
//
// 任务卡 id（GroupChatView）与 Agent 角色 id（ChatPanel）是两套命名，
// 用 ALIAS 归一，调用方不需要知道这层差异。
// ============================================================

import type { NewsCategory } from '../tools/impl/newsCollector'

export interface RecommendTopic {
  label: string
  /** 快段排序偏好（同分类加权） */
  categories: NewsCategory[]
  /** 慢段 LLM 打分用的兴趣描述 */
  interests: string
}

export const RECOMMEND_TOPICS: Record<string, RecommendTopic> = {
  chat: {
    label: '日常聊天',
    categories: ['trending', 'general', 'ai'],
    interests: '社会热点、生活百科、趣味科普、科技新闻、娱乐资讯',
  },
  learn: {
    label: '学习辅导',
    categories: ['paper', 'ai', 'general'],
    interests: '学术论文、AI 前沿研究、学习方法、科普知识、编程教程',
  },
  write: {
    label: '写作创作',
    categories: ['general', 'trending', 'tech'],
    interests: '内容创作、写作技巧、文案案例、文化热点、媒体动态',
  },
  code: {
    label: '代码开发',
    categories: ['ai', 'oss', 'tech'],
    interests: 'AI 编程工具、开源项目、编程语言与框架、软件工程实践、技术教程',
  },
  design: {
    label: '商业设计',
    categories: ['tech', 'general', 'ai'],
    interests: 'UI/UX 设计、设计系统、产品设计、配色与排版、设计工具',
  },
  intel: {
    label: '情报监控',
    categories: ['ai', 'finance', 'tech'],
    interests: 'AI 行业动态、公司融资与产品发布、芯片与算力、政策监管、竞品动向',
  },
  work: {
    label: '职场办公',
    categories: ['general', 'tech', 'finance'],
    interests: '办公效率工具、职场沟通、管理与协作、商业资讯、职场成长',
  },
}

/** Agent 角色 id（ChatPanel）→ 任务卡 id（GroupChatView） */
const ALIAS: Record<string, string> = {
  general: 'chat',
  learner: 'learn',
  writer: 'write',
  developer: 'code',
  colleague: 'work',
}

/** 把任意一端的角色 id 归一成话题；未知返回 null（走全局推荐） */
export function resolveRecommendTopic(id?: string | null): RecommendTopic | null {
  if (!id) {return null}
  const key = ALIAS[id] || id
  return RECOMMEND_TOPICS[key] || null
}

/** 缓存 key：不同话题必须分开缓存，否则切角色会看到上一个角色的榜单 */
export function topicCacheKey(id?: string | null): string {
  if (!id) {return '_all'}
  return ALIAS[id] || id
}
