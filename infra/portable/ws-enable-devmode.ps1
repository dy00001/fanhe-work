<#
  ws-enable-devmode.ps1
  Host level setup for the portable workspace.

  Turns on two Windows settings that the workspace depends on but cannot
  redirect, because they live in HKLM and apply to the whole machine.
    1. Developer Mode, which permits creating symbolic links without
       elevation. Required before Git core.symlinks can be switched to true.
    2. NTFS long path support, which lifts the 260 character path limit for
       Win32 applications that opt in.

  Both writes need administrator rights. Run the companion wrapper
  ws-enable-devmode.cmd, which self elevates. Running this script directly in
  a non elevated shell aborts without changing anything.

  Usage
      infra\portable\ws-enable-devmode.cmd
      powershell -ExecutionPolicy Bypass -File infra\portable\ws-enable-devmode.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Continue'

function Say {
    param([string]$Message, [string]$Level = 'info')
    switch ($Level) {
        'ok'    { Write-Host ('[setup] ' + $Message) -ForegroundColor Green }
        'warn'  { Write-Host ('[setup] ' + $Message) -ForegroundColor Yellow }
        'error' { Write-Host ('[setup] ' + $Message) -ForegroundColor Red }
        default { Write-Host ('[setup] ' + $Message) -ForegroundColor DarkGray }
    }
}

# ---------------------------------------------------------------------------
# 0. Elevation guard. Registry writes under HKLM fail without it, so the check
#    happens before anything is touched and the exit code stays meaningful.
# ---------------------------------------------------------------------------
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Say 'not elevated, nothing was changed' 'error'
    Say 'run ws-enable-devmode.cmd instead, it raises a UAC prompt' 'warn'
    exit 1
}

Say ('host = ' + $env:COMPUTERNAME + ' / ' + $env:USERNAME)

$failures = 0

# ---------------------------------------------------------------------------
# 1. Developer Mode. Allows symlink creation without an elevated token, which
#    is the precondition for Git core.symlinks = true.
# ---------------------------------------------------------------------------
$devKey  = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock'
$devName = 'AllowDevelopmentWithoutDevLicense'
$devBefore = $null
try { $devBefore = (Get-ItemProperty -Path $devKey -Name $devName -ErrorAction Stop).$devName } catch { $devBefore = 'NOT_SET' }
Say ('developer mode before = ' + $devBefore)
if (-not (Test-Path -LiteralPath $devKey)) { New-Item -Path $devKey -Force | Out-Null }
try {
    New-ItemProperty -Path $devKey -Name $devName -Value 1 -PropertyType DWord -Force -ErrorAction Stop | Out-Null
    $devAfter = (Get-ItemProperty -Path $devKey -Name $devName -ErrorAction Stop).$devName
    Say ('developer mode after  = ' + $devAfter + '   (1 means enabled)') 'ok'
} catch {
    Say ('developer mode write failed: ' + $_.Exception.Message) 'error'
    $failures++
}

# ---------------------------------------------------------------------------
# 2. NTFS long path support. The workspace path plus deep dependency trees can
#    exceed the 260 character default.
# ---------------------------------------------------------------------------
$lpKey  = 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem'
$lpName = 'LongPathsEnabled'
$lpBefore = $null
try { $lpBefore = (Get-ItemProperty -Path $lpKey -Name $lpName -ErrorAction Stop).$lpName } catch { $lpBefore = 'NOT_SET' }
Say ('long path support before = ' + $lpBefore)
try {
    New-ItemProperty -Path $lpKey -Name $lpName -Value 1 -PropertyType DWord -Force -ErrorAction Stop | Out-Null
    $lpAfter = (Get-ItemProperty -Path $lpKey -Name $lpName -ErrorAction Stop).$lpName
    Say ('long path support after  = ' + $lpAfter + '   (1 means enabled)') 'ok'
} catch {
    Say ('long path write failed: ' + $_.Exception.Message) 'error'
    $failures++
}

# ---------------------------------------------------------------------------
# 3. Summary
# ---------------------------------------------------------------------------
Write-Host ''
if ($failures -eq 0) {
    Say 'both settings are enabled' 'ok'
    Say 'open a new shell, and restart any running IDE, for the change to apply' 'warn'
    exit 0
} else {
    Say ('{0} setting(s) could not be written' -f $failures) 'error'
    exit 2
}
