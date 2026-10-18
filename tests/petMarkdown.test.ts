// tests/petMarkdown.test.ts
//
// 2026-10-18（第十轮）桌宠聊天窗排版修复的守护测试。
//
// 【用户看到的】点 Live2D 角色聊天，回复是一大坨文字：
//   `**- 先写大纲再动笔…**`、`- 金句要「可转发」…` 全挤在一行，
//   星号和短横线原样露出来 —— 「眼睛看起来比较难受」。
//
// 【两条根因】
//   1) `.cp-msg` 没设 white-space → 默认 normal → 模型输出里的换行**全部折叠**；
//   2) 正文走 `textContent`，是纯文本 → Markdown 标记不可能被渲染。
//
// 【本文件守的】
//   · 渲染器把标题/列表/代码/表格/引用变成真标签
//   · **换行不再被吃掉**（最关键的一条）
//   · LLM 输出是不可信内容：先转义再插标签，`javascript:` 不生成链接
//   · 页面接线：脚本先加载、有纯文本兜底、user 气泡仍保留 pre-wrap
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'

const src = fs.readFileSync('electron/pet/pet-md.js', 'utf-8')
const mod: any = { exports: {} }
// 渲染器是 IIFE（浏览器直接 <script> 引入），这里给它 module/window 两个桩
// eslint-disable-next-line no-new-func
new Function('module', 'window', src)(mod, {})
const PetMD = mod.exports as {
  render: (s: string) => string
  escapeHtml: (s: string) => string
  safeUrl: (s: string) => string
}
const render = PetMD.render

const petChat = fs.readFileSync('electron/pet/pet-chat.html', 'utf-8')
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf-8'))

// ============================================================
// 一、核心：换行不再被折叠
// ============================================================
describe('渲染器 — 换行与段落', () => {
  it('单个换行 → <br>（不再被 white-space:normal 吃掉）', () => {
    expect(render('第一行\n第二行')).toBe('<p>第一行<br>第二行</p>')
  })

  it('空行分段 → 两个 <p>', () => {
    const out = render('第一段\n\n第二段')
    expect(out).toBe('<p>第一段</p><p>第二段</p>')
  })

  it('多行列表逐条成 <li>，不是一坨', () => {
    const out = render('- 甲\n- 乙\n- 丙')
    expect(out).toBe('<ul><li>甲</li><li>乙</li><li>丙</li></ul>')
  })

  it('CRLF 与制表符先归一化（模型输出常见 \\r\\n）', () => {
    expect(render('a\r\nb')).toBe('<p>a<br>b</p>')
    expect(render('\t缩进')).toBe('<p>  缩进</p>')
  })

  it('空输入 → 空串', () => {
    expect(render('')).toBe('')
    expect(render('   \n  ')).toBe('')
    expect(render(null as any)).toBe('')
  })
})

// ============================================================
// 二、块级元素
// ============================================================
describe('渲染器 — 块级元素', () => {
  it('标题：## → h4（气泡里 # 从 h3 起，避免字号过大）', () => {
    expect(render('# 大标题')).toBe('<h3>大标题</h3>')
    expect(render('## 二级')).toBe('<h4>二级</h4>')
    expect(render('### 三级')).toBe('<h5>三级</h5>')
  })

  it('有序列表保留起始序号（模型常从 3. 开始续写）', () => {
    expect(render('3. 三\n4. 四')).toBe('<ol start="3"><li>三</li><li>四</li></ol>')
    expect(render('1. 一')).toBe('<ol><li>一</li></ol>')
  })

  it('围栏代码块：保留内部换行与缩进，语言标在 data-lang', () => {
    const out = render('```js\nconst a = 1\n  return a\n```')
    expect(out).toBe('<pre class="cp-pre" data-lang="js"><code>const a = 1\n  return a</code></pre>')
  })

  it('代码块里不解析 Markdown（** 原样保留）', () => {
    const out = render('```\n**不是粗体**\n```')
    expect(out).toContain('**不是粗体**')
    expect(out).not.toContain('<strong>')
  })

  it('引用、分割线', () => {
    expect(render('> 引用一行')).toBe('<blockquote>引用一行</blockquote>')
    expect(render('---')).toBe('<hr>')
  })

  it('表格渲染成 table，表头进 th', () => {
    const out = render('| 名称 | 说明 |\n|---|---|\n| A | 甲 |\n| B | 乙 |')
    expect(out).toContain('<table>')
    expect(out).toContain('<th>名称</th>')
    expect(out).toContain('<td>A</td>')
    expect(out).toContain('<td>乙</td>')
  })
})

