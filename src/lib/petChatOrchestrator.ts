/**
 * petChatOrchestrator — 桌宠聊天（pet-chat / pet-live2d）↔ 主 Agent 串行编排
 *
 * 背景根因（见交付说明）：
 *   旧实现里桌宠每发一条消息会**同时**打两路 LLM：
 *     1) pet:sync-send → 主窗口 PetChatSync → agent:chat（完整 ReAct 回复）
 *     2) pet:chat → intentDispatcher.petChat() → createPetLLM().call()（意图 JSON）
 *   两路并发砸向同一个本地 LM Studio；冷启动/单槽位时，完整 agentChat 的 HTTP 请求
 *   被挤崩 → reactEngine 循环 catch → 返回兜底文案"抱歉，处理时出了点问题…"，
 *   而 agentIpc 把它包成 { success:true, content:<兜底> }，PetChatSync 又只看
 *   content 非空就当成功上屏 → 用户连续发消息时前几次全是"出了点问题"。
 *   此外 PetChatSync 旧逻辑用 processingRef 直接**丢弃**处理中到达的新消息，
 *   且没有任何失败重试。
 *
 * 本模块把"桌宠→主Agent→回桌宠"这一段抽成**纯、可测**的编排器：
 *   - FIFO 队列：处理中到达的新消息**排队**而不是丢弃；
 *   - 同一时刻只跑一个 agentChat（串行），本地模型不再被并发打垮；
 *   - 失败（success===false / 空 content / 抛错）按指数退避重试 1~2 次；
 *   - 重试期间不向桌宠发任何错误气泡（桌宠端的"正在思考"三点动画保持）；
 *   - 重试耗尽才上屏一条友好错误。
 *
 * 依赖全部由构造注入（store / agentChat / sendToPet / sleep），不 import React、
 * 不 import electron、不碰 DOM，便于 vitest 在 node 环境里直接 mock。
 */

export interface PetTurnMessage {
  role: 'user' | 'assistant' | 'system' | string
  content: string
}

/** agent:chat 运行时实际返回形状（preload 的 TS 类型只声明了 content，这里宽松断言） */
export interface PetAgentResult {
  content?: string
  error?: string
  success?: boolean
}

/** store 里一条消息（双向同步去重用） */
export interface StoreMessage {
  id: string
  role: string
  content: string
  timestamp?: number
}

/**
 * 用户点 Live2D 头顶搭话卡片那一刻的屏幕上下文。
 *
 * 【为什么必须带上它】卡片上的选项是"接着当前场景说的话"，典型如
 *   「让我帮你整理**这部剧**的资料吧」—— 里面全是**指代**。
 *   旧实现点完只发选项文本，场景信息（窗口标题）被丢掉，于是模型
 *   完全不知道"这部剧"是哪部，只能反问「你指的是哪部剧？」。
 *   用户看到的就是「点了也没用，它什么都不会」。
 */
export interface PetSceneContext {
  /** 场景分类（video / code / doc …，由主进程判定） */
  scene?: string
  /** 活动窗口标题 —— 绝大多数情况下"这部剧/这段代码"就靠它解析 */
  title?: string
  /** 进程名 */
  process?: string
}

/** 队列里的一轮待处理消息 */
export interface PetTurn {
  text: string
  scene?: PetSceneContext | null
}

export interface PetChatDeps {
  /** 取 conv-pet-live2d 的非 system 对话历史（供 agentChat 拼上下文） */
  getHistory: () => PetTurnMessage[]
  /** 注入一条消息到该对话，返回消息 id（用于双向同步去重，不回显给桌宠自己发的） */
  addMessage: (role: 'user' | 'assistant', content: string) => string
  /** 调主 Agent 完整对话（内部自行拼 config）；scene 用于解析"这部剧/这段代码" */
  agentChat: (text: string, history: PetTurnMessage[], scene?: PetSceneContext | null) => Promise<PetAgentResult>
  /** 把回复/错误推回桌宠窗（petSyncReply） */
  sendToPet: (text: string, role: 'user' | 'assistant') => void
  /** 回复成功后，由文本本地派生动作/表情（走 pet:test-intent，**不再发第二次 LLM**） */
  dispatchLocalIntent?: (replyText: string) => void
  /** 可注入的退避 sleep（测试用 fake 时钟，真实实现用 setTimeout） */
  sleep?: (ms: number) => Promise<void>
}

