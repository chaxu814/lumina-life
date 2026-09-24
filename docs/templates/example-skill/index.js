// daily-quote/index.js — 每日一言（CJS 沙箱入口）
//
// 运行在 Lumina 的技能沙箱里：可用的 API 只有：
//   lumina.console.log/warn/error
//   lumina.fetch(url)        （需在 skill.json 声明 permissions: ["network"]）
//   lumina.readFile(rel)      （需声明 permissions: ["fs.read"]）
//   lumina.writeFile(rel, s)  （需声明 permissions: ["fs.write"]）
// 不提供 require / process / child_process。
//
// 导出形态：module.exports = { tools: [{ name, description, handler }] }

const QUOTES = [
  '慢慢来，比较快。',
  '今天只做一件最重要的事。',
  '休息不是偷懒，是给系统留整理的时间。',
  '完成比完美更重要。',
  '别和别人比节奏，你有自己的时区。',
]

module.exports = {
  tools: [
    {
      name: 'daily_quote',
      description: '根据今天日期返回一句格言；可选传入 mood 调整语气',
      handler: function dailyQuote(args) {
        const day = new Date()
        const idx = (day.getFullYear() * 372 + day.getMonth() * 31 + day.getDate()) % QUOTES.length
        let text = QUOTES[idx]
        if (args && args.mood === 'tired') {
          text = '今天累了就早点收工，明天还在。'
        } else if (args && args.mood === 'focus') {
          text = '把通知关掉，先做 25 分钟。'
        }
        lumina.console.log('daily_quote served:', text)
        return { date: day.toISOString().slice(0, 10), quote: text }
      },
    },
  ],
}
