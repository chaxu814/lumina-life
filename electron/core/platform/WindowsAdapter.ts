// ============================================================
// electron/core/platform/WindowsAdapter.ts — Windows 桌面控制实现
//
// 从 electron/tools/impl/cuCore.ts 原样迁移 PowerShell 键鼠/截屏逻辑，
// 命令串与脚本字节保持不变，保证改造后 Windows 行为与之前完全一致。
//   • 鼠标：user32.dll mouse_event + System.Windows.Forms.Cursor
//   • 键盘：SendKeys；文本输入走剪贴板粘贴（支持中文）
//   • 截屏：screenshot-desktop（多显示器/隐私遮罩仍由 cuCore 负责）
// ============================================================

import * as cp from 'child_process'
import * as path from 'path'
import * as os from 'os'
import * as fs from 'fs'
import { clipboard } from 'electron'
import screenshot from 'screenshot-desktop'
import {
  PlatformAdapter, PlatformCapabilities, ScreenCaptureResult,
  ActiveWindowInfo, InstalledApp, execCmd, wrapCmdResult, readPngSize,
} from './PlatformAdapter'
import { buildSendKeysToken } from '../../tools/impl/cuKeyTokens'

/** 与 cuCore 历史实现一致：写临时 .ps1 并执行 */
function runPS(lines: string[], timeout = 15000): Promise<string> {
  const ps1 = path.join(os.tmpdir(), `lu-ps-${Date.now()}-${Math.round(Math.random() * 1e6)}.ps1`)
  return new Promise<string>(resolve => {
    try { fs.writeFileSync(ps1, lines.join('\n'), 'utf-8') } catch (e: any) {
      return resolve(`ERR:ps1_write:${e.message}`)
    }
    cp.execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1],
      { timeout, windowsHide: true },
      (err, stdout, stderr) => {
        try { fs.unlinkSync(ps1) } catch {}
        if (err) {resolve(`ERR:${err.message}|${String(stderr).slice(0, 100)}`)}
        else {resolve(String(stdout).trim())}
      })
  })
}

export class WindowsAdapter implements PlatformAdapter {
  readonly capabilities: PlatformCapabilities = {
    platform: 'win32',
    mouse: true,
    keyboard: true,
    screenshot: true,
    windowInfo: true,
    uia: true,
    openApp: true,
    installedApps: true,
    notes: [],
  }

  async mouseMove(x: number, y: number): Promise<string> {
    const rx = Math.round(x), ry = Math.round(y)
    const r = await runPS([
      'Add-Type -AssemblyName System.Windows.Forms',
      `[System.Windows.Forms.Cursor]::Position=New-Object System.Drawing.Point(${rx},${ry})`,
      "Write-Output 'OK'",
    ])
    return wrapCmdResult(r, '移动')
  }

  async mouseClick(x: number, y: number, button: 'left' | 'right', dbl: boolean): Promise<string> {
    const rx = Math.round(x), ry = Math.round(y)
    const click = dbl ? '[MO]::DoubleClickLeft()'
      : button === 'right' ? '[MO]::ClickRight()' : '[MO]::ClickLeft()'
    const r = await runPS([
      "Add-Type @'",
      'using System;using System.Runtime.InteropServices;',
      'public class MO{',
      '[DllImport("user32.dll")]public static extern void mouse_event(uint f,uint dx,uint dy,uint d,int e);',
      'public const uint L=0x0002;public const uint LU=0x0004;',
      'public const uint R=0x0008;public const uint RU=0x0010;',
      'public static void ClickLeft(){mouse_event(L,0,0,0,0);System.Threading.Thread.Sleep(50);mouse_event(LU,0,0,0,0);}',
      'public static void ClickRight(){mouse_event(R,0,0,0,0);System.Threading.Thread.Sleep(50);mouse_event(RU,0,0,0,0);}',
      'public static void DoubleClickLeft(){ClickLeft();System.Threading.Thread.Sleep(100);ClickLeft();}',
      '}',
      "'@",
      'Add-Type -AssemblyName System.Windows.Forms',
      `[System.Windows.Forms.Cursor]::Position=New-Object System.Drawing.Point(${rx},${ry})`,
      'Start-Sleep -Milliseconds 80',
      click,
      "Write-Output 'OK'",
    ])
    return wrapCmdResult(r, '点击')
  }