// ============================================================
// 三、行内元素
// ============================================================
describe('渲染器 — 行内元素', () => {
  it('粗体 / 斜体 / 删除线 / 行内代码', () => {
    expect(render('**粗**')).toBe('<p><strong>粗</strong></p>')
    expect(render('*斜*')).toBe('<p><em>斜</em></p>')
    expect(render('~~删~~')).toBe('<p><del>删</del></p>')
    expect(render('用 `npm i` 装')).toBe('<p>用 <code>npm i</code> 装</p>')
  })

  it('行内代码里的星号不被当成粗体', () => {
    expect(render('`a ** b`')).toBe('<p><code>a ** b</code></p>')
  })

  it('链接 → <a data-ext>，交给受控外链打开', () => {
    const out = render('见 [文档](https://example.com/x)')
    expect(out).toContain('href="https://example.com/x"')
    expect(out).toContain('data-ext="1"')
    expect(out).toContain('>文档</a>')
  })

  it('裸 URL 自动成链接', () => {
    const out = render('打开 https://example.com/a?b=1 看看')
    expect(out).toContain('<a href="https://example.com/a?b=1" data-ext="1">')
  })
})

// ============================================================
// 四、安全：LLM 输出是不可信内容
// ============================================================
describe('渲染器 — XSS 防护', () => {
  it('<script> 只会变成可见字符', () => {
    const out = render('<script>alert(1)</script>')
    expect(out).not.toContain('<script')
    expect(out).toContain('&lt;script&gt;')
  })

  it('img onerror 被转义，不会生成真实标签', () => {
    const out = render('<img src=x onerror="alert(1)">')
    expect(out).not.toContain('<img')
    expect(out).toContain('&lt;img')
    expect(out).toContain('&quot;')
  })

  it('javascript: 链接不生成 <a>（只留文字）', () => {
    const out = render('[点我](javascript:alert(1))')
    expect(out).not.toContain('<a')
    expect(out).toContain('点我')
  })

  it('data: 链接同样不放行', () => {
    const out = render('[x](data:text/html,<script>alert(1)</script>)')
    expect(out).not.toContain('href="data:')
  })

  it('safeUrl 只放行 http(s)', () => {
    expect(PetMD.safeUrl('https://a.com')).toBe('https://a.com')
    expect(PetMD.safeUrl('http://a.com')).toBe('http://a.com')
    expect(PetMD.safeUrl('javascript:alert(1)')).toBe('')
    expect(PetMD.safeUrl('file:///C:/Windows')).toBe('')
    expect(PetMD.safeUrl('')).toBe('')
  })

  it('属性值里的引号被转义，无法闭合属性注入事件', () => {
    const out = render('[x](https://a.com/"onmouseover="alert(1))')
    const tag = out.match(/<a [^>]*>/)![0]
    // 把引号内的值抹掉，只看"骨架"：任何 on* 属性都必须出现在值里，而不是骨架里
    const skeleton = tag.replace(/"[^"]*"/g, '""')
    expect(skeleton).not.toMatch(/on\w+=/i)
    // 属性定界引号必须成对（值里不可能再有裸引号）
    expect((tag.match(/"/g) || []).length % 2).toBe(0)
  })
})

// ============================================================
// 五、真实场景：用户截图里那段回复
// ============================================================
describe('渲染器 — 还原用户截图里的那段回复', () => {
  const sample = [
    '**图文笔记** —— 一张图讲透一个概念，配色不超过 3 种，字体大小要有层次',
    '',
    '**写作/文案类：**',
    '- 先写大纲再动笔，卡文时回头看结构而不是硬憋',
    '- 金句要「可转发」—— 短、准、有情绪',
    '- 商业文案避免自嗨，用「用户为什么会选你」倒推卖点',
    '',
    '**AI 辅助创作：**',
    '1. Prompt 模板化：角色 + 任务 + 约束 + 输出格式',
    '2. 多视角生成：同一个主题让 AI 从不同人设写',
    '3. 跨领域嫁接：用游戏设计思路做产品',
  ].join('\n')

  const out = render(sample)

  it('不残留任何 Markdown 标记（用户看到的应该是排版，不是星号）', () => {
    expect(out).not.toContain('**')
    expect(out).not.toContain('\n- ')
  })

  it('粗体变成 strong，列表变成 ul/ol', () => {
    expect(out).toContain('<strong>图文笔记</strong>')
    expect(out).toContain('<ul>')
    expect(out).toContain('<ol>')
    expect((out.match(/<li>/g) || []).length).toBe(6)
  })

  it('每一行都单独成段/条目，不再挤成一坨', () => {
    expect(out).toContain('<li>先写大纲再动笔，卡文时回头看结构而不是硬憋</li>')
    expect(out).toContain('<li>金句要「可转发」—— 短、准、有情绪</li>')
  })
})

// ============================================================
// 六、页面接线
// ============================================================
describe('pet-chat.html — 接线', () => {
  it('pet-md.js 在主脚本之前加载', () => {
    const libIdx = petChat.indexOf('<script src="./pet-md.js">')
    const mainIdx = petChat.indexOf('<script>', libIdx)
    expect(libIdx).toBeGreaterThan(-1)
    expect(mainIdx).toBeGreaterThan(libIdx)
  })

  it('助手气泡走 PetMD.render，而不是 textContent', () => {
    const start = petChat.indexOf('function addChatMsg(role, text)')
    const end = petChat.indexOf('/* ── 相邻重复消息判定', start)
    const fn = petChat.slice(start, end)
    expect(fn).toMatch(/window\.PetMD\.render\(text\)/)
    expect(fn).toMatch(/body\.innerHTML = html/)
  })

  it('渲染失败要有纯文本兜底（pet-md.js 缺失也不能吞消息）', () => {
    const start = petChat.indexOf('function addChatMsg(role, text)')
    const end = petChat.indexOf('/* ── 相邻重复消息判定', start)
    const fn = petChat.slice(start, end)
    expect(fn).toMatch(/catch \(e\) \{ html = ''; \}/)
    expect(fn).toMatch(/body\.textContent = text/)
    expect(fn).toMatch(/no-md/)
  })

  it('用户气泡保留 pre-wrap，助手气泡用 normal（否则块级结构会被二次撑开）', () => {
    expect(petChat).toMatch(/#chat-panel \.cp-msg\.user \{ white-space: pre-wrap; \}/)
    expect(petChat).toMatch(/#chat-panel \.cp-msg\.pet \{ white-space: normal; \}/)
    // 兜底态要能保住换行
    expect(petChat).toMatch(/\.cp-msg\.pet\.no-md \{ white-space: pre-wrap; \}/)
  })

  it('渲染出的链接走受控外链（事件委托，不在 innerHTML 里挂 onclick）', () => {
    expect(petChat).toMatch(/closest\('a\[data-ext\]'\)/)
    expect(petChat).toMatch(/window\.petAPI\.openExternal\(url\)/)
    expect(petChat).toMatch(/\^https\?:\\\/\\\//)
  })

  it('渲染后的正文仍可选中复制', () => {
    expect(petChat).toMatch(/#chat-panel \.cp-msg \{ user-select: text;/)
  })

  it('pet-md.js 进了 extraResources（否则打包后 404）', () => {
    const entry = pkg.build.extraResources.find((r: any) => r.from === 'electron/pet/pet-md.js')
    expect(entry).toBeTruthy()
    expect(entry.to).toBe('pet/pet-md.js')
  })
})

// ============================================================
// 七、与主面板的 agent 质量对齐
// ============================================================
describe('PetChatSync — 与主面板对齐', () => {
  const sync = fs.readFileSync('src/components/PetChatSync.tsx', 'utf-8')
  const chatPanel = fs.readFileSync('src/panels/ChatPanel.tsx', 'utf-8')

  it('maxToolCalls 与 ChatPanel 一致（不能再少给）', () => {
    // 只认配置行（行首缩进 + 冒号），否则会匹配到注释里提到的旧值
    const main = chatPanel.match(/^\s*maxToolCalls:\s*(\d+)/m)
    const pet = sync.match(/^\s*maxToolCalls:\s*(\d+)/m)
    expect(main).toBeTruthy()
    expect(pet).toBeTruthy()
    expect(Number(pet![1])).toBe(Number(main![1]))
  })

  it('用户在设置里禁用的工具，桌宠同样不能用', () => {
    expect(sync).toMatch(/disabledTools: getDisabledToolNames\(/)
  })

  it('人格跟主面板走，不硬编码 lumina', () => {
    expect(sync).toMatch(/personaId: state\.activePersona \|\| 'lumina'/)
  })
})
