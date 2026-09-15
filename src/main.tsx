import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles/global.css'
import './styles/app.css'
import './i18n'  // 🌐 i18n 初始化
import 'uno.css' // ⚡ UnoCSS
import './stores/loopStore' // 🔁 Loop 引擎自启动（Phase 1）

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
