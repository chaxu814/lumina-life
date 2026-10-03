import React, { useEffect, useRef, useState } from 'react'
import TopBar from './components/TopBar'
import Sidebar from './components/Sidebar'
import ChatPanel from './panels/ChatPanel'
import MailPanel from './panels/MailPanel'
import SettingsModal from './components/SettingsModal'
import ProfilePanel from './panels/ProfilePanel'
import BookmarksPanel from './panels/BookmarksPanel'
import KnowledgePanel from './panels/KnowledgePanel'  // 🧠 v3.9
import SkillMarketPanel from './panels/SkillMarketPanel'  // 📦 v3.10
import DeepResearchPanel from './panels/DeepResearchPanel'
import DreamPanel from './panels/DreamPanel'  // 🌙 v3.0: 梦境系统
import RealityShowPanel from './panels/RealityShowPanel'  // 🎬 v3.0: Agent 真人秀
import SkillDevPanel from './panels/SkillDevPanel'  // 📦 v3.0: 技能 SDK
import SocialPanel from './panels/SocialPanel'  // 🌐 v3.0: 跨用户社交
import FamilyTreePanel from './panels/FamilyTreePanel'  // 🌳 v3.0: Agent 家谱
import MoreSettingsPanel from './panels/MoreSettingsPanel'  // ⚙️ v1.0: 更多设置
import MoreSettingsModal from './components/MoreSettingsModal'  // ⚙️ v1.0: 更多设置弹窗
import TeamCommunityModal from './components/TeamCommunityModal'  // 👥 v1.0: 团队社区弹窗
import PersonalModal from './components/PersonalModal'  // 👤 v1.0: 个性化弹窗
import NewsPanel from './panels/NewsPanel'  // 🆕 v1.1: 新闻早报
import SandboxPanel from './panels/SandboxPanel'  // 🔍 I5: 沙箱透明玻璃房
import TasksPanel from './panels/TasksPanel'  // 🗓️ 任务工作区（托盘菜单入口）
import { initThemeClient } from './services/themeClient'  // 🎨 主题皮肤生态

import PluginPanelContainer from './components/PluginPanelContainer'  // 🆕 v8.1: 插件面板
import Toast from './components/Toast'
import { showToast } from './components/Toast'
import ProactiveToast from './components/ProactiveToast'  // 🆕 v3.8.1
import LoopToast from './components/LoopToast'  // 🔁 Phase 4: Loop 完成通知
import OnboardingWizard from './components/OnboardingWizard'  // 🆕 v1.0: 首次运行引导
import ModeTransition from './components/ModeTransition'  // 🆕 v2.0: 场景模式过渡动画
import PetChatSync from './components/PetChatSync'  // 🐾 桌宠聊天同步
import { useStore, type PanelType } from './stores/appStore'
import { useTaskWorkspace } from './stores/taskWorkspaceStore'
import { generateReport } from './services/reportGenerator'

