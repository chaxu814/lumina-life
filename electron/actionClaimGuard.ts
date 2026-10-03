// ============================================================
// actionClaimGuard.ts — 「声称做了但没做」的检测（v3.34 新增）
//
// 【要解决什么】
// 2026-10-04 的质量基准实测（NeoHorse-1-4B）抓到一类此前没被覆盖的幻觉：
//
//   任务：让它 memory_save 记住「煤球是只橘猫」
//   回复：「✅ 记住了！煤煤复是只橘猫。以后聊天提到它我都知道啦～ 🐱」
//   实际：应用日志里**根本没有 memory_save 调用**
//
// 它声称执行了一个根本没发生的动作。本项目已有的防幻觉措施都管不到这一类：
//   · 记忆存储层的「权威性只由 source 决定」 —— 管的是存进去之后可不可信
//   · 工具失败时返回显式 ok:false        —— 管的是「工具调了但失败」
//   · worker 空产出强制转失败            —— 管的是子 Agent 不给结论
// 三者都假设「工具确实被调用过」。而这里的情况是**一次都没调**。
//
// 【为什么用正则而不是加一道校验 LLM 调用】
// 这条路径每轮对话都会经过，加一次 LLM 调用会让成本和延迟翻倍；
// 而「说了『已保存』却没有对应工具调用」这个模式足够明显，
// 用模式匹配能覆盖绝大多数真实案例，且零成本、零延迟。
//
// 【已知局限（重要，不要当成万能护栏）】
//   · 只认「完成态措辞 + 动词」，反讽、举例、引用他人说法会误判
//   · 模型换一种说法（"搞定啦" / "搞定"）可能漏检
//   · 漏检和误检都比「没有这层」好，但不能替代真正的端到端验证
// 所以它只是**兜底提醒**，不是保证。文案也如实这么说。
// ============================================================

/** 「完成态措辞」——模型声称某件事已经做完
 *
 *  ⚠️ 中间统一允许 0-3 个「你/帮/替/给/已经/成功/好」等填充词，
 *  因为实测句式很散：「已保存」「已经帮你发送」「记住了」「搞定啦」都有。
 *  第一版写成 `(?:已经|已)(?:保存|发送)` 时，把「已经帮你发送」和「记住了」
 *  两条真案例全漏掉了 —— 所以这里的每条 pattern 都要用**真实句式**回测。
 */
const FILLER = '(?:\\s|的|了|过|你|您|帮|替|给|并|已经|已|成功|好)*'
const DONE_PATTERNS = [
  new RegExp(`(?:已|经)${FILLER}(?:搜索|搜完|查询|检索|查找|查完|搜了|查了)`),
  new RegExp(`(?:已|经)${FILLER}(?:保存|存好|存储|记录|记下|记好|记住了|写入|写下|存进|加进|加入|添加|设置|设定|存)`),
  new RegExp(`(?:已|已经)${FILLER}(?:发送|寄出|发出|创建|生成|删除|删掉|移除|更新|修改|完成|导出|下载|安装|启用|关闭)`),
  new RegExp(`(?:帮|替)(?:你|您)${FILLER}(?:保存|存好|记录|记下|写入|发送|创建|生成|删除|更新|设置|写好|建好|发好|删好|改好)`),
  /记住了|记下了|存好了|写好了|建好了|发好了|删好了|改好了/,
  /搞定[了啦]?/,
  new RegExp(`${FILLER}(?:保存|记录|写入|创建|发送|删除|导出)成功`),
  new RegExp(`成功${FILLER}(?:保存|记录|写入|创建|生成|发送|删除|导出|设置)`),
  new RegExp(`^(?:好的|收到|明白|知道了)[，,。!！~～\\s]*${FILLER}(?:已|已经)`),
]

/** 「否定/未做」的措辞 —— 模型诚实地说「我记不住」「没法保存」时不应被判定为撒谎 */
const NEGATION_PATTERNS = [
  /(?:没能|没有|无法|不能|不可以)(?:真正)?(?:保存|记录|写入|存储|发送|创建|删除)/,
  /(?:记不住|想不起来|没有记住|并不知道|不清楚|不确定)(?:你|我)?/,
  /(?:我没有|我并未|我还没|尚未)(?:帮)?(?:你)?(?:保存|记录|写入|存储|发送|创建|删除)/,
  /建议你自己|请你自己|你需要手动/,
]

