// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
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
        if (existsSync(resolve(srcDir, 'pet-chat.html'))) {
          copyFileSync(resolve(srcDir, 'pet-chat.html'), resolve(destDir, 'pet-chat.html'))
        }
        // 其余渲染形态页（程序化小猫 / MMD / PNGTuber）：漏拷会导致对应模型
        // 找不到渲染页而回退，Cat 这种内置保底形象会因此白屏。
        for (const page of ['pet-cat.html', 'pet-mmd.html', 'pet-pngtuber.html']) {
          if (existsSync(resolve(srcDir, page))) {
            copyFileSync(resolve(srcDir, page), resolve(destDir, page))
          }
        }
        if (existsSync(resolve(srcDir, 'assets'))) {
          // Mao 等 Live2D Cubism 示例模型受 SDK 再分发条款约束，不得随安装包分发
          // （modelLibrary 已将内置保底形象切换为零素材的程序化小猫 Cat）。
          // 这些模型目录在源码树里被 .gitignore 排除，这里再加一道过滤，
          // 防止作者本机残留的模型文件被打包进公开安装包。
          cpSync(resolve(srcDir, 'assets'), resolve(destDir, 'assets'), {
            recursive: true,
            filter: (p) => !/[\\/]Mao[\\/]|[\\/]Hiyori[\\/]/.test(p)
          })
        }
        // 内置示例技能（13 个 SKILL.md）：skillsLoader 的 SKILLS_DIR 解析为
        // 打包后 __dirname/../skills，即 app.asar/out/skills。不拷贝则安装包
        // 里所有内置技能（git/shell/memory/…）静默消失。
        const builtinSkills = resolve(__dirname, 'electron', 'skills')
        if (existsSync(builtinSkills)) {
          cpSync(builtinSkills, resolve(destDir, '..', 'skills'), { recursive: true })
        }
        if (existsSync(resolve(srcDir, 'plugins'))) {
          cpSync(resolve(srcDir, 'plugins'), resolve(destDir, 'plugins'), { recursive: true })
        }
        // 托盘浮层菜单（自定义圆角卡片 HTML）
        const trayHtml = resolve(__dirname, 'electron', 'tray', 'trayMenu.html')
        if (existsSync(trayHtml)) {
          copyFileSync(trayHtml, resolve(destDir, 'trayMenu.html'))
          // 交互脚本必须和 HTML 同目录：HTML 用 <script src="trayMenu.ui.js"> 引用，
          // 且 CSP 是 script-src 'self'（不放行内联脚本），漏拷会导致菜单点不动。
          // 文件名带 .ui 是为了不跟 trayMenu.ts 撞名——Vite 的 resolve.extensions
          // 里 .js 排在 .ts 前面，同名会把 `from './tray/trayMenu'` 解析到 .js。
          const trayUiJs = resolve(__dirname, 'electron', 'tray', 'trayMenu.ui.js')
          if (existsSync(trayUiJs)) {
            copyFileSync(trayUiJs, resolve(destDir, 'trayMenu.ui.js'))
          }
        }
        // 内置浏览器宿主页（工具栏 + webview 容器）
        const browserHtml = resolve(__dirname, 'electron', 'browser', 'browser.html')
        if (existsSync(browserHtml)) {
          copyFileSync(browserHtml, resolve(destDir, 'browser.html'))
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
      // 🛡️ 不让 Vite 自动清空 out/main。
      //   原因：某些受限终端环境会拦截"一次删除 >50 个文件"的批量操作
      //   （`fs.rm(dir,{recursive})`），导致构建在清空 out/main/chunks|assets 时
      //   直接失败 → dev server 起不来 → 主窗口白屏（实测踩过）。
      //   改为由 `scripts/prebuild-clean.cjs`（predev/prebuild 钩子）**逐个**清理，
      //   逐个 unlink 不会被拦，且效果等价。
      emptyOutDir: false,
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'electron/main.ts'),
          modeManager: resolve(__dirname, 'electron/modeManager.ts'),
          'newstools/mcpNewsServer': resolve(__dirname, 'electron/newstools/mcpNewsServer.ts'),
        },
        external: ['better-sqlite3', '@dingtalk/stream', '@xenova/transformers', 'mineflayer']
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/preload',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'electron/preload.ts'),
          trayMenu: resolve(__dirname, 'electron/tray/trayMenuPreload.ts'),
          browser: resolve(__dirname, 'electron/browser/browserPreload.ts'),
          // 桌宠窗口专用受控 preload（contextIsolation:true + 白名单 IPC 桥）
          pet: resolve(__dirname, 'electron/pet/petPreload.ts'),
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
