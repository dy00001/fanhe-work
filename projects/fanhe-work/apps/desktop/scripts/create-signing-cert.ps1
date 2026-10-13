# Create (or reuse) the self-signed code signing certificate used to sign the
# Windows installer, and put its public part into the user's Trusted Publishers.
#
# WHY THIS FILE IS PURE ASCII
#   PowerShell 5.1 decodes a .ps1 without a UTF-8 BOM as the system ANSI code page
#   (GBK on this machine), which turns non-ASCII characters into mojibake and makes
#   the parser fail with a message that does not mention encoding at all -- and not a
#   single line of the script runs. A BOM would fix it, but a BOM is invisible in
#   review and easy to lose. Keeping the file ASCII removes the failure mode entirely.
#   The Chinese explanation for these decisions lives in
#   docs/T6-03-UPDATE-CHANNEL.md section 6.
#
# WHY THE SUBJECT IS ASCII
#   The subject travels through PowerShell -> the certificate store -> signtool ->
#   latest.yml / app-update.yml -> a string comparison inside electron-updater. One
#   lossy encoding step anywhere in that chain silently breaks update verification,
#   and this sandbox swallows PowerShell output so it is hard to observe. The
#   product name stays Chinese where it is user visible; the signing identity does
#   not need to be. Same reasoning as the ASCII installer file name.
#
# WHY THE CERTIFICATE LIVES IN THE STORE, NOT IN THE REPOSITORY
#   DEVELOPMENT-PLAN.md 6.3 item 6 requires that the signing key be kept separately
#   from the workspace and never travel with the removable medium. The workspace
#   lives on removable media; CurrentUser\My lives on the machine, protected by
#   DPAPI and the user's logon. No .pfx is written into the workspace.
#
# USAGE
#   powershell -ExecutionPolicy Bypass -File apps/desktop/scripts/create-signing-cert.ps1
#   powershell -ExecutionPolicy Bypass -File apps/desktop/scripts/create-signing-cert.ps1 -ReportPath <file>
#
#   -ReportPath writes a machine readable summary to a file. Use it from automation:
#   this sandbox swallows PowerShell stdout, so the file is the only reliable channel.

[CmdletBinding()]
param(
  [string]$Subject = 'CN=Fanhe Work',
  [int]$ValidYears = 5,
  [string]$ReportPath = ''
)

$ErrorActionPreference = 'Stop'
$report = New-Object System.Collections.Generic.List[string]

function Add-Report([string]$line) {
  $report.Add($line) | Out-Null
  Write-Host $line
}

try {
  # --- 1. Reuse an existing certificate if it is still usable ------------------
  # Idempotent on purpose: re-running must not rotate the signing identity, because
  # rotating it changes publisherName and breaks update verification on machines
  # that already have the app installed.
  $existing = @(Get-ChildItem Cert:\CurrentUser\My |
    Where-Object { $_.Subject -eq $Subject -and $_.HasPrivateKey })

  $cert = $null
  if ($existing.Count -gt 0) {
    # Prefer the one that lives longest, so a half-finished earlier run cannot win.
    $cert = $existing | Sort-Object NotAfter -Descending | Select-Object -First 1
    $daysLeft = [int]($cert.NotAfter - (Get-Date)).TotalDays
    if ($daysLeft -lt 30) {
      Add-Report "ACTION=rotate reason=expiring-in-$daysLeft-days"
      $cert = $null
    } else {
      Add-Report "ACTION=reuse thumbprint=$($cert.Thumbprint) daysLeft=$daysLeft"
    }
  } else {
    Add-Report 'ACTION=create reason=no-certificate-with-private-key-found'
  }

  # --- 2. Create it ------------------------------------------------------------
  if ($null -eq $cert) {
    $cert = New-SelfSignedCertificate `
      -Type CodeSigningCert `
      -Subject $Subject `
      -KeyUsage DigitalSignature `
      -KeyAlgorithm RSA `
      -KeyLength 2048 `
      -HashAlgorithm SHA256 `
      -KeyExportPolicy Exportable `
      -CertStoreLocation 'Cert:\CurrentUser\My' `
      -NotAfter (Get-Date).AddYears($ValidYears)
    Add-Report "ACTION=created thumbprint=$($cert.Thumbprint) notAfter=$($cert.NotAfter)"
  }

  # --- 3. Trust the public part on THIS machine --------------------------------
  # Without this the signature is present but reported as untrusted, and the
  # acceptance check cannot distinguish "we signed it" from "Windows rejects it".
  # Only the public certificate is exported; the private key never leaves the store.
  $alreadyTrusted = @(Get-ChildItem Cert:\CurrentUser\TrustedPublisher -ErrorAction SilentlyContinue |
    Where-Object { $_.Thumbprint -eq $cert.Thumbprint })

  if ($alreadyTrusted.Count -gt 0) {
    Add-Report 'TRUST=already-present'
  } else {
    $cerPath = Join-Path ([System.IO.Path]::GetTempPath()) ("fanhe-codesign-" + $cert.Thumbprint + '.cer')
    try {
      Export-Certificate -Cert $cert -FilePath $cerPath -Type CERT | Out-Null
      Import-Certificate -FilePath $cerPath -CertStoreLocation 'Cert:\CurrentUser\TrustedPublisher' | Out-Null
      Add-Report 'TRUST=added-to-TrustedPublisher'
    } finally {
      if (Test-Path $cerPath) { Remove-Item $cerPath -Force }
    }
  }

  # --- 4. Report ---------------------------------------------------------------
  Add-Report "SUBJECT=$($cert.Subject)"
  Add-Report "THUMBPRINT=$($cert.Thumbprint)"
  Add-Report "NOT_AFTER=$($cert.NotAfter)"
  Add-Report "HAS_PRIVATE_KEY=$($cert.HasPrivateKey)"
  Add-Report ("EKU=" + (($cert.EnhancedKeyUsageList | ForEach-Object { $_.FriendlyName }) -join ','))
  Add-Report 'RESULT=OK'
}
catch {
  Add-Report "RESULT=FAILED message=$($_.Exception.Message)"
  if ($ReportPath -ne '') {
    $report -join "`n" | Set-Content -Path $ReportPath -Encoding UTF8
  }
  exit 1
}

if ($ReportPath -ne '') {
  $report -join "`n" | Set-Content -Path $ReportPath -Encoding UTF8
}
exit 0
