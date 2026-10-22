#!/usr/bin/env node
/**
 * Lumina Life — 跨平台 CLI 入口
 *
 * 用法: lumina <命令> [参数]
 *
 * 在 Windows 上通过 `lumina.cmd` 调用（向后兼容），
 * 在 macOS / Linux 上通过符号链接直接执行此文件。
 *
 * 两种运行形态：
 *   - 开发态（仓库根目录）：electron 来自 node_modules，主入口来自 out/main/index.js。
 *   - 打包态（安装后）：本文件随安装包落在 <resources>/，electron 即同层的
 *     `Lumina Life.exe`（Win）/ `Lumina Life.app/...`（mac）/ `Lumina Life`（Linux），
 *     主入口来自 resources/app.asar/out/main/index.js。
 *   判定依据：若 process.resourcesPath 存在且其中能看到 app.asar，则按打包态解析。
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

// 是否处于打包态：Electron 在打包后会设置 process.resourcesPath。
function isPackaged() {
  if (!process.resourcesPath) return false;
  try {
    return fs.existsSync(path.join(process.resourcesPath, 'app.asar'));
  } catch {
    return false;
  }
}

// 打包态：electron 可执行文件 = 安装后的应用本体。
// 安装后的 exe 会自动加载 resources/app.asar（其 package.json main 已指向 out/main/index.js），
// 因此这里不需要、也不应该从外部再传一个 asar 内部路径——普通 node 读不到 asar 内文件。
// 只要带 --cli 参数，主进程就会进入 CLI 模式。
function resolvePackaged() {
  const resourcesPath = process.resourcesPath;
  let electronPath;
  if (process.platform === 'win32') {
    electronPath = path.join(resourcesPath, '..', 'Lumina Life.exe');
  } else if (process.platform === 'darwin') {
    // resources/ 在 Lumina Life.app/Contents/Resources/
    electronPath = path.join(resourcesPath, '..', '..', 'MacOS', 'Lumina Life');
  } else {
    electronPath = path.join(resourcesPath, '..', 'Lumina Life');
  }
  // 以 app.asar 存在作为打包态产物完整的代理校验（asar 是可见文件，内部路径不外部校验）。
  const asarPath = path.join(resourcesPath, 'app.asar');
  return { electronPath, asarPath, mainEntry: null };
}

// 开发态：electron 来自 node_modules，主入口来自仓库根的 out/main/index.js。
function resolveDev() {
  const scriptDir = __dirname;
  const candidates = [
    path.join(scriptDir, 'node_modules', '.bin', 'electron'),
    path.join(scriptDir, 'node_modules', '.bin', 'electron.cmd'),
    path.join(scriptDir, 'node_modules', 'electron', 'dist', 'electron.exe'),
    path.join(scriptDir, 'node_modules', 'electron', 'dist', 'electron'),
    path.join(scriptDir, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron'),
  ];

  let electronPath = null;
  for (const p of candidates) {
    if (fs.existsSync(p)) { electronPath = p; break; }
  }

  // 回退到 PATH 里的 electron
  if (!electronPath) {
    try {
      const which = execSync(process.platform === 'win32' ? 'where electron' : 'which electron', { encoding: 'utf8' }).trim();
      if (which) electronPath = which;
    } catch {
      // ignore
    }
  }

  const mainEntry = path.join(scriptDir, 'out', 'main', 'index.js');
  return { electronPath, mainEntry };
}

const packaged = isPackaged();
const resolved = packaged ? resolvePackaged() : resolveDev();
const electronPath = resolved.electronPath;

if (!electronPath || !fs.existsSync(electronPath)) {
  console.error('[错误] 未找到 Electron 可执行文件。');
  console.error(`  [期望路径] ${electronPath || '(空)'}`);
  if (!packaged) console.error('  开发态请先运行 npm install。');
  process.exit(1);
}

if (packaged) {
  // 打包态：只校验 app.asar 存在（不外部校验其内部 out/main/index.js）。
  if (!fs.existsSync(resolved.asarPath)) {
    console.error('[错误] 打包产物不完整：缺少 resources/app.asar。');
    process.exit(1);
  }
} else if (!fs.existsSync(resolved.mainEntry)) {
  console.error('[错误] 未找到主进程入口 out/main/index.js。');
  console.error(`  [期望路径] ${resolved.mainEntry}`);
  console.error('  开发态请先运行 npm run build。');
  process.exit(1);
}

// 启动 Electron CLI 模式。--no-sandbox 与 dev 保持一致。
// 打包态不传主入口（exe 自动加载 app.asar）；开发态显式传 out/main/index.js。
const spawnArgs = packaged
  ? ['--no-sandbox', '--cli', ...args]
  : ['--no-sandbox', resolved.mainEntry, '--cli', ...args];
const child = spawn(electronPath, spawnArgs, {
  stdio: 'inherit',
  env: { ...process.env },
});

child.on('exit', (code) => {
  process.exit(code ?? 0);
});
