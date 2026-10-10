<#
  ws-state.ps1
  Workspace state manager.

  Records where and on which host the workspace was last used, and triggers the
  repair routine when either changed.

  Called in process by ws-env.ps1 and as a child process by ws-env.sh, so the
  detection logic exists in exactly one place.

  Two independent signals are compared.
    root  the drive letter changed
    host  the workspace was carried to another computer

  The host signal exists because a new computer can assign the same drive letter.
  In that case the root comparison stays silent while host dependent artifacts,
  such as the venv base interpreter recorded in pyvenv.cfg, may be broken.

  The root is stored in the mixed form, drive qualifier plus forward slashes,
  so the state file needs no JSON escaping and the bash entry point can read it
  without a parser.

  Parameters
      -Root      resolved workspace root
      -NoRepair  detect and record, but do not run the repair routine
      -Quiet     suppress informational output
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Root,
    [switch]$NoRepair,
    [switch]$Quiet
)

$ErrorActionPreference = 'Continue'

function Write-StateLog {
    param([string]$Message, [string]$Level = 'info')
    if ($Quiet -and $Level -eq 'info') { return }
    $colour = 'DarkCyan'
    if ($Level -eq 'warn')  { $colour = 'Yellow' }
    if ($Level -eq 'error') { $colour = 'Red' }
    Write-Host ('[ws] ' + $Message) -ForegroundColor $colour
}

function ConvertTo-MixedPath {
    param([string]$Path)
    if (-not $Path) { return '' }
    return ($Path -replace '\\', '/')
}

$portableDir = $PSScriptRoot
$stateDir    = Join-Path $portableDir 'state'
if (-not (Test-Path -LiteralPath $stateDir)) {
    New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
}
$stateFile = Join-Path $stateDir 'root.json'

$root    = [System.IO.Path]::GetFullPath($Root).TrimEnd([char]92)
$rootMix = ConvertTo-MixedPath $root

$qualifier   = Split-Path -Qualifier $root
$driveLetter = $qualifier.TrimEnd(':')
$volumeLabel = ''
try {
    $vol = Get-Volume -DriveLetter $driveLetter -ErrorAction Stop
    if ($vol) { $volumeLabel = [string]$vol.FileSystemLabel }
} catch { $volumeLabel = '' }

$hostName  = [string]$env:COMPUTERNAME
$userName  = [string]$env:USERNAME
$osCaption = ''
try {
    $osCaption = [string](Get-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' `
        -Name ProductName -ErrorAction Stop).ProductName
} catch { $osCaption = '' }

$previous = $null
if (Test-Path -LiteralPath $stateFile) {
    try { $previous = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json } catch { $previous = $null }
}

$relocated = $false
$hostMoved = $false
if ($previous) {
    $prevRootMix = ConvertTo-MixedPath ([string]$previous.root)
    if ($prevRootMix -and ($prevRootMix.ToLowerInvariant() -ne $rootMix.ToLowerInvariant())) { $relocated = $true }
    if ($previous.hostName -and ([string]$previous.hostName -ne $hostName)) { $hostMoved = $true }
}

if ($relocated -or $hostMoved) {
    if ($relocated) { Write-StateLog ('root changed: ' + $previous.root + '  ->  ' + $rootMix) 'warn' }
    if ($hostMoved) { Write-StateLog ('host changed: ' + $previous.hostName + '  ->  ' + $hostName) 'warn' }
    if (-not $NoRepair) {
        $repair = Join-Path $portableDir 'ws-repair.ps1'
        if (Test-Path -LiteralPath $repair) {
            $reason = 'manual'
            if ($relocated) { $reason = 'relocation' } elseif ($hostMoved) { $reason = 'host' }
            Write-StateLog ('running repair, reason = ' + $reason)
            & $repair -Root $root -PreviousRoot ([string]$previous.root) -Reason $reason
        }
    }
} else {
    Write-StateLog ('root = ' + $rootMix + '   host = ' + $hostName)
}

$state = [ordered]@{
    schema      = 2
    root        = $rootMix
    driveLetter = $driveLetter
    volumeLabel = $volumeLabel
    hostName    = $hostName
    userName    = $userName
    osCaption   = $osCaption
    lastSeenUtc = (Get-Date).ToUniversalTime().ToString('o')
}
[System.IO.File]::WriteAllText($stateFile, ($state | ConvertTo-Json), (New-Object System.Text.UTF8Encoding($false)))
