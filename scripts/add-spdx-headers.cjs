#!/usr/bin/env node
// ============================================================
// add-spdx-headers.cjs — 为 git 跟踪的 .ts/.tsx 源文件补 SPDX 双许可头
//
// 行为：
//   - 目标：`git ls-files` 跟踪的 *.ts / *.tsx（不碰未跟踪/忽略文件）
//   - 在文件第 1 行插入：// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
//   - 幂等：前 10 行内已出现 SPDX-License-Identifier 的文件自动跳过
//   - 保留原文件 BOM（有 BOM 就继续带 BOM）
//
// 用法：
//   node scripts/add-spdx-headers.cjs              # 正式执行
//   node scripts/add-spdx-headers.cjs --dry-run   # 只打印将改动的文件，不写盘
//   node scripts/add-spdx-headers.cjs --check      # CI 模式：缺头文件存在时退出码 1
//   node scripts/add-spdx-headers.cjs path/a.ts path/b.ts ...   # 只处理指定文件
//
// 回滚：所有目标文件均为 git 跟踪文件，误改一律 `git checkout -- <files>`。
// 脚本本身不做任何 git 写操作（不 commit / 不 push）。
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const SPDX_LINE = '// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0';
const SCAN_LINES = 10; // 前 10 行内已有 SPDX 即视为已加

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = { dryRun: false, check: false, files: [] };
  for (const a of args) {
    if (a === '--dry-run' || a === '-n') opts.dryRun = true;
    else if (a === '--check' || a === '-c') opts.check = true;
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node scripts/add-spdx-headers.cjs [--dry-run] [--check] [file ...]');
      process.exit(0);
    } else {
      opts.files.push(a);
    }
  }
  return opts;
}

// 通过 git ls-files 枚举跟踪文件；失败则直接退出（不允许退化成扫盘写盘）
function listTrackedTsFiles() {
  const res = spawnSync(
    'git',
    ['ls-files', '-z', '--', '*.ts', '*.tsx'],
    { cwd: REPO_ROOT, encoding: 'utf8' }
  );
  if (res.status !== 0) {
    console.error('git ls-files 失败：' + (res.stderr || '未知错误'));
    console.error('请在 git 仓库根目录（' + REPO_ROOT + '）下运行本脚本。');
    process.exit(2);
  }
  // -z 以 NUL 分隔；空字符串条目要过滤掉
  return res.stdout.split('\0').filter(Boolean);
}

function fileHasSpdxHeader(content) {
  const head = content.split(/\r?\n/).slice(0, SCAN_LINES).join('\n');
  return head.includes('SPDX-License-Identifier');
}

function processFile(absPath) {
  const raw = fs.readFileSync(absPath);
  const hasBom = raw.length > 0 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf;
  const body = hasBom ? raw.slice(3).toString('utf8') : raw.toString('utf8');

  if (fileHasSpdxHeader(body)) {
    return 'skip';
  }
  if (!body.startsWith(SPDX_LINE + '\n') && !body.startsWith(SPDX_LINE + '\r\n')) {
    const eol = body.includes('\r\n') ? '\r\n' : '\n';
    const next = SPDX_LINE + eol + body;
    const out = hasBom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(next, 'utf8')]) : Buffer.from(next, 'utf8');
    fs.writeFileSync(absPath, out);
  }
  return 'added';
}

function main() {
  const opts = parseArgs(process.argv);

  let relFiles;
  if (opts.files.length > 0) {
    relFiles = opts.files.map((f) => (path.isAbsolute(f) ? path.relative(REPO_ROOT, f) : f));
  } else {
    relFiles = listTrackedTsFiles();
  }

  let added = 0;
  let skipped = 0;
  const needHeader = [];

  for (const rel of relFiles) {
    const abs = path.join(REPO_ROOT, rel);
    if (!fs.existsSync(abs)) {
      console.warn('跳过（文件不存在）：' + rel);
      continue;
    }
    if (opts.check || opts.dryRun) {
      const raw = fs.readFileSync(abs).toString('utf8');
      if (fileHasSpdxHeader(raw)) {
        skipped++;
      } else {
        needHeader.push(rel);
      }
    } else {
      const result = processFile(abs);
      if (result === 'added') {
        added++;
        console.log('  + ' + rel);
      } else {
        skipped++;
      }
    }
  }

  if (opts.check || opts.dryRun) {
    for (const rel of needHeader) console.log('  ~ ' + rel);
    console.log('');
    console.log(
      '扫描 ' + relFiles.length + ' 个文件：' +
      '缺头 ' + needHeader.length + '，已有 ' + skipped +
      (opts.dryRun ? '（dry-run，未写盘）' : '')
    );
    if (opts.check && needHeader.length > 0) process.exit(1);
    return;
  }

  console.log('');
  console.log('完成：新增头 ' + added + '，已存在跳过 ' + skipped + '，共扫描 ' + relFiles.length + ' 个文件。');
  console.log('回滚提示：误改文件执行 `git checkout -- <file>`；脚本未做任何 git 提交。');
}

main();
