# Diagnostic harness for the Prisma CLI.
# PowerShell 5.1 wraps native command stderr in ErrorRecord objects and the
# pipeline mangles it, so every invocation goes through the .NET process API
# with both streams read to end.
#
# Note: ProcessStartInfo.ArgumentList only exists on .NET Core. This runs on
# Windows PowerShell 5.1 (.NET Framework), so the argument string is assembled
# by hand with explicit quoting - the workspace path contains a space.
#
# 本文件由 .tmp 归档而来，盘符换成由脚本位置推导出的工作区根。同目录的
# prisma-gen.ps1、migrate.ps1 与 checks\gates.ps1 都复刻了这套进程调用写法。

$ErrorActionPreference = 'Continue'

$wsRoot = if ($env:WS_ROOT) {
    $env:WS_ROOT
} else {
    Split-Path -Parent (Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)))
}

. (Join-Path $wsRoot 'infra\portable\ws-env.ps1') -NoRepair -Quiet

$apiDir = Join-Path $wsRoot 'projects\fanhe-work\apps\api'
$tmp    = Join-Path $wsRoot '.tmp'
$out    = Join-Path $tmp 'prisma-diag.txt'

if (-not (Test-Path -LiteralPath $tmp)) {
    $null = New-Item -ItemType Directory -Path $tmp -Force
}

function Invoke-Tool {
    param(
        [string]$Label,
        [string]$FilePath,
        [string[]]$Arguments,
        [string]$WorkingDirectory
    )
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName               = $FilePath
    $psi.WorkingDirectory       = $WorkingDirectory
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError  = $true
    $psi.UseShellExecute        = $false
    $psi.CreateNoWindow         = $true
    $psi.Arguments = ($Arguments | ForEach-Object { '"' + $_ + '"' }) -join ' '

    $p = [System.Diagnostics.Process]::Start($psi)
    $stdoutTask = $p.StandardOutput.ReadToEndAsync()
    $stderrTask = $p.StandardError.ReadToEndAsync()
    $p.WaitForExit()

    return @(
        "===== $Label =====",
        "exit: $($p.ExitCode)",
        "--- stdout ---",
        $stdoutTask.Result.TrimEnd(),
        "--- stderr ---",
        $stderrTask.Result.TrimEnd(),
        ""
    )
}

$nodeExe   = (Get-Command node -All | Where-Object { $_.Source -like '*.exe' } | Select-Object -First 1).Source
$prismaBin = Join-Path $apiDir 'node_modules\prisma\build\index.js'

$lines = @()
$lines += "node: $nodeExe"
$lines += "prisma bin exists: $(Test-Path -LiteralPath $prismaBin)"
$lines += ""
$lines += Invoke-Tool -Label 'prisma --version' -FilePath $nodeExe -Arguments @($prismaBin, '--version') -WorkingDirectory $apiDir
$lines += Invoke-Tool -Label 'prisma validate'  -FilePath $nodeExe -Arguments @($prismaBin, 'validate')  -WorkingDirectory $apiDir

$lines -join "`r`n" | Set-Content -LiteralPath $out -Encoding UTF8
