/**
 * 桌宠聊天窗 · Phase H 视觉重塑 + 功能接线
 *
 * 对应需求（2026-10-18）：
 *   「为啥窗口外面有一层淡淡的黑框呢？去除掉；
 *     参考这张图片，风格重塑为这样并做出这些功能：
 *     ‹任务列表›（同步 Lumina 的任务工作区）、‹更多›里面是 Lumina 的这些功能、
 *     点击这个 + 选项可以有这些功能（排除参考图的云盘功能和共享屏幕这两个不要）」
 *
 * 这里只做**静态接线校验**：页面里该有的元素在不在、有没有真的绑上处理器、
 * 被明确排除的两项有没有混进来。运行期行为由 petChatUi / petChatSceneAndDelete
 * / petChatDuplicateAndTrace 覆盖。
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf-8')

const html = read('electron/pet/pet-chat.html')
const petSync = read('src/components/PetChatSync.tsx')
const petWindowSrc = read('electron/pet/petWindow.ts')
const preloadSrc = read('electron/preload.ts')

/** 取某个 id 元素在 HTML 里的开标签片段 */
function tagOf(id: string): string {
  const m = html.match(new RegExp(`<[a-z]+[^>]*id="${id}"[^>]*>`))
  return m ? m[0] : ''
}

/** 取某个 pop / 容器整块（从开标签到同级的收尾 `</div>`，用缩进判定） */
function blockOf(id: string): string {
  const at = html.indexOf(`id="${id}"`)
  if (at < 0) {return ''}
  const start = html.lastIndexOf('<', at)
  // 从 start 开始按 div 深度配平
  let depth = 0
  let i = start
  while (i < html.length) {
    const nextOpen = html.indexOf('<div', i)
    const nextClose = html.indexOf('</div>', i)
    if (nextClose < 0) {break}
    if (nextOpen >= 0 && nextOpen < nextClose) {
      depth++
      i = nextOpen + 4
    } else {
      depth--
      i = nextClose + 6
      if (depth === 0) {return html.slice(start, i)}
    }
  }
  return html.slice(start)
}

// ============================================================
// 零、页面脚本能解析
// ============================================================
describe('页面脚本完整性', () => {
  it('内联脚本语法合法（写错一个括号就是整页白屏）', () => {
    const m = html.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/)
    expect(m).toBeTruthy()
    // new Function 只做解析，不执行 —— 不碰 DOM、不碰 ipc
    expect(() => new Function(m![1])).not.toThrow()
  })

  it('pet-md.js 也在（Markdown 渲染器不能漏打包）', () => {
    expect(html).toMatch(/<script src="\.\/pet-md\.js"><\/script>/)
    expect(fs.existsSync(path.join(root, 'electron/pet/pet-md.js'))).toBe(true)
  })
})

