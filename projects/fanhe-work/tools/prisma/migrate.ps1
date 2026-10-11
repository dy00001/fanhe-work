# Apply the initial migration to the real PostgreSQL instance.
#
# Same .NET process API pattern as the other harnesses in this directory: after
# dot-sourcing ws-env.ps1, $ErrorActionPreference is Stop and PowerShell 5.1
# turns a native command's stderr output into a terminating ErrorRecord. Prisma
# always writes progress notices to stderr, so `& prisma ...` cannot be used.
#
# 本文件由 .tmp 归档而来，盘符换成由脚本位置推导出的工作区根。
#
# 注意：这是当初真实库还不可达时用的引导脚本，主路径是 `pnpm db:deploy`。留着它是
# 因为它额外捕获应用前后的 `migrate status`，那个对照在排查「迁移到底应用上没有」
# 时比 deploy 自己的输出更直观。

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
    param([string[]]$Arguments)
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName               = $nodeExe
    $psi.WorkingDirectory       = $apiDir
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

$r = Invoke-Prisma -Arguments @('migrate', 'status')
$lines += '===== migrate status（应用前）====='
$lines += "exit: $($r.Exit)"
$lines += $r.Out.TrimEnd()
$lines += $r.Err.TrimEnd()
$lines += ''

$r = Invoke-Prisma -Arguments @('migrate', 'deploy')
$lines += '===== migrate deploy ====='
$lines += "exit: $($r.Exit)"
$lines += $r.Out.TrimEnd()
$lines += $r.Err.TrimEnd()
$lines += ''

$r = Invoke-Prisma -Arguments @('migrate', 'status')
$lines += '===== migrate status（应用后）====='
$lines += "exit: $($r.Exit)"
$lines += $r.Out.TrimEnd()
$lines += $r.Err.TrimEnd()

$lines -join "`r`n" | Set-Content -LiteralPath (Join-Path $tmp 'migrate-deploy.txt') -Encoding UTF8
