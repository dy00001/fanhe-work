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
#   this script         -> "embedded by WHOM, and does Windows accept it"
#                          (identity + trust)
# The identity is exactly what electron-updater compares against publisherName,
# so presence alone would not be enough.
#
# !! THE CRITERION IS `Status == Valid`, NOT `Status != NotSigned`.
# This file originally accepted anything that was not NotSigned, on the theory that
# a self-signed cert legitimately reports as untrusted and that is not a packaging
# defect. That reasoning was WRONG, and it hid a real blocker (found in T6-03b):
#
#   electron-updater's Windows verifier only runs its publisher-name matching when
#   `data.Status === 0`, and `SignatureStatus` 0 is `Valid`. Any other value skips
#   the match block entirely and the update is REFUSED -- including UnknownError,
#   which is what an untrusted chain produces. So "not NotSigned" is not a lower
#   bar for a self-signed setup; it is a bar that cannot pass electron-updater.
#
# Measured here before the fix: STATUS=UnknownError VALUE=1, Root=False.
# After `certutil -user -addstore -f Root` (see create-signing-cert.ps1 step 3):
# STATUS=Valid VALUE=0, Root=True. The numeric value is recorded below so the
# comparison against electron-updater's `=== 0` is checkable by eye.
#
# This file must stay pure ASCII (comments included). PowerShell 5.1 decodes a
# BOM-less .ps1 using the system ANSI code page, so a single non-ASCII byte can
# break parsing and stop the whole file from running. It must also contain no
# non-ASCII literal in the body -- hardcoding a Chinese artifact name here produced
# mojibake in T6-03b; enumerate the directory instead.

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
      $lines.Add("  STATUS_VALUE=$([int]$sig.Status)")
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
# The criterion is Valid on EVERY artifact, for two independent reasons:
#   - an unsigned or hash-mismatched exe is a failure of the thing being checked;
#   - anything other than Valid makes electron-updater skip publisher matching and
#     refuse the update (see the header). UnknownError is the trap here: it means
#     "signed, but Windows does not trust the chain", which looks fine to a human
#     and is fatal to the updater.
$notValid = 0
foreach ($line in $lines) {
  if ($line -match '^\s+STATUS_VALUE=(\d+)$') {
    if ([int]$Matches[1] -ne 0) { $notValid++ }
  }
}
$lines.Add("NOT_VALID_COUNT=$notValid")
$verdict = 'OK'
if ($count -eq 0) {
  $verdict = 'REVIEW'
  $lines.Add("RESULT=REVIEW reason=no-exe-found")
} elseif ($notValid -gt 0) {
  $verdict = 'REVIEW'
  $lines.Add("RESULT=REVIEW reason=$notValid-not-valid")
} elseif ($subjects.Count -ne 1) {
  $verdict = 'REVIEW'
  $lines.Add("RESULT=REVIEW reason=signer-subjects=$($subjects.Count)")
} else {
  $lines.Add("RESULT=OK")
}

$outDir = Split-Path -Parent $ReportPath
if (-not (Test-Path -LiteralPath $outDir)) {
  New-Item -ItemType Directory -Path $outDir -Force | Out-Null
}
Set-Content -LiteralPath $ReportPath -Value $lines -Encoding UTF8

# Exit non-zero on REVIEW. Without this the script exited 0 no matter what it found,
# so `verify:all` (a && chain) would keep going after a failed signature check -- a
# gate that cannot fail is not a gate. Callers that want the data rather than the
# verdict read the report file; verify-pack.mjs does exactly that.
if ($verdict -eq 'OK') { exit 0 } else { exit 1 }
