// ============================================================
// agentSkills.ts — Lumina Skill 系统 (v3.0)
// ============================================================

export interface SkillDef {
  id: string
  name: string
  description: string
  triggers: string[]
  workflow: string
  /** Team Agent 执行铁则（注入到 Team Agent prompt，必须遵守） */
  executeConstraints?: string
  suggestedTools: string[]
  bestFor: string[]
  notFor: string[]
  examplePrompt: string
  exampleOutput: string
}

export const SKILLS: Record<string, SkillDef> = {

  // ── 代码编写 ────────────────────────────────────
  'code-write': {
    id: 'code-write',
    name: '代码编写',
    description: '编写新代码或新功能。适用场景：创建新文件、实现新功能、写脚本。',
    triggers: ['写代码', '创建', '新建', '实现', '开发', '写个脚本', '写个程序'],
    executeConstraints: `【Team Agent 执行铁则 — 务必遵守 不可跳过】
你是 Team Agent（Yak 或 Recha），你的输出将直接转成可执行操作。
执行任何操作前，请按以下规则：
  ① 先证明问题存在 — 运行命令/读取代码，拿到真实数据
  ② 再执行操作 — 只改真的需要改的部分，最少改动
  ③ 立做验证 — 操作后立刻跑验证，确认没破坏任何东西
  ④ 永不猜错 — 不确定时停下，读取更多上下文再决定
  ⑤ 失败就重试 — 报错时看信息后修复，最多 3 轮（非同一错盲目重试无效）
【必须正向验证】任何修改后的代码/配置，必须对你声称修复的功能执行实际测试用例验证。
禁止仅靠"看代码没问题"交付。已修复+验证通过=交付，二者缺一不可。`,
    workflow: `【代码编写工作流】
1. 理解需求 — 先确认用户的输入输出要求、边界条件、预期行为
2. 检查环境 — shell_exec 确认运行环境（Python 版本、Node 版本、已安装的库）
3. 写代码 — file_write 创建文件，包含：
   - 清晰的模块/函数结构
   - 关键逻辑的注释
   - 错误处理
   - 如果有输入参数，加上参数校验
4. 验证 — shell_exec 运行代码，确认输出正确
5. 修复 — 如果报错或输出不对：
   a. 仔细读报错信息（不要猜！）
   b. 定位到具体行
   c. file_edit 修复
   d. 再运行
   e. 最多 3 轮修复循环
6. 交付 — 告诉用户代码位置 + 运行方式 + 预期输出
【黄金法则】
- 命名清晰，不要 a/b/c
- 复杂逻辑必有注释
- 硬编码值提取为常量
- 函数单一职责`,
    suggestedTools: ['file_write', 'file_read', 'file_edit', 'shell_exec', 'web_search'],
    bestFor: ['yak'],
    notFor: ['recha'],
    examplePrompt: '用 Python 写一个脚本，读取 data.csv 里的销售数据，计算每个月的总销售额并输出图表',
    exampleOutput: '已创建 sales_analysis.py，运行结果：\n```\n2024-01: 45,230\n2024-02: 52,180\n...\n```\n图表已保存为 sales_chart.png',
  },

  // ── 代码修改 ────────────────────────────────────
  'code-modify': {
    id: 'code-modify',
    name: '代码修改/重构',
    description: '修改现有代码、重构、修 bug。适用场景：改功能、修 bug、优化代码。',
    triggers: ['修改', '改', '修复', 'bug', '重构', '优化', '改进', '改一下'],
    executeConstraints: `【Team Agent 执行铁则 — 务必遵守 不可跳过】
你是 Team Agent（Yak 或 Recha），你的输出将直接转成可执行操作。
执行任何操作前，请按以下规则：
  ① 先证明问题存在 — 运行命令/读取代码，拿到真实数据
  ② 再执行操作 — 只改真的需要改的部分，最少改动
  ③ 立做验证 — 操作后立刻跑验证，确认没破坏任何东西
  ④ 永不猜错 — 不确定时停下，读取更多上下文再决定
  ⑤ 失败就重试 — 报错时看信息后修复，最多 3 轮（非同一错盲目重试无效）
【必须正向验证】任何修改后的代码/配置，必须对你声称修复的功能执行实际测试用例验证。
禁止仅靠"看代码没问题"交付。已修复+验证通过=交付，二者缺一不可。`,
    workflow: `【代码修改工作流】
1. 先读懂 — file_read 目标文件，理解现有逻辑
   - ⚠️ 不要只看改动的几行，要理解上下文
   - ⚠️ 追踪相关调用：谁调用了这个函数？这个函数调用了谁？
2. 确认改动范围 — 用 git_diff 或手动定位需要改的代码块
3. 修改 — file_edit 精确替换
   - 保持代码风格一致（缩进、命名风格、注释风格）
   - 不要顺手改无关的东西（避免引入新 bug）
4. 验证 — shell_exec 运行相关测试或用例
   - 确认修改的功能正常
   - 确认没有破坏现有功能（跑一下原有的测试或用例）
5. 如果出错 — 看报错 → 定位 → 修复 → 再验证
6. 交付 — 说明改了什么、为什么这样改、验证结果
【黄金法则】
- 最小改动原则：只改需要改的，不要重构整个文件
- 别猜：不确定某个函数怎么用时，grep_search 查找用法
- 改完就跑：不要等用户说"你跑一下试试"`,
    suggestedTools: ['file_read', 'file_edit', 'shell_exec', 'git_diff', 'grep_search'],
    bestFor: ['recha', 'yak'],
    notFor: [],
    examplePrompt: 'login.py 里的密码验证太简单了，加上至少 8 位、包含数字和字母的校验',
    exampleOutput: '已在 login.py 第 45 行添加密码强度校验：\n- 最少 8 位\n- 必须包含数字和字母\n验证测试通过：\n```\n"abc" → 拒绝（太短）\n"abcdefgh" → 拒绝（无数字）\n"abc12345" → 通过\n```',
  },

  // ── 代码审查 ────────────────────────────────────
  'code-review': {
    id: 'code-review',
    name: '代码审查',
    description: '审查代码质量、发现问题、提出改进建议。',
    triggers: ['审查', 'review', '检查代码', '看看代码', '代码质量', '代码有什么问题'],
    executeConstraints: `【Team Agent 执行铁则 — 务必遵守 不可跳过】
你是 Team Agent（Yak 或 Recha），你的输出将直接转成可执行操作。
执行任何操作前，请按以下规则：
  ① 先证明问题存在 — 运行命令/读取代码，拿到真实数据
  ② 再执行操作 — 只改真的需要改的部分，最少改动
  ③ 立做验证 — 操作后立刻跑验证，确认没破坏任何东西
  ④ 永不猜错 — 不确定时停下，读取更多上下文再决定
  ⑤ 失败就重试 — 报错时看信息后修复，最多 3 轮（非同一错盲目重试无效）
【必须正向验证】任何修改后的代码/配置，必须对你声称修复的功能执行实际测试用例验证。
禁止仅靠"看代码没问题"交付。已修复+验证通过=交付，二者缺一不可。`,
    workflow: `【代码审查工作流】
1. 全面阅读 — file_read 目标文件和相关的依赖文件
2. 按以下维度逐项检查：

   【正确性】
   - 逻辑是否正确？
   - 边界条件处理了吗？（空输入、极大值、null/undefined）
   - 并发/异步场景安全吗？

   【可读性】
   - 命名清晰吗？
   - 函数太长吗？（超过 30 行考虑拆分）
   - 复杂逻辑有注释吗？

   【健壮性】
   - 有错误处理吗？
   - 外部调用（API、文件、数据库）有超时/重试吗？
   - 资源会泄露吗？（文件未关闭、连接未释放）

   【性能】
   - 有 O(n²) 或更差的算法可以用更好的吗？
   - 有不必要的重复计算吗？
   - 数据库查询有 N+1 问题吗？

   【安全性】
   - 用户输入有校验吗？
   - 敏感信息（密码、token）有硬编码吗？
   - SQL 有注入风险吗？

3. 输出结构化报告：
   - 🔴 严重问题（会导致 bug 或安全漏洞）
   - 🟡 改进建议（不会出错但可以更好）
   - 🟢 亮点（写得好的地方，也要肯定）

4. 如果问题明确，给 Yak 提供可执行修复建议；Recha 不自行修复，只输出证据、风险和修改建议`,
    suggestedTools: ['file_read', 'grep_search', 'shell_exec'],
    bestFor: ['yak', 'recha'],
    notFor: ['lumina'],
    examplePrompt: '审查一下 api.py 的代码质量',
    exampleOutput: '## 代码审查报告：api.py\n\n🔴 严重问题：\n1. 第 23 行：数据库查询没有用参数化，存在 SQL 注入风险\n2. 第 56 行：异常被静默吞掉了，出错时无法排查\n\n🟡 改进建议：\n1. 第 78-95 行：这个函数 30 行，建议拆成两个\n2. 第 120 行：正则表达式可以预编译，避免每次调用重新编译\n\n🟢 亮点：\n1. API 文档注释写得很好\n2. 分页逻辑处理得当',
  },

  // ── 调试排错 ────────────────────────────────────
  'debugging': {
    id: 'debugging',
    name: '调试排错',
    description: '定位和修复 bug。适用场景：代码报错、行为异常、输出不符合预期。',
    triggers: ['报错', '出错', '不对', '不行', '异常', '没反应', '不工作', 'debug', '调试'],
    executeConstraints: `【Team Agent 执行铁则 — 务必遵守 不可跳过】
你是 Team Agent（Yak 或 Recha），你的输出将直接转成可执行操作。
执行任何操作前，请按以下规则：
  ① 先证明问题存在 — 运行命令/读取代码，拿到真实数据
  ② 再执行操作 — 只改真的需要改的部分，最少改动
  ③ 立做验证 — 操作后立刻跑验证，确认没破坏任何东西
  ④ 永不猜错 — 不确定时停下，读取更多上下文再决定
  ⑤ 失败就重试 — 报错时看信息后修复，最多 3 轮（非同一错盲目重试无效）
【必须正向验证】任何修改后的代码/配置，必须对你声称修复的功能执行实际测试用例验证。
禁止仅靠"看代码没问题"交付。已修复+验证通过=交付，二者缺一不可。`,
    workflow: `【调试排错工作流】
1. 复现问题 — 先跑一遍代码，拿到完整的报错信息/异常输出
2. 定位根因（不要猜！按顺序排查）：

   【如果报错】
   - 读报错的最后一行的错误类型和消息
   - 从下往上读 traceback，找到你自己代码的那一行
   - 理解：这一行为什么会触发这个错误？

   【如果无报错但结果不对】
   - 加 print/logging 输出中间变量
   - 找到数据流在哪里出了问题（输入→处理→输出，逐步检查）
   - 检查假设是否正确（文件编码？路径分隔符？时区？）

   【如果间歇性出错】
   - 检查并发/异步逻辑
   - 检查外部依赖是否稳定
   - 检查有没有竞态条件

3. 修复 — file_edit 精准修复根因（不要修症状！）
4. 验证：
   - 跑一遍原来出错的场景，确认修复
   - 跑一下相关功能，确认没引入新问题
5. 回溯 — 如果修复了，想想"为什么一开始会写出这个 bug？"
   - 是逻辑没想清楚？→ 补充注释
   - 是外部 API 行为不清楚？→ 加错误处理
   - 是边界条件没考虑？→ 加测试用例`,
    suggestedTools: ['file_read', 'file_edit', 'shell_exec', 'grep_search'],
    bestFor: ['recha', 'yak', 'lumina'],
    notFor: [],
    examplePrompt: 'app.py 在用户上传文件时报 500 错误，帮我排查',
    exampleOutput: '定位到 bug：app.py 第 42 行，\`file.size\` 在文件为 None 时会报 AttributeError。已修复：加上 \`if file is None: return error_response("请选择文件")\`。验证通过——上传正常文件和空提交都正确处理了。',
  },

  // ── 架构设计 ────────────────────────────────────
  'architecture': {
    id: 'architecture',
    name: '架构设计',
    description: '系统架构设计、技术选型、方案对比。',
    triggers: ['架构', '设计', '选型', '方案', '技术栈', '怎么搭', '整体设计'],
    executeConstraints: `【Team Agent 执行铁则 — 务必遵守 不可跳过】
你是 Team Agent（Yak 或 Recha），你的输出将直接转成可执行操作。
执行任何操作前，请按以下规则：
  ① 先证明问题存在 — 运行命令/读取代码，拿到真实数据
  ② 再执行操作 — 只改真的需要改的部分，最少改动
  ③ 立做验证 — 操作后立刻跑验证，确认没破坏任何东西
  ④ 永不猜错 — 不确定时停下，读取更多上下文再决定
  ⑤ 失败就重试 — 报错时看信息后修复，最多 3 轮（非同一错盲目重试无效）
【必须正向验证】任何修改后的代码/配置，必须对你声称修复的功能执行实际测试用例验证。
禁止仅靠"看代码没问题"交付。已修复+验证通过=交付，二者缺一不可。`,
    workflow: `【架构设计工作流】
1. 问题定义 — 明确约束条件：
   - 用户量级？（1 人用 vs 100 万人用）
   - 数据量级？（MB 级 vs TB 级）
   - 实时性要求？（秒级 vs 天级）
   - 技术栈限制？（必须用什么语言/框架？）
   - 维护者？（谁来维护？技术水平？）

2. 方案设计 — 至少给出 2 种方案：
   【方案 A】简单快速
   【方案 B】完善但复杂
   每个方案列出：技术栈、架构图（文字描述）、优点、缺点、适合场景

3. Trade-off 分析：
   - 复杂度 vs 灵活性
   - 开发速度 vs 可维护性
   - 性能 vs 成本

4. 推荐方案 — 明确推荐哪个，为什么

5. 实施路线 — 如果选定方案，给出：
   - 第一阶段（MVP）
   - 第二阶段（完善）
   - 第三阶段（优化）`,
    suggestedTools: ['web_search', 'file_read'],
    bestFor: ['yak'],
    notFor: ['lumina', 'recha'],
    examplePrompt: '我想做一个个人博客系统，支持 Markdown 写作和评论功能，单用户使用，帮我设计架构',
    exampleOutput: '## 博客系统架构方案\n\n### 方案 A：静态站点 + 第三方评论（推荐）\n- 技术栈：Hugo/Next.js 静态导出 + Giscus 评论\n- 优点：零运维、加载快、免费部署\n- 缺点：评论依赖 GitHub\n\n### 方案 B：全栈应用\n- 技术栈：Next.js + SQLite + 自建评论\n- 优点：评论可控、功能灵活\n- 缺点：需要服务器/VPS\n\n**推荐方案 A**：单用户博客静态站点最合适，无需数据库维护。',
  },

  // ── 数据分析 ────────────────────────────────────
  'data-analysis': {
    id: 'data-analysis',
    name: '数据分析',
    description: '数据处理、统计分析、可视化、得出结论。',
    triggers: ['分析数据', '统计', '图表', '可视化', '趋势', '数据', '报表'],
    executeConstraints: `【Team Agent 执行铁则 — 务必遵守 不可跳过】
你是 Team Agent（Yak 或 Recha），你的输出将直接转成可执行操作。
执行任何操作前，请按以下规则：
  ① 先证明问题存在 — 运行命令/读取代码，拿到真实数据
  ② 再执行操作 — 只改真的需要改的部分，最少改动
  ③ 立做验证 — 操作后立刻跑验证，确认没破坏任何东西
  ④ 永不猜错 — 不确定时停下，读取更多上下文再决定
  ⑤ 失败就重试 — 报错时看信息后修复，最多 3 轮（非同一错盲目重试无效）
【必须正向验证】任何修改后的代码/配置，必须对你声称修复的功能执行实际测试用例验证。
禁止仅靠"看代码没问题"交付。已修复+验证通过=交付，二者缺一不可。`,
    workflow: `【数据分析工作流】
1. 理解数据 — file_read 数据文件，了解：
   - 字段含义
   - 数据量级
   - 数据质量（缺失值？异常值？）
2. 明确问题 — 用户想从数据中得到什么？
3. 选择方法：
   - 描述统计：均值/中位数/标准差/分布
   - 相关性：变量间的关系
   - 可视化：选择合适的图表类型
4. 分析 — 执行计算/可视化
5. 结论 — 用通俗语言总结发现`,
    suggestedTools: ['file_read', 'shell_exec'],
    bestFor: ['yak'],
    notFor: ['lumina', 'recha'],
    examplePrompt: '分析一下 sales.csv 的月度销售趋势',
    exampleOutput: '## 销售数据分析\n\n### 整体趋势\n- Q1 销售额稳步上升（2月春节有峰值）\n- Q2 略有回落\n\n### 细分\n|月份|销售额|环比|\n|---|---|---|\n|1月|45,230|—|\n|2月|68,000|+50%|\n|3月|52,180|-23%|',
  },

  // ── API 设计 ────────────────────────────────────
  'api-design': {
    id: 'api-design',
    name: 'API 设计',
    description: '设计 RESTful API 或 GraphQL Schema。适用场景：新接口、接口规范、API 文档。',
    triggers: ['API', '接口', 'REST', 'GraphQL', '端点', 'endpoint', '接口设计', 'RESTful'],
    executeConstraints: `【Team Agent 执行铁则 — 务必遵守 不可跳过】
你是 Team Agent（Yak 或 Recha），你的输出将直接转成可执行操作。
执行任何操作前，请按以下规则：
  ① 先证明问题存在 — 运行命令/读取代码，拿到真实数据
  ② 再执行操作 — 只改真的需要改的部分，最少改动
  ③ 立做验证 — 操作后立刻跑验证，确认没破坏任何东西
  ④ 永不猜错 — 不确定时停下，读取更多上下文再决定
  ⑤ 失败就重试 — 报错时看信息后修复，最多 3 轮（非同一错盲目重试无效）
【必须正向验证】任何修改后的代码/配置，必须对你声称修复的功能执行实际测试用例验证。
禁止仅靠"看代码没问题"交付。已修复+验证通过=交付，二者缺一不可。`,
    workflow: `【API 设计工作流】
1. 理解需求 — 明确要暴露什么数据/功能
2. 设计资源模型 — 确定主要资源（ nouns ）和操作（ verbs ）
3. 设计端点：
   - 遵循 RESTful 规范（资源用名词、HTTP 方法用动词）
   - 考虑认证、权限、版本
   - 设计请求/响应格式
4. 边界情况 — 空结果、错误码、分页、过滤
5. 给出规范 — 包含示例请求和响应`,
    suggestedTools: ['file_read', 'web_search'],
    bestFor: ['yak'],
    notFor: ['lumina', 'recha'],
    examplePrompt: '设计一个博客的 API，支持文章的 CRUD 和评论功能',
    exampleOutput: '## Blog API 设计\n\n### 文章\n\`\`\`\nGET    /api/v1/posts\nPOST   /api/v1/posts\nGET    /api/v1/posts/:id\nPUT    /api/v1/posts/:id\nDELETE /api/v1/posts/:id\n\`\`\`\n\n### 请求示例\n\`\`\`json\nPOST /api/v1/posts\n{\n  "title": "Hello World",\n  "content": "..."\n}\n\`\`\`',
  },

  // ── Web 搜索 ────────────────────────────────────
  'web-search': {
    id: 'web-search',
    name: 'Web 搜索',
    description: '搜索互联网获取信息。适用场景：查资料、找文档、对比方案、学习新技术。',
    triggers: ['搜索', '查一下', '搜一下', '查找', 'google', 'baidu', 'bing', '找资料', '了解一下'],
    executeConstraints: `【Team Agent 执行铁则 — 务必遵守 不可跳过】
你是 Team Agent（Yak 或 Recha），你的输出将直接转成可执行操作。
执行任何操作前，请按以下规则：
  ① 先证明问题存在 — 运行命令/读取代码，拿到真实数据
  ② 再执行操作 — 只改真的需要改的部分，最少改动
  ③ 立做验证 — 操作后立刻跑验证，确认没破坏任何东西
  ④ 永不猜错 — 不确定时停下，读取更多上下文再决定
  ⑤ 失败就重试 — 报错时看信息后修复，最多 3 轮（非同一错盲目重试无效）
【必须正向验证】任何修改后的代码/配置，必须对你声称修复的功能执行实际测试用例验证。
禁止仅靠"看代码没问题"交付。已修复+验证通过=交付，二者缺一不可。`,
    workflow: `【Web 搜索工作流】
1. 理解需求 — 明确要查什么、为什么要查
2. 选关键词 — 用具体、准确的关键词搜索
3. 筛选来源 — 优先选择：
   - 官方文档（最准确）
   - GitHub Issues/ Discussions（最实用）
   - Stack Overflow（最经典问题）
   - 权威博客/教程
4. 交叉验证 — 多个来源确认信息一致性
5. 总结 — 给出结论 + 来源链接`,
    suggestedTools: ['web_search'],
    bestFor: ['yak', 'lumina'],
    notFor: ['recha'],
    examplePrompt: 'Python 3.10 的 match case 语法怎么用？',
    exampleOutput: 'Python 3.10 引入了 match-case（类似 switch）：\n\`\`\`python\nmatch value:\n    case 1:\n        print("one")\n    case 2:\n        print("two")\n    case _:\n        print("other")\n\`\`\`\n参考：https://docs.python.org/3.10/whatsnew/3.10.html',
  },

  // ── 文件操作 ────────────────────────────────────
  'file-operations': {
    id: 'file-operations',
    name: '文件操作',
    description: '文件读写、整理、查找、格式转换。适用场景：批量处理、数据导入导出、文件管理。',
    triggers: ['文件', '读写', '读取文件', '写入文件', '批量处理', '文件管理', '整理文件', 'csv', 'json', 'excel'],
    executeConstraints: `【Team Agent 执行铁则 — 务必遵守 不可跳过】
你是 Team Agent（Yak 或 Recha），你的输出将直接转成可执行操作。
执行任何操作前，请按以下规则：
  ① 先证明问题存在 — 运行命令/读取代码，拿到真实数据
  ② 再执行操作 — 只改真的需要改的部分，最少改动
  ③ 立做验证 — 操作后立刻跑验证，确认没破坏任何东西
  ④ 永不猜错 — 不确定时停下，读取更多上下文再决定
  ⑤ 失败就重试 — 报错时看信息后修复，最多 3 轮（非同一错盲目重试无效）
【必须正向验证】任何修改后的代码/配置，必须对你声称修复的功能执行实际测试用例验证。
禁止仅靠"看代码没问题"交付。已修复+验证通过=交付，二者缺一不可。`,
    workflow: `【文件操作工作流】
1. 确认需求 — 明确：
   - 输入文件路径和格式
   - 输出格式和位置
   - 处理逻辑（过滤、转换、合并、拆分等）
2. 检查文件 — shell_exec 确认文件存在、格式正确
3. 编写脚本 — file_write 创建处理脚本
4. 处理少量测试数据 — 先用小样本验证逻辑
5. 全量运行 — 确认无错误
6. 清理 — 删除中间文件（如需）`,
    suggestedTools: ['file_read', 'file_write', 'shell_exec'],
    bestFor: ['lumina'],
    notFor: ['recha'],
    examplePrompt: '把文件夹里所有 txt 文件合并成一个，每篇之间加分隔线',
    exampleOutput: '已合并 23 个 txt 文件到 merged.txt（共 15.2 MB）',
  },
}

export function getSkill(id: string): SkillDef | undefined {
  return SKILLS[id]
}

export function matchSkill(task: string): SkillDef | undefined {
  const t = task.toLowerCase()
  let best: SkillDef | undefined
  let bestScore = 0
  for (const s of Object.values(SKILLS)) {
    const score = s.triggers.reduce((acc, trig) => acc + (t.includes(trig.toLowerCase()) ? 1 : 0), 0)
    if (score > bestScore) {
      bestScore = score
      best = s
    }
  }
  return best
}
