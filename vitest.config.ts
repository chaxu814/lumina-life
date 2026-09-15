// vitest.config.ts — Lumina 测试配置
import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // agentRunner 依赖链重（工具/Skill/记忆系统注册），冷加载约 5~8s，全量并发更慢；
    // 默认 5s 超时会让动态 import 它的套件偶发超时并连锁误报，统一放宽（不改任何断言）。
    testTimeout: 20000,
    hookTimeout: 20000,
    coverage: {
      provider: 'v8',
      include: ['electron/agentRunner.ts', 'electron/memory/**/*.ts', 'electron/securityGuard.ts', 'electron/tokenEstimator.ts'],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
})
