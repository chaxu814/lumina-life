// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// sample-code.ts — Lumina 产物渲染器自检示例代码
// 含 import / 函数 / 类 / 注释 / 字符串 / 数字 / async / await
// ============================================================

import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

/** 版本号 */
export const VERSION = '1.0.0'

/** 配置项接口 */
export interface ArtifactConfig {
  /** 文件名 */
  filename: string
  /** 最大行数 */
  maxLines?: number
  /** 是否高亮语法 */
  highlight: boolean
}

/** 简单工具函数：求和 */
function sum(a: number, b: number): number {
  return a + b
}

/** 主任务类 */
class TaskRunner {
  private name: string
  private retries = 3

  constructor(name: string) {
    this.name = name
  }

  /** 异步运行任务 */
  async run(inputPath: string): Promise<string> {
    const start = Date.now()
    console.log('开始任务:', this.name)

    for (let i = 0; i < this.retries; i++) {
      try {
        const raw = await readFile(inputPath, 'utf-8')
        const trimmed = raw.trim()
        console.log('读取字节数:', trimmed.length)
        return trimmed
      } catch (err) {
        // 失败时重试
        console.error('第', i + 1, '次失败:', (err as Error).message)
        await new Promise((r) => setTimeout(r, 100))
      }
    }
    throw new Error('任务失败: ' + this.name)
  }

  /** 写入结果 */
  async save(outDir: string, content: string): Promise<string> {
    const target = path.join(outDir, 'result.txt')
    await writeFile(target, content, 'utf-8')
    return target
  }
}

/** 入口 */
export async function main(args: string[]): Promise<void> {
  const runner = new TaskRunner('demo')
  const content = await runner.run(args[0] || 'input.txt')
  const out = await runner.save('./out', content)
  const total = sum(1, 2)
  console.log('完成，输出:', out, 'total=', total)
}

// 模块自执行
if (require.main === module) {
  main(process.argv.slice(2)).catch((e) => {
    console.error('致命错误:', e.message)
    process.exit(1)
  })
}
