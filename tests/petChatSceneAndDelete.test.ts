// tests/petChatSceneAndDelete.test.ts
//
// 2026-10-18（第九轮）两个用户可见故障的守护测试：
//
// ①「在这里 Lumina AI 做啥都不会」
//    根因：桌宠点卡片只发选项文本，把窗口标题（scene）丢了。卡片选项全是指代
//    （"让我帮你整理**这部剧**的资料吧"），模型不知道"这部剧"是哪部，只能反问。
//    叠加旧配置 mode:'chat'（11 个工具、没有写文件/执行命令）+ noAutoSearch:true
//    → 用户感知就是"点了没用，它什么都不会"。
//    修法：scene 从 Live2D 卡片一路带到 systemPrompt + 换成 agent 档。
//    ⚠️ scene **不能**拼进 text：agentRunner.sendMessage 的去重条件是「history
//       末条 user 与本次 text 逐字相同」，拼前缀会让去重失效 → 用户的话说两遍。
//
// ②「点垃圾桶删了对话，没有选择删除，也没有一键全删」
//    根因：旧 handler 只调 clearChat()（清 DOM），store 里的会话一条没动。
//    修法：菜单三口径 → 纯函数 planPetConvDelete 算删除计划 → 主窗执行。
//    关键约束：桌宠会话是桌宠聊天窗的数据宿主，永不真删，只清消息。
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import { planPetConvDelete } from '../src/lib/petConversationDelete'

const PET = 'conv-pet-live2d'
const petChat = fs.readFileSync('electron/pet/pet-chat.html', 'utf-8')
const petSync = fs.readFileSync('src/components/PetChatSync.tsx', 'utf-8')
const petWin = fs.readFileSync('electron/pet/petWindow.ts', 'utf-8')
const preload = fs.readFileSync('electron/preload.ts', 'utf-8')
const live2d = fs.readFileSync('electron/pet/pet-live2d.html', 'utf-8')

// ============================================================
// 一、planPetConvDelete —— 三种删除口径
// ============================================================
describe('planPetConvDelete — 删除口径', () => {
  const convs = [
    { id: PET, messages: [{}, {}, {}] },
    { id: 'conv-a', messages: [{}] },
    { id: 'conv-b', messages: [{}, {}] },
  ]

  it("scope='current' → 只清桌宠会话，一条都不删", () => {
    const plan = planPetConvDelete(convs, 'current', undefined, PET)
    expect(plan.deleteIds).toEqual([])
    expect(plan.clearIds).toEqual([PET])
  })

  it("scope='select' → 只删勾选的非桌宠会话", () => {
    const plan = planPetConvDelete(convs, 'select', ['conv-a'], PET)
    expect(plan.deleteIds).toEqual(['conv-a'])
    expect(plan.clearIds).toEqual([])
  })

  it("scope='select' 勾了多个 → 全部删掉", () => {
    const plan = planPetConvDelete(convs, 'select', ['conv-a', 'conv-b'], PET)
    expect(plan.deleteIds).toEqual(['conv-a', 'conv-b'])
  })

  it("scope='select' 勾到桌宠会话 → 改成清空，绝不进 deleteIds", () => {
    const plan = planPetConvDelete(convs, 'select', [PET, 'conv-a'], PET)
    expect(plan.deleteIds).toEqual(['conv-a'])
    expect(plan.clearIds).toEqual([PET])
    expect(plan.deleteIds).not.toContain(PET)
  })

  it("scope='select' 对重复 / 不存在的 id 去重并过滤（清单可能比 store 旧一拍）", () => {
    const plan = planPetConvDelete(convs, 'select', ['conv-a', 'conv-a', 'conv-ghost', '', null as any], PET)
    expect(plan.deleteIds).toEqual(['conv-a'])
  })

  it("scope='select' 空选择 → 什么都不做", () => {
    expect(planPetConvDelete(convs, 'select', [], PET)).toEqual({ deleteIds: [], clearIds: [] })
    expect(planPetConvDelete(convs, 'select', undefined, PET)).toEqual({ deleteIds: [], clearIds: [] })
  })

  it("scope='all' → 删掉其余全部，桌宠会话只清空（结果恰好剩一个空会话）", () => {
    const plan = planPetConvDelete(convs, 'all', undefined, PET)
    expect(plan.deleteIds).toEqual(['conv-a', 'conv-b'])
    expect(plan.clearIds).toEqual([PET])
    // 关键不变量：桌宠会话永不被真删 —— 否则 store 会补兜底会话，
    // 用户看到"点了全删怎么还剩一条"
    expect(plan.deleteIds).not.toContain(PET)
  })

  it("scope='all' 只有桌宠会话一个 → 只清空，不删任何会话", () => {
    const plan = planPetConvDelete([{ id: PET, messages: [{}] }], 'all', undefined, PET)
    expect(plan.deleteIds).toEqual([])
    expect(plan.clearIds).toEqual([PET])
  })

  it('任何 scope 下桌宠会话都不会出现在 deleteIds 里', () => {
    const scopes = ['current', 'select', 'all'] as const
    const picks: Array<string[] | undefined> = [undefined, [], [PET], ['conv-a'], [PET, 'conv-a', 'conv-b']]
    for (const scope of scopes) {
      for (const ids of picks) {
        const plan = planPetConvDelete(convs, scope, ids, PET)
        expect(plan.deleteIds).not.toContain(PET)
        // deleteIds 与 clearIds 不能重叠（否则先删后清，clear 落空）
        expect(plan.clearIds.filter((id) => plan.deleteIds.includes(id))).toEqual([])
      }
    }
  })
})

