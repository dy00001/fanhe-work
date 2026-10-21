# Chain the whole daily pipeline: collect -> export -> verify -> import -> verify DB.
#
# Why this script exists
#   Until now the five steps were run by hand, one at a time, in two different
#   directories. Two things went wrong because of that:
#     - steps got skipped (the export and the import were never scheduled at all)
#     - nobody checked the seam between steps, so "collector says complete,
#       exporter says nothing" was invisible. The channel dimension on 10-19 is
#       exactly that case: 2 files saved, byte count fine, thin=false, yet the
#       tree endpoint never fired and the channel board stayed empty.
#
# What each step is responsible for (do not merge them)
#   1 collect-daily.mjs        browser -> raw JSON for one day. Never merges.
#   2 export-daily-ingest.mjs  raw JSON -> ingest contract. Rejects a window that
#                              disagrees with the target date.
#   3 verify-daily.mjs         contract <-> manifest cross-check. Blocks only
#                              when wrong data would be written, not when data
#                              is merely missing.
#   4 ops-import.ts            contract -> database, same code path as the HTTP
#                              ingest endpoint.
#   5 ops-verify.ts            database <-> contract. The only step that reads
#                              back what actually landed.
#
# Usage
#   powershell -ExecutionPolicy Bypass -File scripts/run-pipeline.ps1
#   powershell -ExecutionPolicy Bypass -File scripts/run-pipeline.ps1 -Target 2026-10-19
#   powershell -ExecutionPolicy Bypass -File scripts/run-pipeline.ps1 -SkipCollect
#   powershell -ExecutionPolicy Bypass -File scripts/run-pipeline.ps1 -NoImport
#
# Exit codes
#   0 every step clean
#   2 data landed, but some dimension is missing (thin page, known gap)
#   1 aborted: a step failed, or the pre-import check blocked the write
#
# Keep the file pure ASCII: Windows PowerShell 5.1 reads BOM-less files as ANSI,
# and non-ASCII bytes make the parser fail with "unexpected token".

param(
  [string]$Target = "",
  [switch]$SkipCollect,
  [switch]$NoImport
)

$ErrorActionPreference = "Stop"

# The child scripts print UTF-8 Chinese. Windows PowerShell 5.1 defaults the
# console to the ANSI code page, so the log comes out as mojibake and the
# operator cannot read the reason a step failed.
try {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  $OutputEncoding = [System.Text.Encoding]::UTF8
} catch {
  Write-Host "console encoding not switched to UTF-8; Chinese output may be garbled"
}

$ROOT = Split-Path -Parent $PSScriptRoot
$REPO = Resolve-Path (Join-Path $ROOT "..\..")
$API = Join-Path $REPO "apps\api"
# tsx must be started through its shim, not through `node ...\tsx\dist\cli.mjs`.
# Calling the cli module directly runs it under plain node, the TypeScript loader
# is never registered, and every `import './x.js'` fails with ERR_MODULE_NOT_FOUND
# because only the .ts file exists on disk. The shim sets the loader up itself.
$TSX = Join-Path $API "node_modules\.bin\tsx.cmd"

$NODE = Join-Path $env:USERPROFILE ".workbuddy\binaries\node\versions\22.22.2-6\node.exe"
if (-not (Test-Path $NODE)) {
  $NODE = Get-ChildItem "$env:USERPROFILE\.workbuddy\binaries\node\versions" -Directory -ErrorAction SilentlyContinue |
    Sort-Object Name -Descending |
    ForEach-Object { Join-Path $_.FullName "node.exe" } |
    Where-Object { Test-Path $_ } |
    Select-Object -First 1
}
if (-not $NODE) { $NODE = "node" }

if (-not (Test-Path $TSX)) {
  Write-Host ("tsx not found: " + $TSX)
  Write-Host "Run pnpm install first. The import step cannot run without it."
  exit 1
}

# Resolve the business day: explicit -Target wins, otherwise the newest dated
# directory. Newest-dir is the right default for an unattended run started right
# after collection; it is wrong for a backfill, which is why -Target exists.
if (-not $Target) {
  $latest = Get-ChildItem (Join-Path $ROOT "data\daily") -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '^\d{4}-\d{2}-\d{2}$' } |
    Sort-Object Name |
    Select-Object -Last 1
  if (-not $latest) { Write-Host "No dated directory under data\daily."; exit 1 }
  $Target = $latest.Name
}
if ($Target -notmatch '^\d{4}-\d{2}-\d{2}$') {
  Write-Host ("Bad -Target: " + $Target)
  exit 1
}

$CONTRACT = Join-Path $ROOT ("data\ingest\ops-daily-" + $Target + ".json")
$gaps = @()
$failed = ""

