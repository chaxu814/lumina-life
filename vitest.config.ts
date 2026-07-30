// vitest.config.ts — Lumina 测试配置
import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
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
