// ============================================================
// notice/noticeBus.ts — 主进程 → 渲染进程的「提示事件」总线
//
// 【为什么需要它】
//   有些事件不是用户对话流的一部分，而是「系统状态/团队降级」这类
//   需要独立弹给用户看的提示（例：后台 Yak 没配 LLM，本轮由 Lumina
//   影子代执行）。它们不该混进 Agent 事件流，也不该靠工具返回文案
//   被动等主模型转述——必须有一条确定的、主进程主动推的通道。
//
// 【职责边界】
//   - 纯类型化订阅器单例，不依赖 Electron、不碰窗口。
//   - main.ts 启动后调用 attachWindowForwarder() 把事件转发到主窗口；
//     窗口未就绪期间事件按通道缓存，就绪后回放，不丢。
//   - 任何 emit 都吞异常（提示总线绝不能反过来搞挂主流程）。
//
// 【冻结契约】通道名 / payload 形状与渲染层严格对齐，改动需双方同步。
// ============================================================

// ── 通道 payload 类型（冻结契约）─────────────────────────

/** 团队降级：后台成员未单独配 LLM，本轮由 Lumina 影子代执行 */
export interface TeamDegradedNotice {
  memberId: 'yak' | 'recha'
  memberName: string
  taskPreview: string
  reason: string
  ts: number
}

/** Python/语音节点状态 */
export interface PythonStatusNotice {
  healthy: boolean
  pythonPresent: boolean
  tts: boolean
  stt: boolean
  embedding: boolean
  message: string
  docUrl: string
  ts: number
}

/** 通道名 → payload 形状的映射表。新增通道只加这里。 */
export interface NoticeChannelMap {
  'team:degraded': TeamDegradedNotice
  'python:status': PythonStatusNotice
}

export type NoticeChannel = keyof NoticeChannelMap

/** 某通道的监听器签名 */
type Listener<K extends NoticeChannel> = (payload: NoticeChannelMap[K]) => void

// ── 内部转发器签名 ────────────────────────────────────────

type WindowForwarder = <K extends NoticeChannel>(channel: K, payload: NoticeChannelMap[K]) => void

class NoticeBus {
  /** 每通道的监听器集合（类型安全，不经过裸 EventEmitter 的 any 回调面） */
  private readonly listeners: { [K in NoticeChannel]: Set<Listener<K>> } = {
    'team:degraded': new Set<Listener<'team:degraded'>>(),
    'python:status': new Set<Listener<'python:status'>>(),
  }
  /** 窗口未就绪期间的待发缓存（按通道保留最近一条，足够提示语义） */
  private readonly buffer = new Map<NoticeChannel, NoticeChannelMap[NoticeChannel]>()
  private forwarder: WindowForwarder | null = null

  /** 主进程侧订阅（main.ts 用来挂窗口转发）。返回取消函数。 */
  on<K extends NoticeChannel>(channel: K, listener: Listener<K>): () => void {
    const set = this.listeners[channel] as Set<Listener<K>>
    set.add(listener)
    return () => { set.delete(listener) }
  }

  /**
   * 发射一条提示。
   * 1) 先投给主进程订阅者（窗口转发器）；转发失败/未挂则缓存。
   * 2) 缓存是为「窗口尚未创建」准备的——attachWindowForwarder 时回放。
   */
  emit<K extends NoticeChannel>(channel: K, payload: NoticeChannelMap[K]): void {
    try {
      this.buffer.set(channel, payload)
      if (this.forwarder) {
        this.forwarder(channel, payload)
      }
      // 事件也照常投给主进程监听器，便于测试/其他主进程订阅
      for (const listener of this.listeners[channel] as Set<Listener<K>>) {
        try { listener(payload) } catch { /* 单个订阅者出错不影响其他 */ }
      }
    } catch {
      // 提示总线绝不抛错
    }
  }

  /**
   * main.ts 注册窗口转发器。立即回放缓冲过的事件（窗口此前未就绪）。
   * forwarder 内部必须自行保证 webContents 存在且未销毁。
   */
  attachWindowForwarder(forwarder: WindowForwarder): void {
    this.forwarder = forwarder
    // 回放积压
    for (const [channel, payload] of this.buffer) {
      try { forwarder(channel, payload) } catch { /* 窗口仍未就绪，留待下次 */ }
    }
    this.buffer.clear()
  }

  /** 仅供测试 */
  _reset(): void {
    for (const channel of Object.keys(this.listeners) as NoticeChannel[]) {
      this.listeners[channel].clear()
    }
    this.buffer.clear()
    this.forwarder = null
  }
}

/** 全局单例 */
export const noticeBus = new NoticeBus()
