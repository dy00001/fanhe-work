# Export the Qianniu login session (CEF cookies) for one shop.
#
# Why the instance must be closed
#   CEF holds the Cookies SQLite database with an exclusive lock while running:
#   no other process can even open it for reading (verified: both Node copyFileSync
#   and .NET FileShare.ReadWrite fail with "file is in use"). Closing Qianniu does
#   NOT lose the login - the cookies are on disk - so the sequence is
#   close -> copy -> decrypt -> (user reopens Qianniu).
#
# What it produces
#   .secrets\<shop>-cookies.json  - plaintext cookies for .taobao.com / .tmall.com.
#   Treat it like a password: it is gitignored, ACL-restricted, and meant to be
#   deleted after the browser profile has absorbed it.
#
# Usage
#   powershell -ExecutionPolicy Bypass -File scripts/shop-cookie-export.ps1 -Shop fanhe-main -CefDir instance_1
#   powershell -ExecutionPolicy Bypass -File scripts/shop-cookie-export.ps1 -Shop s2 -CefDir instance_2 -Yes
#
# -CefDir is the Qianniu CEF profile folder name (instance_1, instance_2, ...).
#   Find it with: Get-CimInstance Win32_Process -Filter "Name='AliRender.exe'" |
#                 Where-Object { $_.CommandLine -notmatch '--type=' }
# -Yes skips the confirmation prompt (for scripted runs).
#
# Exit codes: 0 exported with all required cookies, 2 exported but some required
#             cookies are missing, 1 could not export.
#
# Keep this file pure ASCII.

param(
  [string]$Shop = "",
  [string]$CefDir = "",
  [switch]$Yes
)

$ErrorActionPreference = "Stop"
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
Add-Type -AssemblyName System.Security -ErrorAction SilentlyContinue

$ROOT = Split-Path -Parent $PSScriptRoot
$NODE = Join-Path $env:USERPROFILE ".workbuddy\binaries\node\versions\22.22.2-6\node.exe"
if (-not (Test-Path $NODE)) {
  $NODE = Get-ChildItem "$env:USERPROFILE\.workbuddy\binaries\node\versions" -Directory -ErrorAction SilentlyContinue |
    Sort-Object Name -Descending |
    ForEach-Object { Join-Path $_.FullName "node.exe" } |
    Where-Object { Test-Path $_ } |
    Select-Object -First 1
}
if (-not $NODE) { $NODE = "node" }

if (-not $Shop) { Write-Host "-Shop is required (see shops.config.json)"; exit 1 }

