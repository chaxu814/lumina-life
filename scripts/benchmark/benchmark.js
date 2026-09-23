#!/usr/bin/env node
/**
 * Lumina Life 性能基准脚本
 * ---------------------------------------------------------------------------
 * 用法:
 *   node scripts/benchmark/benchmark.js                     # 默认 idle 场景
 *   node scripts/benchmark/benchmark.js --scenario idle
 *   node scripts/benchmark/benchmark.js --scenario onnx-loaded
 *   node scripts/benchmark/benchmark.js --help
 *
 * 环境变量:
 *   BENCH_SCENARIO=chat node scripts/benchmark/benchmark.js
 *   BENCH_SAMPLES=10 node scripts/benchmark/benchmark.js   # 覆盖采样次数
 *   BENCH_INTERVAL=1500 node ...                            # 采样间隔(ms)
 *   BENCH_OUT=path/to/out.json node ...                    # 输出 JSON 路径
 *
 * 本脚本不依赖任何外部 npm 包，仅使用 Node 内置模块。
 * 既可以在纯 Node.js 下运行（测量脚本/框架自身开销），
 * 也可以在 Electron 主进程中运行（process.versions.electron 存在时自动启用
 * Electron 专属指标 process.getProcessMemoryInfo() / app.getAppMetrics()）。
 *
 * 注意: chat / live2d / onnx-loaded / computer-use 等场景需要真实应用负载。
 *       在纯 Node 下运行这些场景时，只会测量当前 Node 进程，结果会被
 *       明确标注为 "standalone (非应用负载)"，绝不编造应用内数据。
 */

'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// 命令行参数 / 环境变量解析
// ---------------------------------------------------------------------------
const VALID_SCENARIOS = ['idle', 'chat', 'live2d', 'onnx-loaded', 'computer-use'];

function parseArgs(argv) {
  const args = {
    scenario: process.env.BENCH_SCENARIO || 'idle',
    samples: Number(process.env.BENCH_SAMPLES || 5),
    interval: Number(process.env.BENCH_INTERVAL || 1000),
    out: process.env.BENCH_OUT || null,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      args.help = true;
    } else if (a === '--scenario' || a === '-s') {
      args.scenario = argv[++i];
    } else if (a === '--samples' || a === '-n') {
      args.samples = Number(argv[++i]);
    } else if (a === '--interval') {
      args.interval = Number(argv[++i]);
    } else if (a === '--out' || a === '-o') {
      args.out = argv[++i];
    } else if (a.startsWith('--scenario=')) {
      args.scenario = a.split('=')[1];
    }
  }
  return args;
}

function printHelp() {
  const lines = [
    'Lumina Life 性能基准脚本',
    '',
    '用法:',
    '  node scripts/benchmark/benchmark.js [选项]',
    '',
    '选项:',
    '  -s, --scenario <name>   场景: ' + VALID_SCENARIOS.join(' | ') + '  (默认 idle)',
    '  -n, --samples <n>        采样次数 (默认 5)',
    '      --interval <ms>     采样间隔毫秒 (默认 1000)',
    '  -o, --out <path>        JSON 输出路径 (默认 scripts/benchmark/benchmark-results.json)',
    '  -h, --help              显示本帮助',
    '',
    '说明:',
    '  idle        空载：启动后稳定采样（所有环境均可测）',
    '  chat        对话中：需在 Electron 应用内运行（纯 Node 下只测进程基线）',
    '  live2d      Live2D 渲染中：需在 Electron 应用内运行',
    '  onnx-loaded @xenova/transformers 运行时加载后（纯 Node 下尝试 require 运行时并测量）',
    '  computer-use 截图+VLM 循环：需在 Electron 应用内运行',
  ];
  console.log(lines.join('\n'));
}

// ---------------------------------------------------------------------------
// 硬件 / 运行环境信息采集
// ---------------------------------------------------------------------------
function bytesToMB(n) {
  return Math.round((n / 1024 / 1024) * 10) / 10;
}

function collectHardware() {
  const cpus = os.cpus() || [];
  const first = cpus[0] || {};
  const info = {
    platform: os.platform(),
    arch: os.arch(),
    release: os.release(),
    nodeVersion: process.version,
    electronVersion: process.versions.electron || null,
    chromeVersion: process.versions.chrome || null,
    cpuModel: first.model || 'unknown',
    cpuCores: cpus.length,
    cpuSpeedMHz: first.speed || null,
    totalMemGB: Math.round((os.totalmem() / 1024 / 1024 / 1024) * 10) / 10,
    freeMemGB: Math.round((os.freemem() / 1024 / 1024 / 1024) * 10) / 10,
  };
  return info;
}

