# Per-shop login guide for the Qianniu collector.
#
# Why this script exists
#   Each shop is a separate Taobao account, so each one needs its own browser
#   profile. Logging shop B in the same profile as shop A silently kicks A out:
#   the collector still sees "logged in", only the account behind the session has
#   changed, and B's numbers get written under A's name without one error.
#   So: one profile dir, one debug port, one account - all driven from
#   shops.config.json.
#
# What it does
#   1. starts that shop's Edge (own --user-data-dir, own --remote-debugging-port)
#   2. checks the login state with the SAME rule the collector uses
#   3. if not logged in, waits for you to sign in, then re-checks
#   4. closes the window (unless -Keep), cookies stay on disk
#
# Usage
#   powershell -ExecutionPolicy Bypass -File scripts/shop-login.ps1 -Check
#   powershell -ExecutionPolicy Bypass -File scripts/shop-login.ps1 -Shop s2
#   powershell -ExecutionPolicy Bypass -File scripts/shop-login.ps1 -All
#   powershell -ExecutionPolicy Bypass -File scripts/shop-login.ps1 -Shop s2 -Keep
#   powershell -ExecutionPolicy Bypass -File scripts/shop-login.ps1 -Shop s2 -Keep -NoPrompt
#
# -Keep keeps the window open after the check. -NoPrompt skips the "press Enter
# when signed in" step, for callers that have no console (the desktop shell
# spawns this with stdio ignored, so Read-Host would block on an invisible
# prompt). Desktop uses -Keep -NoPrompt: open the browser and leave it alone.
#
# -Check only reports the state of every shop (no interaction, safe for scripts).
# Exit codes: 0 all checked shops are logged in, 3 at least one needs a login,
#             1 setup problem (no Edge, no config, bad shop code).
#
# Keep this file pure ASCII: Windows PowerShell 5.1 reads BOM-less files as ANSI
# and non-ASCII bytes make the parser fail with "unexpected token".

param(
  [string]$Shop = "",
  [switch]$All,
  [switch]$Check,
  [switch]$Keep,
  [switch]$NoPrompt,
  [int]$LoginWait = 12
)

$ErrorActionPreference = "Stop"

# Node writes UTF-8; PowerShell 5.1 would decode the child's stdout as ANSI (936)
# and turn every Chinese line into mojibake.
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$ROOT = Split-Path -Parent $PSScriptRoot

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

