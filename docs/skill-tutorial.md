# 5 分钟写一个 Lumina 技能

> 本文面向 Lumina 二次开发者。读完后你能从零写出一个"可被 Agent 调用"的技能。
> 所有代码均可直接复制粘贴，与当前代码库（Electron 40 + TypeScript）一致。

---

## 1. 技能系统是什么

Lumina 的技能（Skill）采用 **QwenPaw 风格**：技能用一个 `SKILL.md` 文件描述，里面用 Markdown 表格列出这个技能提供哪些**工具（Tool）**。Agent 运行时：

```
loadAllSkills()
  → 扫描 electron/skills/<name>/SKILL.md
  → 解析表格，提取工具名
  → 注入系统提示词（告诉 LLM "你有这些技能可用"）
  → LLM 决定调用某个工具名
  → registry.executeTool(name, args) 找到对应的实现函数并执行
```

**关键认知：`SKILL.md` 只是"说明书"，真正干活的是 `electron/tools/impl/` 下的 TypeScript 函数。**
光写 `SKILL.md` 工具不会执行——必须同时：

1. 写工具实现文件（导出 `xxxDef: ToolDef` 和 `async function xxx(args)`）；
2. 在 `electron/tools/index.ts` 里 `import` 并 `registerTool(xxxDef, xxx)`；
3. 在 `electron/tools/registry.ts` 的 `TOOLSETS` 里登记技能名 → 工具名列表；
4. 在 `electron/skills/<name>/SKILL.md` 里写说明书。

> 用户技能（放到 userData 目录）只需要 `SKILL.md` + 实现会在运行时被加载说明书；但**工具实现函数仍需在 index.ts 注册**才能被调用。详见第 8 节。

---

## 2. 目录结构

```
electron/
├── skills/                    ← 内置技能说明书
│   └── weather_brief/
│       └── SKILL.md
├── tools/
│   ├── types.ts               ← ToolDef / ToolResult 类型定义
│   ├── registry.ts            ← TOOLSETS + 工具注册表
│   ├── index.ts               ← registerAllTools()：注册所有工具
│   └── impl/
│       └── weatherBrief.ts    ← 工具实现（导出 Def + handler）
└── skills/skillsLoader.ts      ← 扫描 SKILL.md 的加载器
```

---

## 3. SKILL.md 格式规范

加载器 `extractToolNames()` 解析表格的规则（**照着写就不会出错**）：

- 工具名必须在表格**第一列**；
- 工具名用反引号包裹（如 `` `weather_get` ``），加载器会自动去掉反引号；
- 工具名只能是小写字母 + 下划线（`/^[a-z_]+$/i`），否则会被忽略；
- **表头第一列不要用英文单词**（如 `name`）——它会被误当成工具名。用中文 `工具名`；
- 表头分隔行 `|--------|` 含 `---`，会自动跳过；
- 代码块（``` ... ```）内的表格行不会被提取。

标准模板（3 列：名称 | 描述 | 参数）：

```markdown
# my_skill — 一句话技能名

什么时候用这个技能。可以写一段触发说明。

## 工具

| 工具名 | 描述 | 参数 |
|--------|------|------|
| `my_tool` | 工具干什么。 | `arg1` 参数说明 |

## 使用示例

​```
用户: "xxx"
  → my_tool(arg1="...")
​```

## 使用守则

1. 规则一。
2. 规则二。
```

> 注意：上面 ``` 三反引号在你自己的 SKILL.md 里正常写即可，不要带外层的 `​`。

---

## 4. ToolDef 和 ToolResult 类型

定义在 `electron/tools/types.ts`。**这是当前代码库的真实类型**，照着写：

```ts
// 工具定义（你要导出的 xxxDef）
export interface ToolDef {
  name: string              // 工具名，和 SKILL.md 表格里一致
  description: string       // 描述，会给 LLM 看
  params?: Record<string, ToolParamSchema>   // 参数表
  toolsets: string[]        // 归属工具集，例如 ['agent']
  dangerous?: boolean       // 是否危险操作（如 git_commit）
}

export interface ToolParamSchema {
  type: string              // 'string' | 'number' | 'boolean'
  description: string
  required?: boolean
  enum?: string[]
}

