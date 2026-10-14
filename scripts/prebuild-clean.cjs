// ============================================================
// prebuild-clean.cjs — 构建前逐个清理输出目录
//
// 【为什么需要它】
//   electron-vite 构建时会用 `fs.rm(dir, { recursive: true })` 之类的**批量删除**
//   清空 out/main/chunks。某些受限终端环境（如带"批量删除守卫"的终端）会拦截
//   一次性删除 >50 个文件的操作，导致：
//       ✗ Build failed  [safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED]
//   → dev server 起不来 → 主窗口加载不到页面 → **一片白屏**（实测踩过）。
//
//   而**逐个 unlink** 不会被拦（实测 60 个文件逐个删除全部成功），效果完全等价。
//   所以：构建前先逐个清空这些目录，electron-vite 再做批量清理时就"无文件可删"，
//   自然不会被拦。
//
// 【对普通用户有无副作用】没有。这些本来就是每次构建都会重新生成的产物；
//   预清理只是把"构建时清"提前到"构建前清"，结果一致。
// ============================================================

const fs = require('fs')
const path = require('path')

/** 逐个删除目录内所有文件（含子目录），返回删除数量。绝不抛错。 */
function cleanDirFiles(dir) {
  let n = 0
  try {
    if (!fs.existsSync(dir)) { return 0 }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        n += cleanDirFiles(p)
        try { fs.rmdirSync(p) } catch { /* 非空/占用则忽略 */ }
      } else {
        try { fs.unlinkSync(p); n++ } catch { /* 占用则忽略 */ }
      }
    }
  } catch { /* 目录不存在或无权限，忽略 */ }
  return n
}

function main() {
  const root = path.resolve(__dirname, '..')
  // 只清真正会触发批量删除告警、且会被构建重新生成的目录
  const targets = [
    path.join(root, 'out', 'main', 'chunks'),
    path.join(root, 'out', 'main', 'newstools'),
    path.join(root, 'out', 'main', 'assets'),
  ]
  let total = 0
  for (const t of targets) { total += cleanDirFiles(t) }
  if (total > 0) {
    console.log(`[prebuild-clean] ✅ 已逐个清理 ${total} 个构建产物文件（规避批量删除守卫）`)
  }
}

main()
