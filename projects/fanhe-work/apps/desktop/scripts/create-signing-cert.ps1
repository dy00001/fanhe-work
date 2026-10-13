# Create (or reuse, import, export) the self-signed code signing certificate used to
# sign the Windows installer, put its public part into the user's Trusted Publishers,
# and keep a record of the signing IDENTITY so it can be found again later.
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
# WHY THERE IS NOW AN IDENTITY RECORD (added in tooling v2, T6-03d)
#   The certificate store is the right home for the key, but it remembers nothing
#   about which key was used to publish which release. Measured consequence on
#   2026-10-13: CurrentUser\My was empty, `dist:dir` failed with
#   "Cannot find certificate CN=Fanhe Work", and the only visible remedy --
#   re-running this script -- would have minted a NEW certificate with the SAME
#   subject but a DIFFERENT thumbprint. That stops every already-installed copy
#   from ever updating again, silently.
#
#   WHY, EXACTLY (get this right -- the intuitive answer is wrong):
#   It is NOT because publisherName changes. publisherName is derived from the
#   certificate Subject DN (app-builder-lib/out/publish/PublishManager.js:202 ->
#   computePublisherName in windowsSignToolManager.js), so the same CN yields the
#   same string -- measured output is `publisherName: [Fanhe Work]`. A new cert
#   with the same CN does not move it.
#   What actually breaks is the layer above: electron-updater only runs its
#   publisher comparison when `data.Status === 0` (Valid)
#   (electron-updater/out/windowsExecutableCodeSignatureVerifier.js:56), and
#   Status requires the chain to reach a root TRUSTED ON THAT MACHINE. A
#   self-signed root is imported per machine -- step 3 below only touches the
#   current user -- so a new certificate means a new root that already-installed
#   machines do not have: Status becomes UnknownError(1), the whole comparison is
#   skipped, and the update is refused. Same gate T6-03b hit locally, recurring
#   after a machine change. Fix the TRUST ROOT, not publisherName.
#
#   So every run now writes a small JSON record (default
#   %LOCALAPPDATA%\FanheWork\signing\signing-identity.json) holding the current
#   identity plus a history of the ones it replaced. With it:
#     - a lost key can be identified and restored instead of blindly replaced;
#     - changing the identity requires -AllowRotate, so it cannot happen by accident;
#     - `verify:pack` can assert the built artifacts were signed by the recorded
#       identity rather than by "some certificate".
#
# BACKWARD COMPATIBILITY
#   The script name, the -Subject / -ValidYears / -ReportPath parameters and the
#   report keys (SUBJECT / THUMBPRINT / NOT_AFTER / HAS_PRIVATE_KEY / EKU / RESULT)
#   are unchanged. -Subject now defaults to '' meaning "read certificateSubjectName
#   from electron-builder.yml", falling back to CN=Fanhe Work -- the same effective
#   default as before, but with one source of truth instead of two constants that
#   could drift apart. Every other parameter is new and optional, and a machine
#   with no identity record behaves exactly as tooling v1 did.
#
# USAGE
#   powershell -ExecutionPolicy Bypass -File apps/desktop/scripts/create-signing-cert.ps1
#   powershell -ExecutionPolicy Bypass -File apps/desktop/scripts/create-signing-cert.ps1 -ReportPath <file>
#   powershell -ExecutionPolicy Bypass -File apps/desktop/scripts/create-signing-cert.ps1 -CheckOnly -ReportPath <file>
#   powershell -ExecutionPolicy Bypass -File apps/desktop/scripts/create-signing-cert.ps1 -ExportPath D:\keys\fanhe.pfx
#   powershell -ExecutionPolicy Bypass -File apps/desktop/scripts/create-signing-cert.ps1 -ImportPath D:\keys\fanhe.pfx
#   powershell -ExecutionPolicy Bypass -File apps/desktop/scripts/create-signing-cert.ps1 -AdoptFromArtifact -ArtifactPath release\fanhe-work-setup-0.1.1.exe
#
#   -AdoptFromArtifact rebuilds the identity record from the signer certificate
#   embedded in an already-signed artifact. It is the recovery path when the key is
#   gone but a published build survives: it touches no certificate store, creates
#   nothing, and only writes the record. HAS_PRIVATE_KEY is reported as False --
#   knowing the identity does not make signing possible again.
#
#   -ReportPath writes a machine readable summary to a file. Use it from automation:
#   this sandbox swallows PowerShell stdout, so the file is the only reliable channel.
#
#   -ImportPath / -ExportPath take the pfx password from the environment variable
#   named by -ExportPasswordEnvVar (default FANHE_SIGNING_PFX_PASSWORD), never from
#   argv -- argv is visible in the process table to any other process on the machine.