// ============================================================
// 二、删除计划在 PetChatSync 里被真正执行
// ============================================================
describe('PetChatSync — 删除执行链路', () => {
  it('走纯函数算计划，而不是手写 if 分支', () => {
    expect(petSync).toMatch(/import \{ planPetConvDelete \} from '\.\.\/lib\/petConversationDelete'/)
    expect(petSync).toMatch(/const plan = planPetConvDelete\(/)
  })

  it('先 ensurePetConv 再算计划（否则 all 会把宿主壳也删掉）', () => {
    const start = petSync.indexOf('const unsubConvDelete')
    const end = petSync.indexOf('// ── 主聊天 → 桌宠', start)
    const fn = petSync.slice(start, end)
    const ensureIdx = fn.indexOf('ensurePetConv()')
    const planIdx = fn.indexOf('planPetConvDelete(')
    expect(ensureIdx).toBeGreaterThan(-1)
    expect(planIdx).toBeGreaterThan(ensureIdx)
  })

  it('先删会话再清消息，最后补回桌宠会话', () => {
    const start = petSync.indexOf('const unsubConvDelete')
    const end = petSync.indexOf('// ── 主聊天 → 桌宠', start)
    const fn = petSync.slice(start, end)
    const delIdx = fn.indexOf('plan.deleteIds')
    const clearIdx = fn.indexOf('plan.clearIds')
    expect(delIdx).toBeGreaterThan(-1)
    expect(clearIdx).toBeGreaterThan(delIdx)
  })

  it('删完必须通知桌宠窗刷新（petNotifyConvChanged）', () => {
    const start = petSync.indexOf('const unsubConvDelete')
    const end = petSync.indexOf('// ── 主聊天 → 桌宠', start)
    expect(petSync.slice(start, end)).toMatch(/api\.petNotifyConvChanged\?\.\(\)/)
  })

  it('会话清单带 isPet 标记与消息数，供选择面板渲染', () => {
    const start = petSync.indexOf('const unsubConvListReq')
    const end = petSync.indexOf('const clearConvMessages', start)
    const fn = petSync.slice(start, end)
    expect(fn).toMatch(/count: \(c\.messages \|\| \[\]\)\.length/)
    expect(fn).toMatch(/isPet: c\.id === PET_CONV_ID/)
    expect(fn).toMatch(/api\.petSendConvList\?\.\(/)
  })
})

// ============================================================
// 三、IPC 三跳接线：桌宠窗 → 主进程 → 主窗口（反向亦然）
// ============================================================
describe('删除 IPC 三跳接线', () => {
  it('preload 暴露 4 个 send + 4 个 listen', () => {
    for (const name of ['petRequestConvList', 'petSendConvList', 'petDeleteConvs', 'petNotifyConvChanged']) {
      expect(preload).toMatch(new RegExp(`${name}:`))
    }
    for (const name of ['onPetConvListRequest', 'onPetConvList', 'onPetConvDelete', 'onPetConvChanged']) {
      expect(preload).toMatch(new RegExp(`${name}:`))
    }
    expect(preload).toMatch(/ipcRenderer\.send\('pet:conv-delete'/)
    expect(preload).toMatch(/ipcRenderer\.send\('pet:conv-list-request'/)
  })

  it('主进程把桌宠窗的请求转给主窗口', () => {
    expect(petWin).toMatch(/ipcMain\.on\('pet:conv-list-request'/)
    expect(petWin).toMatch(/ipcMain\.on\('pet:conv-delete'/)
    expect(petWin).toMatch(/target\.webContents\.send\('pet:conv-delete', payload\)/)
  })

  it('主进程把主窗口的结果转回桌宠聊天窗（用 sendWhenReady 防丢）', () => {
    expect(petWin).toMatch(/sendWhenReady\(petChatWindow, 'pet:conv-list', list\)/)
    expect(petWin).toMatch(/sendWhenReady\(petChatWindow, 'pet:conv-changed', null\)/)
  })
})

// ============================================================
// 四、pet-chat.html —— 菜单 / 选择面板 / 确认框
// ============================================================
describe('pet-chat.html — 垃圾桶三种口径', () => {
  it('垃圾桶不再直接 clearChat()，而是弹菜单', () => {
    const start = petChat.indexOf("document.getElementById('chat-clear').addEventListener")
    const end = petChat.indexOf('delMenu.addEventListener', start)
    const fn = petChat.slice(start, end)
    expect(fn).toMatch(/delMenu\.classList\.toggle\('show'\)/)
    expect(fn).not.toMatch(/clearChat\(\)/)
  })

  it('菜单三项对应 current / select / all', () => {
    expect(petChat).toMatch(/data-act="current"/)
    expect(petChat).toMatch(/data-act="select"/)
    expect(petChat).toMatch(/data-act="all"/)
    expect(petChat).toMatch(/doDelete\(\{ scope: 'current' \}\)/)
    expect(petChat).toMatch(/doDelete\(\{ scope: 'all' \}\)/)
    expect(petChat).toMatch(/doDelete\(\{ scope: 'select', ids: ids \}\)/)
  })

  it('current 与 all 都要先过确认框（防误删）', () => {
    const start = petChat.indexOf("delMenu.addEventListener")
    const end = petChat.indexOf("document.getElementById('cp-picker-close')", start)
    const fn = petChat.slice(start, end)
    expect(fn.match(/askConfirm\(/g)?.length).toBe(2)
  })

  it('选择面板：打开时先发清单请求，收到清单才渲染', () => {
    const start = petChat.indexOf('function openPicker')
    const end = petChat.indexOf("document.getElementById('chat-clear')", start)
    const fn = petChat.slice(start, end)
    expect(fn).toMatch(/pickerMask\.classList\.add\('show'\)/)
    expect(fn).toMatch(/ipc\.send\('pet:conv-list-request'\)/)
    // 迟到的清单不能弹窗：只在面板开着时渲染
    expect(petChat).toMatch(/ipc\.on\('pet:conv-list', \(_e, list\) => \{[\s\S]{0,200}?if \(pickerMask\.classList\.contains\('show'\)\) renderPicker\(list\)/)
  })

  it('全选联动 + 未选时禁用删除按钮', () => {
    const start = petChat.indexOf('function syncPickerState')
    const end = petChat.indexOf('function renderPicker', start)
    const fn = petChat.slice(start, end)
    expect(fn).toMatch(/pickerOkBtn\.disabled = picked === 0/)
    expect(fn).toMatch(/pickerAllBox\.checked = boxes\.length > 0 && picked === boxes\.length/)
    expect(petChat).toMatch(/pickerAllBox\.addEventListener\('change'/)
  })

  it('删完收到 pet:conv-changed → 清屏 + 重置去重 + 重新拉历史', () => {
    const start = petChat.indexOf("ipc.on('pet:conv-changed'")
    expect(start).toBeGreaterThan(-1)
    const fn = petChat.slice(start, start + 500)
    expect(fn).toMatch(/chatLog\.innerHTML = ''/)
    expect(fn).toMatch(/resetMsgDedupe\(\)/)
    expect(fn).toMatch(/ipc\.send\('pet:sync-history-request'\)/)
  })

  it('无 IPC（浏览器预览）时退化为本地清屏，不假装删掉了', () => {
    const start = petChat.indexOf('function doDelete')
    const end = petChat.indexOf('function pickerBoxes', start)
    const fn = petChat.slice(start, end)
    expect(fn).toMatch(/if \(!HAS_IPC\) \{[\s\S]*clearChat\(\)[\s\S]*return/)
  })
})

// ============================================================
// 五、scene 屏幕上下文：Live2D → 主 Agent
// ============================================================
describe('scene 屏幕上下文传递', () => {
  it('showProactiveCard 把卡片自带的 scene 存起来', () => {
    const start = live2d.indexOf('function showProactiveCard')
    const end = live2d.indexOf('function addChatOptions', start)
    // 实际写法带空值兜底：_pcScene = (cmd && cmd.scene) ? cmd.scene : null
    expect(live2d.slice(start, end)).toMatch(/_pcScene = \(cmd && cmd\.scene\) \? cmd\.scene : null/)
  })

  it('replyProactive 把 scene 一起发出去，发完即清', () => {
    const start = live2d.indexOf('function replyProactive')
    const end = live2d.indexOf('function positionProactiveCard', start)
    const fn = live2d.slice(start, end)
    expect(fn).toMatch(/const scene = _pcScene/)
    expect(fn).toMatch(/_pcScene = null/)
    expect(fn).toMatch(/pet:sync-send', \{ text, scene \}/)
  })

  it('主进程把 scene 原样转进 pet:sync-message', () => {
    const start = petWin.indexOf("ipcMain.on('pet:sync-send'")
    const fn = petWin.slice(start, start + 1200)
    expect(fn).toMatch(/scene: data\.scene \|\| null/)
  })

  it('PetChatSync 把 scene 交给编排器', () => {
    // 2026-10-18：附件不再单独透传，而是先合并进 scene.files 再交给编排器
    //   （`const scene = files.length ? { ...(data.scene||{}), files } : ...`）
    expect(petSync).toMatch(/orchestrator\.handlePetMessage\(data\.text, scene\)/)
    expect(petSync).toMatch(/files\.length[\s\S]{0,120}files\s*\}\s*:\s*\(data\.scene \|\| null\)/)
  })

  it('编排器把 scene 透传给每一轮 agentChat（含续轮）', () => {
    const orch = fs.readFileSync('src/lib/petChatOrchestrator.ts', 'utf-8')
    expect(orch).toMatch(/this\.deps\.agentChat\(text, history, scene\)/)
    expect(orch).toMatch(/this\.deps\.agentChat\(continuationText, history2, scene\)/)
    // 队列元素带 scene
    expect(orch).toMatch(/this\.queue\.push\(\{ text: t, scene: scene \|\| null \}\)/)
  })
})

// ============================================================
// 六、buildScenePrompt —— 走 systemPrompt，绝不拼进 text
// ============================================================
function loadBuildScenePrompt(): (scene?: { scene?: string; title?: string; process?: string } | null) => string | undefined {
  // 源文件是 CRLF，先归一化再按行尾 `}` 切函数体
  const norm = petSync.replace(/\r\n/g, '\n')
  const start = norm.indexOf('function buildScenePrompt')
  expect(start).toBeGreaterThan(-1)
  const end = norm.indexOf('\n}\n', start)
  expect(end).toBeGreaterThan(start)
  const raw = norm.slice(start, end + 3)
  // 去掉 TS 类型标注（new Function 只吃 JS）
  const src = raw
    .replace(/function buildScenePrompt\([^)]*\)[^{]*\{/, 'function buildScenePrompt(scene) {')
    // 局部变量上的类型标注，例如 `const lines: string[] = [`
    .replace(/const (\w+): [^=]+? = /g, 'const $1 = ')
  // eslint-disable-next-line no-new-func
  return new Function(`${src}\nreturn buildScenePrompt`)() as any
}

describe('buildScenePrompt — 屏幕上下文注入', () => {
  const build = loadBuildScenePrompt()

  it('没有 scene / 空字段 → undefined（不产生空指令块）', () => {
    expect(build(null)).toBeUndefined()
    expect(build(undefined)).toBeUndefined()
    expect(build({})).toBeUndefined()
    expect(build({ title: '   ', process: '  ' })).toBeUndefined()
  })

  it('有窗口标题 → 明确告诉模型"这个/这部剧/这段代码"指的就是它', () => {
    const out = build({ title: '哔哩哔哩 - 三体 第 3 集', process: 'chrome.exe' }) as string
    expect(out).toContain('### 🖥️ 屏幕上下文')
    expect(out).toContain('哔哩哔哩 - 三体 第 3 集')
    expect(out).toContain('chrome.exe')
    expect(out).toContain('这部剧')
    expect(out).toContain('这段代码')
  })

  it('只有进程名也能用（标题抓不到时的兜底）', () => {
    const out = build({ process: 'Code.exe' }) as string
    expect(out).toContain('Code.exe')
    expect(out).toContain('### 🖥️ 屏幕上下文')
  })

  it('明确要求"别反问"和"别把上下文说出来"', () => {
    const out = build({ title: 'X', process: 'Y' }) as string
    expect(out).toMatch(/不要反过来问用户/)
    expect(out).toMatch(/不要把这段上下文本身说出来/)
  })

  it('❗scene 必须走 config.systemPrompt，不能拼进 text', () => {
    // 这是 agentRunner.sendMessage 的去重前提：history 末条 user 必须与本次
    // text 逐字相同。拼前缀 → 去重失效 → 用户的话被模型看到两遍。
    expect(petSync).toMatch(/systemPrompt: buildScenePrompt\(scene\)/)
    const start = petSync.indexOf('const result: any = await api.agentChat(')
    const fn = petSync.slice(start, start + 400)
    expect(fn).toMatch(/text,/)
    // text 变量本身不能被赋值/拼接
    expect(petSync).not.toMatch(/text:\s*`[^`]*\$\{buildScenePrompt/)
    expect(petSync).not.toMatch(/text:\s*buildScenePrompt/)
  })

  it('桌宠跑 agent 档（完整工具链），不再是只有 11 个工具、不能落盘的 chat 档', () => {
    expect(petSync).toMatch(/mode: 'agent' as const/)
    expect(petSync).not.toMatch(/mode: 'chat' as const/)
    // 工具预算与主面板对齐（2026-10-18 从 8 提到 20，见 PetChatSync 注释）
    const pet = petSync.match(/^\s*maxToolCalls:\s*(\d+)/m)
    expect(pet).toBeTruthy()
    expect(Number(pet![1])).toBeGreaterThanOrEqual(20)
    expect(petSync).toMatch(/noAutoSearch: false/)
  })
})
