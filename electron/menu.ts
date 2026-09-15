// ============================================================
// Lumina Life 1.0 — 中文应用菜单
// ============================================================

import { Menu, BrowserWindow, app, shell, dialog } from 'electron'

export function createAppMenu(mainWindow: BrowserWindow) {
  const isMac = process.platform === 'darwin'

  const template: Electron.MenuItemConstructorOptions[] = [
    // ============================================
    // 文件 (File)
    // ============================================
    {
      label: '文件',
      submenu: [
        {
          label: '新建会话',
          accelerator: 'CmdOrCtrl+N',
          click: () => mainWindow.webContents.send('menu:new-session'),
        },
        {
          label: '打开配置文件夹',
          accelerator: 'CmdOrCtrl+O',
          click: () => shell.openPath(app.getPath('userData')),
        },
        { type: 'separator' },
        {
          label: '保存当前会话',
          accelerator: 'CmdOrCtrl+S',
          click: () => mainWindow.webContents.send('menu:save-session'),
        },
        {
          label: '导出对话记录...',
          accelerator: 'CmdOrCtrl+Shift+E',
          click: async () => {
            const result = await dialog.showSaveDialog(mainWindow, {
              title: '导出对话记录',
              defaultPath: `lumina-chat-${new Date().toISOString().slice(0, 10)}.json`,
              filters: [
                { name: 'JSON 文件', extensions: ['json'] },
                { name: '文本文件', extensions: ['txt'] },
                { name: '所有文件', extensions: ['*'] },
              ],
            })
            if (!result.canceled && result.filePath) {
              mainWindow.webContents.send('menu:export-chat', result.filePath)
            }
          },
        },
        {
          label: '导入配置...',
          click: async () => {
            const result = await dialog.showOpenDialog(mainWindow, {
              title: '导入配置文件',
              filters: [
                { name: 'JSON 文件', extensions: ['json'] },
                { name: '所有文件', extensions: ['*'] },
              ],
              properties: ['openFile'],
            })
            if (!result.canceled && result.filePaths.length > 0) {
              mainWindow.webContents.send('menu:import-config', result.filePaths[0])
            }
          },
        },
        { type: 'separator' },
        {
          label: '清空所有数据',
          click: async () => {
            const { response } = await dialog.showMessageBox(mainWindow, {
              type: 'warning',
              title: '确认清空',
              message: '确定要清空所有对话记录和记忆数据吗？',
              detail: '此操作不可撤销。建议先导出备份。',
              buttons: ['取消', '先导出再清空', '直接清空'],
              defaultId: 0,
              cancelId: 0,
            })
            if (response === 1) {
              mainWindow.webContents.send('menu:export-then-clear')
            } else if (response === 2) {
              mainWindow.webContents.send('menu:clear-all-data')
            }
          },
        },
        { type: 'separator' },
        {
          label: '退出',
          accelerator: isMac ? 'Cmd+Q' : 'Alt+F4',
          click: () => {
            app.quit()
          },
        },
      ],
    },

    // ============================================
    // 编辑 (Edit)
    // ============================================
    {
      label: '编辑',
      submenu: [
        {
          label: '撤销',
          accelerator: 'CmdOrCtrl+Z',
          role: 'undo',
        },
        {
          label: '重做',
          accelerator: isMac ? 'Shift+Cmd+Z' : 'Ctrl+Y',
          role: 'redo',
        },
        { type: 'separator' },
        {
          label: '剪切',
          accelerator: 'CmdOrCtrl+X',
          role: 'cut',
        },
        {
          label: '复制',
          accelerator: 'CmdOrCtrl+C',
          role: 'copy',
        },
        {
          label: '粘贴',
          accelerator: 'CmdOrCtrl+V',
          role: 'paste',
        },
        {
          label: '全选',
          accelerator: 'CmdOrCtrl+A',
          role: 'selectAll',
        },
        { type: 'separator' },
        {
          label: '查找...',
          accelerator: 'CmdOrCtrl+F',
          click: () => mainWindow.webContents.send('menu:find'),
        },
        {
          label: '替换...',
          accelerator: 'CmdOrCtrl+H',
          click: () => mainWindow.webContents.send('menu:replace'),
        },
      ],
    },

    // ============================================
    // 视图 (View)
    // ============================================
    {
      label: '视图',
      submenu: [
        {
          label: '显示桌宠',
          accelerator: 'CmdOrCtrl+Shift+P',
          click: () => mainWindow.webContents.send('menu:toggle-pet'),
        },
        { type: 'separator' },
        {
          label: '切换到聊天面板',
          accelerator: 'CmdOrCtrl+1',
          click: () => mainWindow.webContents.send('menu:switch-panel', 'chat'),
        },
        {
          label: '切换到设置面板',
          accelerator: 'CmdOrCtrl+2',
          click: () => mainWindow.webContents.send('menu:switch-panel', 'settings'),
        },
        {
          label: '切换到 Agent 面板',
          accelerator: 'CmdOrCtrl+3',
          click: () => mainWindow.webContents.send('menu:switch-panel', 'agent'),
        },
        {
          label: '切换到安全面板',
          accelerator: 'CmdOrCtrl+4',
          click: () => mainWindow.webContents.send('menu:switch-panel', 'security'),
        },
        {
          label: '切换到技能面板',
          accelerator: 'CmdOrCtrl+5',
          click: () => mainWindow.webContents.send('menu:switch-panel', 'skills'),
        },
        { type: 'separator' },
        {
          label: '重新加载',
          accelerator: 'CmdOrCtrl+R',
          role: 'reload',
        },
        {
          label: '强制重新加载',
          accelerator: 'CmdOrCtrl+Shift+R',
          role: 'forceReload',
        },
        {
          label: '开发者工具',
          accelerator: isMac ? 'Alt+Cmd+I' : 'Ctrl+Shift+I',
          role: 'toggleDevTools',
        },
        { type: 'separator' },
        {
          label: '放大',
          accelerator: 'CmdOrCtrl+=',
          role: 'zoomIn',
        },
        {
          label: '缩小',
          accelerator: 'CmdOrCtrl+-',
          role: 'zoomOut',
        },
        {
          label: '重置缩放',
          accelerator: 'CmdOrCtrl+0',
          role: 'resetZoom',
        },
        { type: 'separator' },
        {
          label: '全屏',
          accelerator: 'F11',
          role: 'togglefullscreen',
        },
      ],
    },

    // ============================================
    // 窗口 (Window)
    // ============================================
    {
      label: '窗口',
      submenu: [
        {
          label: '最小化',
          accelerator: 'CmdOrCtrl+M',
          role: 'minimize',
        },
        {
          label: '最大化',
          accelerator: 'CmdOrCtrl+Shift+M',
          click: () => {
            if (mainWindow.isMaximized()) {
              mainWindow.unmaximize()
            } else {
              mainWindow.maximize()
            }
          },
        },
        {
          label: '还原默认大小',
          click: () => {
            mainWindow.setSize(1280, 820)
            mainWindow.center()
          },
        },
        { type: 'separator' },
        {
          label: '窗口置顶',
          type: 'checkbox',
          checked: false,
          accelerator: 'CmdOrCtrl+T',
          click: (menuItem) => {
            mainWindow.setAlwaysOnTop(menuItem.checked)
          },
        },
        {
          label: '隐藏到托盘',
          click: () => mainWindow.hide(),
        },
        { type: 'separator' },
        {
          label: '关闭窗口',
          accelerator: 'CmdOrCtrl+W',
          click: () => mainWindow.hide(),
        },
      ],
    },

    // ============================================
    // 帮助 (Help)
    // ============================================
    {
      label: '帮助',
      submenu: [
        {
          label: '关于 Lumina Life',
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: '关于 Lumina Life 1.0',
              message: 'Lumina Life 1.0（正式版）',
              detail: [
                '版本: 1.0.0',
                'Electron: 35.7.5',
                'React: 19.x',
                'TypeScript: 5.x',
                '',
                '一个可爱的 AI 桌面伙伴，基于 Electron + LLM 技术栈。',
                '支持多 Agent 团队协作、技能扩展、情绪识别与定时任务。',
                '',
                '© 2026 Lumina Life Team',
              ].join('\n'),
            })
          },
        },
        {
          label: '使用文档',
          click: () => shell.openExternal('https://github.com/lumina-life/docs'),
        },
        {
          label: '检查更新',
          click: () => mainWindow.webContents.send('menu:check-update'),
        },
        { type: 'separator' },
        {
          label: '反馈与建议',
          click: () => shell.openExternal('https://github.com/lumina-life/issues'),
        },
        {
          label: '调试信息',
          click: () => {
            const info = {
              electron: process.versions.electron,
              chrome: process.versions.chrome,
              node: process.versions.node,
              platform: process.platform,
              arch: process.arch,
              version: app.getVersion(),
              userData: app.getPath('userData'),
            }
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: '调试信息',
              message: '系统信息',
              detail: JSON.stringify(info, null, 2),
            })
          },
        },
        { type: 'separator' },
        {
          label: '开发者选项',
          submenu: [
            {
              label: '打开日志文件夹',
              click: () => shell.openPath(app.getPath('logs')),
            },
            {
              label: '清空缓存',
              click: async () => {
                const { response } = await dialog.showMessageBox(mainWindow, {
                  type: 'warning',
                  title: '清空缓存',
                  message: '确定要清空所有缓存数据吗？',
                  detail: '这将清除本地缓存，应用可能需要重新加载。',
                  buttons: ['取消', '确定'],
                })
                if (response === 1) {
                  mainWindow.webContents.session.clearCache()
                  mainWindow.webContents.send('menu:cache-cleared')
                }
              },
            },
            {
              label: '重置所有设置',
              click: async () => {
                const { response } = await dialog.showMessageBox(mainWindow, {
                  type: 'warning',
                  title: '重置设置',
                  message: '确定要重置所有设置到默认值吗？',
                  detail: '配置文件和记忆数据将被清除，此操作不可撤销。',
                  buttons: ['取消', '确定重置'],
                })
                if (response === 1) {
                  mainWindow.webContents.send('menu:reset-settings')
                }
              },
            },
          ],
        },
      ],
    },
  ]

  // macOS 特殊处理：添加应用名菜单
  if (isMac) {
    template.unshift({
      label: app.getName(),
      submenu: [
        { role: 'about', label: '关于 Lumina Life' },
        { type: 'separator' },
        { role: 'services', label: '服务' },
        { type: 'separator' },
        { role: 'hide', label: '隐藏' },
        { role: 'hideOthers', label: '隐藏其他' },
        { role: 'unhide', label: '全部显示' },
        { type: 'separator' },
        { role: 'quit', label: '退出' },
      ],
    })
  }

  const menu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(menu)
}