// 工具执行返回值（你函数的返回类型）
export interface ToolResult {
  callId: string            // 固定填 ''
  ok: boolean              // 成功 true / 失败 false
  content: string          // 返回给 LLM 的文本（成功时填这里）
  error?: string           // 失败时填这里
  durationMs?: number      // 可选，registry 会自动补
}
```

> ⚠️ **常见坑**：不要用 `{ success, result, message }` 这种写法。代码库里 `ToolResult` 是 `{ callId, ok, content, error }`，写错了 `tsc --noEmit` 会报类型错误。

---

## 5. 完整示例：hello_world 技能

一个最简单的技能：输入名字，返回一句问候。

### 5.1 工具实现 `electron/tools/impl/helloWorld.ts`

```ts
// ============================================================
// impl/helloWorld.ts — Hello World 示例工具
// ============================================================

import type { ToolDef, ToolResult } from '../types'

export const helloWorldDef: ToolDef = {
  name: 'hello_world',
  description: `打个招呼。

参数:
- name: 要问候的名字`,
  params: {
    name: { type: 'string', description: '名字', required: true },
  },
  toolsets: ['agent'],
}

export async function helloWorld(args: Record<string, any>): Promise<ToolResult> {
  const name = String(args.name || '').trim()
  if (!name) {
    return { callId: '', ok: false, content: '', error: '需要提供 name 参数' }
  }
  return {
    callId: '',
    ok: true,
    content: `你好，${name}！欢迎使用 Lumina 技能。`,
  }
}
```

### 5.2 注册工具 — `electron/tools/index.ts`

在文件顶部的 import 区加：

```ts
import { helloWorldDef, helloWorld } from './impl/helloWorld'
```

在 `registerAllTools()` 函数体里加：

```ts
registerTool(helloWorldDef, helloWorld)
```

### 5.3 登记工具集 — `electron/tools/registry.ts`

在 `TOOLSETS` 对象里加：

```ts
  hello_world: {
    description: 'Hello World 示例',
    tools: ['hello_world'],
  },
```

### 5.4 写说明书 — `electron/skills/hello_world/SKILL.md`

```markdown
# hello_world — 打招呼

当用户想测试技能系统或打个招呼时使用。

## 工具

| 工具名 | 描述 | 参数 |
|--------|------|------|
| `hello_world` | 输入名字，返回一句问候。 | `name` 名字 |
```

### 5.5 验证

```powershell
cd "K:\2\Lumina AI"
npx tsc --noEmit   # 确认没有类型错误
npm run dev        # 启动后对 Agent 说 "用 hello_world 问候一下小明"
```

---

## 6. 调用外部 API

**不要自己裸写 `https.request`**——代码库已经封装好了统一客户端，自动处理 SSL、重定向、超时。用 `electron/tools/utils/httpClient.ts` 的 `httpGet`：

```ts
import { httpGet } from '../utils/httpClient'

const resp = await httpGet(
  'https://api.example.com/data',
  { 'User-Agent': 'Lumina/1.0' },  // 额外 headers，可选
  10000,                            // 超时毫秒（建议 10s）
)

if (!resp.ok) {
  return { callId: '', ok: false, content: '', error: `HTTP ${resp.status}` }
}

let json: any
try {
  json = JSON.parse(resp.text)
} catch {
  return { callId: '', ok: false, content: '', error: '返回不是 JSON' }
}
```

`httpGet` 返回：

```ts
{ ok: boolean; status: number; text: string; contentType: string }
```

> 参考实现：`electron/tools/impl/bilibiliHot.ts`（B站热搜）、`electron/tools/impl/weatherBrief.ts`（天气）。

**错误处理要求**：所有外部调用都要 try/catch，超时要设，失败时返回 `ok: false` + 明确 `error` 文本，**不要让异常冒泡**（registry 虽然有兜底，但自己处理更友好）。

---

## 7. 使用 Electron API（通知等）

主进程里可以直接用 Electron 模块，但要包在 try/catch 里（因为工具也可能在 CLI/测试环境被调用）：

```ts
function notify(title: string, body: string): void {
  try {
    const electron = require('electron')
    const Notification = electron?.Notification
    if (Notification && typeof Notification === 'function') {
      new Notification({ title, body: body.slice(0, 200) }).show()
      return
    }
  } catch { /* 非 Electron 环境，忽略 */ }
  console.log(`[notify] ${title}: ${body}`)
}
```

其他常用 Electron 能力：

- `shell.openExternal(url)` — 打开浏览器链接；
- `app.getPath('userData')` — 用户数据目录；
- `Notification` — 系统通知。

> 参考实现：`electron/tools/impl/pomodoro.ts`（番茄钟到点提醒）。

---

## 8. 安装到用户技能目录

除了放进内置 `electron/skills/`（随版本发布），你也可以把技能放到**用户数据目录**，升级不丢失、不用改源码：

```
<userData>/skills/
  ├── disabled.json          ← 被禁用的技能名列表（自动生成）
  └── my_skill/
      └── SKILL.md