# CefDir from the config when not given on the command line
if (-not $CefDir) {
  $cfgPath = Join-Path $ROOT "shops.config.json"
  if (Test-Path $cfgPath) {
    $cfg = [System.IO.File]::ReadAllText($cfgPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
    $slot = $cfg.shops | Where-Object { $_.code -eq $Shop } | Select-Object -First 1
    if ($slot -and $slot.qianniu -and $slot.qianniu.cefDir) { $CefDir = $slot.qianniu.cefDir }
  }
}
if (-not $CefDir) {
  Write-Host "CefDir unknown. Pass -CefDir instance_1 / instance_2 ..."
  Write-Host "  list running instances:"
  Get-CimInstance Win32_Process -Filter "Name='AliRender.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -notmatch '--type=' } |
    ForEach-Object {
      $m = [regex]::Match($_.CommandLine, '--cef_dir="([^"]+)"')
      if ($m.Success) { Write-Host ("    " + (Split-Path $m.Groups[1].Value -Leaf) + "   pid=" + $_.ProcessId) }
    }
  exit 1
}

$cefBase = Join-Path $env:LOCALAPPDATA 'QNCEF1301Temp'
$cefRoot = Join-Path $cefBase $CefDir
$cookieDb = Join-Path $cefRoot 'Default\Network\Cookies'
$localState = Join-Path $cefRoot 'Local State'

if (-not (Test-Path $cefRoot)) {
  Write-Host ("CEF profile not found: " + $cefRoot)
  exit 1
}

Write-Host ("shop     : " + $Shop)
Write-Host ("cef dir  : " + $cefRoot)

# Locate the CEF browser process of THIS instance and its shell parent
$browser = Get-CimInstance Win32_Process -Filter "Name='AliRender.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -notmatch '--type=' -and $_.CommandLine.Contains($CefDir) } |
  Select-Object -First 1

$shellPid = 0
if ($browser) {
  $m = [regex]::Match($browser.CommandLine, '--mojo-named-platform-channel-pipe=(\d+)\.')
  if ($m.Success) { $shellPid = [int]$m.Groups[1].Value }
  Write-Host ("cef pid  : " + $browser.ProcessId)
  Write-Host ("shell pid: " + $shellPid)
} else {
  Write-Host "no running CEF browser for this instance (already closed?)"
}

if ($browser -and -not $Yes) {
  Write-Host ""
  Write-Host "Qianniu for this instance must be CLOSED to read its cookie database."
  Write-Host "Closing it does not log you out; reopen Qianniu afterwards."
  $ans = Read-Host "Close it now? (y/N)"
  if ($ans -notmatch '^(y|Y)') { Write-Host "aborted"; exit 1 }
}

# Close the shell (its whole tree goes with it)
if ($shellPid -gt 0) {
  Write-Host ("closing shell pid " + $shellPid + " ...")
  & taskkill /PID $shellPid /T /F 2>&1 | Out-Null
  Start-Sleep -Seconds 2
} elseif ($browser) {
  & taskkill /PID $browser.ProcessId /T /F 2>&1 | Out-Null
  Start-Sleep -Seconds 2
}

# Wait for the database to become readable
function Copy-Shared($src, $dst) {
  $in = [System.IO.File]::Open($src, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
  $outFs = [System.IO.File]::Create($dst)
  $in.CopyTo($outFs)
  $outFs.Close()
  $in.Close()
}

$work = Join-Path $ROOT '.tmp\cookie-export'
New-Item -ItemType Directory -Force -Path $work | Out-Null
$copy = Join-Path $work 'Cookies'

$ok = $false
for ($i = 0; $i -lt 20; $i++) {
  try {
    Copy-Shared $cookieDb $copy
    $ok = $true
    break
  } catch {
    Start-Sleep -Milliseconds 700
  }
}
if (-not $ok) {
  Write-Host "still locked. Make sure every Qianniu window for this instance is closed, then retry."
  exit 1
}
Write-Host ("cookie db copied: " + (Get-Item $copy).Length + " bytes")

# DPAPI -> AES key
$lsCopy = Join-Path $work 'Local State'
Copy-Shared $localState $lsCopy
$lsRaw = [System.IO.File]::ReadAllText($lsCopy, [System.Text.Encoding]::UTF8)
$lsJson = $lsRaw | ConvertFrom-Json
$encKeyB64 = $lsJson.os_crypt.encrypted_key
if (-not $encKeyB64) { Write-Host "Local State has no os_crypt.encrypted_key"; exit 1 }

$enc = [Convert]::FromBase64String($encKeyB64)
$prefix = [System.Text.Encoding]::ASCII.GetString($enc[0..4])
if ($prefix -ne 'DPAPI') { Write-Host ("unexpected key prefix: " + $prefix); exit 1 }

$payload = New-Object byte[] ($enc.Length - 5)
[Array]::Copy($enc, 5, $payload, 0, $payload.Length)
$key = $null
try {
  $key = [System.Security.Cryptography.ProtectedData]::Unprotect(
    $payload, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
} catch {
  Write-Host ("DPAPI unwrap failed: " + $_.Exception.Message)
  exit 1
}
if ($key.Length -ne 32) { Write-Host ("unexpected key length " + $key.Length); exit 1 }

$keyFile = Join-Path $work 'key.b64'
[System.IO.File]::WriteAllText($keyFile, [Convert]::ToBase64String($key), [System.Text.Encoding]::ASCII)
Write-Host "DPAPI key unwrapped (32 bytes)"

# Decrypt + export
$secretDir = Join-Path $ROOT '.secrets'
New-Item -ItemType Directory -Force -Path $secretDir | Out-Null
$outFile = Join-Path $secretDir ($Shop + '-cookies.json')

$ErrorActionPreference = "Continue"
& $NODE (Join-Path $ROOT 'scripts\export-qianniu-cookies.mjs') `
  --db $copy --key-file $keyFile --shop $Shop --source ("qianniu " + $CefDir) --out $outFile 2>&1 | Out-String | Write-Host
$code = $LASTEXITCODE
$ErrorActionPreference = "Stop"

# Shred the working copies: key + cookie db
Remove-Item $keyFile -Force -ErrorAction SilentlyContinue
Remove-Item $copy -Force -ErrorAction SilentlyContinue
Remove-Item $lsCopy -Force -ErrorAction SilentlyContinue

if (Test-Path $outFile) {
  & icacls $outFile /inheritance:r /grant:r ("$env:USERNAME:(R,W)") 2>&1 | Out-Null
  Write-Host ("secrets  : " + $outFile)
}

Write-Host ""
Write-Host "Reopen Qianniu now (double-click the icon) and sign in again if asked."
Write-Host "Next: node scripts/shop-cookie-inject.mjs --shop $Shop"
exit $code
