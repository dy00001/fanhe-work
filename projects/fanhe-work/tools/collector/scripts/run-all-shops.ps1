# Run the daily collection for several shops, one after another.
#
# Why serial and not parallel
#   1. Each shop needs its own Edge instance. Four Edge windows competing for one
#      desktop session make the page load times erratic, and the collector judges
#      a page by "did the business request fire within WAIT ms" - erratic loads
#      turn into false THIN verdicts.
#   2. All four shops leave from the same public IP. Sycm has baxia risk control;
#      hammering it with four parallel sessions is how an account gets throttled
#      (this already happened once on 2026-10-20 and looked like a script bug).
#
# Usage
#   powershell -ExecutionPolicy Bypass -File scripts/run-all-shops.ps1
#   powershell -ExecutionPolicy Bypass -File scripts/run-all-shops.ps1 -Shops s2,s3
#   powershell -ExecutionPolicy Bypass -File scripts/run-all-shops.ps1 -Target 2026-10-19
#   powershell -ExecutionPolicy Bypass -File scripts/run-all-shops.ps1 -Wait 32000
#
# Default target set = every shop with collect=true in shops.config.json.
# A shop whose login has expired is reported and skipped; the remaining shops
# still run (one expired cookie must not stop the other three).
#
# Exit codes
#   0  every shop collected and passed its gate
#   1  at least one shop failed its gate (data unusable)
#   4  at least one shop's tab never loaded (environment problem, not a login)
#   3  no shop failed, but at least one needed a login (nothing collected for it)
#   2  no hard failure, but some pages stayed thin after retries
#
# Keep this file pure ASCII: Windows PowerShell 5.1 reads BOM-less files as ANSI
# and non-ASCII bytes make the parser fail with "unexpected token".

param(
  [string]$Shops = "",
  [string]$Target = "",
  [int]$Wait = 60000,
  [int]$Boot = 14000
)

$ErrorActionPreference = "Stop"

# Node writes UTF-8; PowerShell 5.1 would decode the child's stdout as ANSI (936)
# and turn every Chinese log line into mojibake.
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$ROOT = Split-Path -Parent $PSScriptRoot

$cfgPath = Join-Path $ROOT "shops.config.json"
if (-not (Test-Path $cfgPath)) { Write-Host ("shop config missing: " + $cfgPath); exit 1 }
# PowerShell 5.1 reads BOM-less files as ANSI, which garbles the Chinese names.
$cfg = [System.IO.File]::ReadAllText($cfgPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json

# Resolve the target list
if ($Shops) {
  $wanted = $Shops -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ }
} else {
  $wanted = @($cfg.shops | Where-Object { $_.collect } | ForEach-Object { $_.code })
}

$slots = @()
foreach ($code in $wanted) {
  $slot = $cfg.shops | Where-Object { $_.code -eq $code } | Select-Object -First 1
  if (-not $slot) {
    $codes = ($cfg.shops | ForEach-Object { $_.code }) -join ", "
    Write-Host ("unknown shop: " + $code + "   available: " + $codes)
    exit 1
  }
  if (-not $slot.port) {
    Write-Host ("shop " + $code + " has no debug port (placeholder, collect=false); skipped")
    continue
  }
  $slots += $slot
}

if ($slots.Count -eq 0) { Write-Host "no shop to run"; exit 1 }

if (-not $Target) { $Target = (Get-Date).AddDays(-1).ToString("yyyy-MM-dd") }

$PS = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
$RUN = Join-Path $ROOT "scripts\run-daily.ps1"

Write-Host ("root    : " + $ROOT)
Write-Host ("target  : " + $Target)
Write-Host ("shops   : " + (($slots | ForEach-Object { $_.code }) -join ", "))
Write-Host ("per shop: about " + [math]::Round(17 * ($Wait / 60000) + ($Boot / 60000), 1) + " min of waiting alone, plus load time")
Write-Host ""

$results = @()
$started = Get-Date

foreach ($slot in $slots) {
  Write-Host "================================================================"
  Write-Host ("  " + $slot.code + "  " + $slot.name)
  Write-Host "================================================================"

  $t0 = Get-Date
  $ErrorActionPreference = "Continue"
  & $PS -NoProfile -ExecutionPolicy Bypass -File $RUN -Shop $slot.code -Target $Target -Wait $Wait -Boot $Boot
  $code = $LASTEXITCODE
  $ErrorActionPreference = "Stop"
  $mins = [math]::Round(((Get-Date) - $t0).TotalMinutes, 1)

  $label = switch ($code) {
    0 { "ok" }
    1 { "gate-failed" }
    2 { "thin" }
    3 { "login-required" }
    4 { "env-error" }
    default { "crash" }
  }
  $results += [pscustomobject]@{ Shop = $slot.code; Name = $slot.name; Exit = $code; Result = $label; Minutes = $mins }
  Write-Host ("  -> " + $label + "  (" + $mins + " min)")
  Write-Host ""
}

$total = [math]::Round(((Get-Date) - $started).TotalMinutes, 1)

Write-Host "================================================================"
Write-Host "  summary"
Write-Host "================================================================"
$results | Format-Table -AutoSize | Out-String | Write-Host
Write-Host ("total " + $total + " min")

$codes = @($results | ForEach-Object { $_.Exit })

$exit = 0
if ($codes -contains 1) { $exit = 1 }
elseif ($codes -contains 4) { $exit = 4 }
elseif ($codes -contains 3) { $exit = 3 }
elseif ($codes -contains 2) { $exit = 2 }

if ($codes -contains 4) {
  Write-Host ""
  Write-Host "Shops whose debug tab never loaded (restart the window first, do not re-login blindly):"
  $results | Where-Object { $_.Exit -eq 4 } | ForEach-Object {
    Write-Host ("  powershell -ExecutionPolicy Bypass -File scripts/shop-login.ps1 -Shop " + $_.Shop)
  }
}

if ($codes -contains 3) {
  Write-Host ""
  Write-Host "Shops needing a login:"
  $results | Where-Object { $_.Exit -eq 3 } | ForEach-Object {
    Write-Host ("  powershell -ExecutionPolicy Bypass -File scripts/shop-login.ps1 -Shop " + $_.Shop)
  }
}

Write-Host ("overall exit code: " + $exit)
exit $exit
