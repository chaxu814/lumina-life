// ============================================================
// impl/todo.ts — 任务追踪工具
// ============================================================

import type { ToolDef, ToolResult } from '../types'

interface TodoItem {
  id: number
  text: string
  done: boolean
}

let todos: TodoItem[] = []
let nextId = 1

export const todoDef: ToolDef = {
  name: 'todo',
  description: '管理任务追踪列表。多步骤任务时创建计划，完成时标记，防止遗漏目标。',
  params: {
    action: {
      type: 'string',
      description: '操作类型',
      enum: ['create', 'mark_done', 'list'],
      required: true,
    },
    items: { type: 'string', description: 'create时: 任务列表文本 (每行一项)', required: false },
    id: { type: 'number', description: 'mark_done时: 任务ID', required: false },
  },
  toolsets: ['agent'],
}

export async function todo(args: Record<string, any>): Promise<ToolResult> {
  const action: string = args.action

  if (action === 'create') {
    const itemsText: string = args.items || ''
    const items = itemsText.split('\n').filter((l) => l.trim())
    todos = items.map((text, i) => ({
      id: nextId + i,
      text: text.replace(/^\d+[\.\)、\s]*/, '').trim(),
      done: false,
    }))
    nextId += items.length

    const list = todos.map((t) => `  [ ] ${t.id}. ${t.text}`).join('\n')
    return { callId: '', ok: true, content: `任务计划创建 (${todos.length} 项):\n${list || '(空)'}` }
  }

  if (action === 'mark_done') {
    const id = args.id
    const item = todos.find((t) => t.id === id)
    if (!item) {
      return { callId: '', ok: false, content: '', error: `未找到任务 ID: ${id}` }
    }
    item.done = true
    const doneCount = todos.filter((t) => t.done).length
    return { callId: '', ok: true, content: `任务 ${id} 已完成 (${doneCount}/${todos.length})` }
  }

  if (action === 'list') {
    if (todos.length === 0) {
      return { callId: '', ok: true, content: '(无任务)' }
    }
    const list = todos.map((t) => `  [${t.done ? '✓' : ' '}] ${t.id}. ${t.text}`).join('\n')
    return { callId: '', ok: true, content: list }
  }

  return { callId: '', ok: false, content: '', error: `未知操作: ${action}` }
}