```

`userData` 路径（Windows）：

```
%APPDATA%\Lumina Life\skills\
```

加载器行为（见 `electron/skills/skillsLoader.ts`）：

- 同时扫描内置目录和用户目录；
- **同名时用户技能覆盖内置技能**；
- 用户技能目录不存在时，行为和以前完全一致（向后兼容）。

运行时管理 API（在主进程任意处 `require`）：

```ts
const {
  listUserSkills,   // UserSkillInfo[] — 列出用户技能（名称/标题/是否启用/目录）
  enableSkill,      // (name: string) => boolean — 启用
  disableSkill,    // (name: string) => boolean — 禁用
} = require('./skills/skillsLoader')
```

禁用方式有两种（任选）：

1. `disableSkill('my_skill')` —— 把名字写进 `disabled.json`；
2. 在技能目录里放一个空文件 `.disabled`。

> ⚠️ 注意：用户目录里的 `SKILL.md` 只会让技能**出现在系统提示词里**。要让工具真正能被调用，工具实现函数仍然需要在 `electron/tools/index.ts` 注册（因为运行时无法动态加载任意 TS）。如果你只想让 Agent"知道"这个技能的存在和用法，可以只放 SKILL.md。

---

## 9. 本地调试

```powershell
# 1. 类型检查（改完必跑）
cd "K:\2\Lumina AI"
npx tsc --noEmit

# 2. 启动开发版
npm run dev

# 3. 看启动日志
#    [Tools] 已注册 N 个工具
#    如果工具没注册，会看到 "[Tools] Skill 未找到" 或 registry 警告
```

快速验证技能说明书是否被正确解析（不启动完整 App）：

```powershell
node -e "const {loadAllSkills}=require('./out/skills/skillsLoader.js'); console.log(loadAllSkills().map(s=>s.name+': '+s.tools.join(',')))"
```

> 需要先 `tsc` 编译到 `out/`。直接看源码更简单的方式是检查你新写的 SKILL.md 表格是否符合第 3 节规则。

调试技巧：

- **工具没出现** → 检查 `index.ts` 有没有 `registerTool`；
- **Agent 不知道技能** → 检查 SKILL.md 是否在 `electron/skills/` 下、文件名是否就叫 `SKILL.md`；
- **工具名提取不出来** → 检查工具名是否小写+下划线、第一列、有没有用中文表头；
- **想临时关一个技能** → `disableSkill('name')` 或建 `.disabled` 文件。

---

## 10. 常见问题 FAQ

**Q: 我写了 SKILL.md 但 Agent 说没有这个工具？**
A: SKILL.md 只是说明书。工具实现必须在 `electron/tools/impl/` 写好，并在 `electron/tools/index.ts` 里 `registerTool`，在 `registry.ts` 的 `TOOLSETS` 里登记。

**Q: tsc 报 `ToolResult` 类型不匹配？**
A: 确认返回的是 `{ callId: '', ok, content, error? }`，不是 `{ success, result, message }`。

**Q: 外部 API 请求一直失败？**
A: 用 `httpGet` 而不是自己写 `https`。确认超时（建议 10000ms）、错误 JSON 解析有 try/catch、失败返回 `ok:false`。

**Q: 技能在用户目录放了但没生效？**
A: 确认目录是 `<userData>/skills/<name>/SKILL.md`，文件编码 UTF-8。`listUserSkills()` 能列出来就说明加载成功。

**Q: 能不能热重载技能？**
A: SKILL.md 是启动时加载的，改完重启 dev 即可。工具实现（TS）改完需要重新编译/重启。

**Q: 内置的 4 个示例技能在哪？**
A:
- `electron/skills/bilibili_hot/` + `impl/bilibiliHot.ts` —— B站热搜；
- `electron/skills/weather_brief/` + `impl/weatherBrief.ts` —— 天气简报；
- `electron/skills/code_daily/` + `impl/codeDaily.ts` —— 代码日报；
- `electron/skills/pomodoro/` + `impl/pomodoro.ts` —— 番茄钟。

它们分别演示了：调外部 HTTP API、免费 API 无 Key、`child_process` 调用 git、Electron 通知+定时器——写新技能时直接照着抄。
