// ═══════════════════════════════════════════════════════
// Lumina Pet Plugin 示例插件
// @name        示例插件
// @description 演示插件 API：定时打招呼、点击模型时反应
// ═══════════════════════════════════════════════════════

// Lumina 对象由插件系统注入，包含以下 API：
//   Lumina.say(text)              — 在模型头顶显示气泡
//   Lumina.execIntent(intent)     — 执行动作/表情
//   Lumina.addChatMsg(role, text) — 添加聊天消息 ('pet'|'user')
//   Lumina.getState()             — 获取模型状态
//   Lumina.getPrefs()             — 获取偏好设置
//   Lumina.on(event, callback)    — 注册事件钩子
//   Lumina.sendCommand(cmd)       — 发送主进程命令
//   Lumina.log(...args)           — 控制台日志

// 事件：'click' 点击模型, 'dblclick' 双击, 'idle' 闲置, 'boot' 启动完成

Lumina.on('boot', () => {
  Lumina.say('插件已加载喵~')
  Lumina.log('示例插件已启动！')
})

Lumina.on('click', () => {
  const reactions = [
    { action: 'wave', speech: '嗨！' },
    { action: 'happy', speech: '好开心！' },
    { action: 'nod', speech: '嗯嗯！' },
  ]
  const r = reactions[Math.floor(Math.random() * reactions.length)]
  Lumina.execIntent(r)
})

// 每 30 秒有 10% 概率主动打招呼
setInterval(() => {
  if (Math.random() < 0.1) {
    const greetings = ['主人在吗~', '记得喝水哦！', '休息一下眼睛吧~', '今天也要加油喵！']
    Lumina.say(greetings[Math.floor(Math.random() * greetings.length)])
  }
}, 30000)
