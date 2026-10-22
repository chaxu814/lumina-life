// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// toolRouter.ts — 工具按需筛选（2026-10-07）
//
// 【它解决什么问题】
// 修复前，`getToolsForMode()` 每轮把整档工具**全量**塞进 function list：
//   agent 档 67 个工具 ≈ 9,700 tokens
//   developer 档 93 个 ≈ 12,400 tokens
// 而这笔开销**每一次模型调用都要重发一遍** —— 包括「现在几点」这种一句话问题。
//
// 【实测依据】本机 601 次真实工具调用里：
//   · 只有 22 个工具被调用过（142 个中占 15%）
//   · 前 7 个工具（web_search / browser / web_fetch / file_read /
//     shell_exec / file_list / file_write）占了 **95%** 的调用量
//   · 团队协作 25 个工具占 agent 档 44% 的开销，实际只用到 3 个
// 也就是说：大部分 schema 是「每轮重发、从未使用」。
//
// 【设计原则】
//   1. **核心常驻 + 能力按需**：高频工具永远在；低频/重工具等关键词命中才加。
//   2. **粘性**：一旦某个能力组被激活，本会话内一直保留。
//      否则「上一轮能用、下一轮不见了」——这比不筛还糟。
//   3. **失败开放**：拿不到用户输入、或筛选后工具过少时，**退回全量**。
//      宁可多花 token，也不能让模型「没有工具可用」。
//   4. **可关闭**：feature flag `tools.onDemand`（缺省开）。
//   5. **不碰提示词教过的工具**：`agentTeamPersonas` 明确教模型调用
//      delegate_to / team_message / team_tasks / hire_worker / workflow /
//      adversarial_review / git_worktree / save_context / load_context /
//      write_notice / read_notices / delegate_chain。
//      这些留在核心层，避免「提示词让模型调一个不在列表里的工具」。
//      只有**提示词没教过**的团队工具（phase_gate_delegate / run_subagents /
//      worker_control / team_autonomy / team_roles / team_checkpoint /
//      team_stats / team_log / teach）才进按需组。
//
// 【与其它过滤层的关系】
//   本模块只做「从该模式本可用的工具里挑子集」，是**减法**。
//   调用方（getToolsForMode）在本模块之后仍会依次执行
//   disabledTools → rolePolicy → 情绪门控，那三层语义完全不变。
// ============================================================

/** 一个能力组：命中任一关键词 → 整组工具加入本轮 function list */
export interface CapabilityGroup {
  /** 给日志看的中文名 */
  label: string
  /** 触发关键词（大小写不敏感，中英混合） */
  keywords: string[]
  /** 该组包含的工具名 */
  tools: string[]
}

/**
 * 常驻核心 —— 无论用户问什么都在。
 *
 * 选取标准：**实测调用量最高的那批** + 「没有它就没法干活」的基础能力
 *           + **提示词明确教过的那批**（见文件头「设计原则 5」）。
 *
 * 刻意保持精简：每多一个常驻工具，每次调用都要多付一次 schema 开销。
 * 但精简的边界是「不能和提示词打架」—— 提示词教了却不在列表里，
 * 模型只会去调一个不存在的工具，那比多花 token 糟得多。
 */
export const CORE_TOOLS: readonly string[] = [
  // 文件（实测 file_read/file_write/file_list/file_search 全在前 11）
  'file_read', 'file_write', 'file_edit', 'file_list', 'file_search',
  // 终端（shell_exec 实测 27 次）
  'shell_exec',
  // 搜索（实测 web_search 346 次 = 全部调用的 69%）
  'web_search', 'web_fetch', 'browser',
  // 记忆（实测 memory_search 12 / memory_get 10 / memory_save 5）
  'memory_save', 'memory_search', 'memory_get',
  // 时间与交互
  'datetime', 'todo', 'ask_decision',
  // 技能（「怎么做到某件事」的逃生阀，让模型不必硬编码流程）
  'skill_search', 'skill_run',
  // ── 团队基础 + 提示词教过的团队工具 ──
  //   ⚠️ 这一整段是「不能动」的：electron/agentTeamPersonas.ts 的
  //   TEAM_LUMINA.systemPrompt 逐条点名教模型使用它们
  //   （delegate_to / team_message / team_tasks / hire_worker / workflow /
  //     adversarial_review / git_worktree / save_context / load_context /
  //     write_notice / read_notices / delegate_chain / team_mailbox）。
  //   把它们挪进按需组会让提示词和 function list 打架。
  //   由 tests/toolRouting.test.ts 的「设计不变量」用例守着。
  'delegate_to', 'delegate_chain', 'team_context', 'team_message', 'team_mailbox',
  'team_tasks', 'hire_worker', 'workflow', 'adversarial_review', 'git_worktree',
  'write_notice', 'read_notices', 'save_context', 'load_context',
  // 🆕 2026-10-08：五阶段门控（Research→Plan→Execute→Verify→Review）此前
  //   只在按需组、且人格提示词没教 → 模型几乎不会主动调用（真代码却不可达）。
  //   现移入常驻核心，并在 agentTeamPersonas 里教模型何时用它。
  'phase_gate_delegate',
]