export const PET_RETRY_MAX = 2
export const PET_RETRY_BACKOFF_MS = [600, 1500] as const

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export class PetChatOrchestrator {
  private queue: PetTurn[] = []
  private running = false

  // ── 观测点（测试断言用）─────────────────────────
  /** agentChat 被调用的总次数 */
  public agentCallCount = 0
  /** 每次退避等待的毫秒数（按顺序记录） */
  public sleepCalls: number[] = []

  constructor(private readonly deps: PetChatDeps) {}

  get isRunning(): boolean { return this.running }
  get pendingCount(): number { return this.queue.length }

  /**
   * 桌宠发来一条用户消息。
   * 立即注入对话历史（保证主窗/桌宠历史一致）并入队；串行泵处理，绝不丢消息。
   *
   * @param scene 点卡片那一刻的屏幕上下文（解析"这部剧/这段代码"用），闲聊时为 undefined
   */
  handlePetMessage(text: string, scene?: PetSceneContext | null): void {
    const t = (text || '').trim()
    if (!t) {return}
    this.deps.addMessage('user', t)
    this.queue.push({ text: t, scene: scene || null })
    void this.pump()
  }

  /** 串行泵：同一时刻只跑一条；当前条结束后自动处理下一条排队消息 */
  private async pump(): Promise<void> {
    if (this.running) {return}
    this.running = true
    try {
      while (this.queue.length > 0) {
        const turn = this.queue.shift() as PetTurn
        await this.runOne(turn)
      }
    } finally {
      this.running = false
    }
  }

  /** 跑单条：失败按退避重试，耗尽才报错 */
  private async runOne(turn: PetTurn): Promise<void> {
    const { text, scene } = turn
    let attempt = 0
    let lastReason = '空回复'

    let reply = ''
    for (;;) {
      this.agentCallCount++
      let res: PetAgentResult
      try {
        const history = this.deps.getHistory()
        res = await this.deps.agentChat(text, history, scene)
      } catch (e: any) {
        res = { success: false, error: e?.message || String(e) }
      }

      const ok =
        !!res &&
        res.success !== false &&
        typeof res.content === 'string' &&
        res.content.length > 0

      if (ok) {
        reply = (res as PetAgentResult).content as string
        break
      }

      // 失败：记录原因，退避后重试
      lastReason = (res && (res.error || res.content)) || '空回复'
      if (attempt >= PET_RETRY_MAX) {break}
      const wait = PET_RETRY_BACKOFF_MS[attempt] ?? 1500
      this.sleepCalls.push(wait)
      await (this.deps.sleep ?? defaultSleep)(wait)
      attempt++
    }

    if (!reply) {
      // 重试仍失败 → 友好错误（上屏 + 推桌宠），不再静默
      const safeReason = String(lastReason).replace(/\s+/g, ' ').slice(0, 60) || '未知错误'
      const errText = `抱歉，我暂时没答上来（${safeReason}）。稍等一下再发一次试试？`
      this.deps.addMessage('assistant', errText)
      this.deps.sendToPet(errText, 'assistant')
      return
    }

    // 🔧 2026-10-10：拦截「占位型」回复（如「我来帮你查一下…」）。
    //   真实踩坑：桌宠引导式 ABC 选项（"想了解群聊怎么发公告吗？"）走的是
    //   mode:'chat' + noAutoSearch:true 的轻量陪伴 Agent —— 模型**有权限**
    //   调 web_search，但实际只回一句占位确认就结束，用户看到的回复永远停在
    //   "我来帮你查一下…"，内容不完整。修法：检测到占位后**自动续一轮**，
    //   明确要求模型用 web_search 真正搜并给出答案，最多续 1 次避免死循环。
    if (isPlaceholderReply(reply)) {
      const continuationText = '（系统提示：上一条是占位回复。请实际调用 web_search 工具搜索并给出完整的答案，不要再只说"我来查"。）'
      // 🐛 2026-10-10（P2-10）修复：这里原来调 `addMessage('user', continuationText)`
      //   把这条**内部指令**持久化成了用户消息。PetChatSync 的 getHistory /
      //   onPetHistoryRequest 只过滤 role!=='system'，于是它会：
      //     ① 混进主窗口的桌宠对话历史，被回推给桌宠窗；
      //     ② 在后续每轮的上下文里反复出现，污染真实对话。
      //   现在：只把它拼进**本次请求的 history**，不落库、不上屏。
      try {
        const history2: PetTurnMessage[] = [
          ...this.deps.getHistory(),
          { role: 'user', content: continuationText },
        ]
        this.agentCallCount++
        const res2 = await this.deps.agentChat(continuationText, history2, scene)
        const ok2 = !!res2 && res2.success !== false && typeof res2.content === 'string' && res2.content.length > 0
        if (ok2) {
          const realReply = (res2 as PetAgentResult).content as string
          // 续轮成功 → 只上屏真答案（第一轮的占位回复从未 addMessage，无需清理）
          this.deps.addMessage('assistant', realReply)
          this.deps.sendToPet(realReply, 'assistant')
          try { this.deps.dispatchLocalIntent?.(realReply) } catch { /* 表情派生失败不影响回复 */ }
          return
        }
      } catch { /* 续轮失败就回退到原占位回复，不让用户看到空 */ }
    }

    // 默认：直接上屏第一轮回复
    this.deps.addMessage('assistant', reply)
    this.deps.sendToPet(reply, 'assistant')
    try { this.deps.dispatchLocalIntent?.(reply) } catch { /* 表情派生失败不影响回复 */ }
  }
}

