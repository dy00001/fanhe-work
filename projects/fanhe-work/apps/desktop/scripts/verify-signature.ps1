# Signature report for the packaged artifacts (T6-03c).
#
# Why this is a separate .ps1 instead of living inside verify-pack.mjs:
#   verify-pack.mjs runs in Node, and in this environment Node cannot spawn any
#   child process at all (spawnSync returns errno -4082 / EBUSY for every target).
#   So the PowerShell side has to be its own entry point.
#
# Why the result goes into a FILE instead of stdout:
#   the PowerShell host in this environment silently swallows stdout, so a script
#   that "prints" its findings looks like it produced nothing. Writing to a file
#   with -Encoding UTF8 is the only channel that actually carries the text back.
#
# Why Get-AuthenticodeSignature at all, when verify-pack.mjs already parses the
# PE Certificate Table in-process: the two answer different questions.
#   PE table non-empty  -> "a signature is embedded"      (presence)
#   this script         -> "embedded by WHOM, and is it internally consistent"
#                          (identity)
# The identity is exactly what electron-updater compares against publisherName,
# so presence alone would not be enough. Note the Status field mixes presence
# with trust-chain evaluation: a self-signed cert is reported as untrusted on any
# machine that has not imported it, which is NOT a packaging defect. This script
# therefore treats a non-NotSigned status as success and records the status
# verbatim rather than pretending "untrusted" means "unsigned".
#
# This file must stay pure ASCII (comments included). PowerShell 5.1 decodes a
# BOM-less .ps1 using the system ANSI code page, so a single non-ASCII byte can
# break parsing and stop the whole file from running.

[CmdletBinding()]
param(
  [string]$DesktopDir = '',
  [string]$ReportPath = ''
)

$ErrorActionPreference = 'Continue'

if ([string]::IsNullOrEmpty($DesktopDir)) {
  $DesktopDir = Split-Path -Parent $PSScriptRoot
}
if ([string]::IsNullOrEmpty($ReportPath)) {
  $ReportPath = Join-Path (Join-Path $DesktopDir 'release') 'signature-report.txt'
}

$lines = New-Object System.Collections.Generic.List[string]
$lines.Add("DESKTOP_DIR=$DesktopDir")

# Two distinct places to look:
#   win-unpacked\  the application exe the user actually runs
#   release\       the installer that gets downloaded and verified by the updater
$scanDirs = @(
  (Join-Path $DesktopDir 'release\win-unpacked'),
  (Join-Path $DesktopDir 'release')
)

$seen = New-Object System.Collections.Generic.HashSet[string]
$count = 0
$subjects = New-Object System.Collections.Generic.HashSet[string]

foreach ($dir in $scanDirs) {
  if (-not (Test-Path -LiteralPath $dir)) {
    $lines.Add("DIR_MISSING=$dir")
    continue
  }
  $lines.Add("DIR=$dir")
  # Skip elevate.exe (a stock helper that ships pre-signed by its own vendor) and
  # the uninstaller, so the assertions below are about OUR signing identity only.
  $exes = @(Get-ChildItem -LiteralPath $dir -Filter '*.exe' -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -notmatch '^(elevate|Uninstall)' })
  foreach ($exe in $exes) {
    $key = $exe.FullName.ToLowerInvariant()
    if (-not $seen.Add($key)) { continue }
    $count++
    try {
      $sig = Get-AuthenticodeSignature -LiteralPath $exe.FullName -ErrorAction Stop
      $status = [string]$sig.Status
      $subject = ''
      $thumb = ''
      if ($null -ne $sig.SignerCertificate) {
        $subject = [string]$sig.SignerCertificate.Subject
        $thumb = [string]$sig.SignerCertificate.Thumbprint
        [void]$subjects.Add($subject)
      }
      $lines.Add("EXE=$($exe.Name)")
      $lines.Add("  PATH=$($exe.FullName)")
      $lines.Add("  SIZE=$($exe.Length)")
      $lines.Add("  STATUS=$status")
      $lines.Add("  SUBJECT=$subject")
      $lines.Add("  THUMBPRINT=$thumb")
    } catch {
      $lines.Add("EXE=$($exe.Name)")
      $lines.Add("  ERROR=$($_.Exception.Message)")
    }
  }
}

$lines.Add("EXE_COUNT=$count")
$lines.Add("DISTINCT_SIGNER_SUBJECTS=$($subjects.Count)")
foreach ($s in $subjects) { $lines.Add("SIGNER_SUBJECT=$s") }

# RESULT must not be OK just because *some* exe carried a signature.
# An unsigned exe in the list is a failure of the thing being checked, so it has
# to drag the summary down; otherwise the one-line summary contradicts the body.
$notSigned = 0
foreach ($line in $lines) {
  if ($line -match '^\s+STATUS=NotSigned$') { $notSigned++ }
}
$lines.Add("NOT_SIGNED_COUNT=$notSigned")
if ($count -eq 0) {
  $lines.Add("RESULT=REVIEW reason=no-exe-found")
} elseif ($notSigned -gt 0) {
  $lines.Add("RESULT=REVIEW reason=$notSigned-unsigned")
} elseif ($subjects.Count -ne 1) {
  $lines.Add("RESULT=REVIEW reason=signer-subjects=$($subjects.Count)")
} else {
  $lines.Add("RESULT=OK")
}

$outDir = Split-Path -Parent $ReportPath
if (-not (Test-Path -LiteralPath $outDir)) {
  New-Item -ItemType Directory -Path $outDir -Force | Out-Null
}
Set-Content -LiteralPath $ReportPath -Value $lines -Encoding UTF8
