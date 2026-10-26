# Plugin-based daily collection entry (replaces the CDP chain).
#
# Why a separate entry instead of editing run-daily.ps1 in place:
# run-daily.ps1 drives check_daily.mjs as a gate, and that gate understands the
# CDP on-disk layout (one folder per page). The plugin chain writes one file per
# command. Swapping the gate is a separate change and must be verified first.
# Keeping both entries alive until the plugin chain is proven is the only way to
# avoid ending up with two broken paths at once.
#
# Prerequisites:
#   1. Chrome is open with the taobao-cli bridge extension enabled.
#   2. The shop account is saved in the extension (tb account save <name>).
#   3. runtime/sycm-cli/.venv exists (see docs/ops/PLUGIN-COLLECTOR-PLAN-2026-10-25.md).
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts/run-plugin-daily.ps1
#   powershell -ExecutionPolicy Bypass -File scripts/run-plugin-daily.ps1 -Date 2026-10-24
#   powershell -ExecutionPolicy Bypass -File scripts/run-plugin-daily.ps1 -Account fanhe
#   powershell -ExecutionPolicy Bypass -File scripts/run-plugin-daily.ps1 -SkipCollect
#
# Exit codes:
#   0  collection and payload export both succeeded
#   2  collection finished with failed commands (data is on disk)
#   3  precondition failed (plugin offline, CLI missing)
#   4  payload export failed

param(
  [string]$Date = "",
  [string]$Account = "",
  [switch]$SkipCollect
)

$ErrorActionPreference = "Stop"
$ROOT = Split-Path -Parent $PSScriptRoot

if ($Date -eq "") {
  $Date = (Get-Date).AddDays(-1).ToString("yyyy-MM-dd")
}
if ($Date -notmatch '^\d{4}-\d{2}-\d{2}$') {
  Write-Host "[FAIL] -Date must be yyyy-MM-dd, got: $Date"
  exit 1
}

Write-Host "=== plugin daily collection ==="
Write-Host ("date   : " + $Date)
Write-Host ("shop   : " + $(if ($Account -eq "") { "all collectable" } else { $Account }))
Write-Host ""

$node = (Get-Command node -ErrorAction SilentlyContinue)
if ($null -eq $node) {
  Write-Host "[FAIL] node not found on PATH"
  exit 3
}

$collectScript = Join-Path $ROOT "scripts\collect-via-plugin.mjs"
$exportScript = Join-Path $ROOT "scripts\export-sycm-ingest.mjs"

if (-not (Test-Path $collectScript)) {
  Write-Host ("[FAIL] missing " + $collectScript)
  exit 3
}

# ---- 1. collect ----
if (-not $SkipCollect) {
  $collectArgs = @($collectScript, "--date", $Date)
  if ($Account -ne "") { $collectArgs += @("--account", $Account) }
  & $node.Source @collectArgs
  $collectCode = $LASTEXITCODE
  Write-Host ("collect exit = " + $collectCode)
  if ($collectCode -eq 3) {
    Write-Host "[FAIL] plugin offline or CLI unusable. Open Chrome, click the bridge icon once."
    exit 3
  }
  if ($collectCode -ne 0) {
    Write-Host "[WARN] some commands failed. Data is on disk; inspect before exporting."
  }
} else {
  Write-Host "collect skipped"
}

# ---- 2. export to ops-ingest.v1 ----
$exportArgs = @($exportScript, "--date", $Date)
if ($Account -ne "") { $exportArgs += @("--account", $Account) }
& $node.Source @exportArgs
$exportCode = $LASTEXITCODE
Write-Host ("export exit = " + $exportCode)
if ($exportCode -eq 1) {
  Write-Host "[FAIL] no payload produced"
  exit 4
}
if ($exportCode -eq 2) {
  Write-Host "[WARN] payload produced but summary is incomplete."
  Write-Host "       Do NOT enable the scheduled job yet: ingest clears rows by type,"
  Write-Host "       so a 9-item summary will shrink the window to 9 items."
}

# ---- 3. next step ----
$payloadDir = Join-Path $ROOT ("data\payload\" + $Date)
Write-Host ""
Write-Host ("payload dir: " + $payloadDir)
Write-Host "Import with:"
Write-Host ("  cd " + (Split-Path -Parent (Split-Path -Parent $ROOT)))
Write-Host ("  pnpm db:ops-import " + $payloadDir)
Write-Host ""
Write-Host "Verify in the dashboard: /ops/trade?p=1d&shop=<code>"

if ($exportCode -eq 2) { exit 2 }
exit 0