/** developer 档额外常驻：写代码真正天天用的那批 */
export const DEVELOPER_CORE_TOOLS: readonly string[] = [
  'git_status', 'git_commit', 'git_log', 'git_diff',
  'ast_search', 'lsp_symbols', 'lsp_references',
  'developer_companion_check',
  // 浏览器精细操作 —— 写前端/调试网页时是刚需，放 developer 常驻
  'browser_open', 'browser_click', 'browser_type', 'browser_read',
  'browser_list', 'browser_screenshot', 'browser_close',
]

/**
 * 按需能力组。key 会作为粘性标记与日志名。
 */
export const CAPABILITY_GROUPS: Record<string, CapabilityGroup> = {
  // ── 团队进阶 ──
  //   ⚠️ 这里**只能**放提示词没有教过的团队工具。
  //   实测：TEAM_LUMINA.systemPrompt 教过 delegate_to / delegate_chain /
  //   team_message / team_mailbox / team_tasks / hire_worker / workflow /
  //   adversarial_review / git_worktree / write_notice / read_notices /
  //   save_context / load_context / phase_gate_delegate —— 那 14 个已全部放进 CORE_TOOLS。
  //   剩下这些（任务板检查点/绩效统计/并行派生/worker 控制/自治/日志/角色/教学）
  //   提示词里没提，模型不会主动去调，因此可以按需。
  team_advanced: {
    label: '团队进阶',
    keywords: [
      '团队', '协作', '分工', '同事', '队友', '员工', '人手', '多个人', '一起做',
      '并行', '雇佣', '招聘', '实习生', '评审', '审查', '对抗', '验收', '复核',
      '流程', '工作流', '里程碑', '绩效', '统计', '日志', '角色', 'worktree',
      '独立分支', '任务板', '泳道', '项目', '完整', '重构', '发布', '自动化',
      // 🆕 口语化说法（实测漏掉）：「这个活太多了，找人分担一下」「让 Yak 看看」
      '找人', '分担', '活太多', '忙不过来', '让 yak', '让yak', '@yak',
      '让热茶', '@热茶', '找 yak', '找热茶', '叫 yak', '叫热茶',
      'team', 'worker', 'workflow', 'review', 'delegate', 'subagent',
    ],
    tools: [
      'teach', 'team_checkpoint', 'team_stats',
      'run_subagents', 'worker_control', 'team_autonomy', 'team_log', 'team_roles',
    ],
  },
  lumina_mode: {
    label: '模式切换',
    keywords: [
      '模式', '工作模式', '学习模式', '娱乐模式', '休息模式', '切换模式',
      '工作状态', '现在是', 'mode',
    ],
    tools: ['mode_switch', 'mode_status'],
  },
  // 自我认知：用户问"你是谁/你能做什么/团队有谁/Lucky 是什么"时按需加载 about_lumina
  self_info: {
    label: '自我信息',
    keywords: [
      '你是谁', '你叫什么', '你是什么', '介绍一下你', '介绍你', '自我介绍', '自我',
      '你能做什么', '你会什么', '你有什么功能', '你有什么能力', '你的功能', '你的能力',
      '你的版本', '什么版本', '支持什么平台', '支持什么系统', '你的团队', '团队有谁',
      '队友有谁', '成员有谁', 'lucky', 'about_lumina',
      // 🆕 优势 / 使用方法类提问（实测会漏）
      '有什么用', '有什么用处', '能干嘛', '能干什么', '可以干嘛', '有什么用吗',
      '怎么用', '如何使用', '使用方法', '怎么开始', '怎么上手', '怎么玩',
      '你的优势', '优势是什么', '有什么好处', '为什么用你', '有什么特色', '有什么不同',
      '教程', '使用指南', '帮助', '怎么设置',
    ],
    tools: ['about_lumina'],
  },

  // ── 日程与效率 ──
  calendar: {
    label: '日历日程',
    keywords: [
      '日历', '日程', '会议', '安排', '约会', '排期', '时间表', '空闲',
      '什么时候', '有没有空', '提醒我开会', 'calendar', 'meeting', 'schedule',
      // 🆕 口语化（实测漏掉）：「明天几点开会」「三点要见客户，帮我记一下」「帮我排个时间」
      '几点开', '开会', '见客户', '排个时间', '排时间', '记一下', '订个',
      '行程', '安排一下',
    ],
    tools: ['calendar_list', 'calendar_add', 'calendar_remove', 'calendar_free'],
  },
  tasks_schedule: {
    label: '定时任务',
    keywords: [
      '定时', '每天', '每周', '每月', '提醒', '循环', '稍后', '闹钟',
      '时间胶囊', '定期', 'cron', 'remind', 'timer', 'daily', 'weekly',
      // 🆕 「半小时后提醒我」「每天早上叫我起床」「到点了提醒我一下」
      '叫醒', '叫我起床', '到点', '半小时后', '一小时后', '多久后',
    ],
    tools: ['cron_schedule', 'cron_list', 'cron_cancel', 'time_capsule'],
  },
  desktop_tidy: {
    label: '桌面整理',
    keywords: [
      '整理', '收拾', '归类', '归档', '桌面太乱', '清理桌面', '文件太多',
      '乱七八糟', 'tidy', 'organize',
      // 🆕 实测漏掉：「我桌面文件太乱了」「把桌面清理一下」
      '桌面文件', '太乱', '桌面乱', '清理一下桌面', '收拾桌面', '桌面一堆',
      '归归类', '清理一下',
    ],
    tools: ['desktop_tidy_scan', 'desktop_tidy_plan', 'desktop_tidy'],
  },

  // ── 系统与记忆深化 ──
  system_extra: {
    label: '系统操作',
    keywords: [
      // ⚠️ 中文口语里「截个图 / 截一下图 / 截屏 / 截个屏」比「截图」更常见，
      //   只写「截图」会漏掉最典型的说法（这是实测踩到的坑）。
      '截图', '截个图', '截一下图', '截屏', '截张图', '截个屏', '截一下屏',
      '剪贴板', '复制', '粘贴', '打开文件', '打开软件', '进程',
      '系统信息', '内存', 'cpu', '磁盘', '通知', '弹窗', 'screenshot', 'clipboard',
      // 🆕 实测漏掉：「帮我打开这个文件夹」「看看哪个进程占内存」
      '打开文件夹', '打开目录', '打开这个文件夹', '文件夹', '目录',
      '占内存', '占 cpu', '多少内存',
    ],
    tools: ['open_file', 'screenshot', 'clipboard_get', 'clipboard_set', 'process_list', 'system_info', 'notification'],
  },
  memory_deep: {
    label: '记忆深化',
    keywords: [
      '回忆', '记得', '记忆', '以前', '之前说过', '忘了', '翻翻',
      '总结一下我们', '聊过什么', 'remember', 'recall', 'memory',
      // 🆕 实测漏掉：「把我们聊的总结一下」
      '我们聊的', '我们聊过', '聊过的', '回顾一下我们', '我们之前', '之前聊',
    ],
    tools: ['memory_all', 'memory_summarize', 'memory_chat_search'],
  },
  skills_extra: {
    label: '技能管理',
    keywords: ['技能', 'skill', '安装技能', '装个技能', '插件'],
    tools: ['skill_install', 'use_skill'],
  },

  // ── 电脑操控（重工具，实测 0 次调用）──
  computer_use: {
    label: '电脑操控',
    keywords: [
      // ⚠️ 这组的关键词必须覆盖**口语化的桌宠请求**。
      //   实测踩到：「帮我打开那个软件点一下确定」——这是 README 承诺的
      //   招牌场景，但原关键词（'帮我点'/'软件界面'）一个都没命中，
      //   导致工具没进列表。中文口语的动词会被拆开（点一下 / 点确定 / 点它），
      //   所以不能只写完整短语。
      '操作电脑', '帮我点', '点一下', '点确定', '点这个', '点它', '点到',
      '鼠标', '键盘', '窗口', '软件界面', '屏幕', '识别图', '图片识别',
      'ocr', '桌面程序', '自动化操作', '帮我操作', '输入框', '按钮',
      '打开那个软件', '打开软件', '打开应用', '帮我打开', '软件里',
      // 🆕 实测漏掉：「打开记事本打几个字」「帮我关了那个弹窗」
      //   「这个软件怎么操作」「帮我自动填一下」
      '记事本', '打几个字', '输入文字', '打字', '关了那个', '关闭窗口',
      '关掉', '怎么操作', '自动填', '自动操作', '填一下', '输入到',
    ],
    tools: [
      'desktop_act', 'desktop_element_act', 'desktop_scan', 'desktop_click',
      'desktop_elements', 'desktop_see', 'desktop_type', 'desktop_key',
      'desktop_screen_size', 'ocr',
    ],
  },
  browser_actions: {
    label: '浏览器精细操作',
    keywords: [
      '登录', '填表', '表单', '点按钮', '网页操作', '自动填', '抓取网页',
      '打开网站', '浏览器', '网站', '页面上', 'browser', 'login', 'form',
      // 🆕 实测漏掉：「这个网页打不开」——只写了「网站」漏了「网页」
      '网页', '页面', '站点', '打不开', '加载不出',
    ],
    tools: [
      'browser_open', 'browser_click', 'browser_type', 'browser_read',
      'browser_list', 'browser_screenshot', 'browser_close', 'browser_cdp',
    ],
  },

  // ═══════════════════════════════════════════════════════════
  // 以下能力组是 2026-10-07 补的。它们对应的工具**此前根本不在 agent 档**
  // （见 registry.ts 里 agent.includes 的说明），所以这里补组的同时，
  // agent.includes 也必须把对应能力层加进去 —— 两处要一起改，否则
  // 「激活了组但候选集里没有该工具」，组会静默失效。
  // tests/toolRouting.test.ts 的「按需组引用真实工具」用例守着这点。
  // ═══════════════════════════════════════════════════════════

  mcp: {
    label: 'MCP 扩展',
    keywords: ['mcp', '外部服务', '外部工具', '协议服务', '接个服务'],
    tools: ['mcp_connect', 'mcp_list_servers', 'mcp_list_tools', 'mcp_call_tool'],
  },
  voice: {
    label: '语音与听觉',
    keywords: [
      '语音', '朗读', '念给我', '读出来', '听写', '录音', '转录', '播报',
      'tts', '语音输入', '说话给我听',
      // 🆕 实测漏掉：「帮我念出来」「把这段读给我听」
      '念出来', '读给我听', '读一遍', '念一下', '读一下', '念给我听', '语音朗读',
    ],
    tools: [
      'voice_speak', 'hearing_start', 'hearing_stop', 'hearing_status',
      'hearing_transcript',
    ],
  },
  weather: {
    label: '天气',
    keywords: [
      '天气', '气温', '下雨', '会不会冷', '温度', '穿什么', '紫外线', 'weather',
      // 🆕 实测漏掉：「今天冷吗」「明天要带伞吗」
      '冷吗', '热吗', '带伞', '要穿', '下雪', '晴天', '阴天', '多少度', '下雨没',
    ],
    tools: ['weather', 'weather_get', 'weather_brief'],
  },
  mail: {
    label: '邮件',
    keywords: ['邮件', '邮箱', '发信', '收信', '来信', 'email', 'mail', '回一封', '发封'],
    tools: ['mail_send', 'mail_list', 'mail_mark_read'],
  },
  social: {
    label: '社交动态',
    keywords: ['朋友圈', '社交', '动态', '发帖', '渠道', '公众号', '微博', 'team social', '发条动态'],
    tools: ['social_engine', 'channel_send', 'channel_status'],
  },
  proactive: {
    label: '主动关心',
    keywords: ['主动关心', '主动推送', '主动找我', '推送状态', '别打扰', '免打扰'],
    tools: ['proactive_trigger', 'proactive_status'],
  },
  creator: {
    label: '创作',
    keywords: [
      '写文章', '文章', '大纲', '文案', '创作', '博客', '公众号文章',
      '生成图', '画一张', '配图', '写篇',
      // 🆕 实测**全漏**：「帮我写个方案」「写一篇公众号」「帮我起个标题」「生成一张图」
      '写个方案', '方案', '写一篇', '公众号', '标题', '起个标题', '起个名',
      '生成一张', '生成图', '做个图', '写个文案', '写一段', '写一首', '写首诗',
      '写个报告', '帮我写',
    ],
    tools: ['creator_outline', 'creator_generate', 'creator_export', 'creator_enrich', 'image_generate'],
  },
  news: {
    label: '资讯日报',
    keywords: [
      '新闻', '资讯', '日报', '热点', 'b站', 'bilibili', '今日要闻', 'arxiv', 'paper',
      // 🆕 实测漏掉：「今天有什么大事」「看看科技圈发生了什么」
      '大事', '科技圈', '发生了什么', '有什么新鲜事', '热搜', '有什么新闻',
    ],
    tools: ['daily_paper', 'bilibili_hot_search', 'bilibili_hot_push', 'code_daily_generate', 'code_daily_weekly'],
  },
  gaming: {
    label: '游戏',
    keywords: ['游戏', '玩一局', '我的世界', '打游戏', 'minecraft', '陪我玩'],
    tools: ['game_action', 'game_status', 'game_look', 'game_auto', 'game_chat'],
  },
  pomodoro: {
    label: '番茄钟',
    keywords: ['番茄钟', '番茄', '专注', '计时器', '倒计时', 'pomodoro', '计时', '开始专注'],
    tools: ['pomodoro_start', 'pomodoro_status', 'pomodoro_stop'],
  },
  research: {
    label: '深度研究',
    keywords: ['深度研究', '调研', '研究报告', '深挖', '深入调查', 'deep research', '深入调研'],
    tools: ['deep_research'],
  },
  git_ops: {
    label: '版本控制',
    keywords: [
      '提交', 'commit', 'git', '分支', '仓库', '版本', '回滚', '改动', 'diff', '推送代码',
      // 🆕 实测漏掉：「看一下我改了什么」「把改动存一下」
      '改了什么', '我改的', '变更', '存一下', '存档', '代码存', '提交代码',
    ],
    tools: ['git_status', 'git_commit', 'git_log', 'git_diff'],
  },
}

