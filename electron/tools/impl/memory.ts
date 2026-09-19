// ============================================================
// impl/memory.ts — Agent 记忆工具
// v2.5.1: 接入 SQLite MemoryStore 持久化，重启不丢失
// ============================================================

import type { ToolDef, ToolResult } from '../types'
import { getMemoryStore } from '../../memory/memoryStore'

const AGENT_MEMORY_CATEGORY = 'agent_memory'

/** 将 key-value 编码为单行存储 */
function encode(key: string, value: string): string {
  return `${key}::${value}`
}

/** 解码 key::value */
function decode(content: string): { key: string; value: string } | null {
  const idx = content.indexOf('::')
  if (idx === -1) {return null}
  return { key: content.slice(0, idx), value: content.slice(idx + 2) }
}

function getStore() {
  try { return getMemoryStore() } catch { return null }
}

// ═══════════════════════════════════════════════════════════

export const memorySaveDef: ToolDef = {
  name: 'memory_save',
  description: '保存信息到 Agent 记忆（持久化，重启不丢失）。用于记住用户偏好、重要信息等。',
  params: {
    key: { type: 'string', description: '记忆键名', required: true },
    value: { type: 'string', description: '记忆内容', required: true },
  },
  toolsets: ['agent'],
}

export async function memorySave(args: Record<string, any>): Promise<ToolResult> {
  const key: string = args.key
  const value: string = args.value
  const store = getStore()
  if (!store) {return { callId: '', ok: false, content: '', error: '记忆存储不可用' }}

  // 先删旧值，再存新值（同 key 覆盖）
  const existing = store.getFacts(AGENT_MEMORY_CATEGORY, 50)
  for (const f of existing) {
    const d = decode(f.content)
    if (d?.key === key) {
      store.deleteFact(f.id)
    }
  }

  store.addFact({
    category: AGENT_MEMORY_CATEGORY,
    content: encode(key, value),
    confidence: 1.0,
    source: 'agent_tool' as any,
  })

  return { callId: '', ok: true, content: `记忆已保存: ${key}` }
}

export const memoryGetDef: ToolDef = {
  name: 'memory_get',
  description: '读取指定记忆',
  params: {
    key: { type: 'string', description: '记忆键名', required: true },
  },
  toolsets: ['agent'],
}

export async function memoryGet(args: Record<string, any>): Promise<ToolResult> {
  const key: string = args.key
  const store = getStore()
  if (!store) {return { callId: '', ok: false, content: '', error: '记忆存储不可用' }}

  const facts = store.getFacts(AGENT_MEMORY_CATEGORY, 50)
  for (const f of facts) {
    const d = decode(f.content)
    if (d?.key === key) {
      return { callId: '', ok: true, content: d.value }
    }
  }

  return { callId: '', ok: false, content: '', error: `未找到记忆: ${key}` }
}

export const memoryAllDef: ToolDef = {
  name: 'memory_all',
  description: '列出所有已保存的记忆',
  params: {},
  toolsets: ['agent'],
}

export async function memoryAll(): Promise<ToolResult> {
  const store = getStore()
  if (!store) {return { callId: '', ok: true, content: '(记忆存储不可用)' }}

  const facts = store.getFacts(AGENT_MEMORY_CATEGORY, 50)
  if (facts.length === 0) {return { callId: '', ok: true, content: '(暂无记忆)' }}

  const items = facts.map(f => {
    const d = decode(f.content)
    return d ? `- ${d.key}: ${d.value.slice(0, 200)}` : `- ${f.content.slice(0, 200)}`
  })

  return { callId: '', ok: true, content: items.join('\n') }
}
