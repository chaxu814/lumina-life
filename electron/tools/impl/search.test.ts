import { webSearch } from './search'

async function main() {
  const engines = ['bing', 'baidu'] as const
  for (const engine of engines) {
    const res = await webSearch({ query: '2026年高考作文题', engine, count: 3 })
    console.log(`\n===== ${engine} =====`)
    console.log(res.ok ? res.content : `ERROR: ${res.error}`)
  }
}

main().catch((e) => {
  console.error('测试脚本异常:', e)
  process.exit(1)
})
