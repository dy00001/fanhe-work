<#
  ws-run.ps1
  Primary entry point. Applies the portable environment, then runs a command in
  the caller's directory. Because the environment is applied in this process,
  every child process inherits the redirected paths. Falls back to the workspace
  root only when invoked from outside the workspace.

  Examples
      powershell -ExecutionPolicy Bypass -File infra\portable\ws-run.ps1 npm install
      powershell -ExecutionPolicy Bypass -File infra\portable\ws-run.ps1 python -m pytest
      powershell -ExecutionPolicy Bypass -File infra\portable\ws-run.ps1 -Shell
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0, ValueFromRemainingArguments = $true)]
    [string[]]$Command,
    [switch]$Shell
)

$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'ws-env.ps1')

if ($Shell) {
    Write-Host '[ws] interactive shell. Workspace environment is active.' -ForegroundColor DarkCyan
    Write-Host ('[ws] root = ' + $env:WS_ROOT) -ForegroundColor DarkCyan
    $Host.UI.RawUI.WindowTitle = 'ws shell ' + $env:WS_ROOT
    return
}

if (-not $Command -or $Command.Count -eq 0) {
    Write-Host '[ws] no command supplied. Environment applied to this process.' -ForegroundColor DarkCyan
    Write-Host ('[ws] root = ' + $env:WS_ROOT) -ForegroundColor DarkCyan
    Get-ChildItem env: |
        Where-Object { $_.Name -like 'WS_*' -or $_.Name -in @('TMP', 'TEMP', 'GOPATH', 'CARGO_HOME', 'GRADLE_USER_HOME', 'VIRTUAL_ENV') } |
        Sort-Object Name |
        Format-Table Name, Value -AutoSize
    return
}

$exe     = $Command[0]
$cmdArgs = @()
if ($Command.Count -gt 1) { $cmdArgs = $Command[1..($Command.Count - 1)] }

# Keep the caller's working directory when it is already inside the workspace,
# and fall back to the root only when invoked from outside. The redirection is
# applied through process-level environment variables, so the working directory
# has nothing to do with it.
#
# Forcing a cd to the root used to be harmless because projects lived at the top
# level. Once they moved under projects\<name>\ it stopped being harmless: the
# root has no package.json, so `pnpm install` and friends ran in the wrong
# directory without printing anything about it.
$wsCurrentPath = [System.IO.Path]::GetFullPath((Get-Location).Path)
$wsRootPath    = [System.IO.Path]::GetFullPath($env:WS_ROOT)
$wsInsideRoot  = $false

if ($wsCurrentPath.Equals($wsRootPath, [System.StringComparison]::OrdinalIgnoreCase)) {
    $wsInsideRoot = $true
} else {
    # Both sides are normalised by GetFullPath, so separators are consistent and
    # a plain prefix test is enough. The trailing separator stops "fanhe Work-2"
    # from being treated as a subdirectory of "fanhe Work".
    $wsPrefix = $wsRootPath.TrimEnd([char[]]@(92, 47)) + '\'
    if ($wsCurrentPath.StartsWith($wsPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        $wsInsideRoot = $true
    }
}

if (-not $wsInsideRoot) { Push-Location $env:WS_ROOT }
try {
    & $exe @cmdArgs
    $code = $LASTEXITCODE
    if ($null -eq $code) { $code = 0 }
} finally {
    if (-not $wsInsideRoot) { Pop-Location }
}
exit $code
