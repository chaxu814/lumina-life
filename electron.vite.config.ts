import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import UnoCSS from 'unocss/vite'
import { resolve } from 'path'
import { copyFileSync, cpSync, mkdirSync, existsSync } from 'fs'

// 把 Live2D 桌宠的 pet-live2d.html 与 assets/（模型、渲染库）拷贝进构建产物 out/main。
// 否则 petWindow 的 copyPetAssets 在运行时找不到源文件，桌宠会退回旧 CSS 猫。
function copyPetAssets() {
  const srcDir = resolve(__dirname, 'electron/pet')
  const destDir = resolve(__dirname, 'out/main')  // 运行时 __dirname 即 out/main
  return {
    name: 'copy-pet-assets',
    closeBundle() {
      try {
        if (!existsSync(destDir)) {mkdirSync(destDir, { recursive: true })}
        copyFileSync(resolve(srcDir, 'pet-live2d.html'), resolve(destDir, 'pet-live2d.html'))
        if (existsSync(resolve(srcDir, 'pet-vrm.html'))) {
          copyFileSync(resolve(srcDir, 'pet-vrm.html'), resolve(destDir, 'pet-vrm.html'))
        }
        if (existsSync(resolve(srcDir, 'settings.html'))) {
          copyFileSync(resolve(srcDir, 'settings.html'), resolve(destDir, 'settings.html'))
        }
        if (existsSync(resolve(srcDir, 'onboarding.html'))) {
          copyFileSync(resolve(srcDir, 'onboarding.html'), resolve(destDir, 'onboarding.html'))
        }
        if (existsSync(resolve(srcDir, 'assets'))) {
          cpSync(resolve(srcDir, 'assets'), resolve(destDir, 'assets'), { recursive: true })
        }
        if (existsSync(resolve(srcDir, 'plugins'))) {
          cpSync(resolve(srcDir, 'plugins'), resolve(destDir, 'plugins'), { recursive: true })
        }
        // 拷贝 IndexTTS 服务脚本
        const pyDir = resolve(__dirname, 'python')
        if (existsSync(resolve(pyDir, 'indextts_server.py'))) {
          copyFileSync(resolve(pyDir, 'indextts_server.py'), resolve(destDir, 'indextts_server.py'))
        }
        if (existsSync(resolve(pyDir, 'start_indextts.bat'))) {
          copyFileSync(resolve(pyDir, 'start_indextts.bat'), resolve(destDir, 'start_indextts.bat'))
        }
        console.log('[copy-pet-assets] ✔ Live2D 桌宠资产已拷贝到 out/main')
      } catch (e) {
        console.error('[copy-pet-assets] 失败:', e)
      }
    },
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(), copyPetAssets()],
    build: {
      outDir: 'out/main',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'electron/main.ts'),
          modeManager: resolve(__dirname, 'electron/modeManager.ts'),
          'newstools/mcpNewsServer': resolve(__dirname, 'electron/newstools/mcpNewsServer.ts'),
        },
        external: ['better-sqlite3', '@dingtalk/stream', '@xenova/transformers']
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/preload',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'electron/preload.ts')
        }
      }
    }
  },
  renderer: {
    root: '.',
    build: {
      outDir: 'out/renderer',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'index.html')
        }
      }
    },
    plugins: [react(), UnoCSS()],
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src')
      }
    }
  }
})