// ---------------------------------------------------------------------------
// 采样：进程内存 + CPU 时间
// ---------------------------------------------------------------------------
const isElectron = !!process.versions.electron;
let electronApp = null;
if (isElectron) {
  try {
    // 在 Electron 主进程中 require('electron') 可用
    electronApp = require('electron').app;
  } catch (_e) {
    electronApp = null;
  }
}

function sampleProcessMemory() {
  const mu = process.memoryUsage();
  const out = {
    rssMB: bytesToMB(mu.rss),
    heapUsedMB: bytesToMB(mu.heapUsed),
    heapTotalMB: bytesToMB(mu.heapTotal),
    externalMB: bytesToMB(mu.external),
    arrayBuffersMB: mu.arrayBuffers ? bytesToMB(mu.arrayBuffers) : 0,
  };
  // Electron 专属：更细的内存分类
  if (typeof process.getProcessMemoryInfo === 'function') {
    try {
      const em = process.getProcessMemoryInfo();
      out.electron = {
        privateMB: bytesToMB(em.privateBytes),
        sharedMB: bytesToMB(em.sharedBytes),
        residentMB: bytesToMB(em.residentSet),
      };
    } catch (_e) { /* ignore */ }
  }
  return out;
}

function readCpuUsage() {
  const cu = process.cpuUsage();
  return { userMicros: cu.user, systemMicros: cu.system };
}

// 计算两次采样之间的 CPU 使用率
// wallMs: 两次采样之间的真实墙钟时间
// 返回 perCorePct: 占一个核心的百分比; machinePct: 占整机逻辑核心总容量的百分比
function computeCpuPct(before, after, wallMs, logicalCores) {
  const deltaMicros = (after.userMicros - before.userMicros) + (after.systemMicros - before.systemMicros);
  const wallMicros = wallMs * 1000;
  if (wallMicros <= 0) return { perCorePct: 0, machinePct: 0 };
  const perCore = (deltaMicros / wallMicros) * 100;
  const machine = logicalCores > 0 ? perCore / logicalCores : perCore;
  return {
    perCorePct: Math.round(perCore * 100) / 100,
    machinePct: Math.round(machine * 100) / 100,
  };
}

// ---------------------------------------------------------------------------
// 采样循环
// ---------------------------------------------------------------------------
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function summarize(values) {
  if (!values.length) return { avg: 0, max: 0, min: 0, stddev: 0 };
  const sum = values.reduce((a, b) => a + b, 0);
  const avg = sum / values.length;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const variance = values.reduce((a, b) => a + (b - avg) * (b - avg), 0) / values.length;
  const stddev = Math.sqrt(variance);
  return {
    avg: Math.round(avg * 100) / 100,
    max: Math.round(max * 100) / 100,
    min: Math.round(min * 100) / 100,
    stddev: Math.round(stddev * 100) / 100,
  };
}

