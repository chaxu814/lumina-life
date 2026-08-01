import React, { useEffect, useRef } from 'react'
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
import TeamPanel from './panels/TeamPanel'  // 🆕 v1.0: AI 小团队面板
import PluginPanelContainer from './components/PluginPanelContainer'  // 🆕 v8.1: 插件面板
import Toast from './components/Toast'
import { showToast } from './components/Toast'
import ProactiveToast from './components/ProactiveToast'  // 🆕 v3.8.1
import OnboardingWizard from './components/OnboardingWizard'  // 🆕 v1.0: 首次运行引导
import ModeTransition from './components/ModeTransition'  // 🆕 v2.0: 场景模式过渡动画
import { useStore, type PanelType } from './stores/appStore'
import { generateReport } from './services/reportGenerator'

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
  team: TeamPanel, // 🆕 v1.0: AI 小团队面板
  plugins: PluginPanelContainer, // 🆕 v8.1: 插件面板
  more: MoreSettingsPanel, // ⚙️ v1.0: 更多设置（整合入口）
}

export default function App() {
  const activePanel = useStore((s) => s.activePanel)
  const setActivePanel = useStore((s) => s.setActivePanel)
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
      if (typeof cleanup === 'function') cleanup()
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
    return () => cleanups.forEach((fn) => fn?.())
  }, [])

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

  // 启动时同步 cron 任务到主进程
  const cronTasksForSync = useStore((s) => s.cronTasks)
  useEffect(() => {
    if (!window.luminaAPI?.cronSyncAll) return
    const entries = cronTasksForSync.filter(t => t.enabled).map(t => ({
      name: t.name,
      schedule: t.schedule,
      action: t.action,
      enabled: t.enabled,
    }))
    window.luminaAPI.cronSyncAll(entries).then(r => {
      if (r.ok) console.log(`[Cron] 已同步 ${r.count} 个任务到主进程`)
    }).catch((e: any) => console.warn('[Cron] 同步失败:', e.message))
  }, []) // 只在启动时执行一次

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
    if (!api?.onXpGained) return
    const unsub = api.onXpGained((data: any) => {
      const mult = data.multiplier || 1
      let msg = `✨ +${data.amount} XP`
      if (mult > 1) msg += ` ×${mult.toFixed(1)} 心情加成 🎉`
      else if (mult < 1) msg += ` 😔 心情低落 ×${mult.toFixed(1)}`
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
        <SettingsModal open onClose={() => setActivePanel('chat')} />
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