// ============================================================
// 一、窗口外观：去掉「淡淡的黑框」
// ============================================================
describe('窗口外观 — 去掉窗口外的那层黑框', () => {
  const panelRule = (() => {
    const m = html.match(/#chat-panel\s*\{([\s\S]*?)\}/)
    return m ? m[1] : ''
  })()

  it('#chat-panel 贴满窗口（inset 0），不再留 10px 内缩', () => {
    // 旧实现是 inset:10px：面板比窗口小一圈，10px 的缝隙里露出的正是
    // 窗口自身的底色 —— 这就是用户看到的「一层淡淡的黑框」。
    expect(html).not.toMatch(/#chat-panel\s*\{[^}]*inset:\s*10px/)
    expect(panelRule).toMatch(/top:\s*0/)
    expect(panelRule).toMatch(/left:\s*0/)
    expect(panelRule).toMatch(/right:\s*0/)
    expect(panelRule).toMatch(/bottom:\s*0/)
  })

  it('面板自身不再带大半径投影（旧投影被窗口硬裁成暗边）', () => {
    // 旧：box-shadow: 0 12px 40px rgba(40,60,120,.30)
    //   40px 模糊半径远大于 10px 的窗口留白 → 被裁掉的部分变成四条暗带。
    expect(panelRule).toMatch(/box-shadow:\s*none/)
    expect(html).not.toMatch(/#chat-panel\s*\{[^}]*box-shadow:\s*0\s+12px\s+40px/)
  })

  it('html/body 透明（圆角外不露底色）', () => {
    const m = html.match(/html,\s*body\s*\{([\s\S]*?)\}/)
    expect(m).toBeTruthy()
    expect(m![1]).toMatch(/background:\s*transparent/)
  })
})

// ============================================================
// 二、顶栏
// ============================================================
describe('顶栏 — 左中右三段式', () => {
  const ids = ['tb-min', 'tb-pin', 'tb-side', 'tb-title', 'tb-speak', 'tb-main', 'tb-task', 'tb-work', 'chat-clear', 'chat-close']

  it('10 个控件都在', () => {
    for (const id of ids) {
      expect(html, `缺少 #${id}`).toContain(`id="${id}"`)
    }
  })

  it('每个控件都真的绑了处理器（没有只画不接的按钮）', () => {
    // tb-pin / tb-speak / tb-side 用变量名绑（pinBtn / speakBtn / sideBtn）
    expect(html).toMatch(/pinBtn\.addEventListener\('click'/)
    expect(html).toMatch(/speakBtn\.addEventListener\('click'/)
    expect(html).toMatch(/sideBtn\.addEventListener\('click'/)
    for (const id of ['tb-min', 'tb-main', 'tb-task', 'tb-work', 'tb-title', 'chat-clear', 'chat-close']) {
      const bound = new RegExp(`\\$id\\('${id}'\\)\\.addEventListener|getElementById\\('${id}'\\)\\.addEventListener`)
      expect(html, `#${id} 没有绑定 click`).toMatch(bound)
    }
  })

  it('顶栏可拖动，但每个按钮都是 no-drag（否则点不动）', () => {
    const bar = html.match(/#chat-panel\s*\.cp-topbar\s*\{([\s\S]*?)\}/)
    expect(bar).toBeTruthy()
    expect(bar![1]).toMatch(/-webkit-app-region:\s*drag/)
    // -webkit-app-region 会继承：顶栏 drag 时子元素默认也是 drag，按钮必须显式 no-drag
    const ico = html.match(/#chat-panel\s*\.cp-ico\s*\{([\s\S]*?)\}/)
    expect(ico).toBeTruthy()
    expect(ico![1]).toMatch(/-webkit-app-region:\s*no-drag/)
  })

  it('标题写的是 Lumina Virtual Pet（与参考稿一致）', () => {
    const t = tagOf('tb-title')
    expect(t).toBeTruthy()
    expect(html).toContain('Lumina Virtual Pet')
  })

  it('默认 420px 宽度下标题不会被顶栏按钮挤掉', () => {
    // 顶栏是「左 3 图标 + 标题 + 右 N 图标」的 flex 三段式。
    // 窗口默认 420px（PET_CHAT_WINDOW_W），标题一旦被挤到 150px 以下，
    // 「Lumina Virtual Pet」就会变成「Lumina Virtu…」，观感立刻变差。
    // 这里按 CSS 常量把固定开销算一遍，以后谁再加图标就会被这条挡住。
    const bar = html.match(/#chat-panel\s*\.cp-topbar\s*\{([\s\S]*?)\}/)![1]
    const icoW = Number((html.match(/#chat-panel\s*\.cp-ico\s*\{[^}]*?width:\s*(\d+)px/) || [])[1])
    const padX = Number((bar.match(/padding:\s*\d+px\s+(\d+)px/) || [])[1])
    const barGap = Number((bar.match(/gap:\s*(\d+)px/) || [])[1])
    const groupGap = Number((html.match(/#chat-panel\s*\.cp-tb-group\s*\{[^}]*?gap:\s*(\d+)px/) || [])[1])
    const head = blockOf('chat-head')
    const n = (head.match(/class="cp-ico/g) || []).length

    expect(icoW).toBeGreaterThan(0)
    expect(padX).toBeGreaterThanOrEqual(0)
    expect(barGap).toBeGreaterThanOrEqual(0)
    expect(groupGap).toBeGreaterThanOrEqual(0)
    expect(n).toBeGreaterThanOrEqual(9)

    // 固定开销 = 左右内边距 + 三段之间的 2 个 gap + n 个图标 + 组内 (n-2) 个 gap
    const fixed = padX * 2 + barGap * 2 + n * icoW + (n - 2) * groupGap
    const titleW = 420 - fixed
    expect(titleW, `顶栏固定开销 ${fixed}px，标题只剩 ${titleW}px`).toBeGreaterThanOrEqual(150)
  })

  it('窄窗（≤380px）有兜底：收起标题文字', () => {
    expect(html).toMatch(/@media\s*\(max-width:\s*380px\)/)
    const mq = html.match(/@media\s*\(max-width:\s*380px\)\s*\{([\s\S]*?)\n  \}/)
    expect(mq).toBeTruthy()
    expect(mq![1]).toMatch(/\.cp-name\s*\{\s*display:\s*none/)
  })
})

// ============================================================
// 三、输入区（composer）
// ============================================================
describe('输入区 — 输入框 + 底部操作条', () => {
  it('结构是「附件条 / 文本域 / 底部条」', () => {
    expect(html).toContain('id="composer"')
    expect(html).toContain('id="attach-bar"')
    expect(html).toMatch(/<textarea[^>]*id="pet-chat-input"/)
    expect(html).toContain('class="cp-composer-foot"')
  })

  it('底部条：+ ｜ 对话 更多 ｜ 🎤', () => {
    const foot = blockOf('composer')
    expect(foot).toContain('id="btn-plus"')
    expect(foot).toContain('id="btn-conv"')
    expect(foot).toContain('id="btn-more"')
    expect(foot).toContain('id="btn-mic"')
  })

  it('🎤 在有文字/附件时变成发送箭头', () => {
    expect(html).toMatch(/function syncMicMode\(\)/)
    const fn = html.match(/function syncMicMode\(\) \{([\s\S]*?)\n\}/)
    expect(fn).toBeTruthy()
    // 有内容 → 换成向上箭头并打 has-text 标记；空 → 换回麦克风
    expect(fn![1]).toMatch(/classList\.toggle\('has-text'/)
    expect(fn![1]).toMatch(/发送（Enter）/)
    expect(fn![1]).toMatch(/M12 19V5M6 11l6-6 6 6/)
  })

  it('回车发送 / Shift+回车换行', () => {
    expect(html).toMatch(/e\.key === 'Enter' && !e\.shiftKey/)
  })
})

// ============================================================
// 四、「+」菜单 —— 只保留上传与截图
// ============================================================
describe('「+」菜单 — 排除云盘与共享屏幕', () => {
  const pop = blockOf('pop-plus')

  it('有「上传文件或图片」和「截图提问」', () => {
    expect(pop).toContain('data-act="upload"')
    expect(pop).toContain('data-act="shot"')
    expect(pop).toContain('上传文件或图片')
    expect(pop).toContain('截图提问')
  })

  it('没有云盘入口（用户明确排除）', () => {
    expect(pop).not.toContain('云盘')
    expect(pop).not.toMatch(/data-act="(cloud|drive|pan)"/)
  })

  it('没有共享屏幕 / 投屏入口（用户明确排除）', () => {
    expect(pop).not.toMatch(/共享屏幕|投屏|屏幕共享/)
    expect(pop).not.toMatch(/data-act="(share-screen|screen-share|cast)"/)
  })

  it('两项都接到了真实动作', () => {
    expect(html).toMatch(/act === 'upload'[\s\S]{0,120}pickFiles\(\)/)
    expect(html).toMatch(/act === 'shot'[\s\S]{0,120}takeScreenshot\(\)/)
  })
})

// ============================================================
// 五、「更多」菜单 —— Lumina 本体功能
// ============================================================
describe('「更多」菜单 — 对齐 Lumina 本体功能', () => {
  const pop = blockOf('pop-more')
  const acts = ['enhance', 'lucky', 'thinking', 'emoji', 'file', 'voice', 'cu', 'capsule']

  it('8 项功能齐全', () => {
    for (const a of acts) {
      expect(pop, `缺少 data-act="${a}"`).toContain(`data-act="${a}"`)
    }
  })

  it('文案与本体一致（增强提示词 / Lucky Agent / 思考 / AI 操作电脑）', () => {
    expect(pop).toContain('增强提示词')
    expect(pop).toContain('Lucky Agent')
    expect(pop).toContain('思考')
    expect(pop).toContain('AI 操作电脑')
    expect(pop).toContain('实时语音对话')
  })

  it('思考 / 语音 / 操作电脑是开关型（带 cp-sw）', () => {
    for (const a of ['thinking', 'voice', 'cu']) {
      const re = new RegExp(`data-act="${a}"[\\s\\S]{0,300}?cp-sw`)
      expect(pop, `${a} 应有开关样式`).toMatch(re)
    }
  })

  it('每一项都接到了处理器', () => {
    for (const a of acts) {
      const re = new RegExp(`act === '${a}'`)
      expect(html, `${a} 没有分支`).toMatch(re)
    }
  })
})

// ============================================================
// 六、任务列表 —— 同步 Lumina 的任务工作区
// ============================================================
describe('任务列表 — 与 Lumina 任务工作区同源', () => {
  it('三节：对话产物 / 技能 / 最近文件', () => {
    const pop = blockOf('pop-task')
    expect(pop).toContain('data-sec="artifacts"')
    expect(pop).toContain('data-sec="skills"')
    expect(pop).toContain('data-sec="recent"')
    expect(pop).toContain('对话产物')
    expect(pop).toContain('技能')
    expect(pop).toContain('最近文件')
  })

  it('计数来自主窗推送，而不是页面自己编', () => {
    expect(html).toMatch(/ipc\.on\('pet:ui:tasklist'/)
    expect(html).toMatch(/cnt-artifacts/)
    expect(html).toMatch(/cnt-skills/)
    expect(html).toMatch(/cnt-recent/)
  })

  it('打开面板时向主窗要数据（tasklist-request）', () => {
    expect(html).toMatch(/pet:ui:tasklist-request/)
    expect(petWindowSrc).toMatch(/ipcMain\.on\('pet:ui:tasklist-request'/)
    expect(preloadSrc).toMatch(/onPetUiTaskListRequest/)
    expect(preloadSrc).toMatch(/petSendTaskList/)
  })

  it('主窗侧用 taskWorkspaceStore 的纯派生函数算这三节', () => {
    expect(petSync).toMatch(/deriveConversationArtifacts/)
    expect(petSync).toMatch(/deriveRecentFiles/)
    expect(petSync).toMatch(/deriveUsedSkills/)
    expect(petSync).toMatch(/petSendTaskList\?\.\(\{\s*artifacts,\s*skills,\s*recentFiles\s*\}\)/)
  })

  it('明细面板存在，点 › 能下钻', () => {
    expect(html).toContain('id="pop-task-detail"')
    expect(html).toMatch(/function openTaskDetail\(sec\)/)
  })
})

// ============================================================
// 七、侧边工作台（Ctrl+Shift+B）
// ============================================================
describe('侧边工作台 — 右侧抽屉', () => {
  it('工作台容器与 6 个入口都在', () => {
    expect(html).toContain('id="workbench"')
    for (const wb of ['search', 'folder', 'recent', 'newfile', 'capsule', 'life']) {
      expect(html, `缺少 data-wb="${wb}"`).toContain(`data-wb="${wb}"`)
    }
  })

  it('顶栏按钮 + Ctrl+Shift+B 都能开关，✕ 能关', () => {
    expect(html).toMatch(/function toggleWorkbench\(force\)/)
    expect(html).toMatch(/ctrlKey && e\.shiftKey[\s\S]{0,80}toggleWorkbench\(\)/)
    expect(html).toMatch(/wb-close'\)\.addEventListener\('click', function \(\) \{ toggleWorkbench\(false\)/)
  })

  it('工作台是从右侧滑出的抽屉，不是又一个弹窗', () => {
    const rule = html.match(/#chat-panel\s*\.cp-workbench\s*\{([\s\S]*?)\}/)
    expect(rule).toBeTruthy()
    // inset:0 铺满，靠 translateX(101%) 从右侧滑入/滑出
    expect(rule![1]).toMatch(/inset:\s*0/)
    expect(rule![1]).toMatch(/transform:\s*translateX\(1\d\d%\)/)
    expect(html).toMatch(/#chat-panel\s*\.cp-workbench\.show\s*\{[^}]*translateX\(0\)/)
  })

  it('打开文件夹 / 新建文件 走主进程真实对话框', () => {
    expect(html).toMatch(/ipc\.invoke\('pet:ui:pick-folder'\)/)
    expect(html).toMatch(/ipc\.invoke\('pet:ui:new-file'\)/)
    expect(petWindowSrc).toMatch(/ipcMain\.handle\('pet:ui:pick-folder'/)
    expect(petWindowSrc).toMatch(/ipcMain\.handle\('pet:ui:new-file'/)
  })
})

// ============================================================
// 八、附件链路：只走 attachments 字段，绝不拼进 text
// ============================================================
describe('附件 — 独立字段透传', () => {
  it('页面把附件放在 attachments 字段里发出去', () => {
    expect(html).toMatch(/pet:sync-send', \{ text: [^,]+, attachments: files/)
  })

  it('附件 chips 可渲染、可移除', () => {
    expect(html).toMatch(/function renderAttachments\(\)/)
    expect(html).toMatch(/function addAttachments\(list\)/)
    expect(html).toContain('class="cp-attach-bar"')
  })

  it('主进程原样转发，不合并进 text', () => {
    const m = petWindowSrc.match(/ipcMain\.on\('pet:sync-send'[\s\S]*?\n {2}\}\)/)
    expect(m).toBeTruthy()
    expect(m![0]).toMatch(/attachments: Array\.isArray\(data\.attachments\)/)
  })

  it('主窗把附件合并进 scene.files 再交给编排器', () => {
    expect(petSync).toMatch(/files\.length[\s\S]{0,140}files\s*\}\s*:\s*\(data\.scene \|\| null\)/)
  })

  it('附件最终写进 systemPrompt，不写进 text', () => {
    expect(petSync).toMatch(/### 📎 本轮附件/)
    expect(petSync).toMatch(/systemPrompt: buildScenePrompt\(scene\)/)
    // 反例：绝不允许出现 `text + ...` 之类的拼接
    expect(petSync).not.toMatch(/agentChat\(\{\s*text:\s*[^,]*\+/)
  })
})

// ============================================================
// 九、增强提示词 —— 走 llm:enhance-prompt
// ============================================================
describe('增强提示词', () => {
  it('页面发 pet:ui:action { kind: "enhance" }', () => {
    expect(html).toMatch(/ipc\.send\('pet:ui:action', \{ kind: 'enhance', text: draft \}\)/)
  })

  it('主窗用 llmEnhancePrompt 实现，而不是占用桌宠对话队列', () => {
    expect(petSync).toMatch(/case 'enhance':/)
    expect(petSync).toMatch(/luminaAPI\?\.llmEnhancePrompt/)
    expect(petSync).toMatch(/return reply\(true, enhanced\)/)
    // 明确不要走 agentChat（会往 conv-pet-live2d 里塞消息）
    const branch = petSync.slice(petSync.indexOf("case 'enhance':"), petSync.indexOf("case 'enhance':") + 1400)
    expect(branch).not.toMatch(/agentChat/)
  })

  it('结果回填输入框', () => {
    expect(html).toMatch(/data\.kind === 'enhance'[\s\S]{0,200}chatInput\.value = data\.message/)
  })
})

// ============================================================
// 十、自动播报
// ============================================================
describe('自动播报', () => {
  it('回复到达后触发播报（用户气泡不念）', () => {
    expect(html).toMatch(/\}\s*else\s*\{\s*traceFinish\(true\);\s*endWait\(\);[\s\S]{0,200}speakReply\(data && data\.text\)/)
  })

  it('默认关闭，开关状态持久化到配置', () => {
    expect(html).toMatch(/let _autoSpeak = false/)
    expect(html).toMatch(/pet:ui:set-auto-speak/)
    expect(petWindowSrc).toMatch(/chatAutoSpeak/)
  })

  it('播报前洗掉代码块/表格（否则念出来是灾难）', () => {
    const fn = html.match(/function speakReply\(text\) \{([\s\S]*?)\n\}/)
    expect(fn).toBeTruthy()
    expect(fn![1]).toMatch(/```/)
    expect(fn![1]).toMatch(/slice\(0, 500\)/)
    expect(fn![1]).toMatch(/edge-tts:speak/)
  })
})

// ============================================================
// 十一、置顶 / 最小化 / 在主窗打开
// ============================================================
describe('窗口控制', () => {
  it('置顶开关落到窗口 alwaysOnTop', () => {
    expect(petWindowSrc).toMatch(/ipcMain\.handle\('pet:ui:set-pinned'/)
    expect(petWindowSrc).toMatch(/alwaysOnTop: petCaps\.alwaysOnTop && config\.chatPinned !== false/)
  })

  it('最小化走主进程（无边框窗口没有系统按钮）', () => {
    expect(petWindowSrc).toMatch(/ipcMain\.on\('pet:chat-window-minimize'/)
    expect(html).toMatch(/ipc\.send\('pet:chat-window-minimize'\)/)
  })

  it('「在主窗口中打开」切到桌宠对话', () => {
    expect(preloadSrc).toMatch(/onPetUiOpenMain/)
    expect(petSync).toMatch(/switchConversation\(PET_CONV_ID\)/)
  })
})
