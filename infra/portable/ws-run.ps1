<#
  ws-run.ps1
  Primary entry point. Applies the portable environment, then runs a command
  inside it. Because the environment is applied in this process, every child
  process inherits the redirected paths.

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

Push-Location $env:WS_ROOT
try {
    & $exe @cmdArgs
    $code = $LASTEXITCODE
    if ($null -eq $code) { $code = 0 }
} finally {
    Pop-Location
}
exit $code