/** 会话级粘性：已激活的能力组（避免「上一轮能用下一轮没了」） */
const sessionActiveGroups = new Map<string, Set<string>>()

/**
 * 粘性组数量上限。
 *
 * 【为什么要有上限】粘性本身是对的（不能「上一轮能用下一轮没了」），但**无上限**
 * 的粘性会让长会话里激活的组越攒越多 —— 每一组都会往 function list 里塞一批工具，
 * 于是模型手里的工具从"当前的 30 个"膨胀成"几十上百个杂项"，
 * 表现就是「它总在挑不相关的工具用」。
 * 超限时淘汰**最早激活**的组（Set 保持插入序），保证工具面始终贴合最近的话题。
 */
const MAX_STICKY_GROUPS = 6

/** 清空某会话的粘性（新建会话 / 清空历史时调用） */
export function resetToolRouting(sessionId: string): void {
  sessionActiveGroups.delete(sessionId)
}

/** 仅供测试：清空全部粘性 */
export function _resetAllToolRouting(): void {
  sessionActiveGroups.clear()
}

/** 读取某会话当前已激活的组（诊断用） */
export function getActiveGroups(sessionId: string): string[] {
  return [...(sessionActiveGroups.get(sessionId) || [])]
}

/**
 * 判断文本命中了哪些能力组。大小写不敏感。
 * 导出以便单测（关键词表是「配置」，必须有测试守着它别写错）。
 */
