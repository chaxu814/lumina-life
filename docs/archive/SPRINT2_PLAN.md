# Sprint 2 实现计划

## 功能清单
1. 🌙 **梦境系统** — 每天自动生成梦境日记，展示在独立面板
2. 📱 **多渠道推送** — ServerChan + 钉钉 Webhook，重要事件推送
3. 💻 **桌宠模式** — Lumina 跳出窗口到桌面

## 实现顺序
先搭后端基础设施，再做前端 UI：

### 第1步: 梦境系统
- `electron/dream/dreamEngine.ts` — 梦境生成引擎（模板+随机）
- `electron/dream/index.ts` — 导出
- `electron/main.ts` — 注册 IPC + 启动调度
- `src/panels/DreamPanel.tsx` — 梦境界面
- `src/App.tsx` — 注册面板
- `src/stores/appStore.ts` — 添加 PanelType + dream store
- `src/components/Sidebar.tsx` — 添加侧边栏入口

### 第2步: 多渠道推送
- `electron/push/pushService.ts` — ServerChan + DingTalk 推送
- `src/panels/SettingsPanel.tsx` — 添加推送配置区

### 第3步: 桌宠模式
- `electron/pet/petWindow.ts` — 透明副窗口
- `electron/main.ts` — 创建/关闭管理
- `src/panels/SettingsPanel.tsx` — 添加开关
- `src/components/PetAvatar.tsx` — 桌宠前端组件

## 需要你配合的
- 多渠道推送：需要注册 ServerChan (https://sct.ftqq.com) 拿 Key
- 桌宠模式：需要你确认桌面透明窗口效果