// ═══════ 桌宠聊天框内"朋友圈/剧场/日报"数据组装（取自主界面同一 store / localStorage，实时互通）═══════
type PetLifeItem = { icon?: string; title: string; body?: string; meta?: string }
function fmtLifeTime(ts?: number): string {
  if (!ts) {return ''}
  const diff = Date.now() - ts
  if (diff < 60000) {return '刚刚'}
  if (diff < 3600000) {return Math.floor(diff / 60000) + ' 分钟前'}
  if (diff < 86400000) {return Math.floor(diff / 3600000) + ' 小时前'}
  const d = new Date(ts); return `${d.getMonth() + 1}/${d.getDate()}`
}
function buildMomentsItems(): PetLifeItem[] {
  let posts: any[] = []
  try { posts = JSON.parse(localStorage.getItem('lumina_moments') || '[]') } catch { posts = [] }
  const iconMap: Record<string, string> = { lumina: '🐱', recha: '🍵', yak: '📊', user: '👤' }
  return posts.slice().sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0)).slice(0, 20).map((p: any) => ({
    icon: iconMap[p.author] || '✨', title: p.authorName || p.author || 'Agent',
    meta: fmtLifeTime(p.timestamp) + (p.likes ? ` · ♥${p.likes}` : ''), body: p.content || '',
  }))
}
function buildTheaterItems(): PetLifeItem[] {
  const st = useStore.getState() as any
  const items: PetLifeItem[] = []
  const convs = [...(st.conversations || [])].sort((a: any, b: any) => (a.createdAt || 0) - (b.createdAt || 0))
  if (convs[0]) {items.push({ icon: '🌟', title: '一切的开始', meta: fmtLifeTime(convs[0].createdAt), body: `第一次对话"${convs[0].name || '未命名'}"，三个 Agent 从这里开始了解你。` })}
  const total = (st.conversations || []).reduce((n: number, c: any) => n + (c.messages?.length || 0), 0)
  if (total >= 5) {items.push({ icon: '💬', title: `已交流 ${total} 条消息`, meta: '里程碑', body: '每一条消息都在让 Lumina 更懂你。' })}
  const lessons = st.structuredMemory?.memory?.lessons
  if (Array.isArray(lessons)) {lessons.slice(0, 6).forEach((l: string) => items.push({ icon: '💡', title: '学到的经验', meta: '发现', body: String(l).slice(0, 180) }))}
  return items.slice(0, 14)
}
async function buildDailyItems(): Promise<PetLifeItem[]> {
  let reports: any[] = []
  try { reports = JSON.parse(localStorage.getItem('lumina_daily_report') || '[]') } catch { reports = [] }
  try {
    const r = await window.luminaAPI?.reportList?.({ type: 'daily', limit: 15 })
    if (r?.reports?.length) {
      const have = new Set(reports.map((x: any) => x.date))
      r.reports.forEach((rp: any) => {
        const d = rp.date || rp.period
        if (d && !have.has(d)) {reports.push({ date: d, content: rp.summary || rp.content || '', generated: true })}
      })
    }
  } catch { /* localStorage 兜底即可 */ }
  return reports.slice().sort((a, b) => String(b.date || '').localeCompare(String(a.date || ''))).slice(0, 15).map((r: any) => ({
    icon: '📰', title: `${r.date || ''} 日报`, meta: r.generated === false ? '草稿' : '已生成', body: r.content || r.summary || '',
  }))
}
async function buildPetLifeData(target: string): Promise<PetLifeItem[]> {
  try {
    if (target === 'moments') {return buildMomentsItems()}
    if (target === 'theater') {return buildTheaterItems()}
    if (target === 'daily') {return await buildDailyItems()}
  } catch (e) { console.warn('[pet-life] 组装失败', e) }
  return []
}

const panelMap: Record<string, React.FC> = {
  chat: ChatPanel,
  mail: MailPanel,
  profile: ProfilePanel,
  bookmarks: BookmarksPanel,
  knowledge: KnowledgePanel,     // 🧠 v3.9
  skillmarket: SkillMarketPanel, // 📦 v3.10
  deepresearch: DeepResearchPanel, // 🔬 v3.11
  dream: DreamPanel, // 🌙 v3.0: 梦境系统
  reality: RealityShowPanel, // 🎬 v3.0: Agent 真人秀
  skilldev: SkillDevPanel, // 📦 v3.0: 技能 SDK
  social: SocialPanel, // 🌐 v3.0: 跨用户社交
  familytree: FamilyTreePanel, // 🌳 v3.0: Agent 家谱
  news: NewsPanel, // 🆕 v1.1: 新闻早报
  sandbox: SandboxPanel, // 🔍 I5: 沙箱透明玻璃房（7×8 规则实时审计）

  plugins: PluginPanelContainer, // 🆕 v8.1: 插件面板
  more: MoreSettingsPanel, // ⚙️ v1.0: 更多设置（整合入口）
  tasks: TasksPanel, // 🗓️ 任务工作区（托盘菜单「任务工作区」入口）
}