export function matchGroups(text: string): string[] {
  const t = String(text || '').toLowerCase()
  if (!t) {return []}
  const hit: string[] = []
  for (const [name, g] of Object.entries(CAPABILITY_GROUPS)) {
    if (g.keywords.some(k => t.includes(k.toLowerCase()))) {hit.push(name)}
  }
  return hit
}

// ═══════════════════════════════════════════════════════════
// 🧠 语义兜底路由（2026-10-07「方案 C」）
//
// 【它解决什么】关键词匹配是**长尾**：能覆盖 100% 的测试集，但用户下一句可能是
//   一种从没见过的说法。方案 A（纯关键词）会漏，方案 B（每句话都问 LLM）太慢贵。
//
// 【方案 C 的取舍】只在**最可能判断错**的情况下才调 LLM：
//   ① 关键词一个都没命中（说明规则确实不知道该给什么）
//   ② 且这句话看起来是「要求做事」（不是闲聊）
//   ③ 且开了开关
//   闲聊、以及关键词已命中的请求 —— **一次 LLM 都不调**，零延迟零成本。
//
// 【代价要讲清楚】命中的请求会多一次 LLM 分类调用，约 0.5–2s 首字延迟。
//   这是产品取舍，所以总开关 `tools.semanticRouting` 默认开、可关。
// ═══════════════════════════════════════════════════════════

