// vitest.config.ts — Lumina 测试配置
import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // ⚠️ v3.34 修复：此前 include 只写 'tests/**'，导致 electron/__tests__/ 下的
    // 7 个测试文件**永远不会被 npm test 执行**（186 个 test 文件只跑 179 个）。
    // 其中 electron/__tests__/memoryStore.test.ts 是本项目唯一一份真正的
    // MemoryStore 集成测试 —— 也就是 63KB 的核心记忆存储模块一直是裸奔的。
    // 现在把两个目录都纳入。
    include: [
      'tests/**/*.test.ts',
      'electron/**/__tests__/**/*.test.ts',
    ],
    // 断环后 agentRunner 的冷加载已回到预算内（实测全量套件 14s）。
    // 阈值仍留出余量：agentRunner 依赖工具/Skill/记忆三套注册，冷加载在
    // 慢机器或覆盖率插桩下仍会明显变慢。
    testTimeout: 30000,
    hookTimeout: 30000,
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