[CmdletBinding()]
param(
  [string]$Subject = '',
  [int]$ValidYears = 5,
  [string]$ReportPath = '',
  [string]$ImportPath = '',
  [string]$ExportPath = '',
  [string]$ExportPasswordEnvVar = 'FANHE_SIGNING_PFX_PASSWORD',
  [string]$IdentityPath = '',
  [switch]$CheckOnly,
  [switch]$AllowRotate,
  [switch]$AllowWorkspaceExport,
  [switch]$AdoptFromArtifact,
  [string]$ArtifactPath = ''
)

$ErrorActionPreference = 'Stop'

# Bump TOOLING_VERSION when the record's meaning changes; bump SCHEMA_VERSION only
# when the file's shape changes. Readers use them to tell "written by an older
# script" from "not a record at all".
$SCHEMA_VERSION = 1
$TOOLING_VERSION = 2
$FALLBACK_SUBJECT = 'CN=Fanhe Work'
$ROTATE_WITHIN_DAYS = 30
$IDENTITY_FILE_NAME = 'signing-identity.json'

$report = New-Object System.Collections.Generic.List[string]

function Add-Report([string]$line) {
  $report.Add($line) | Out-Null
  Write-Host $line
}

# Resolve a possibly relative path against the caller's current directory.
function Resolve-FullPath([string]$Path) {
  if ([System.IO.Path]::IsPathRooted($Path)) { return [System.IO.Path]::GetFullPath($Path) }
  return [System.IO.Path]::GetFullPath((Join-Path (Get-Location).Path $Path))
}

# The single source of truth for the signing subject is electron-builder.yml.
# Keeping a second copy in this file is exactly the kind of duplicated constant the
# project's docs warn about: two copies drift, and neither one complains.
function Resolve-ConfiguredSubject([string]$DesktopDir) {
  $yml = Join-Path $DesktopDir 'electron-builder.yml'
  if (-not (Test-Path -LiteralPath $yml)) { return '' }
  try {
    $text = [System.IO.File]::ReadAllText($yml)
  } catch {
    return ''
  }
  $m = [regex]::Match($text, '(?m)^[ \t]*certificateSubjectName:[ \t]*(.+?)[ \t]*\r?$')
  if (-not $m.Success) { return '' }
  return $m.Groups[1].Value.Trim().Trim("'").Trim('"')
}

# Returns @{ State = 'absent' | 'corrupt' | 'ok'; Record = $null|object; Message = '' }.
# A corrupt record is reported as such rather than treated as "no record": the two
# mean opposite things. "No record" is a fresh machine; "corrupt record" is a machine
# that HAS a history and just lost the ability to read it -- so it must not silently
# fall back to the fresh-machine path, which would happily mint a new identity.
function Read-IdentityRecord([string]$Path) {
  $result = @{ State = 'absent'; Record = $null; Message = '' }
  if ([string]::IsNullOrEmpty($Path)) {
    $result.Message = 'no identity path'
    return $result
  }
  if (-not (Test-Path -LiteralPath $Path)) { return $result }
  try {
    $raw = [System.IO.File]::ReadAllText($Path)
    $obj = $raw | ConvertFrom-Json
    if ($null -eq $obj -or [string]::IsNullOrEmpty([string]$obj.thumbprint)) {
      $result.State = 'corrupt'
      $result.Message = 'parsed but carries no thumbprint'
      return $result
    }
    $result.State = 'ok'
    $result.Record = $obj
    return $result
  } catch {
    $result.State = 'corrupt'
    $result.Message = $_.Exception.Message
    return $result
  }
}

