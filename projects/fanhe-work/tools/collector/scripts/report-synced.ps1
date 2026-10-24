# Report a successful collection back to the platform (clear the pending flag,
# record the login state, refresh the heartbeat).
#
# Why this is a separate file: run-daily.ps1 can only be exercised by running a
# real collection against a logged-in Edge. The write-back has nothing to do with
# Edge -- it is one DB call -- so keeping it here makes it testable on its own,
# and gives a manual escape hatch for "I already collected by hand, mark it".
#
# Usage
#   powershell -ExecutionPolicy Bypass -File scripts/report-synced.ps1 -Shop s2
#   powershell -ExecutionPolicy Bypass -File scripts/report-synced.ps1 -All
#
# Exit codes
#   0 written
#   1 setup problem (no node, no tsx, no apps/api)
#   2 the CLI rejected the arguments
#
# Keep this file pure ASCII: Windows PowerShell 5.1 reads BOM-less files as ANSI.

param(
  [string]$Shop = "",
  [switch]$All
)

$ErrorActionPreference = "Stop"

if (-not $Shop -and -not $All) {
  Write-Host "need -Shop <code> or -All"
  exit 2
}

# Repo root is two levels above the collector dir: tools\collector -> tools -> repo.
$ROOT = Split-Path -Parent $PSScriptRoot
$repoRoot = Split-Path -Parent (Split-Path -Parent $ROOT)
$apiDir = Join-Path $repoRoot "apps\api"
$tsx = Join-Path $apiDir "node_modules\.bin\tsx.cmd"

if (-not (Test-Path $tsx)) {
  Write-Host ("tsx not found at " + $tsx)
  exit 1
}

# tsx.cmd calls a bare `node`. The portable runtime is not on the machine PATH,
# so put the directory of whichever node we can find in front of it.
$NODE = Join-Path $env:USERPROFILE ".workbuddy\binaries\node\versions\22.22.2-6\node.exe"
if (-not (Test-Path $NODE)) {
  $NODE = Get-ChildItem "$env:USERPROFILE\.workbuddy\binaries\node\versions" -Directory -ErrorAction SilentlyContinue |
    Sort-Object Name -Descending |
    ForEach-Object { Join-Path $_.FullName "node.exe" } |
    Where-Object { Test-Path $_ } |
    Select-Object -First 1
}
if ($NODE) { $env:PATH = (Split-Path -Parent $NODE) + ";" + $env:PATH }

$cliArgs = @("src\tools\ops-mark-synced.ts")
if ($All) {
  $cliArgs += "--all"
} else {
  $cliArgs += @("--codes", $Shop)
}

Push-Location $apiDir
$ErrorActionPreference = "Continue"
& $tsx @cliArgs 2>&1 | Out-String | Write-Host
$code = $LASTEXITCODE
$ErrorActionPreference = "Stop"
Pop-Location

exit $code
