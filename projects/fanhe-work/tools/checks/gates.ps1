# Gate checks for the fanhe-work repository.
#
# Every tool is invoked as `node <entry.js>` rather than through its .cmd shim.
# Two reasons: the .NET process API cannot start a .cmd without a shell, and
# ws-env.ps1 sets $ErrorActionPreference = 'Stop', which turns a native
# command's stderr output into a terminating ErrorRecord on PowerShell 5.1.
#
# 本文件由 .tmp 归档而来。归档时把硬编码的 F:\fanhe Work 换成由脚本位置推导出的
# 工作区根 —— 受版本控制的文件不写盘符（工作区约定），这份脚本要跟着介质换机器。

$ErrorActionPreference = 'Continue'

# 工作区根：ws-env.ps1 会导出 WS_ROOT，但我们要在 dot-source 它之前就知道路径，
# 因此未设置时从本脚本所在目录（tools\<分类>\）向上四级推导到工作区根。
$wsRoot = if ($env:WS_ROOT) {
    $env:WS_ROOT
} else {
    Split-Path -Parent (Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)))
}

. (Join-Path $wsRoot 'infra\portable\ws-env.ps1') -NoRepair -Quiet

$repo    = Join-Path $wsRoot 'projects\fanhe-work'
$tmp     = Join-Path $wsRoot '.tmp'
$nodeExe = (Get-Command node -All | Where-Object { $_.Source -like '*.exe' } | Select-Object -First 1).Source

# .tmp 是被清理过的临时目录，脚本直接跑时可能不存在。原版假定它已经在，归档后补上
# 这一句：少一个目录就报「找不到路径」会让人以为是脚本坏了。
if (-not (Test-Path -LiteralPath $tmp)) {
    $null = New-Item -ItemType Directory -Path $tmp -Force
}

function Get-BinPath {
    param([string]$PackageJsonPath, [string]$BinName)
    $pkg = Get-Content -LiteralPath $PackageJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $rel = $pkg.bin
    if ($rel -isnot [string]) { $rel = $rel.$BinName }
    return Join-Path (Split-Path -Parent $PackageJsonPath) $rel
}

function Invoke-Node {
    param([string]$Label, [string[]]$Arguments, [string]$WorkingDirectory = $repo)
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName               = $nodeExe
    $psi.WorkingDirectory       = $WorkingDirectory
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError  = $true
    $psi.UseShellExecute        = $false
    $psi.CreateNoWindow         = $true
    $psi.Arguments = ($Arguments | ForEach-Object { '"' + $_ + '"' }) -join ' '

    $p = [System.Diagnostics.Process]::Start($psi)
    $o = $p.StandardOutput.ReadToEndAsync()
    $e = $p.StandardError.ReadToEndAsync()
    $p.WaitForExit()
    return [pscustomobject]@{ Label = $Label; Exit = $p.ExitCode; Out = $o.Result; Err = $e.Result }
}

$eslintBin   = Join-Path $repo 'node_modules\eslint\bin\eslint.js'
$prettierBin = Get-BinPath -PackageJsonPath (Join-Path $repo 'node_modules\prettier\package.json') -BinName 'prettier'
$sharedTsc   = Join-Path $repo 'packages\shared\node_modules\typescript\bin\tsc'
$apiTsc      = Join-Path $repo 'apps\api\node_modules\typescript\bin\tsc'
$webTsc      = Join-Path $repo 'apps\web\node_modules\typescript\bin\tsc'
$prismaBin   = Join-Path $repo 'apps\api\node_modules\prisma\build\index.js'

$results = @()

$results += Invoke-Node -Label 'prettier write'   -Arguments @($prettierBin, '--write', '.')
$results += Invoke-Node -Label 'shared build'     -Arguments @($sharedTsc, '-p', 'packages/shared/tsconfig.json')
$results += Invoke-Node -Label 'prisma generate'  -Arguments @($prismaBin, 'generate') -WorkingDirectory (Join-Path $repo 'apps\api')
$results += Invoke-Node -Label 'typecheck api'    -Arguments @($apiTsc, '--noEmit', '-p', 'apps/api/tsconfig.json')
$results += Invoke-Node -Label 'typecheck web'    -Arguments @($webTsc, '--noEmit', '-p', 'apps/web/tsconfig.json')
$results += Invoke-Node -Label 'typecheck shared' -Arguments @($sharedTsc, '--noEmit', '-p', 'packages/shared/tsconfig.json')
$results += Invoke-Node -Label 'eslint'           -Arguments @($eslintBin, '.')
$results += Invoke-Node -Label 'prettier check'   -Arguments @($prettierBin, '--check', '.')

$lines = @()
foreach ($r in $results) {
    $lines += "===== $($r.Label) ====="
    $lines += "exit: $($r.Exit)"
    if ($r.Out.Trim().Length -gt 0) { $lines += '--- stdout ---'; $lines += $r.Out.TrimEnd() }
    if ($r.Err.Trim().Length -gt 0) { $lines += '--- stderr ---'; $lines += $r.Err.TrimEnd() }
    $lines += ''
}
$lines += '===== summary ====='
foreach ($r in $results) { $lines += ("{0,-18} exit={1}" -f $r.Label, $r.Exit) }

$lines -join "`r`n" | Set-Content -LiteralPath (Join-Path $tmp 'gates.txt') -Encoding UTF8