function Invoke-Child {
  param([string]$Exe, [string]$WorkDir, [string[]]$Arguments)
  Push-Location $WorkDir
  $ErrorActionPreference = "Continue"
  # Out-Host, not Out-String: inside a function every uncaptured pipeline object
  # becomes part of the return value, so Out-String would make $code an array of
  # the child's output plus the exit code, and every -eq comparison would be
  # against an array. Out-Host writes straight to the console and leaves the
  # return value as the integer exit code only.
  & $Exe @Arguments 2>&1 | Out-Host
  $code = $LASTEXITCODE
  $ErrorActionPreference = "Stop"
  Pop-Location
  return $code
}

Write-Host ("repo     : " + $REPO)
Write-Host ("node     : " + $NODE)
Write-Host ("day      : " + $Target)
Write-Host ("contract : " + $CONTRACT)
Write-Host ""

# ---- 1. collect -------------------------------------------------------------
# Exit 3 means the login state is gone: no page was touched, retrying is
# pointless. Exit 2 means some pages are still thin but the data on disk is
# usable, so it is a gap rather than a failure.
if (-not $SkipCollect) {
  Write-Host "---- 1/5 collect ----"
  $code = Invoke-Child $NODE $ROOT @((Join-Path $ROOT "scripts\collect-daily.mjs"), "--date", $Target)
  if ($code -eq 0) {
    Write-Host "collect: ok"
  } elseif ($code -eq 2) {
    Write-Host "collect: some pages thin (data on disk)"
    $gaps += "collect: thin pages"
  } elseif ($code -eq 3) {
    $failed = "collect: login state lost, re-login in the collector browser profile"
  } else {
    $failed = "collect: exit " + $code
  }
  Write-Host ""
} else {
  Write-Host "---- 1/5 collect: skipped ----"
  Write-Host ""
}

if ($failed) { Write-Host ("ABORT  " + $failed); exit 1 }

# ---- 2. export --------------------------------------------------------------
# Exit 1 is structural: the response date disagrees with the target date, or no
# overview row could be recognised. Never let that file be imported.
Write-Host "---- 2/5 export ----"
$code = Invoke-Child $NODE $ROOT @(
  (Join-Path $ROOT "scripts\export-daily-ingest.mjs"),
  "--dir", (Join-Path $ROOT ("data\daily\" + $Target))
)
if ($code -eq 0) {
  Write-Host "export: ok"
} elseif ($code -eq 2) {
  Write-Host "export: written with gaps"
  $gaps += "export: incomplete coverage"
} else {
  $failed = "export: exit " + $code
}
Write-Host ""
if ($failed) { Write-Host ("ABORT  " + $failed); exit 1 }

if (-not (Test-Path $CONTRACT)) {
  Write-Host ("ABORT  contract not written: " + $CONTRACT)
  exit 1
}

# ---- 3. verify contract before writing --------------------------------------
# This is the gate that did not exist. It only blocks when the contract would
# write wrong data; missing data is reported and allowed through.
Write-Host "---- 3/5 verify contract ----"
$code = Invoke-Child $NODE $ROOT @((Join-Path $ROOT "scripts\verify-daily.mjs"), "--date", $Target, "--ingest", $CONTRACT)
if ($code -eq 0) {
  Write-Host "verify: clean"
} elseif ($code -eq 2) {
  Write-Host "verify: gaps only, safe to import"
  $gaps += "verify: gaps before import"
} else {
  $failed = "verify: blocked, wrong data would be written"
}
Write-Host ""
if ($failed) { Write-Host ("ABORT  " + $failed); exit 1 }

if ($NoImport) {
  Write-Host "---- 4/5 import: skipped ----"
  Write-Host "---- 5/5 verify DB: skipped ----"
  Write-Host ""
  if ($gaps.Count -gt 0) {
    Write-Host ("DONE with gaps: " + ($gaps -join "; "))
    exit 2
  }
  Write-Host "DONE (no import requested)"
  exit 0
}

# ---- 4. import --------------------------------------------------------------
# Same function as POST /api/ops/ingest, so the backfill path and the daily path
# cannot drift on dedupe, revised flags or window cleanup.
Write-Host "---- 4/5 import ----"
$code = Invoke-Child $TSX $API @((Join-Path $API "src\tools\ops-import.ts"), $CONTRACT)
if ($code -ne 0) { $failed = "import: exit " + $code }
Write-Host ""

# ---- 5. verify what landed --------------------------------------------------
# Reading the database back is the only way to catch "reported succeeded but
# wrote nothing". Do it even when the import failed, so the report says why.
Write-Host "---- 5/5 verify DB ----"
$code = Invoke-Child $TSX $API @(
  (Join-Path $API "src\tools\ops-verify.ts"),
  "--date", $Target, "--contract", $CONTRACT
)
if ($code -ne 0 -and -not $failed) { $failed = "verify DB: rows do not match the contract" }
Write-Host ""

if ($failed) {
  Write-Host ("FAILED  " + $failed)
  exit 1
}
if ($gaps.Count -gt 0) {
  Write-Host ("DONE with gaps: " + ($gaps -join "; "))
  Write-Host "Missing dimensions will show as a dash; rows not reported this run are kept."
  exit 2
}
Write-Host "DONE  collect -> export -> verify -> import -> verify all clean"
exit 0
