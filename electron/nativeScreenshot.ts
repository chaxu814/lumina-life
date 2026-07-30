// ============================================================
// nativeScreenshot.ts — 桌面截图 (v2.5 → v2.11 修复)
//
// v2.11: 优先使用 screenshot-desktop 原生绑定，回退到 PowerShell -Command
// （不再使用临时 .ps1 文件，避免编码/BOM问题）
//
// ⚠️ 原生模块问题排查：
//   如果 Electron 版本升级后截图失败（MODULE_NOT_FOUND / ABI mismatch），
//   运行: npx electron-rebuild -f -w screenshot-desktop
//   或:   npm rebuild screenshot-desktop --build-from-source
//
//   screenshot-desktop 依赖:
//   - Windows: 无需额外依赖（使用 Win32 GDI+）
//   - macOS:   需要屏幕录制权限（System Preferences → Security）
//   - Linux:   需要 imagemagick / x11-utils
// ============================================================

import * as cp from 'child_process'
import * as path from 'path'
import * as os from 'os'
import * as fs from 'fs'
import screenshot from 'screenshot-desktop'

/** 截图 → PNG 文件路径 */
export async function captureDesktopToFile(): Promise<string> {
  const id = Date.now()
  const png = path.join(os.tmpdir(), `lu-ns-${id}.png`)

  // ── 首选: screenshot-desktop 原生 C++ 绑定 ──
  try {
    await screenshot({ filename: png, format: 'png' })
    return png
  } catch (_nativeErr) {
    // 静默回退
  }

  // ── 回退: PowerShell (使用 -Command，不写 .ps1 文件) ──
  const ep = png.replace(/\\/g, '\\\\')
  const psCmd = [
    'Add-Type -AssemblyName System.Windows.Forms,System.Drawing;',
    `$s=[System.Windows.Forms.Screen]::PrimaryScreen;`,
    `$b=New-Object System.Drawing.Bitmap($s.Bounds.Width,$s.Bounds.Height);`,
    `$g=[System.Drawing.Graphics]::FromImage($b);`,
    `$g.CopyFromScreen($s.Bounds.X,$s.Bounds.Y,0,0,$s.Bounds.Size);`,
    `$b.Save('${ep}',[System.Drawing.Imaging.ImageFormat]::Png);`,
    `$g.Dispose();$b.Dispose();`,
    `Write-Output 'OK';`,
  ].join(' ')

  return new Promise<string>((resolve, reject) => {
    cp.execFile('powershell', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-Command', psCmd,
    ], { timeout: 15000, windowsHide: true },
    (err, stdout, stderr) => {
      if (err || !String(stdout).includes('OK')) {
        try { fs.unlinkSync(png) } catch {}
        reject(new Error(`ss:${(err as any)?.code || 'unk'}|${String(stderr || stdout).slice(0, 100)}`))
        return
      }
      resolve(png)
    })
  })
}

/** 截图 → Base64 */
export async function captureDesktopToBase64(): Promise<string> {
  const pngPath = await captureDesktopToFile()
  try { return fs.readFileSync(pngPath).toString('base64') }
  finally { try { fs.unlinkSync(pngPath) } catch {} }
}
