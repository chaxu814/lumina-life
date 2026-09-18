#!/usr/bin/env node
/**
 * Lumina Life — 跨平台 CLI 入口
 *
 * 用法: lumina <命令> [参数]
 *
 * 在 Windows 上通过 `lumina.cmd` 调用（向后兼容），
 * 在 macOS / Linux 上通过符号链接直接执行此文件。
 */

const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const args = process.argv.slice(2);

function showHelp() {
  console.log(`
Lumina Life — 命令行工具

用法:
  lumina <命令> [参数]

命令:
  chat     向 Lumina 发送消息
  tool     执行工具
  agent    查看 Agent 状态
  memory   搜索记忆
  config   管理配置
  skill    管理技能
  cron     管理定时任务
  doctor   系统诊断

示例:
  lumina chat "今天天气怎么样"
  lumina doctor
  lumina --help
`);
}

if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
  showHelp();
  process.exit(0);
}

// 查找 Electron 可执行文件
function findElectron() {
  const scriptDir = __dirname;

  // 优先找 node_modules 里的本地 electron
  const candidates = [
    path.join(scriptDir, 'node_modules', '.bin', 'electron'),
    path.join(scriptDir, 'node_modules', '.bin', 'electron.cmd'),
    path.join(scriptDir, 'node_modules', 'electron', 'dist', 'electron.exe'),
    path.join(scriptDir, 'node_modules', 'electron', 'dist', 'electron'),
    path.join(scriptDir, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron'),
  ];

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }

  // 回退到 PATH 里的 electron
  try {
    const which = execSync(process.platform === 'win32' ? 'where electron' : 'which electron', { encoding: 'utf8' }).trim();
    if (which) return which;
  } catch {
    // ignore
  }

  return null;
}

const electronPath = findElectron();
if (!electronPath) {
  console.error('[错误] 未找到 Electron。请先运行 npm install。');
  process.exit(1);
}

const mainEntry = path.join(__dirname, 'out', 'main', 'index.js');
if (!fs.existsSync(mainEntry)) {
  console.error('[错误] 未找到构建产物。请先运行 npm run build。');
  console.error(`  [期望路径] ${mainEntry}`);
  process.exit(1);
}

// 启动 Electron CLI 模式
const child = spawn(electronPath, ['--no-sandbox', mainEntry, '--cli', ...args], {
  stdio: 'inherit',
  env: { ...process.env },
});

child.on('exit', (code) => {
  process.exit(code ?? 0);
});
