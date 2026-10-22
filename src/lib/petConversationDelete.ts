// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
/**
 * petConversationDelete — 桌宠聊天窗「垃圾桶」的删除口径计算
 *
 * 【背景】桌宠聊天窗右上角 🗑 以前只调 `clearChat()`：把 DOM 清空，后端
 *   store 里的会话和消息一条没动。下次开窗拉历史，删掉的对话全回来了 ——
 *   用户感知就是「点了删除根本没删掉」，而且没有"选择删除 / 一键全删"的口径。
 *
 * 【为什么单独抽成纯函数】
 *   会话住在**主窗口**的 zustand store 里（桌宠窗够不到），实际删除由
 *   `PetChatSync` 执行。删除涉及三种口径 + 一个关键约束（桌宠会话是本窗口的
 *   宿主，不能真删），逻辑放在组件里既难测又容易改错。这里只算"该删谁、
 *   该清谁"，执行交给调用方，便于单测覆盖所有分支。
 *
 * 【关键约束：桌宠会话永远不真删】
 *   `conv-pet-live2d` 是桌宠聊天窗的数据宿主。把它删掉后
 *     · 若它是最后一个 → store 的 deleteConversation 会**自动造一个兜底会话**
 *       `conv-<时间戳>`，桌宠窗再补回自己的会话就变成"两个对话"，用户看到
 *       "明明点了全删怎么还剩一条"；
 *     · 若不是最后一个 → 桌宠窗历史直接断掉。
 *   所以对它的处理一律是**清空消息**（用户可见效果与删除一致），不删壳。
 */

export type PetDeleteScope = 'current' | 'select' | 'all'

/** 参与删除计算的会话（只需 id 与消息数） */
export interface PetConvLike {
  id: string
  messages?: unknown[]
}

/** 删除计划：先删 deleteIds，再清 clearIds，最后补 ensurePetConv() */
export interface PetConvDeletePlan {
  /** 整条会话删掉 */
  deleteIds: string[]
  /** 会话保留，只清空里面的消息 */
  clearIds: string[]
}

/**
 * 计算一次删除动作要删/要清哪些会话。
 *
 * @param convs     当前所有会话（**前提**：桌宠会话已存在，调用方先 ensurePetConv）
 * @param scope     'current' 只清当前桌宠对话 / 'select' 用户勾选的 / 'all' 全部
 * @param ids       scope==='select' 时用户勾选的会话 id
 * @param petConvId 桌宠会话 id（永不真删）
 */
export function planPetConvDelete(
  convs: PetConvLike[],
  scope: PetDeleteScope,
  ids: string[] | undefined,
  petConvId: string,
): PetConvDeletePlan {
  const all = Array.isArray(convs) ? convs : []

  if (scope === 'current') {
    return { deleteIds: [], clearIds: [petConvId] }
  }

  if (scope === 'select') {
    // 去重 + 只认真实存在的 id（桌宠窗的清单可能比 store 旧一拍）
    const exists = new Set(all.map((c) => c.id))
    const picked = Array.from(new Set((ids || []).filter((id) => typeof id === 'string' && id && exists.has(id))))

    const deleteIds: string[] = []
    let clearPet = false
    for (const id of picked) {
      if (id === petConvId) {clearPet = true}
      else {deleteIds.push(id)}
    }
    // 勾了桌宠会话 = 清空它（用户看到的效果就是"这条没了"），不删壳
    return { deleteIds, clearIds: clearPet ? [petConvId] : [] }
  }

  // scope === 'all'：保留桌宠会话的壳并清空，其余全删。
  // 这样结果恰好剩一个空会话，不会触发 store 的"删到 0 个自动补兜底会话"。
  return {
    deleteIds: all.map((c) => c.id).filter((id) => id !== petConvId),
    clearIds: [petConvId],
  }
}