$cfgPath = Join-Path $ROOT "shops.config.json"
if (-not (Test-Path $cfgPath)) { Write-Host ("shop config missing: " + $cfgPath); exit 1 }
# PowerShell 5.1 reads BOM-less files as ANSI, which garbles the Chinese shop
# names. Read as UTF-8 explicitly.
$cfg = [System.IO.File]::ReadAllText($cfgPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json

function Get-ProfileDir($code) { return (Join-Path $ROOT (".browser-profile\" + $code)) }

function Stop-ShopEdge($code) {
  $profileDir = Get-ProfileDir $code
  # Match this shop's full profile path only; the bare word "browser-profile"
  # would kill every shop's Edge, including one mid-collection.
  Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine.Contains($profileDir) } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

function Wait-Port($port, $tries) {
  for ($i = 0; $i -lt $tries; $i++) {
    Start-Sleep -Milliseconds 800
    try {
      $null = Invoke-RestMethod -Uri "http://127.0.0.1:$port/json/version" -TimeoutSec 2
      return $true
    } catch {}
  }
  return $false
}

function Start-ShopEdge($slot) {
  # $profile is a PowerShell automatic variable (the user's profile script path).
  # Shadowing it works but is a trap; use an explicit name.
  $profileDir = Get-ProfileDir $slot.code
  $env:LOGIN_WAIT = "$($LoginWait * 1000)"
  $env:WAIT = "$($LoginWait * 1000)"
  Write-Host ("  starting Edge  profile=" + $profileDir + "  port=" + $slot.port)
  # The path contains a space, and Start-Process does NOT quote -ArgumentList
  # elements. Unquoted, Edge falls back to the default profile and every shop
  # ends up sharing one account. Quote it explicitly.
  Start-Process -FilePath $EDGE -ArgumentList @(
    "--remote-debugging-port=$($slot.port)",
    ('--user-data-dir="' + $profileDir + '"'),
    "--no-first-run",
    "--no-default-browser-check",
    "--new-window",
    "https://sycm.taobao.com"
  )
  if (-not (Wait-Port $slot.port 40)) {
    Write-Host ("  debug port " + $slot.port + " not ready")
    return $false
  }
  # Edge binds the debug port before it initialises the profile, so the dir shows
  # up a moment later. Poll instead of checking once.
  $ready = $false
  for ($i = 0; $i -lt 20; $i++) {
    if (Test-Path $profileDir) { $ready = $true; break }
    Start-Sleep -Milliseconds 500
  }
  if (-not $ready) {
    Write-Host ("  profile dir was NOT created: " + $profileDir)
    Write-Host "  Edge ignored --user-data-dir; the window is using the default profile."
    Write-Host "  Close all Edge windows and try again, otherwise you would sign in"
    Write-Host "  to the wrong account."
    return $false
  }
  return $true
}

function Test-ShopLogin($slot) {
  $env:LOGIN_WAIT = "$($LoginWait * 1000)"
  Push-Location $ROOT
  $ErrorActionPreference = "Continue"
  $raw = & $NODE (Join-Path $ROOT "scripts\check-login.mjs") --shop $slot.code --json 2>&1 | Out-String
  $exit = $LASTEXITCODE
  $ErrorActionPreference = "Stop"
  Pop-Location
  $state = "unknown"
  try { $state = ($raw | ConvertFrom-Json).state } catch {}
  return @{ ok = ($exit -eq 0); exit = $exit; state = $state; raw = $raw.Trim() }
}

# Which shops to handle
$targets = @()
if ($All) {
  $targets = @($cfg.shops | Where-Object { $_.collect })
} elseif ($Shop) {
  $one = $cfg.shops | Where-Object { $_.code -eq $Shop } | Select-Object -First 1
  if (-not $one) {
    $codes = ($cfg.shops | ForEach-Object { $_.code }) -join ", "
    Write-Host ("unknown shop: " + $Shop + "   available: " + $codes)
    exit 1
  }
  $targets = @($one)
} else {
  # No target: report every shop that participates in collection.
  $targets = @($cfg.shops | Where-Object { $_.collect })
  $Check = $true
}

Write-Host ("root    : " + $ROOT)
Write-Host ("node    : " + $NODE)
Write-Host ""

$summary = @()
$needLogin = 0

foreach ($slot in $targets) {
  Write-Host ("== " + $slot.code + " (" + $slot.name + ")  port " + $slot.port + " ==")

  $already = $false
  try {
    $null = Invoke-RestMethod -Uri "http://127.0.0.1:$($slot.port)/json/version" -TimeoutSec 2
    $already = $true
  } catch {}

  if (-not $already) {
    if ($Check) {
      Write-Host "  not running (Edge for this shop is not started)"
      $summary += [pscustomobject]@{ Shop = $slot.code; Name = $slot.name; State = "not-running" }
      $needLogin++
      continue
    }
    if (-not (Start-ShopEdge $slot)) {
      $summary += [pscustomobject]@{ Shop = $slot.code; Name = $slot.name; State = "port-failed" }
      $needLogin++
      continue
    }
  }

  $r = Test-ShopLogin $slot
  Write-Host ("  state: " + $r.state)

  if (-not $r.ok -and -not $Check -and -not $NoPrompt) {
    Write-Host ""
    Write-Host ("  Sign in to the " + $slot.name + " account in the Edge window that just opened.")
    Write-Host "  Use the account/password for THIS shop. Do not switch accounts in another shop's window."
    Write-Host "  Press Enter here when the shop dashboard is visible..."
    $null = Read-Host
    Start-Sleep -Seconds 3
    $r = Test-ShopLogin $slot
    Write-Host ("  state after sign-in: " + $r.state)
  }

  if ($r.ok) {
    $summary += [pscustomobject]@{ Shop = $slot.code; Name = $slot.name; State = "logged-in" }
  } else {
    $summary += [pscustomobject]@{ Shop = $slot.code; Name = $slot.name; State = $r.state }
    $needLogin++
  }

  if (-not $Check -and -not $Keep) {
    Start-Sleep -Seconds 2
    Stop-ShopEdge $slot.code
    Write-Host "  Edge closed, cookies kept on disk"
  }
  Write-Host ""
}

Write-Host "---- summary ----"
$summary | Format-Table -AutoSize | Out-String | Write-Host

if ($needLogin -gt 0) {
  Write-Host ("shops needing a login: " + $needLogin)
  if ($Check) {
    Write-Host "run: powershell -ExecutionPolicy Bypass -File scripts/shop-login.ps1 -Shop <code>"
  }
  exit 3
}

Write-Host "all checked shops are logged in"
exit 0