function Write-IdentityRecord([string]$Path, $Cert, $History, [string]$CreatedAt) {
  $dir = Split-Path -Parent $Path
  if (-not (Test-Path -LiteralPath $dir)) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
  }
  $now = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  # Both of these can throw on CNG-backed keys; the record treats them as optional
  # detail, so degrade to empty/0 instead of failing the whole run over a nice-to-have.
  $keyAlgorithm = ''
  try { $keyAlgorithm = [string]$Cert.PublicKey.Oid.FriendlyName } catch { $keyAlgorithm = '' }
  $keyLength = 0
  try { $keyLength = [int]$Cert.PublicKey.Key.KeySize } catch { $keyLength = 0 }

  $obj = [ordered]@{
    schemaVersion = $SCHEMA_VERSION
    toolingVersion = $TOOLING_VERSION
    subject       = [string]$Cert.Subject
    simpleName    = ([string]$Cert.Subject -replace '^CN=', '')
    thumbprint    = [string]$Cert.Thumbprint
    notBefore     = $Cert.NotBefore.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    notAfter      = $Cert.NotAfter.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    keyAlgorithm  = $keyAlgorithm
    keyLength     = $keyLength
    hashAlgorithm = 'SHA256'
    createdAt     = $CreatedAt
    updatedAt     = $now
    history       = @($History)
  }

  # Written through .NET rather than Set-Content: PowerShell 5.1's
  # `-Encoding UTF8` emits a BOM, and JSON.parse rejects a BOM.
  $json = $obj | ConvertTo-Json -Depth 6
  [System.IO.File]::WriteAllText($Path, $json, (New-Object System.Text.UTF8Encoding($false)))
}

# Walk up for the workspace marker. Never hardcode a drive letter: the workspace
# lives on removable media and the letter changes between machines.
function Find-WorkspaceRoot([string]$From) {
  $current = $From
  for ($i = 0; $i -lt 12; $i++) {
    if (Test-Path -LiteralPath (Join-Path $current '.ws-root')) { return $current }
    $parent = Split-Path -Parent $current
    if ([string]::IsNullOrEmpty($parent) -or $parent -eq $current) { break }
    $current = $parent
  }
  return $null
}

