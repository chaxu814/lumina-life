#!/usr/bin/env node
// ============================================================
// lumina-mcp.cjs — Lumina MCP stdio server 启动器
//
// 作用：以「纯 Node 运行时」（ELECTRON_RUN_AS_NODE=1）拉起打包好的
//   MCP server，把 Lumina 的工具注册表通过 stdio JSON-RPC 暴露给
//   MCP host（Claude Desktop / 任意 MCP 客户端）。
//
// 为什么需要它：Electron GUI 进程在 Windows 上无法读取 stdin（GUI 子系统
//   拿不到控制台管道），所以 MCP stdio server 必须跑在纯 Node 形态下。
//
// 用法（host 配置示例）：
//   { "command": "node", "args": ["<安装路径>/resources/lumina-mcp.cjs"] }
//   开发态：node lumina-mcp.cjs
//
// 本脚本不做任何 git 写操作；仅 spawn 一个子进程并继承 stdio。
// ============================================================

'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const here = __dirname;

function exists(p) {
  try { return fs.existsSync(p); } catch { return false; }
}

// 打包后本脚本位于 resources/（extraResources），开发态位于仓库根。
const isPackaged =
  path.basename(here) === 'resources' && exists(path.join(here, 'app.asar'));

let electronExe = null;
let bundle = null;

if (isPackaged) {
  const resources = here;
  const exeCandidates = [
    path.join(resources, '..', 'Lumina Life.exe'), // Windows
    path.join(resources, '..', 'Lumina Life.app', 'Contents', 'MacOS', 'Lumina Life'), // macOS
    path.join(resources, '..', 'lumina-life'), // Linux
    path.join(resources, '..', 'Lumina Life'), // Linux fallback
  ];
  electronExe = exeCandidates.find(exists) || null;

  // 注意：本启动器由普通 node 运行，普通 node 的 fs 无法探测 app.asar 内部路径
  // （asar 是 Electron 才识别的虚拟文件系统）。这里只校验 app.asar 本身存在，
  // 其内部 bundle 由 spawn 出来的 ELECTRON_RUN_AS_NODE 进程读取。
  const asarPath = path.join(resources, 'app.asar');
  const unpackedBundle = path.join(resources, 'app.asar.unpacked', 'out', 'mcp-server', 'mcp-server.js');
  if (exists(asarPath)) {
    bundle = path.join(asarPath, 'out', 'mcp-server', 'mcp-server.js');
  } else if (exists(unpackedBundle)) {
    bundle = unpackedBundle;
  } else {
    bundle = null;
  }
} else {
  const exePath = path.join(here, 'node_modules', 'electron', 'dist', 'electron.exe');
  electronExe = exists(exePath) ? exePath : null;
  const devBundle = path.join(here, 'out', 'mcp-server', 'mcp-server.js');
  bundle = exists(devBundle) ? devBundle : null;
}

if (!electronExe || !bundle) {
  process.stderr.write(
    'Lumina MCP server 未找到。请先完成构建（npm run build），并确认安装完整。\n'
  );
  process.exit(2);
}

const child = spawn(electronExe, [bundle], {
  stdio: ['inherit', 'inherit', 'inherit'],
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
});

child.on('error', (err) => {
  process.stderr.write(`启动 MCP server 失败: ${err && err.message ? err.message : String(err)}\n`);
  process.exit(2);
});

child.on('exit', (code, signal) => {
  if (code !== null) { process.exit(code); }
  process.exit(signal ? 1 : 0);
});