/**
 * 双向同步去重：主窗 store 变化时，挑出"该推给桌宠"的新消息。
 *
 * zustand 的 subscribe 在 set() 时同步触发。我们自己注入桌宠消息时会置
 * `injectedByUs=true`，此时同步订阅看到的新消息全部是"桌宠侧来的"，已经由
 * sendToPet 直接推过，绝不回推（否则桌宠会把自己发的用户消息再收到一遍，形成回声）。
 * `injectedByUs=false` 时，新消息来自用户在**主窗输入框**敲进 conv-pet-live2d，
 * 才需要推给桌宠。system 消息一律跳过。
 */
export function messagesToForward(newMsgs: StoreMessage[], injectedByUs: boolean): StoreMessage[] {
  if (injectedByUs) {return []}
  return (newMsgs || []).filter((m) => m && m.role !== 'system')
}

/**
 * 由回复文本本地派生一个动作/表情意图（**不发任何 LLM**）。
 * 用于替代旧的"同一轮再打一次 pet:chat 意图 LLM"——避免与完整回复并发抢模型。
 * 纯关键词启发式，足够驱动 Live2D 动效即可。
 */
export function deriveLocalIntent(replyText: string): { action: string; mood?: string } {
  const t = replyText || ''
  if (/[?？]$|^为什么|怎么|如何|是不是|对吗|呢[?？]/.test(t) || /[?？]/.test(t.slice(-6))) {
    return { action: 'think', mood: '好奇 🤔' }
  }
  if (/[哈呵嘿嘻嘻]|😊|😄|🎉|✨|开心|高兴|棒|好耶/.test(t)) {
    return { action: 'happy', mood: '开心 😊' }
  }
  if (/晚安|睡|困|累|疲惫|早点休息/.test(t)) {
    return { action: 'sleep', mood: '疲惫 😩' }
  }
  if (/抱歉|对不起|没答上|出错|失败|不行/.test(t)) {
    return { action: 'sad', mood: '闷闷不乐 😕' }
  }
  // 默认：点头回应
  return { action: 'nod', mood: '平静 😐' }
}

/**
 * 🔧 2026-10-10：识别「占位型」回复 —— 模型说要做某事但没真做。
 * 实测踩坑：桌宠引导式 ABC 选项（"想了解群聊怎么发公告吗？"）走轻量 chat 模式，
 *   模型回 "我来帮你查一下群聊发公告的具体方法。" 就结束，从不调 web_search。
 *   用户看到的回复永远停在"我来查"，内容不完整。
 *
 * 识别规则：短回复（≤80 字）+ 包含「将要去做」的措辞 + 不含具体内容。
 *   · 强信号（命中任一即判定为占位）：
 *     我来(帮你|帮你查|查一下|看看|搜一下|搜一搜|找一下|找找)
 *     让我(查|看看|搜|找|查查|搜搜)
 *     I'll|let me|I will|I can help.*(check|look|search|find)
 *   · 弱信号（需配合长度 ≤80）：
 *     等我|稍等|马上|一会儿
 *
 * 反向排除：包含具体答案关键词（步骤/1./第一步/链接/示例/…）的不算占位。
 */
export function isPlaceholderReply(reply: string): boolean {
  const t = String(reply || '').trim()
  if (!t) {return false}
  // 已经给了具体内容的，不算占位
  if (/[1-9]\.|第[一二三四五六七八九十]步|步骤|链接|示例|比如|例如|http|https|\.com|\.cn|```/.test(t)) {
    return false
  }
  // 🐛 2026-10-10（P2-11）修复：函数文档一直写的是「**短**回复（≤80 字）」，
  //   但代码只对**弱信号**做了长度限制，强信号无限制 —— 于是像
  //   「让我看看这段代码的问题，我觉得可能是异步竞态导致的…」（长回复）
  //   也会被判成占位 → 白多打一轮 LLM。这里把 ≤80 提到最前面，强/弱信号统一生效。
  if (t.length > 80) {return false}
  // 强信号
  const strong = /我来(帮你)?(查|看看|搜|找|查查|搜搜|找找|看一下)|让我(查|看看|搜|找|查查|搜搜|找找)|i'll|let me |i will|i can help.*(check|look|search|find)/i.test(t)
  if (strong) {return true}
  // 弱信号 + 短回复
  if (/等我|稍等|马上|一会儿/.test(t)) {return true}
  // ⚠️ 残留歧义：像「让我看看这个报错。」这种「只有一句宣告、没有实质内容」的短回复
  //   仍会被判为占位。这是可接受的：误判的代价只是**多打一轮 LLM**，
  //   而漏判的代价是用户永远看到「我来帮你查一下…」的半截回复。
  return false
}
