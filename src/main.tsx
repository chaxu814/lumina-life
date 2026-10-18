import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles/global.css'
import './styles/app.css'
import './styles/thinking.css'      // 🧠 思考过程步骤列表（单聊/群聊共用）
import './styles/task-workspace.css'  // task workspace panel
import './styles/subagent-cards.css'  // 子智能体（实习生）进度卡片
import './styles/decision-card.css'  // 🧭 决策卡片（agent 征询「走哪条路」）
import './styles/theater-feed.css'  // 🎭 团队可见性剧场（创新功能 2）
import './styles/theme-vars.css'       // 🎨 主题皮肤生态：语义化 CSS 变量
import './styles/a11y-high-contrast.css' // ♿ 高对比度主题 + 字号缩放（创新提案 7）
import './styles/composer.css'          // ⌨️ 统一输入栏（Agent / 团队群聊 / 桌宠同款观感）
import './i18n'  // 🌐 i18n 初始化
import 'uno.css' // ⚡ UnoCSS
import './stores/loopStore' // 🔁 Loop 引擎自启动（Phase 1）
import { initTaskWorkspaceBridge } from './services/taskWorkspaceBridge' // 🆕 v02: 后台任务事件→任务工作区

initTaskWorkspaceBridge()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