  async mouseHover(x: number, y: number, holdMs: number): Promise<string> {
    const rx = Math.round(x), ry = Math.round(y), hold = Math.round(holdMs)
    const r = await runPS([
      'Add-Type -AssemblyName System.Windows.Forms',
      `[System.Windows.Forms.Cursor]::Position=New-Object System.Drawing.Point(${rx},${ry})`,
      `Start-Sleep -Milliseconds ${hold}`,
      "Write-Output 'OK'",
    ])
    return wrapCmdResult(r, '悬停')
  }

  async mouseLongPress(x: number, y: number, holdMs: number): Promise<string> {
    const rx = Math.round(x), ry = Math.round(y), hold = Math.round(holdMs)
    const r = await runPS([
      "Add-Type @'",
      'using System;using System.Runtime.InteropServices;',
      'public class ML{',
      '[DllImport("user32.dll")]public static extern void mouse_event(uint f,uint dx,uint dy,uint d,int e);',
      '[DllImport("user32.dll")]public static extern bool SetCursorPos(int X,int Y);',
      '}',
      "'@",
      `[ML]::SetCursorPos(${rx},${ry})`,
      'Start-Sleep -Milliseconds 80',
      '[ML]::mouse_event(0x0002,0,0,0,0)',
      `Start-Sleep -Milliseconds ${hold}`,
      '[ML]::mouse_event(0x0004,0,0,0,0)',
      "Write-Output 'OK'",
    ])
    return wrapCmdResult(r, '长按')
  }

  async mouseDrag(x1: number, y1: number, x2: number, y2: number): Promise<string> {
    const rx1 = Math.round(x1), ry1 = Math.round(y1), rx2 = Math.round(x2), ry2 = Math.round(y2)
    const r = await runPS([
      "Add-Type @'",
      'using System;using System.Runtime.InteropServices;',
      'public class MD{',
      '[DllImport("user32.dll")]public static extern void mouse_event(uint f,uint dx,uint dy,uint d,int e);',
      '[DllImport("user32.dll")]public static extern bool SetCursorPos(int X,int Y);',
      '}',
      "'@",
      `[MD]::SetCursorPos(${rx1},${ry1})`,
      'Start-Sleep -Milliseconds 80',
      '[MD]::mouse_event(0x0002,0,0,0,0)',
      'Start-Sleep -Milliseconds 50',
      `$steps=20;for($i=1;$i -le $steps;$i++){$nx=[int](${rx1}+(${rx2}-${rx1})*$i/$steps);$ny=[int](${ry1}+(${ry2}-${ry1})*$i/$steps);[MD]::SetCursorPos($nx,$ny);Start-Sleep -Milliseconds 15}`,
      `[MD]::SetCursorPos(${rx2},${ry2})`,
      'Start-Sleep -Milliseconds 50',
      '[MD]::mouse_event(0x0004,0,0,0,0)',
      "Write-Output 'OK'",
    ])
    return wrapCmdResult(r, '拖拽')
  }

  async mouseScroll(amount: number): Promise<string> {
    const n = Math.abs(amount)
    const dirHex = amount > 0 ? '0x0800' : '0x0078'
    const reps = Array(Math.min(20, Math.max(1, n))).fill(`[MS]::mouse_event(${dirHex},0,0,0,0);Start-Sleep -Milliseconds 20`).join(';')
    const r = await runPS([
      "Add-Type @'",
      'using System;using System.Runtime.InteropServices;',
      'public class MS{[DllImport("user32.dll")]public static extern void mouse_event(uint f,uint dx,uint dy,uint d,int e);}',
      "'@",
      reps,
      "Write-Output 'OK'",
    ])
    return wrapCmdResult(r, '滚动')
  }