/**
 * 语义分类器：给定用户原话 + 候选能力组名，返回相关组名（空数组 = 不需要额外能力）。
 * 返回 null / 抛错 = 分类失败，调用方静默退回关键词结果。
 */
export type SemanticClassifier = (userText: string, groupNames: string[]) => Promise<string[] | null>

/** 「要求做事」的信号词 —— 出现即说明用户在提需求，不是在闲聊 */
const ACTION_SIGNALS = [
  '帮我', '帮忙', '帮个忙', '帮下', '帮一', '替我', '给我', '请你', '请帮',
  '麻烦你', '麻烦帮', '能不能帮', '可以帮', '协助我', '拜托', '劳驾',
]

/** 动作动词 —— 用户可能在用祈使句提需求 */
const ACTION_VERBS = [
  '查', '查一下', '查看', '看看', '看', '搜', '搜索', '找', '找找', '翻', '翻翻',
  '写', '写个', '写一下', '写一篇', '生成', '生成个', '画', '读', '读取', '打开',
  '改', '修改', '改一下', '删', '删除', '建', '创建', '新建', '整理', '收拾',
  '发', '发送', '提交', '总结', '概括', '统计', '分析', '比较', '对比',
  '下载', '安装', '运行', '执行', '跑', '测试', '翻译', '处理', '抓取', '爬',
  '提醒', '记录', '保存', '记住', '回顾', '取消', '关闭', '清理', '复制', '粘贴',
]