# Containment test that does not fall for the "E:\ws" vs "E:\ws2" prefix trap.
function Test-PathInside([string]$Child, [string]$Parent) {
  if ([string]::IsNullOrEmpty($Child) -or [string]::IsNullOrEmpty($Parent)) { return $false }
  $c = [System.IO.Path]::GetFullPath($Child).TrimEnd('\', '/')
  $p = [System.IO.Path]::GetFullPath($Parent).TrimEnd('\', '/')
  if ($c.Equals($p, [System.StringComparison]::OrdinalIgnoreCase)) { return $true }
  return $c.StartsWith($p + '\', [System.StringComparison]::OrdinalIgnoreCase)
}

$exitCode = 0

try {
  $desktopDir = Split-Path -Parent $PSScriptRoot

  # --- 0. Resolve the subject and the identity record path ---------------------
  $subjectSource = 'argument'
  if ([string]::IsNullOrEmpty($Subject)) {
    $Subject = Resolve-ConfiguredSubject $desktopDir
    $subjectSource = 'electron-builder.yml'
    if ([string]::IsNullOrEmpty($Subject)) {
      $Subject = $FALLBACK_SUBJECT
      $subjectSource = 'fallback'
    }
  }

  if ([string]::IsNullOrEmpty($IdentityPath)) {
    $localAppData = $env:LOCALAPPDATA
    if (-not [string]::IsNullOrEmpty($localAppData)) {
      $IdentityPath = Join-Path (Join-Path $localAppData 'FanheWork\signing') $IDENTITY_FILE_NAME
    }
  }

  $identity = Read-IdentityRecord $IdentityPath

  Add-Report "TOOLING_VERSION=$TOOLING_VERSION"
  Add-Report "SCHEMA_VERSION=$SCHEMA_VERSION"
  Add-Report "SUBJECT=$Subject"
  Add-Report "SUBJECT_SOURCE=$subjectSource"
  Add-Report "IDENTITY_PATH=$IdentityPath"
  Add-Report "IDENTITY_RECORD=$($identity.State)"
  if ($identity.State -eq 'corrupt') {
    Add-Report "WARN_IDENTITY_RECORD_CORRUPT=$($identity.Message)"
  }
  if ($identity.State -eq 'ok') {
    Add-Report "IDENTITY_RECORD_THUMBPRINT=$($identity.Record.thumbprint)"
  }

  if ($CheckOnly) {
    # --- Check-only: read the world, change nothing ----------------------------
    # Exit 0 only when a usable certificate exists AND it is the recorded identity.
    # Absence and drift are failures on purpose: both mean "do not start a build yet",
    # and the caller (a human or a script) needs to be able to tell them apart.
    $current = @(Get-ChildItem Cert:\CurrentUser\My -ErrorAction SilentlyContinue |
      Where-Object { $_.Subject -eq $Subject -and $_.HasPrivateKey })

    if ($current.Count -eq 0) {
      Add-Report 'CURRENT_THUMBPRINT='
      Add-Report 'RESULT=MISSING reason=no-certificate-with-private-key-found'
      Add-Report 'HINT=restore it with -ImportPath <pfx> if you still have the original; creating a new one changes the signing identity'
      $exitCode = 1
    } else {
      $cert = $current | Sort-Object NotAfter -Descending | Select-Object -First 1
      $daysLeft = [int]($cert.NotAfter - (Get-Date)).TotalDays
      Add-Report "CURRENT_THUMBPRINT=$($cert.Thumbprint)"
      Add-Report "CURRENT_NOT_AFTER=$($cert.NotAfter)"
      Add-Report "CURRENT_DAYS_LEFT=$daysLeft"
      if ($identity.State -eq 'ok' -and ([string]$identity.Record.thumbprint) -ne ([string]$cert.Thumbprint)) {
        Add-Report 'RESULT=DRIFT reason=record-thumbprint-differs'
        Add-Report "HINT=the recorded identity is $($identity.Record.thumbprint); builds signed with the current one will not update machines holding the recorded one"
        $exitCode = 1
      } elseif ($daysLeft -lt $ROTATE_WITHIN_DAYS) {
        Add-Report 'RESULT=EXPIRING reason=less-than-rotate-window'
        $exitCode = 1
      } else {
        Add-Report 'RESULT=OK'
      }
    }
  } elseif ($AdoptFromArtifact) {
    # --- Adopt: rebuild the identity record from an already-signed artifact ------
    # This is the recovery path for the exact situation the record exists for: the
    # certificate is gone from the store, but a previously published artifact still
    # carries the signer's public certificate. That is enough to learn WHICH identity
    # signed that release -- the one fact needed to choose between "go find the
    # original key" and "rotate deliberately".
    #
    # It touches NO certificate store and creates NOTHING. A private key cannot be
    # recovered from a signed file, and pretending otherwise would be worse than the
    # original problem. Only the identity record is written.
    #
    # Measured motivation (2026-10-13): CurrentUser\My was empty and nothing on the
    # machine recorded the identity, yet release\fanhe-work-setup-0.1.{0,1}.exe were
    # both signed by thumbprint 0604B238... -- recoverable only from the artifacts.
    if ([string]::IsNullOrEmpty($ArtifactPath)) {
      throw 'AdoptFromArtifact was given but ArtifactPath is empty. Point it at a signed artifact, e.g. release\fanhe-work-setup-0.1.1.exe'
    }
    $artifact = Resolve-FullPath $ArtifactPath
    if (-not (Test-Path -LiteralPath $artifact)) {
      throw "ArtifactPath does not exist: $artifact"
    }
    $sig = Get-AuthenticodeSignature -LiteralPath $artifact -ErrorAction Stop
    if ($null -eq $sig.SignerCertificate) {
      throw "no embedded signature in $artifact (Status=$($sig.Status)), so there is no identity to adopt from it"
    }
    $adopted = $sig.SignerCertificate

    Add-Report "ADOPT_ARTIFACT=$artifact"
    Add-Report "ADOPT_STATUS=$($sig.Status)"
    Add-Report "ADOPT_SUBJECT=$($adopted.Subject)"
    Add-Report "ADOPT_THUMBPRINT=$($adopted.Thumbprint)"

    $now = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    # createdAt means "how old is this key", not "when did I write this file" -- so an
    # adopted identity takes the certificate's own NotBefore. Using the adopt moment
    # would make a years-old key look brand new, which is the opposite of the point.
    $createdAt = $adopted.NotBefore.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    $history = @()
    $adoptChangesRecord = $false
    if ($identity.State -eq 'ok') {
      # Guard against @($null) producing a one-element array containing $null.
      if ($null -ne $identity.Record.history) { $history += @($identity.Record.history) }
      if (([string]$identity.Record.thumbprint) -ne ([string]$adopted.Thumbprint)) {
        $adoptChangesRecord = $true
      } elseif (-not [string]::IsNullOrEmpty([string]$identity.Record.createdAt)) {
        $createdAt = [string]$identity.Record.createdAt
      }
    }

    # Same rule as the normal path: the record's identity never changes without an
    # explicit -AllowRotate. Adopting a different identity rewrites what the record
    # claims the last release was signed with, and that claim is what the guard and
    # verify:pack reason from -- so it does not get to change by accident either.
    if ($adoptChangesRecord) {
      if (-not $AllowRotate) {
        throw "the artifact was signed by a different identity than the record (record=$($identity.Record.thumbprint), artifact=$($adopted.Thumbprint)). Adopting it would rewrite what the record claims, so pass -AllowRotate to accept that deliberately."
      }
      $history += [pscustomobject]@{
        thumbprint = [string]$identity.Record.thumbprint
        subject    = [string]$identity.Record.subject
        replacedAt = $now
        reason     = 'adopted-from-artifact'
      }
      Add-Report 'IDENTITY_CHANGE=allowed-by-AllowRotate'
    }

    if ($identity.State -eq 'corrupt' -and -not [string]::IsNullOrEmpty($IdentityPath)) {
      $stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
      $backup = "$IdentityPath.corrupt-$stamp"
      try {
        Copy-Item -LiteralPath $IdentityPath -Destination $backup -Force
        Add-Report "IDENTITY_CORRUPT_BACKUP=$backup"
      } catch {
        Add-Report "IDENTITY_CORRUPT_BACKUP_FAILED=$($_.Exception.Message)"
      }
    }

    if (-not [string]::IsNullOrEmpty($IdentityPath)) {
      Write-IdentityRecord -Path $IdentityPath -Cert $adopted -History $history -CreatedAt $createdAt
      Add-Report 'ACTION=adopted'
      Add-Report "IDENTITY_WRITTEN=$IdentityPath"
      Add-Report "IDENTITY_HISTORY_COUNT=$($history.Count)"
    } else {
      Add-Report 'IDENTITY_WRITTEN=skipped reason=no-LOCALAPPDATA'
    }

    Add-Report "SUBJECT=$($adopted.Subject)"
    Add-Report "THUMBPRINT=$($adopted.Thumbprint)"
    Add-Report "NOT_AFTER=$($adopted.NotAfter)"
    # Always False here, and that is the point: the private key is not on this
    # machine. Building still requires the original key (-ImportPath) or a
    # deliberate rotation -- adopting the identity does not make signing possible.
    Add-Report 'HAS_PRIVATE_KEY=False'
    Add-Report 'RESULT=OK'
  } else {
    # --- 1. Decide which certificate this run is about --------------------------
    $cert = $null
    $rotateReason = ''

    if (-not [string]::IsNullOrEmpty($ImportPath)) {
      $password = [Environment]::GetEnvironmentVariable($ExportPasswordEnvVar)
      if ([string]::IsNullOrEmpty($password)) {
        throw "ImportPath was given but $ExportPasswordEnvVar is empty. Supply the pfx password through that environment variable -- never through the command line, where it is visible in the process table."
      }
      $secure = ConvertTo-SecureString -String $password -AsPlainText -Force
      $imported = Import-PfxCertificate -FilePath $ImportPath -CertStoreLocation 'Cert:\CurrentUser\My' -Password $secure
      $thumb = [string](@($imported)[0].Thumbprint)
      # Re-read from the store: the object returned by Import-PfxCertificate is not
      # guaranteed to expose HasPrivateKey the way a store-backed one does.
      $cert = @(Get-ChildItem Cert:\CurrentUser\My |
        Where-Object { $_.Thumbprint -eq $thumb }) | Select-Object -First 1
      if ($null -eq $cert) {
        throw "imported $ImportPath but thumbprint $thumb is not in CurrentUser\My afterwards"
      }
      Add-Report "IMPORT=$ImportPath"
      Add-Report "IMPORT_THUMBPRINT=$thumb"
      if ([string]$cert.Subject -ne $Subject) {
        Add-Report "WARN_SUBJECT_MISMATCH=imported:$($cert.Subject) configured:$Subject"
      }
    } else {
      # Idempotent on purpose: re-running must not rotate the signing identity, because
      # rotating it changes publisherName and breaks update verification on machines
      # that already have the app installed.
      $existing = @(Get-ChildItem Cert:\CurrentUser\My |
        Where-Object { $_.Subject -eq $Subject -and $_.HasPrivateKey })

      if ($existing.Count -gt 0) {
        # Prefer the one that lives longest, so a half-finished earlier run cannot win.
        $candidate = $existing | Sort-Object NotAfter -Descending | Select-Object -First 1
        $daysLeft = [int]($candidate.NotAfter - (Get-Date)).TotalDays
        if ($daysLeft -lt $ROTATE_WITHIN_DAYS) {
          $rotateReason = "expiring-in-$daysLeft-days"
        } else {
          $cert = $candidate
          Add-Report "ACTION=reuse thumbprint=$($cert.Thumbprint) daysLeft=$daysLeft"
        }
      } else {
        $rotateReason = 'no-certificate-with-private-key-found'
      }
    }

    # --- 2. Guard: the signing identity must never change silently ---------------
    $recordThumbprint = ''
    if ($identity.State -eq 'ok') { $recordThumbprint = [string]$identity.Record.thumbprint }

    $willChange = $false
    $plannedThumbprint = ''
    if ($null -ne $cert) {
      $plannedThumbprint = [string]$cert.Thumbprint
      if ($identity.State -eq 'ok' -and $plannedThumbprint -ne $recordThumbprint) { $willChange = $true }
    } elseif ($identity.State -eq 'ok') {
      # About to mint a brand new identity; it cannot match the recorded one.
      $willChange = $true
    }

    if ($willChange) {
      if (-not $AllowRotate) {
        throw "the signing identity is about to change (record=$recordThumbprint, planned=$plannedThumbprint, reason=$rotateReason). Every machine that already installed a build signed by the recorded identity would stop receiving updates, and nothing would report an error: the new root is not trusted there, so Status is not Valid and electron-updater skips the whole check (see the header). Restore the recorded identity with -ImportPath <pfx> (recommended), or pass -AllowRotate to accept that consequence deliberately."
      }
      Add-Report 'IDENTITY_CHANGE=allowed-by-AllowRotate'
    }

    # A corrupt record cannot be allowed to overwrite its own evidence: keep a copy
    # before the new record replaces it, so the lost history is still recoverable.
    if ($identity.State -eq 'corrupt' -and -not [string]::IsNullOrEmpty($IdentityPath)) {
      $stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
      $backup = "$IdentityPath.corrupt-$stamp"
      try {
        Copy-Item -LiteralPath $IdentityPath -Destination $backup -Force
        Add-Report "IDENTITY_CORRUPT_BACKUP=$backup"
      } catch {
        Add-Report "IDENTITY_CORRUPT_BACKUP_FAILED=$($_.Exception.Message)"
      }
    }

    # --- 3. Create it if this run is about a new one ----------------------------
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
      if ([string]::IsNullOrEmpty($rotateReason)) { $rotateReason = 'no-certificate-with-private-key-found' }
      Add-Report "ACTION=created reason=$rotateReason thumbprint=$($cert.Thumbprint) notAfter=$($cert.NotAfter)"
    }

    # --- 4. Trust the public part on THIS machine --------------------------------
    # TWO stores are needed, and they do different jobs. Adding only to
    # TrustedPublisher -- which is what this script did until T6-03b -- is not enough
    # and leaves a silent hole:
    #
    #   TrustedPublisher  suppresses the "unknown publisher" prompt. It does NOT make
    #                     the certificate chain trusted.
    #   Root               is what makes the chain trusted. Without it
    #                     Get-AuthenticodeSignature reports Status=UnknownError
    #                     ("the certificate chain terminated in a root certificate
    #                     which is not trusted"), NOT Valid.
    #
    # !! Why that matters: electron-updater's Windows verifier only enters its
    # publisher-name matching when `data.Status === 0` (SignatureStatus.Valid) --
    # see windowsExecutableCodeSignatureVerifier.js. With Status=UnknownError the whole
    # match block is skipped and EVERY update is refused, while the file still looks
    # perfectly signed to a human. Measured on this machine before the fix:
    # STATUS=UnknownError VALUE=1, Root=False; after: STATUS=Valid VALUE=0, Root=True.
    #
    # Only the public certificate is exported; the private key never leaves the store.
    $cerPath = Join-Path ([System.IO.Path]::GetTempPath()) ("fanhe-codesign-" + $cert.Thumbprint + '.cer')
    try {
      Export-Certificate -Cert $cert -FilePath $cerPath -Type CERT -Force | Out-Null

      $thumbprint = $cert.Thumbprint
      $inPublisher = @(Get-ChildItem Cert:\CurrentUser\TrustedPublisher -ErrorAction SilentlyContinue |
        Where-Object { $_.Thumbprint -eq $thumbprint })
      if ($inPublisher.Count -gt 0) {
        Add-Report 'TRUST_PUBLISHER=already-present'
      } else {
        Import-Certificate -FilePath $cerPath -CertStoreLocation 'Cert:\CurrentUser\TrustedPublisher' | Out-Null
        Add-Report 'TRUST_PUBLISHER=added'
      }

      $inRoot = @(Get-ChildItem Cert:\CurrentUser\Root -ErrorAction SilentlyContinue |
        Where-Object { $_.Thumbprint -eq $thumbprint })
      if ($inRoot.Count -gt 0) {
        Add-Report 'TRUST_ROOT=already-present'
      } else {
        # certutil, not Import-Certificate: adding to Root through the cmdlet fails in a
        # non-interactive session with "This operation does not allow the use of UI" --
        # it wants the root-certificate confirmation dialog. `certutil -user -addstore`
        # writes HKCU and does not prompt (measured: exit 0).
        $certutil = Join-Path $env:SystemRoot 'System32\certutil.exe'
        $out = & $certutil '-user' '-addstore' '-f' 'Root' $cerPath 2>&1 | Out-String
        $code = $LASTEXITCODE
        $ok = @(Get-ChildItem Cert:\CurrentUser\Root -ErrorAction SilentlyContinue |
          Where-Object { $_.Thumbprint -eq $thumbprint }).Count -gt 0
        Add-Report "TRUST_ROOT_CERTUTIL_EXIT=$code VERIFIED=$ok"
        if (-not $ok) {
          $oneLine = ($out -replace "`r?`n", ' | ').Trim()
          Add-Report "TRUST_ROOT_FAILED out=$oneLine"
          throw "could not add the signing certificate to CurrentUser\Root; electron-updater would refuse every update"
        }
      }
    } finally {
      if (Test-Path $cerPath) { Remove-Item $cerPath -Force }
    }

    # --- 5. Export the identity so another machine can reproduce it --------------
    if (-not [string]::IsNullOrEmpty($ExportPath)) {
      $full = Resolve-FullPath $ExportPath
      $wsRoot = Find-WorkspaceRoot $PSScriptRoot
      if ((-not $AllowWorkspaceExport) -and (Test-PathInside $full $wsRoot)) {
        throw "refusing to write the private key into the workspace ($full is inside $wsRoot). The workspace travels on removable media and DEVELOPMENT-PLAN.md 6.3 item 6 requires the signing key to be kept separately. Pick a path outside, or pass -AllowWorkspaceExport if you really mean it."
      }
      $password = [Environment]::GetEnvironmentVariable($ExportPasswordEnvVar)
      if ([string]::IsNullOrEmpty($password)) {
        throw "ExportPath was given but $ExportPasswordEnvVar is empty. Supply the pfx password through that environment variable -- never through the command line, where it is visible in the process table."
      }
      $exportDir = Split-Path -Parent $full
      if (-not [string]::IsNullOrEmpty($exportDir) -and -not (Test-Path -LiteralPath $exportDir)) {
        New-Item -ItemType Directory -Path $exportDir -Force | Out-Null
      }
      $secure = ConvertTo-SecureString -String $password -AsPlainText -Force
      Export-PfxCertificate -Cert $cert -FilePath $full -Password $secure | Out-Null
      Add-Report "EXPORT=$full"
      Add-Report "EXPORT_THUMBPRINT=$($cert.Thumbprint)"
    }

    # --- 6. Record the identity ---------------------------------------------------
    $now = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    $createdAt = $now
    $history = @()
    if ($identity.State -eq 'ok') {
      # Guard against @($null) producing a one-element array containing $null.
      if ($null -ne $identity.Record.history) { $history += @($identity.Record.history) }
      if (([string]$identity.Record.thumbprint) -ne ([string]$cert.Thumbprint)) {
        $history += [pscustomobject]@{
          thumbprint = [string]$identity.Record.thumbprint
          subject    = [string]$identity.Record.subject
          replacedAt = $now
          reason     = $rotateReason
        }
      } elseif (-not [string]::IsNullOrEmpty([string]$identity.Record.createdAt)) {
        # Same identity: keep its original createdAt, so the record tells the truth
        # about how old the key is instead of resetting on every run.
        $createdAt = [string]$identity.Record.createdAt
      }
    }

    if (-not [string]::IsNullOrEmpty($IdentityPath)) {
      Write-IdentityRecord -Path $IdentityPath -Cert $cert -History $history -CreatedAt $createdAt
      Add-Report "IDENTITY_WRITTEN=$IdentityPath"
      Add-Report "IDENTITY_HISTORY_COUNT=$($history.Count)"
    } else {
      Add-Report 'IDENTITY_WRITTEN=skipped reason=no-LOCALAPPDATA'
    }

    # --- 7. Report ---------------------------------------------------------------
    Add-Report "SUBJECT=$($cert.Subject)"
    Add-Report "THUMBPRINT=$($cert.Thumbprint)"
    Add-Report "NOT_AFTER=$($cert.NotAfter)"
    Add-Report "HAS_PRIVATE_KEY=$($cert.HasPrivateKey)"
    Add-Report ("EKU=" + (($cert.EnhancedKeyUsageList | ForEach-Object { $_.FriendlyName }) -join ','))
    Add-Report 'RESULT=OK'
  }
} catch {
  Add-Report "RESULT=FAILED message=$($_.Exception.Message)"
  $exitCode = 1
}

if ($ReportPath -ne '') {
  $report -join "`n" | Set-Content -Path $ReportPath -Encoding UTF8
}
exit $exitCode
