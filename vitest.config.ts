// vitest.config.ts — Lumina 测试配置
import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // agentRunner 依赖链重（工具/Skill/记忆系统注册），冷加载 5~8s；
    // 统一放宽测试/钩子超时，避免动态 import 它的用例偶发超时与连锁误报。
    testTimeout: 20000,
    hookTimeout: 20000,
    coverage: {
      provider: 'v8',
      // 只把「已建立实测的核心模块」纳入门禁，作为防回归门；
      // 历史单体（agentRunner、memoryStore 等）在抽出可测核心后逐个补测，再逐步纳入。
      include: [
        'electron/core/reactEngine.ts',
        'electron/memory/layeredMemory.ts',
        'electron/memory/layeredMemoryAdapter.ts',
        'electron/pet/lifeStateStore.ts',
        'electron/pet/emotionFusion.ts',
        'electron/pet/modelLibrary.ts',
        'electron/pet/avatarRenderer.ts',
        'electron/dream/dreamEngine.ts',
        'electron/realityShow/realityShowEngine.ts',
        'electron/securityGuard.ts',
        'electron/tokenEstimator.ts',
        // v0.1 打磨：新增的纯逻辑/跨平台/开箱/形态模块（均有对应单测）
        'electron/pet/platformCaps.ts',
        'electron/pet/life/alphaTrim.ts',
        'electron/pet/vrm/vrmLayout.ts',
        'electron/core/localProviderDiscovery.ts',
        'electron/whisper/sttModelConfig.ts',
      ],
      // 覆盖率门禁：CI 中 `vitest run --coverage` 低于阈值即失败
      thresholds: {
        lines: 70,
        functions: 70,
        statements: 70,
        branches: 55,
        perFile: false,
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
})