export default function App() {
  const activePanel = useStore((s) => s.activePanel)
  const setActivePanel = useStore((s) => s.setActivePanel)
  const [settingsTab, setSettingsTab] = useState<string>('llm')
  const activeConversationId = useStore((s) => s.activeConversationId)
  const clearMessages = useStore((s) => s.clearCurrentMessages)
  const addMessage = useStore((s) => s.addMessage)
  const messages = useStore((s) => {
    const conv = s.conversations.find((c) => c.id === s.activeConversationId)
    return conv?.messages || []
  })
  const cronTasks = useStore((s) => s.cronTasks)
  const addAuditLog = useStore((s) => s.addAuditLog)

  // ⏰ 定时任务 — v2.5: 已迁移至主进程 cron 引擎 (electron/tools/impl/cron.ts)
  // 主进程通过 'cron:triggered' IPC 推送触发事件
  useEffect(() => {
    const cleanup = window.luminaAPI?.onMenuEvent('cron:triggered', async (data: {
      id: number; name: string; action: string; schedule: string; time: string
    }) => {
      const store = useStore.getState()

      // 📊 日报/周报/月报自动生成 (v1.1: 加日报)
      if (data.name.includes('日报') || data.name.includes('周报') || data.name.includes('月报') || data.name.includes('report')) {
        const period = data.name.includes('月报') ? 'monthly' : (data.name.includes('日报') ? 'daily' : 'weekly')
        try {
          const report = await generateReport(period, store.llmConfig, data.time)
          store.addMessage(store.activeConversationId, 'assistant',
            `${report.title}\n\n${report.details}\n\n> ⏰ 自动生成 · ${data.time}`)
          // 📌 v1.2: 同时存入 SQLite，刷新后不丢
          try {
            await window.luminaAPI.reportSave({
              type: period,
              title: report.title,
              summary: report.summary,
              content: report.details,
              period: data.time,
            })
          } catch (dbErr) {
            console.warn('[Report] SQLite 存储失败:', dbErr)
          }
        } catch (e: any) {
          store.addMessage(store.activeConversationId, 'assistant',
            `📊 **${data.name}**\n\n> 报告生成失败：${e.message}\n\n触发时间：${data.time}`)
        }
      } else {
        // 普通定时任务：显示静态消息
        store.addMessage(store.activeConversationId, 'assistant',
          `⏰ **${data.name}**\n\n${data.action}\n\n> 触发时间：${data.time} | 调度：${data.schedule}`)
      }

      store.addAuditLog({
        time: data.time,
        action: `⏰ 定时触发 — ${data.name} (${data.schedule})`,
        type: 'system',
      })
    })
    return () => {
      if (typeof cleanup === 'function') {cleanup()}
    }
  }, [])

  // 菜单事件监听
  useEffect(() => {
    const cleanups: (() => void)[] = []
    cleanups.push(window.luminaAPI?.onMenuEvent('menu:switch-panel', (panel: string) => {
      setActivePanel(panel as PanelType)
    }))
    cleanups.push(window.luminaAPI?.onMenuEvent('menu:new-session', () => {
      useStore.getState().createConversation()
    }))
    cleanups.push(window.luminaAPI?.onMenuEvent('menu:do-export', async (filePath: string) => {
      try {
        const json = JSON.stringify(messages, null, 2)
        // 记忆系统保存导出记录
        try { await window.luminaAPI.memorySave('export', JSON.stringify({ path: filePath, date: new Date().toISOString() })) } catch {}
        addMessage(activeConversationId, 'system', `✅ 对话已导出至: ${filePath}`)
      } catch {
        addMessage(activeConversationId, 'system', '❌ 导出失败')
      }
    }))
    cleanups.push(window.luminaAPI?.onMenuEvent('menu:clear-all-data', async () => {
      await window.luminaAPI.clearAllData()
      localStorage.removeItem('lumina-life-storage')
      window.location.reload()
    }))
    cleanups.push(window.luminaAPI?.onMenuEvent('menu:export-then-clear', async () => {
      const result = await window.luminaAPI.dialogSave({
        title: '导出后清空', defaultPath: `lumina-backup-${new Date().toISOString().slice(0, 10)}.json`,
        filters: [{ name: 'JSON', extensions: ['json'] }],
      })
      if (!result.canceled && result.filePath) {
        const json = JSON.stringify(messages, null, 2)
        try { await window.luminaAPI.memorySave('export', JSON.stringify({ path: result.filePath, date: new Date().toISOString() })) } catch {}
        await window.luminaAPI.clearAllData()
        localStorage.removeItem('lumina-life-storage')
        window.location.reload()
      }
    }))
    cleanups.push(window.luminaAPI?.onMenuEvent('menu:reset-settings', async () => {
      await window.luminaAPI.resetSettings()
      localStorage.removeItem('lumina-life-storage')
      window.location.reload()
    }))
    // 右键菜单 → Lumina 任务（翻译/总结/解释/审查代码）
    cleanups.push(window.luminaAPI?.onMenuEvent('menu:lumina-task', (data: { task: string; text: string }) => {
      const taskPrefix: Record<string, string> = {
        translate: '🌐 请翻译以下内容成中文：\n\n',
        summarize: '📝 请总结以下内容：\n\n',
        explain: '💡 请解释以下内容：\n\n',
        review_code: '🔍 热茶，请审查以下代码：\n\n',
      }
      const prefix = taskPrefix[data.task] || '💬 '
      // 先切换到聊天面板
      setActivePanel('chat')
      // 再发送消息
      setTimeout(() => {
        const store = useStore.getState()
        store.addMessage(store.activeConversationId, 'user', `${prefix}${data.text}`)
      }, 100)
    }))
    // Alt+Shift+L → 截图分析
    cleanups.push(window.luminaAPI?.onMenuEvent('menu:capture-and-analyze', () => {
      setActivePanel('chat')
      setTimeout(() => {
        const store = useStore.getState()
        store.addMessage(store.activeConversationId, 'user', '📸 请分析我当前屏幕的内容，告诉我你在屏幕上看到了什么')
      }, 100)
    }))
    // 桌宠开关
    cleanups.push(window.luminaAPI?.onMenuEvent('menu:toggle-pet', async () => {
      try {
        const on = await window.luminaAPI?.petStatus()
        const next = !on
        await window.luminaAPI?.petToggle(next)
        addMessage(activeConversationId, 'system', next ? '🐱 桌宠已开启' : '💤 桌宠已关闭')
      } catch (e) {
        addMessage(activeConversationId, 'system', '❌ 桌宠切换失败：' + ((e as Error)?.message || String(e)))
      }
    }))
    // 桌宠跳转：设置页指定 tab
    cleanups.push(window.luminaAPI?.onMenuEvent('settings:goto', (tab: string) => {
      setSettingsTab(tab)
      setActivePanel('settings')
    }))
    // 🗓️ 托盘浮层 → 任务工作区
    //
    // 注意：任务工作区是 ChatPanel 右侧的抽屉面板（TaskWorkspacePanel），
    // 不是左侧导航里的「定时任务」面板（TasksPanel / cron）。两者同名但完全不同的东西，
    // 之前误跳到 'tasks' 导致用户点了托盘却看到定时任务列表。
    // 抽屉只挂在 ChatPanel 下，所以必须先切回 chat 再展开。
    cleanups.push(window.luminaAPI?.onMenuEvent('tray:open-task-workspace', () => {
      setActivePanel('chat')
      useTaskWorkspace.getState().setPanelOpen(true)
    }))
    // ⚙️ 托盘浮层 → 打开设置
    cleanups.push(window.luminaAPI?.onMenuEvent('tray:open-settings', () => {
      setActivePanel('settings')
    }))
    // 桌宠跳转：指定对话
    cleanups.push(window.luminaAPI?.onMenuEvent('pet:goto-conversation', (convId: string) => {
      setActivePanel('chat')
      const store = useStore.getState()
      const conv = store.conversations.find((c: any) => c.id === convId)
      if (conv) {store.switchConversation(convId)}
    }))
    // 🌸 桌宠"生活"入口：唤起主窗口的 朋友圈 / 剧场 / 日报（均在团队群聊对应 tab）
    cleanups.push(window.luminaAPI?.onMenuEvent('life:open', (data: { target: 'moments' | 'theater' | 'daily' | 'news' }) => {
      if (data?.target === 'news') { setActivePanel('news'); return }
      setActivePanel('chat')
      const store = useStore.getState()
      const team = store.conversations.find((c: any) => c.id === '__team_group_chat__')
      if (team) {store.switchConversation(team.id)}
      const tab = data?.target === 'theater' ? 'theater' : data?.target === 'daily' ? 'daily' : 'moments'
      setTimeout(() => window.dispatchEvent(new CustomEvent('lumina:team-tab', { detail: { tab } })), 160)
    }))
    // 🌸 桌宠聊天框内生活视图请求：从主界面同一数据源取数后回传
    cleanups.push(window.luminaAPI?.onMenuEvent('life:data-request', async (data: { reqId: string; target: string }) => {
      const items = await buildPetLifeData(data?.target || 'moments')
      window.luminaAPI?.lifeProvideData({ reqId: data.reqId, items })
    }))
    return () => cleanups.forEach((fn) => fn?.())
  }, [])

  // 🎨 主题皮肤生态：拉取并注入持久化主题
  useEffect(() => { initThemeClient() }, [])

  // 主题切换 — 应用 data-theme 到 <html>
  const theme = useStore((s) => s.theme)
  useEffect(() => {
    const applyTheme = () => {
      let resolved: string
      if (theme === 'system') {
        resolved = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
      } else {
        resolved = theme
      }
      document.documentElement.setAttribute('data-theme', resolved)
    }
    applyTheme()
    // 跟随系统变化
    if (theme === 'system') {
      const mq = window.matchMedia('(prefers-color-scheme: dark)')
      const handler = () => applyTheme()
      mq.addEventListener('change', handler)
      return () => mq.removeEventListener('change', handler)
    }
  }, [theme])

  // ♿ 无障碍：高对比度 + 字号缩放（创新提案 7）
  const a11y = useStore((s) => s.a11y)
  useEffect(() => {
    const root = document.documentElement
    root.setAttribute('data-a11y-hc', a11y.highContrast ? 'on' : 'off')
    root.style.setProperty('--font-scale', String(a11y.fontScale))
    // Electron/Chromium 下用 zoom 让 inline px 也跟随缩放（桌宠气泡/托盘菜单读同一变量）
    root.style.zoom = String(a11y.fontScale)
  }, [a11y.highContrast, a11y.fontScale])

  // 启动时同步 cron 任务到主进程
  const cronTasksForSync = useStore((s) => s.cronTasks)
  useEffect(() => {
    if (!window.luminaAPI?.cronSyncAll) {return}
    const entries = cronTasksForSync.filter(t => t.enabled).map(t => ({
      name: t.name,
      schedule: t.schedule,
      action: t.action,
      enabled: t.enabled,
    }))
    window.luminaAPI.cronSyncAll(entries).then(r => {
      if (r.ok) {console.log(`[Cron] 已同步 ${r.count} 个任务到主进程`)}
    }).catch((e: any) => console.warn('[Cron] 同步失败:', e.message))
  },
  // 🔧 修复：原来依赖数组是 []，只在启动时同步一次。
  // 而 cronSyncAll 在主进程是**全量替换**语义（replaceAllCronEntries），
  // 于是 TasksPanel 里的「⏸ 暂停 / 删除 / 新建」只写了 localStorage，
  // 主进程调度器里的任务**仍然武装着照常触发** —— 新建的任务要重启才生效。
  // 这比丢数据更糟：用户以为暂停了，它照跑。
  // 依赖 cronTasks：任何增删改都重新同步一次。
  [cronTasksForSync])

  // 启动时从后端 ProviderManager 同步已保存的供应商配置 + 检测连通性
  const syncProviderFromBackend = useStore((s) => s.syncProviderFromBackend)
  useEffect(() => {
    syncProviderFromBackend()
  }, [])

  // 初始化场景模式监听
  const initializeModeListeners = useStore((s) => s.initializeModeListeners)
  useEffect(() => {
    const cleanup = initializeModeListeners()
    return cleanup
  }, [])

  // 🆕 全局 XP 获得提示（任何面板都可见）
  useEffect(() => {
    const api = (window as any).luminaAPI
    if (!api?.onXpGained) {return}
    const unsub = api.onXpGained((data: any) => {
      const mult = data.multiplier || 1
      let msg = `✨ +${data.amount} XP`
      if (mult > 1) {msg += ` ×${mult.toFixed(1)} 心情加成 🎉`}
      else if (mult < 1) {msg += ` 😔 心情低落 ×${mult.toFixed(1)}`}
      showToast(msg, 'info')
    })
    return unsub
  }, [])

  const Panel = panelMap[activePanel] || ChatPanel

  return (
    <div className="app-layout">
      {/* 🆕 v1.0: 首次运行引导 — 只在 firstRun=true 时渲染 */}
      <OnboardingWizard />
      <TopBar />
      <ModeTransition>
        <div className="app-body">
          <Sidebar />
          <main className="main-content">
            <Toast />
            <ProactiveToast />
            <LoopToast />
            <PetChatSync />
            {/* 保持 ChatPanel 始终挂载，确保 TTS 和 Agent 事件正常 */}
            <div style={{ display: activePanel === 'chat' ? 'flex' : 'none', flex: 1, flexDirection: 'column', overflow: 'hidden' }}>
              <ChatPanel />
            </div>
            {activePanel !== 'chat' && activePanel !== 'settings' && activePanel !== 'teamcommunity' && activePanel !== 'more' && activePanel !== 'profile' && <Panel />}
          </main>
        </div>
      </ModeTransition>
      {/* 设置弹窗 — 覆盖在所有内容之上 */}
      {activePanel === 'settings' && (
        <SettingsModal open onClose={() => setActivePanel('chat')} initialTab={settingsTab} />
      )}
      {/* Lumina团队社区弹窗 — 覆盖在所有内容之上 */}
      {activePanel === 'teamcommunity' && (
        <TeamCommunityModal open onClose={() => setActivePanel('chat')} />
      )}
      {/* 更多设置弹窗 — 覆盖在所有内容之上 */}
      {activePanel === 'more' && (
        <MoreSettingsModal open onClose={() => setActivePanel('chat')} />
      )}
      {/* 个性化弹窗 — 覆盖在所有内容之上 */}
      {activePanel === 'profile' && (
        <PersonalModal open onClose={() => setActivePanel('chat')} />
      )}
    </div>
  )
}
