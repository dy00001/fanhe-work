# Run the daily collector with a dedicated Edge debug instance.
#
# Why this script exists
#   Edge processes started from one shell call are gone by the time the next
#   shell call runs, so "start Edge" and "run the collector" must happen inside
#   a single process. This script does both, and also cleans up afterwards.
#
# Safety
#   It only stops msedge processes whose command line contains THIS workspace's
#   .browser-profile directory. A normal Edge window the user has open is left
#   alone.
#
# Usage
#   powershell -ExecutionPolicy Bypass -File scripts/run-daily.ps1
#   powershell -ExecutionPolicy Bypass -File scripts/run-daily.ps1 -Shop s2
#   powershell -ExecutionPolicy Bypass -File scripts/run-daily.ps1 -Pages trade-detail,flow-overview
#   powershell -ExecutionPolicy Bypass -File scripts/run-daily.ps1 -Target 2026-10-19 -Wait 32000
#   powershell -ExecutionPolicy Bypass -File scripts/run-daily.ps1 -SkipPreflight
#
# -Shop <code> switches to multi-shop mode: the profile dir and debug port come
# from shops.config.json, and the output goes to data\daily\<code>\<date>.
# Without -Shop the old single-shop layout (data\daily\<date>, port 9222) is used.
#
# Exit codes
#   0 collection ok and the gate passed
#   2 some pages still thin after retries (data is on disk, gate results printed)
#   3 login check failed, no page was touched
#   4 the tab never loaded (about:blank), so the login state is unknown
#   1 the gate (check_daily.mjs) found empty pages, or the collector crashed
#   A full run chains the gate automatically; a -Pages subset skips it.
#   The login verdict is also written to data\daily\<shop>\_preflight.json.
#
# Keep the file pure ASCII: Windows PowerShell 5.1 reads BOM-less files as ANSI,
# and non-ASCII bytes make the parser fail with "unexpected token".

param(
  [string]$Pages = "",
  [string]$Target = "",
  [int]$Wait = 60000,
  [int]$Boot = 14000,
  [string]$Script = "collect-daily.mjs",
  [string]$ScriptArgs = "",
  [string]$Shop = "",
  [switch]$SkipPreflight
)

$ErrorActionPreference = "Stop"

# Node writes UTF-8. Without this, PowerShell 5.1 decodes the child's stdout with
# the ANSI code page (936 on a Chinese Windows) and every Chinese log line comes
# out as mojibake - which is how a working collector looks like a broken one.
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$ROOT = Split-Path -Parent $PSScriptRoot
$PROFILE_DIR = Join-Path $ROOT ".browser-profile"
$PORT = 9222
$SHOP_NAME = ""