/** 明确是闲聊/寒暄的开始 —— 命中则**绝不**调 LLM */
const CHIT_CHAT_HINTS = [
  '你好', 'hi', 'hello', '嗨', '早上好', '中午好', '晚上好', '早安', '晚安',
  '谢谢', '感谢', '嗯嗯', '哈哈', '哈哈哈', '哦', '好的', '知道了', '拜拜', '再见',
  '你在吗', '你在干嘛', '你是谁', '你叫什么', '讲个笑话', '无聊',
]

/**
 * 判断这句话**是否像在要求做事**。
 * 语义兜底只在返回 true 时才触发 —— 闲聊一句 LLM 都不调。
 */
export function looksLikeActionRequest(text: string): boolean {
  const t = String(text || '').trim().toLowerCase()
  if (!t) {return false}
  // 太短的（如「继续」「嗯」）不值得调 LLM，关键词没命中就按核心集处理
  if (t.length < 4) {return false}
  // 明确的寒暄 → 不是请求
  if (CHIT_CHAT_HINTS.some(h => t.includes(h))) {return false}
  if (ACTION_SIGNALS.some(s => t.includes(s))) {return true}
  if (ACTION_VERBS.some(v => t.includes(v))) {return true}
  return false
}

/**
 * 构造「能力组选择」的分类提示词。
 * 能力清单直接从 CAPABILITY_GROUPS 生成 —— 加组/改组时提示词自动同步，
 * 不会出现「代码里有这个组、提示词里没有」的静默不一致。
 */
export function buildGroupSelectorPrompt(userText: string, groupNames: string[]): string {
  const lines = groupNames
    .map(n => {
      const g = CAPABILITY_GROUPS[n]
      return g ? `- ${n}：${g.label}（${g.keywords.slice(0, 4).join('、')}）` : `- ${n}`
    })
    .join('\n')

  return [
    '你是工具能力分类器。判断完成用户的请求需要用到下列哪些能力组。',
    '',
    '规则：',
    '1. 只输出最相关的 0-3 个组名，用英文逗号分隔，不要任何解释。',
    '2. 如果不需要任何额外能力（纯聊天、或只用文件/终端/搜索/记忆这些基础能力），输出 NONE。',
    '3. 必须只从下面的组名里选，不要自创组名。',
    '',
    '可用能力组：',
    lines,
    '',
    `用户请求：${userText}`,
    '',
    '输出：',
  ].join('\n')
}

/**
 * 解析分类器的输出。非法组名一律丢弃（模型自创的名字不能拿来加载工具）。
 */
