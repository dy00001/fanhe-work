# Docker 工作空间卫生检查。
#
# 检查三件事：ws-env.ps1 是否把 DOCKER_CONFIG 清掉了（指向空目录会让
# `docker compose` 变成未知命令）、docker 可执行文件落在哪里、以及 compose 本身
# 能不能跑通。
#
# 每一步都经 .NET 进程 API 调用，理由见 prisma-diag.ps1 顶部。
#
# 本文件由 .tmp 归档而来，盘符换成由脚本位置推导出的工作区根。

$ErrorActionPreference = 'Continue'

$wsRoot = if ($env:WS_ROOT) {
    $env:WS_ROOT
} else {
    Split-Path -Parent (Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)))
}

. (Join-Path $wsRoot 'infra\portable\ws-env.ps1') -NoRepair -Quiet

$repo = Join-Path $wsRoot 'projects\fanhe-work'
$tmp  = Join-Path $wsRoot '.tmp'
$out  = Join-Path $tmp 'docker-check.txt'

if (-not (Test-Path -LiteralPath $tmp)) {
    $null = New-Item -ItemType Directory -Path $tmp -Force
}

$lines = @()

if ($null -eq $env:DOCKER_CONFIG) {
    $lines += 'DOCKER_CONFIG: 未设置（预期）'
} else {
    $lines += "DOCKER_CONFIG: $env:DOCKER_CONFIG  <-- 仍被设置，修复未生效"
}

$lines += "WS_ROOT: $env:WS_ROOT"
$lines += "docker 可执行文件: $((Get-Command docker -ErrorAction SilentlyContinue).Source)"
$lines += ''

foreach ($argSet in @(@('compose', 'version'), @('context', 'ls'), @('ps', '--format', '{{.Names}}'))) {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName               = 'docker'
    $psi.WorkingDirectory       = $repo
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError  = $true
    $psi.UseShellExecute        = $false
    $psi.CreateNoWindow         = $true
    $psi.Arguments = ($argSet | ForEach-Object { '"' + $_ + '"' }) -join ' '

    $p = [System.Diagnostics.Process]::Start($psi)
    $o = $p.StandardOutput.ReadToEndAsync()
    $e = $p.StandardError.ReadToEndAsync()
    $p.WaitForExit()

    $lines += "===== docker $($argSet -join ' ') ====="
    $lines += "exit: $($p.ExitCode)"
    if ($o.Result.Trim().Length -gt 0) { $lines += $o.Result.TrimEnd() }
    if ($e.Result.Trim().Length -gt 0) { $lines += "stderr: $($e.Result.TrimEnd())" }
    $lines += ''
}

$lines -join "`r`n" | Set-Content -LiteralPath $out -Encoding UTF8
