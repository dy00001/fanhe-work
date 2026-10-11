# Generate the Prisma client and export the initial migration DDL.
#
# Runs the CLI through the .NET process API for the reason documented in
# prisma-diag.ps1: ws-env.ps1 sets $ErrorActionPreference = 'Stop', and
# PowerShell 5.1 turns a native command's stderr output into an ErrorRecord,
# which then terminates the script. Prisma always writes progress notices to
# stderr, so the plain `& tool args` form cannot be used here.
#
# 本文件由 .tmp 归档而来，盘符换成由脚本位置推导出的工作区根。
#
# 产物 `.tmp\init.sql` 是从空库推到当前 schema 的完整 DDL（`migrate diff
# --from-empty`），当初用来在真库不可达时核验空库重建链路。它与
# migrations\20261010150103_init\migration.sql 内容同源但现在已不同步 ——
# 后者只覆盖第一个迁移，前者覆盖当时全部迁移。要拿最新 DDL 就重跑这个脚本。

$ErrorActionPreference = 'Continue'

$wsRoot = if ($env:WS_ROOT) {
    $env:WS_ROOT
} else {
    Split-Path -Parent (Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)))
}

. (Join-Path $wsRoot 'infra\portable\ws-env.ps1') -NoRepair -Quiet

$apiDir    = Join-Path $wsRoot 'projects\fanhe-work\apps\api'
$tmp       = Join-Path $wsRoot '.tmp'
$nodeExe   = (Get-Command node -All | Where-Object { $_.Source -like '*.exe' } | Select-Object -First 1).Source
$prismaBin = Join-Path $apiDir 'node_modules\prisma\build\index.js'

if (-not (Test-Path -LiteralPath $tmp)) {
    $null = New-Item -ItemType Directory -Path $tmp -Force
}

function Invoke-Prisma {
    param([string[]]$Arguments, [string]$WorkingDirectory = $apiDir)
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName               = $nodeExe
    $psi.WorkingDirectory       = $WorkingDirectory
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError  = $true
    $psi.UseShellExecute        = $false
    $psi.CreateNoWindow         = $true
    $psi.Arguments = (@($prismaBin) + $Arguments | ForEach-Object { '"' + $_ + '"' }) -join ' '

    $p = [System.Diagnostics.Process]::Start($psi)
    $o = $p.StandardOutput.ReadToEndAsync()
    $e = $p.StandardError.ReadToEndAsync()
    $p.WaitForExit()
    return [pscustomobject]@{ Exit = $p.ExitCode; Out = $o.Result; Err = $e.Result }
}

$lines = @()

$r = Invoke-Prisma -Arguments @('generate')
$lines += '===== prisma generate ====='
$lines += "exit: $($r.Exit)"
$lines += '--- stdout ---'; $lines += $r.Out.TrimEnd()
$lines += '--- stderr ---'; $lines += $r.Err.TrimEnd()
$lines += ''

$r = Invoke-Prisma -Arguments @('migrate', 'diff', '--from-empty', '--to-schema', 'prisma/schema.prisma', '--script')
$lines += '===== prisma migrate diff (from-empty -> schema) ====='
$lines += "exit: $($r.Exit)"
$lines += '--- stderr ---'; $lines += $r.Err.TrimEnd()
$lines += ''

if ($r.Exit -eq 0 -and $r.Out.Trim().Length -gt 0) {
    $r.Out | Set-Content -LiteralPath (Join-Path $tmp 'init.sql') -Encoding UTF8
    $lines += "SQL written to .tmp\init.sql, $((($r.Out -split "`n").Count)) lines"
} else {
    $lines += 'No SQL produced.'
    $lines += '--- stdout ---'; $lines += $r.Out.TrimEnd()
}

$lines -join "`r`n" | Set-Content -LiteralPath (Join-Path $tmp 'prisma-gen.txt') -Encoding UTF8