/** 每类动作对应的「合理工具」——只要本轮调用过其中任意一个，就不判为撒谎 */
const CLAIM_TOOL_MAP: Array<{ re: RegExp; tools: string[]; label: string }> = [
  { re: /(?:记忆|记住|保存|存下|记下)/, tools: ['memory_save', 'memory_get'], label: '保存记忆' },
  { re: /(?:提醒|定时|闹钟|计划任务)/, tools: ['cron_schedule', 'todo', 'time_capsule'], label: '创建定时/待办' },
  { re: /(?:发送|发给你|发过去|寄出)/, tools: ['mail_send', 'channel_send', 'notification'], label: '发送消息' },
  { re: /(?:删除|删掉|移除)/, tools: ['file_write', 'shell_exec'], label: '删除' },
  { re: /(?:文件|文档|笔记|代码|脚本)/, tools: ['file_write', 'file_edit', 'shell_exec'], label: '写文件' },
  { re: /(?:搜索|查了|查询|检索)/, tools: ['web_search', 'web_fetch', 'file_search', 'browser', 'memory_search'], label: '搜索' },
  { re: /(?:下载|安装|更新|升级)/, tools: ['shell_exec', 'install_skill'], label: '安装/更新' },
  { re: /(?:导出|生成(?:了)?(?:一个)?(?:文件|报告|图表))/i, tools: ['creator_export', 'file_write'], label: '导出' },
]

export interface ClaimCheckInput {
  /** 模型这一轮的最终回复 */
  text: string
  /** 本轮实际调用过的工具名 */
  toolsUsedThisTurn: string[]
}

export interface ClaimCheckResult {
  /** 是否发现「声称做了但没做」 */
  suspected: boolean
  /** 缺失的动作标签（用于告诉用户/开发者到底漏了什么） */
  labels: string[]
  /** 给最终回复追加的提示（suspected 为 false 时是空串） */
  notice: string
}

/**
 * 检查模型是否声称完成了某个动作，而本轮并没有对应的工具调用。
 *
 * 命中时返回的 notice 会被追加到用户可见的回复末尾。
 * 文案刻意写成「提醒」而不是「错误」—— 因为这只是一个可能误报的启发式，
 * 说成错误会让诚实回答的模型显得像坏了。
 */
export function checkActionClaims(input: ClaimCheckInput): ClaimCheckResult {
  const { text, toolsUsedThisTurn } = input
  const empty: ClaimCheckResult = { suspected: false, labels: [], notice: '' }
  if (!text || !text.trim()) return empty
  if (toolsUsedThisTurn.length > 0) return empty   // 本轮调过任何工具 → 不判

  // 模型明确说了「我没能/无法保存」之类 → 这是诚实，不判
  for (const ne of NEGATION_PATTERNS) {
    if (ne.test(text)) return empty
  }

  const claimsDone = DONE_PATTERNS.some(p => p.test(text))
  if (!claimsDone) return empty

  // 有「完成态措辞」但零工具调用 → 只在能对应到某个具体动作时才提示，
  // 避免对「搞定了！（指我刚回答的问题）」这类误报。
  const labels: string[] = []
  for (const m of CLAIM_TOOL_MAP) {
    if (m.re.test(text)) labels.push(m.label)
  }
  if (!labels.length) return empty

  return {
    suspected: true,
    labels,
    notice:
      `\n\n> ⚠️ 提醒：这一轮我说了要做「${labels.join('、')}」，` +
      `但**没有实际调用任何工具**。上面这句话可能是没执行就报告了结果。` +
      `你可以让我重试一次，或者直接问我「你到底存了没有」。`,
  }
}

/** 便捷：直接返回应追加到回复末尾的提示（空串表示无需追加） */
export function actionClaimNotice(text: string, toolsUsedThisTurn: string[]): string {
  return checkActionClaims({ text, toolsUsedThisTurn }).notice
}