  async keyboardType(text: string): Promise<string> {
    if (!text) {return '输入完成'}
    let backup = ''
    try { backup = clipboard.readText() } catch { /* 忽略 */ }
    try { clipboard.writeText(text) } catch (e: any) { return `输入失败:剪贴板${e?.message || e}` }
    const r = await runPS([
      'Add-Type -AssemblyName System.Windows.Forms',
      "[System.Windows.Forms.SendKeys]::SendWait('^v')",
      "Write-Output 'OK'",
    ])
    await new Promise(res => setTimeout(res, 120))
    try { clipboard.writeText(backup) } catch { /* 还原失败不影响结果 */ }
    return wrapCmdResult(r, '输入')
  }

  async keyPress(key: string): Promise<string> {
    const k = (key || '').toLowerCase()
    if (!k) {return '按键失败:空按键'}
    const legacyMap: Record<string, string> = { win: '^{ESC}' }
    const token = legacyMap[k] || buildSendKeysToken(k)
    if (!token) {return `按键失败:不支持的按键组合「${key}」`}
    // SendKeys 记号里的单引号需转义
    const safe = token.replace(/'/g, "''")
    const r = await runPS([
      'Add-Type -AssemblyName System.Windows.Forms',
      `[System.Windows.Forms.SendKeys]::SendWait('${safe}')`,
      "Write-Output 'OK'",
    ])
    return wrapCmdResult(r, '按键')
  }

  async screenshot(): Promise<ScreenCaptureResult> {
    // 主路径在 cuCore 中仍优先使用 screenshot-desktop + 多显示器/隐私遮罩；
    // 这里提供接口契约内的兜底实现。
    const buf = (await screenshot({ format: 'png' })) as unknown as Buffer
    const { w, h } = readPngSize(buf)
    return { buffer: buf, w, h }
  }

  async getActiveWindow(): Promise<ActiveWindowInfo | null> {
    const ps = [
      "Add-Type @'",
      'using System;using System.Runtime.InteropServices;using System.Text;',
      'public class AW{',
      '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
      '[DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);',
      '[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);',
      '[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);',
      '[StructLayout(LayoutKind.Sequential)] public struct R { public int L,T,Rr,B; }',
      '}',
      "'@",
      '$h=[AW]::GetForegroundWindow()',
      '$sb=New-Object System.Text.StringBuilder 512',
      '[void][AW]::GetWindowText($h,$sb,512)',
      '$r=New-Object AW+R; [void][AW]::GetWindowRect($h,[ref]$r)',
      '$pid2=0; [void][AW]::GetWindowThreadProcessId($h,[ref]$pid2)',
      '$proc=""; try { $proc=(Get-Process -Id $pid2 -ErrorAction Stop).ProcessName } catch {}',
      "Write-Output ($sb.ToString()+'|'+$proc+'|'+$r.L+','+$r.T+','+($r.Rr-$r.L)+','+($r.B-$r.T))",
    ]
    const r = await runPS(ps, 8000)
    if (r.startsWith('ERR:') || !r.includes('|')) {return null}
    const [title, proc, rect] = r.split('|')
    const [x, y, w, h] = (rect || '').split(',').map(Number)
    return { title, processName: proc, bounds: { x: x || 0, y: y || 0, w: w || 0, h: h || 0 } }
  }

  async getUiaTree(): Promise<unknown[]> {
    // 真正的 UIA 元素扫描在 cuUia.ts（带缓存/ValuePattern）。
    // 这里仅作能力占位：Windows 上 uia=true，调用方应走 getUiaCache().scan()。
    return []
  }

  async openApp(appName: string): Promise<string> {
    const r = await execCmd('cmd', ['/c', 'start', '', appName])
    return r.startsWith('ERR:') ? `打开应用失败:${r.slice(4)}` : '已尝试打开应用'
  }

  async getInstalledApps(): Promise<InstalledApp[]> {
    // best-effort：枚举开始菜单快捷方式
    const r = await execCmd('powershell', [
      '-NoProfile', '-Command',
      `Get-ChildItem "$env:ProgramData\\Microsoft\\Windows\\Start Menu\\Programs","$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs" -Filter *.lnk -ErrorAction SilentlyContinue | Select-Object -ExpandProperty BaseName`,
    ], 10000)
    if (r.startsWith('ERR:')) {return []}
    return r.split(/\r?\n/).map(s => s.trim()).filter(Boolean).map(name => ({ name }))
  }
}