async function runScenario(scenario, samples, intervalMs) {
  const logicalCores = os.cpus().length;
  const samplesData = [];
  let workloadNote = '';

  // 场景前置：onnx-loaded 尝试 require @xenova/transformers（真实加载运行时）
  if (scenario === 'onnx-loaded') {
    workloadNote = '尝试在当前进程 require @xenova/transformers 以加载 ONNX 运行时';
    try {
      // eslint-disable-next-line global-require
      require('@xenova/transformers');
      workloadNote += ' — require 成功（运行时已加载，未加载具体模型）';
    } catch (e) {
      workloadNote += ' — require 失败: ' + (e && e.message ? e.message.split('\n')[0] : String(e));
    }
    await sleep(1500); // 让运行时初始化稳定
  }

  // chat / live2d / computer-use 在纯 Node 下没有真实应用负载，
  // 这里不伪造数据，只采样当前进程；备注里如实说明。
  if (['chat', 'live2d', 'computer-use'].includes(scenario) && !isElectron) {
    workloadNote = '纯 Node 环境：未驱动真实应用负载，以下为脚本进程基线，非应用内该场景数据';
  }
  if (['chat', 'live2d', 'computer-use'].includes(scenario) && isElectron) {
    workloadNote = 'Electron 环境：假设应用已处于该场景，采样主进程指标';
  }

  // 预热一次，丢弃
  await sleep(300);
  let prevCpu = readCpuUsage();
  let prevWall = process.hrtime.bigint();

  for (let i = 0; i < samples; i++) {
    const mem = sampleProcessMemory();
    const cpuNow = readCpuUsage();
    const wallNow = process.hrtime.bigint();
    const wallMs = Number(wallNow - prevWall) / 1e6;
    const cpu = computeCpuPct(prevCpu, cpuNow, wallMs, logicalCores);
    const sysFreeGB = Math.round((os.freemem() / 1024 / 1024 / 1024) * 10) / 10;
    samplesData.push({
      index: i,
      timestamp: new Date().toISOString(),
      ...mem,
      cpuPerCorePct: cpu.perCorePct,
      cpuMachinePct: cpu.machinePct,
      systemFreeMemGB: sysFreeGB,
    });
    prevCpu = cpuNow;
    prevWall = wallNow;
    if (i < samples - 1) await sleep(intervalMs);
  }

  // 汇总
  const summary = {
    rssMB: summarize(samplesData.map((s) => s.rssMB)),
    heapUsedMB: summarize(samplesData.map((s) => s.heapUsedMB)),
    heapTotalMB: summarize(samplesData.map((s) => s.heapTotalMB)),
    externalMB: summarize(samplesData.map((s) => s.externalMB)),
    cpuMachinePct: summarize(samplesData.map((s) => s.cpuMachinePct)),
    cpuPerCorePct: summarize(samplesData.map((s) => s.cpuPerCorePct)),
  };

  // Electron app.getAppMetrics()：所有进程的聚合内存/CPU
  let electronMetrics = null;
  if (isElectron && electronApp && typeof electronApp.getAppMetrics === 'function') {
    try {
      const metrics = electronApp.getAppMetrics();
      let totalRSS = 0;
      let totalPSS = 0;
      const perProc = metrics.map((m) => {
        totalRSS += m.memory.workingSetSize * 1024;
        if (m.memory.peakWorkingSetSize) totalPSS += m.memory.peakWorkingSetSize * 1024;
        return {
          pid: m.pid,
          type: m.type,
          rssMB: bytesToMB(m.memory.workingSetSize * 1024),
          cpuPercent: m.cpu.percentCPU,
        };
      });
      electronMetrics = {
        processCount: metrics.length,
        totalRssMB: bytesToMB(totalRSS),
        processes: perProc,
      };
    } catch (_e) { /* ignore */ }
  }

  return {
    scenario,
    isElectron,
    workloadNote,
    sampleCount: samples,
    intervalMs,
    logicalCores,
    summary,
    samples: samplesData,
    electronMetrics,
  };
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------
function renderConsoleTable(result, hardware) {
  const s = result.summary;
  const row = [
    result.scenario.padEnd(13),
    String(s.rssMB.avg).padStart(8),
    String(s.heapUsedMB.avg).padStart(8),
    String(s.cpuMachinePct.avg + '%').padStart(8),
    result.workloadNote || '',
  ];
  console.log('');
  console.log('Lumina Life 性能基准结果');
  console.log('硬件: ' + hardware.cpuModel + ' / ' + hardware.cpuCores + ' 核 / ' +
    hardware.totalMemGB + 'GB RAM / ' + (hardware.electronVersion ? 'Electron ' + hardware.electronVersion : 'Node ' + hardware.nodeVersion));
  console.log('-------------------------------------------------------------------------');
  console.log('场景          RSS(MB)  Heap(MB)  CPU%整机  备注');
  console.log('------------- -------- -------- --------- --------------------------------');
  console.log(row.join(' '));
  console.log('-------------------------------------------------------------------------');
  console.log('采样: ' + result.sampleCount + ' 次, 间隔 ' + result.intervalMs + 'ms');
  console.log('RSS    avg=' + s.rssMB.avg + '  max=' + s.rssMB.max + '  stddev=' + s.rssMB.stddev);
  console.log('Heap   avg=' + s.heapUsedMB.avg + '  max=' + s.heapUsedMB.max + '  stddev=' + s.heapUsedMB.stddev);
  console.log('CPU整机 avg=' + s.cpuMachinePct.avg + '%  max=' + s.cpuMachinePct.max + '%');
  if (result.electronMetrics) {
    console.log('Electron 进程数: ' + result.electronMetrics.processCount +
      '  合计 RSS: ' + result.electronMetrics.totalRssMB + 'MB');
  }
  console.log('');
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  if (!VALID_SCENARIOS.includes(args.scenario)) {
    console.error('错误: 未知场景 "' + args.scenario + '"，可选: ' + VALID_SCENARIOS.join(', '));
    process.exit(1);
  }

  const hardware = collectHardware();
  const startedAt = new Date().toISOString();
  console.log('[benchmark] 场景=' + args.scenario + ' 采样=' + args.samples + ' 间隔=' + args.interval + 'ms');

  const result = await runScenario(args.scenario, args.samples, args.interval);
  const endedAt = new Date().toISOString();

  const fullReport = {
    tool: 'lumina-benchmark',
    version: '1.0.0',
    startedAt,
    endedAt,
    hardware,
    result,
  };

  renderConsoleTable(result, hardware);

  // 写 JSON
  const outPath = args.out || path.join(__dirname, 'benchmark-results.json');
  fs.writeFileSync(outPath, JSON.stringify(fullReport, null, 2), 'utf8');
  console.log('[benchmark] JSON 已写入: ' + outPath);
}

main().catch((e) => {
  console.error('[benchmark] 运行失败:', e);
  process.exit(1);
});
