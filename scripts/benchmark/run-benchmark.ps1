<#
.SYNOPSIS
  Lumina Life 性能基准启动脚本
.DESCRIPTION
  1. 检查 Node.js 是否可用
  2. 运行 node scripts/benchmark/benchmark.js（进程自测量）
  3. 通过 Get-Process 附加测量正在运行的 Electron / Lumina 进程（应用级内存与 CPU）
  4. 若存在构建产物 out/main/index.js，提示可在 Electron 中运行
.PARAMETER Scenario
  场景: idle | chat | live2d | onnx-loaded | computer-use  (默认 idle)
.PARAMETER Samples
  采样次数 (默认 5)
.PARAMETER AttachOnly
  只附加测量正在运行的 Electron/Lumina 进程，不运行 node 自测量
.PARAMETER Out
  JSON 输出路径 (默认 scripts/benchmark/benchmark-results.json)
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\benchmark\run-benchmark.ps1
  powershell -ExecutionPolicy Bypass -File scripts\benchmark\run-benchmark.ps1 -Scenario onnx-loaded
#>
param(
  [string]$Scenario = 'idle',
  [int]$Samples = 5,
  [switch]$AttachOnly,
  [string]$Out = ''
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $ProjectRoot

Write-Host "=========================================================="
Write-Host " Lumina Life 性能基准"
Write-Host " 项目根目录: $ProjectRoot"
Write-Host "=========================================================="

# ---------- 1. 检查 Node.js ----------
Write-Host "`n[1/4] 检查 Node.js ..."
try {
  $nodeVer = & node --version
  Write-Host "  Node.js 版本: $nodeVer"
} catch {
  Write-Host "  [错误] 未找到 Node.js，请先安装 Node.js 18+ 并加入 PATH。" -ForegroundColor Red
  exit 1
}

# ---------- 2. 运行 node 自测量 ----------
if (-not $AttachOnly) {
  Write-Host "`n[2/4] 运行 node 基准脚本 (场景: $Scenario, 采样: $Samples) ..."
  $benchScript = Join-Path $PSScriptRoot 'benchmark.js'
  $args = @($benchScript, '--scenario', $Scenario, '--samples', $Samples, '--interval', '1000')
  if ($Out -ne '') { $args += @('--out', $Out) }
  & node @args
  if ($LASTEXITCODE -ne 0) {
    Write-Host "  [警告] node 基准脚本退出码: $LASTEXITCODE" -ForegroundColor Yellow
  }
} else {
  Write-Host "`n[2/4] 已跳过 node 自测量 (-AttachOnly)" -ForegroundColor DarkGray
}

# ---------- 3. 附加测量正在运行的 Electron / Lumina 进程 ----------
Write-Host "`n[3/4] 附加测量正在运行的 Electron / Lumina 进程 ..."
$procs = Get-Process -Name electron,Lumina -ErrorAction SilentlyContinue
if (-not $procs) {
  Write-Host "  当前没有正在运行的 electron / Lumina 进程。" -ForegroundColor DarkGray
  Write-Host "  若要测应用级 idle，请先启动应用 (npm run dev 或 lumina.cmd)，再运行本脚本。"
} else {
  Write-Host ("  发现 {0} 个相关进程，采样 3 次（间隔 2s）..." -f $procs.Count)
  $rows = @()
  for ($i = 0; $i -lt 3; $i++) {
    foreach ($p in $procs) {
      try {
        $fresh = Get-Process -Id $p.Id -ErrorAction SilentlyContinue
        if ($fresh) {
          $rows += [PSCustomObject]@{
            Sample   = $i
            Name     = $fresh.ProcessName
            Id       = $fresh.Id
            WS_MB    = [math]::Round($fresh.WorkingSet64 / 1MB, 1)
            CPU_s    = [math]::Round($fresh.CPU, 2)
            Threads  = $fresh.Threads.Count
          }
        }
      } catch {}
    }
    if ($i -lt 2) { Start-Sleep -Seconds 2 }
  }
  $rows | Format-Table -AutoSize | Out-String | Write-Host
  # 按 PID 汇总平均内存
  $summary = $rows | Group-Object Id | ForEach-Object {
    [PSCustomObject]@{
      Name   = $_.Group[0].Name
      Id     = $_.Name
      AvgWS_MB = [math]::Round(($_.Group | Measure-Object WS_MB -Average).Average, 1)
      MaxWS_MB = [math]::Round(($_.Group | Measure-Object WS_MB -Maximum).Maximum, 1)
    }
  }
  Write-Host "  各进程平均内存 (MB):"
  $summary | Format-Table -AutoSize | Out-String | Write-Host
  $totalMB = [math]::Round(($summary | Measure-Object AvgWS_MB -Sum).Sum, 1)
  Write-Host "  所有相关进程 RSS 合计 (约): $totalMB MB"
}

# ---------- 4. 提示 Electron 内运行选项 ----------
Write-Host "`n[4/4] Electron 运行环境检测 ..."
$builtMain = Join-Path $ProjectRoot 'out\main\index.js'
if (Test-Path $builtMain) {
  Write-Host "  检测到构建产物: out/main/index.js"
  Write-Host "  说明: 当前主进程 (electron/main.ts) 未内置 --benchmark flag。"
  Write-Host "  如需在 Electron 主进程内测量 getProcessMemoryInfo / app.getAppMetrics，"
  Write-Host "  可在 main.ts 的 CLI 模式分支增加 --benchmark 分支调用本脚本，或在 dev 模式下"
  Write-Host "  启动应用后用本脚本的 Get-Process 附加测量（见上一步）。"
  $electronExe = Join-Path $ProjectRoot 'node_modules\electron\dist\electron.exe'
  if (Test-Path $electronExe) {
    Write-Host "  Electron 可执行文件: node_modules\electron\dist\electron.exe (存在)"
  }
} else {
  Write-Host "  未发现 out/main/index.js，请先 npm run build。" -ForegroundColor DarkGray
}

# ---------- 输出结果文件路径 ----------
$jsonPath = if ($Out -ne '') { $Out } else { Join-Path $PSScriptRoot 'benchmark-results.json' }
Write-Host "`n----------------------------------------------------------"
Write-Host " JSON 结果文件: $jsonPath"
if (Test-Path $jsonPath) {
  Write-Host " 文件大小: $([math]::Round((Get-Item $jsonPath).Length/1KB,1)) KB"
}
Write-Host "=========================================================="