export function parseGroupAnswer(raw: string, validNames: string[]): string[] {
  const s = String(raw || '').trim()
  if (!s) {return []}
  if (/^none$/i.test(s)) {return []}
  const valid = new Set(validNames)
  const hit: string[] = []
  for (const part of s.split(/[,，\s;；]+/)) {
    const n = part.trim().toLowerCase()
    if (!n) {continue}
    if (valid.has(n) && !hit.includes(n)) {hit.push(n)}
  }
  return hit
}

export interface RouteResult {
  tools: string[]
  /** 本轮生效的能力组（含粘性继承来的） */
  groups: string[]
  /** 本轮新命中的组（用于日志） */
  newlyMatched: string[]
  /** 是否真的做了裁剪（false = 退回全量，如拿不到输入 / 工具过少） */
  narrowed: boolean
  /** 未裁剪的原因（诊断用） */
  reason?: string
}

/**
 * 从「该模式本可用的工具」里挑出本轮要暴露给模型的子集。
 *
 * @param candidateTools 该模式的全量候选（已过 blockedInChild）
 * @param mode           'chat' | 'agent' | 'developer'
 * @param userInput      本轮用户输入（拿不到就退回全量）
 * @param sessionId      会话 ID，用于粘性；缺失则不使用粘性
 * @param enabled        总开关，false 时直接返回全量
 */
export function routeTools(
  candidateTools: string[],
  mode: string,
  userInput: string | undefined,
  sessionId: string | undefined,
  enabled = true,
  /** 🧠 语义兜底选出的组（方案 C）。与关键词命中的组**合并**，不是替换。 */
  extraGroups: string[] = [],
): RouteResult {
  const passthrough = (reason: string): RouteResult => ({
    tools: candidateTools, groups: [], newlyMatched: [], narrowed: false, reason,
  })

  if (!enabled) {return passthrough('按需筛选已关闭')}
  // chat 档本来就是 0 工具，没有可裁的
  if (mode === 'chat') {return passthrough('chat 档已是最小集')}
  // 🔓 失败开放：拿不到用户输入就不裁 —— 宁可多花 token，也不能让模型没工具用
  const input = String(userInput || '').trim()
  if (!input) {return passthrough('本轮无用户输入，退回全量')}

  // ── 计算生效的组：粘性 ∪ 本轮命中 ──
  const sticky = sessionId ? (sessionActiveGroups.get(sessionId) || new Set<string>()) : new Set<string>()
  const newlyMatched = matchGroups(input)
  // 🧠 语义兜底选出的组合并进来（只接受 CAPABILITY_GROUPS 里存在的名字）
  const semantic = extraGroups.filter(g => g in CAPABILITY_GROUPS)
  const groups = new Set<string>([...sticky, ...newlyMatched, ...semantic])

  // ── 组装允许集 ──
  const allowed = new Set<string>(CORE_TOOLS)
  if (mode === 'developer') {
    for (const t of DEVELOPER_CORE_TOOLS) {allowed.add(t)}
  }
  for (const g of groups) {
    for (const t of (CAPABILITY_GROUPS[g]?.tools || [])) {allowed.add(t)}
  }

  const tools = candidateTools.filter(t => allowed.has(t))

  // 🔓 失败开放：裁完太少说明判断有问题，退回全量
  //   阈值取 8：低于这个数连「读文件 → 改 → 验证」都跑不起来。
  if (tools.length < 8) {
    return passthrough(`裁剪后仅 ${tools.length} 个工具（过少），退回全量`)
  }

  // ── 写入粘性（命中 + 语义都要记住，否则下一轮会掉）──
  const toStick = [...newlyMatched, ...semantic]
  if (sessionId && toStick.length > 0) {
    const set = sessionActiveGroups.get(sessionId) || new Set<string>()
    for (const g of toStick) {
      // 重新插入以把它挪到"最新"，让淘汰顺序反映最近使用情况
      if (set.has(g)) {set.delete(g)}
      set.add(g)
    }
    // 上限保护：超出则淘汰最早激活的组，避免长会话工具面无限膨胀
    while (set.size > MAX_STICKY_GROUPS) {
      const oldest = set.values().next().value
      if (oldest === undefined) {break}
      set.delete(oldest)
    }
    sessionActiveGroups.set(sessionId, set)
  }

  return {
    tools,
    groups: [...groups],
    newlyMatched: [...new Set(toStick)],
    narrowed: true,
  }
}