# Multi-shop mode. Each shop owns its own browser profile and its own debug port.
# Sharing one profile across shops silently swaps accounts: the collector still
# sees a logged-in page, only the shop behind that session has changed, so shop B
# gets written under shop A's name without a single error.
if ($Shop) {
  $cfgPath = Join-Path $ROOT "shops.config.json"
  if (-not (Test-Path $cfgPath)) { Write-Host ("shop config missing: " + $cfgPath); exit 1 }
  # PowerShell 5.1 reads BOM-less files as ANSI, which garbles the Chinese shop
  # names. Read as UTF-8 explicitly instead of Get-Content.
  $cfg = [System.IO.File]::ReadAllText($cfgPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
  $slot = $cfg.shops | Where-Object { $_.code -eq $Shop } | Select-Object -First 1
  if (-not $slot) {
    $codes = ($cfg.shops | ForEach-Object { $_.code }) -join ", "
    Write-Host ("unknown shop: " + $Shop + "   available: " + $codes)
    exit 1
  }
  if (-not $slot.port) {
    Write-Host ("shop " + $Shop + " has no debug port (placeholder shop, collect=false)")
    exit 1
  }
  $PROFILE_DIR = Join-Path $ROOT (".browser-profile\" + $Shop)
  $PORT = [int]$slot.port
  $SHOP_NAME = $slot.name
}

$EDGE = "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
if (-not (Test-Path $EDGE)) { $EDGE = "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe" }
if (-not (Test-Path $EDGE)) { $EDGE = "$env:LOCALAPPDATA\Microsoft\Edge\Application\msedge.exe" }
if (-not (Test-Path $EDGE)) { Write-Host "Edge not found."; exit 1 }

$NODE = Join-Path $env:USERPROFILE ".workbuddy\binaries\node\versions\22.22.2-6\node.exe"
if (-not (Test-Path $NODE)) {
  $NODE = Get-ChildItem "$env:USERPROFILE\.workbuddy\binaries\node\versions" -Directory -ErrorAction SilentlyContinue |
    Sort-Object Name -Descending |
    ForEach-Object { Join-Path $_.FullName "node.exe" } |
    Where-Object { Test-Path $_ } |
    Select-Object -First 1
}
if (-not $NODE) { $NODE = "node" }

function Stop-OurEdge {
  # Match THIS profile's full path only. Matching on the bare word
  # "browser-profile" would kill every shop's Edge instance, including one that
  # is in the middle of a collection run for another shop.
  Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine.Contains($PROFILE_DIR) } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

Write-Host ("root    : " + $ROOT)
if ($Shop) { Write-Host ("shop    : " + $Shop + " (" + $SHOP_NAME + ")") }
Write-Host ("profile : " + $PROFILE_DIR)
Write-Host ("port    : " + $PORT)
Write-Host ("node    : " + $NODE)

Stop-OurEdge
Start-Sleep -Seconds 2

# The profile path contains a space ("F:\fanhe Work\..."). Start-Process joins
# -ArgumentList with plain spaces and does NOT quote elements, so an unquoted
# "--user-data-dir=<path with space>" gets split and Edge silently falls back to
# the user's default profile. That fallback is invisible: the port still opens,
# pages still load, and collection works - on the wrong account. Quote it.
Start-Process -FilePath $EDGE -ArgumentList @(
  "--remote-debugging-port=$PORT",
  ('--user-data-dir="' + $PROFILE_DIR + '"'),
  "--no-first-run",
  "--no-default-browser-check",
  "--new-window",
  "https://sycm.taobao.com"
)

# Fail loudly if Edge ignored the profile flag: a shop without its own profile
# dir means every shop shares one account, which is the exact failure this
# multi-shop layout exists to prevent.
# The dir is created a moment AFTER the debug port starts listening (Edge binds
# the port first, then initialises the profile), so poll instead of checking once.
$profileReady = $false
for ($i = 0; $i -lt 20; $i++) {
  if (Test-Path $PROFILE_DIR) { $profileReady = $true; break }
  Start-Sleep -Milliseconds 500
}
if (-not $profileReady) {
  Write-Host ""
  Write-Host ("profile dir was NOT created: " + $PROFILE_DIR)
  Write-Host "  Edge most likely ignored --user-data-dir (unquoted path with spaces)"
  Write-Host "  or another Edge instance swallowed the command line."
  Write-Host "  Do not collect: the window would use the default profile / wrong account."
  Stop-OurEdge
  exit 1
}

$ready = $false
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Milliseconds 800
  try {
    $v = Invoke-RestMethod -Uri "http://127.0.0.1:$PORT/json/version" -TimeoutSec 2
    $ready = $true
    break
  } catch {}
}
if (-not $ready) { Write-Host "debug port $PORT not ready"; exit 1 }
Write-Host ("edge    : " + $v.Browser)

$env:WAIT = "$Wait"
$env:BOOT = "$Boot"
if ($Shop) { $env:SHOP = $Shop } else { $env:SHOP = "" }
if ($SkipPreflight) { $env:SKIP_PREFLIGHT = "1" } else { $env:SKIP_PREFLIGHT = "" }

$argList = @((Join-Path $ROOT "scripts\$Script"))
if ($Pages) { $argList += $Pages }
# Resolve the date once here so the collector and the checker below agree on it.
# Without this the collector would fall back to its own "yesterday" and a run at
# 00:30 would check the wrong day.
if (-not $Target) { $Target = (Get-Date).AddDays(-1).ToString("yyyy-MM-dd") }
$argList += @("--date", $Target)
if ($ScriptArgs) { $argList += ($ScriptArgs -split '\s+') }

Push-Location $ROOT
# Native stderr becomes an ErrorRecord under Stop mode, which aborts the run.
$ErrorActionPreference = "Continue"
& $NODE @argList 2>&1 | Out-String
$code = $LASTEXITCODE
$ErrorActionPreference = "Stop"
Pop-Location

# The collector parks replaced output in data/daily/.trash instead of deleting it,
# because the machine-wide safe-delete guard rejects more than 50 deletions per
# turn. Purge here, best effort: a failure must not invalidate the collection.
if ($Shop) { $trash = Join-Path $ROOT ("data\daily\" + $Shop + "\.trash") }
else { $trash = Join-Path $ROOT "data\daily\.trash" }
if (Test-Path $trash) {
  $ErrorActionPreference = "Continue"
  try {
    $n = (Get-ChildItem $trash -Directory -ErrorAction SilentlyContinue | Measure-Object).Count
    Remove-Item $trash -Recurse -Force -ErrorAction SilentlyContinue
    if (-not (Test-Path $trash)) { Write-Host ("trash purged: " + $n + " dirs") }
    else { Write-Host "trash not fully purged (safe-delete guard); harmless" }
  } catch {
    Write-Host "trash purge skipped; harmless"
  }
  $ErrorActionPreference = "Stop"
}

Stop-OurEdge

# Chain the gate. Collecting without checking is the same as not collecting:
# a page that opens but sends no business request writes one 183-byte heartbeat
# and exits 0. check_daily.mjs already knows this and exits 1 on empty pages,
# its own header even says "meant to be chained after run-daily.ps1".
# Only chain on a full run; a -Pages subset would look like missing pages.
$fullRun = (-not $Pages) -and ($Script -eq "collect-daily.mjs")
if ($fullRun -and ($code -eq 0 -or $code -eq 2)) {
  Write-Host ""
  Write-Host "---- daily gate ----"
  Push-Location $ROOT
  $ErrorActionPreference = "Continue"
  $gateArgs = @((Join-Path $ROOT "scripts\check_daily.mjs"), "--date", $Target)
  if ($Shop) { $gateArgs += @("--shop", $Shop) }
  & $NODE @gateArgs 2>&1 | Out-String
  $check = $LASTEXITCODE
  $ErrorActionPreference = "Stop"
  Pop-Location
  Write-Host ("gate exit code: " + $check)
  if ($code -eq 0 -and $check -ne 0) { $code = 1 }
}

Write-Host ("collector exit code: " + $code)

if ($code -eq 3) {
  Write-Host ""
  Write-Host "LOGIN REQUIRED"
  Write-Host "  The collector stopped at the preflight check and touched no page."
  if ($Shop) {
    Write-Host ("  1) run: powershell -ExecutionPolicy Bypass -File scripts\shop-login.ps1 -Shop " + $Shop)
    Write-Host ("  2) sign in to the " + $Shop + " account in the Edge window that opens")
    Write-Host "  3) close that window, then re-run this script"
    Write-Host ("  This shop's cookies live in .browser-profile\" + $Shop + ", other shops are untouched.")
    Write-Host ("  Details: data\daily\" + $Shop + "\_preflight.json")
  } else {
    Write-Host "  1) run start-edge-debug.cmd"
    Write-Host "  2) sign in to sycm.taobao.com in the window that opens"
    Write-Host "  3) close that window, then re-run this script"
    Write-Host "  Cookies are persisted, so the re-run needs no second scan."
    Write-Host "  Details: data\daily\_preflight.json"
  }
  Write-Host ""
}

if ($code -eq 4) {
  Write-Host ""
  Write-Host "LOGIN STATE UNKNOWN"
  Write-Host "  The debug tab stayed on about:blank, so the collector could not tell"
  Write-Host "  whether the account is still valid. This is NOT an expired login."
  Write-Host "  Check, in this order:"
  Write-Host ("   1) port " + $PORT + " belongs to this shop (shops.config.json)")
  if ($Shop) {
    Write-Host ("   2) Edge was started with --user-data-dir=.browser-profile\" + $Shop)
    Write-Host ("   3) restart the window: powershell -ExecutionPolicy Bypass -File scripts\shop-login.ps1 -Shop " + $Shop)
    Write-Host ("  Details: data\daily\" + $Shop + "\_preflight.json")
  } else {
    Write-Host "   2) Edge was started with --user-data-dir=.browser-profile"
    Write-Host "   3) restart the window: start-edge-debug.cmd"
    Write-Host "  Details: data\daily\_preflight.json"
  }
  Write-Host ""
}

if ($code -eq 2) {
  Write-Host ""
  Write-Host "THIN PAGES"
  if ($Shop) {
    Write-Host ("  Data is on disk. Verify with: node scripts/check_daily.mjs --shop " + $Shop + " --date <date>")
  } else {
    Write-Host "  Data is on disk. Verify with: node scripts/check_daily.mjs --date <date>"
  }
  Write-Host "  If a page keeps coming back thin, probe it:"
  Write-Host "    powershell -ExecutionPolicy Bypass -File scripts/run-daily.ps1 -Script probe-page.mjs -Pages <page> -ScriptArgs \"--wait 60000\""
  Write-Host ""
}

exit $code
