# Drift check: diff the live database against the schema file.
#
# --from-config-datasource reads the datasource out of prisma.config.ts, which is
# the real instance. --exit-code makes the result machine readable:
#   0 = diff is empty (no drift), 1 = error, 2 = diff is not empty (drift).
#
# This is the check that answers "did the migration actually produce the schema
# we described", which applying the migration alone does not prove.
#
# 本文件由 .tmp 归档而来，盘符换成由脚本位置推导出的工作区根。

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

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName               = $nodeExe
$psi.WorkingDirectory       = $apiDir
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError  = $true
$psi.UseShellExecute        = $false
$psi.CreateNoWindow         = $true
$psi.Arguments = (@(
    $prismaBin,
    'migrate', 'diff',
    '--from-config-datasource',
    '--to-schema', 'prisma/schema.prisma',
    '--script',
    '--exit-code'
) | ForEach-Object { '"' + $_ + '"' }) -join ' '

$p = [System.Diagnostics.Process]::Start($psi)
$o = $p.StandardOutput.ReadToEndAsync()
$e = $p.StandardError.ReadToEndAsync()
$p.WaitForExit()

$lines = @()
$lines += "exit: $($p.ExitCode)"
switch ($p.ExitCode) {
    0 { $lines += '判定: 无漂移，库结构与 schema 完全一致' }
    2 { $lines += '判定: 存在漂移，下面是差异 SQL' }
    default { $lines += '判定: 执行出错' }
}
$lines += ''
$lines += '--- stdout ---'
$lines += $o.Result.TrimEnd()
$lines += '--- stderr ---'
$lines += $e.Result.TrimEnd()

$lines -join "`r`n" | Set-Content -LiteralPath (Join-Path $tmp 'drift-check.txt') -Encoding UTF8
