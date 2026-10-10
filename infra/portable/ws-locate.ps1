<#
  ws-locate.ps1
  Locate the workspace on whichever drive letter it is currently mounted as.
  Used for recovery when a tool or shortcut still points at the old path.

  The marker file .ws-root at the workspace root carries a stable id. Matching
  on that id is what makes the lookup independent of the drive letter.

  Usage
      powershell -ExecutionPolicy Bypass -File infra\portable\ws-locate.ps1
      powershell -ExecutionPolicy Bypass -File infra\portable\ws-locate.ps1 -MaxDepth 4
#>
[CmdletBinding()]
param(
    [string]$FolderName = '',
    [string]$MarkerId   = '',
    [int]$MaxDepth      = 3
)

$ErrorActionPreference = 'Continue'
$markerName = '.ws-root'

function Read-Marker {
    param([string]$Path)
    try { return (Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json) } catch { return $null }
}

$drives = Get-PSDrive -PSProvider FileSystem -ErrorAction SilentlyContinue |
          Where-Object { $_.Root -match '^[A-Za-z]:\\$' }

Write-Host 'Scanning mounted drives for the workspace marker...' -ForegroundColor DarkCyan

$found = New-Object System.Collections.Generic.List[object]

foreach ($drive in $drives) {
    $queue = New-Object System.Collections.Generic.Queue[object]
    $queue.Enqueue([pscustomobject]@{ Path = $drive.Root; Depth = 0 })
    while ($queue.Count -gt 0) {
        $node = $queue.Dequeue()
        $marker = Join-Path $node.Path $markerName
        if (Test-Path -LiteralPath $marker) {
            $m = Read-Marker $marker
            if ($m -and ((-not $MarkerId) -or ($m.id -eq $MarkerId)) -and
                ((-not $FolderName) -or ((Split-Path -Leaf $node.Path) -eq $FolderName))) {
                $found.Add([pscustomobject]@{ Path = $node.Path; Id = $m.id; Name = $m.name; Drive = $drive.Root }) | Out-Null
            }
        }
        if ($node.Depth -ge $MaxDepth) { continue }
        Get-ChildItem -LiteralPath $node.Path -Directory -Force -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -notin @('$RECYCLE.BIN', 'System Volume Information', 'Windows', 'Program Files', 'Program Files (x86)', 'ProgramData', 'AppData') } |
            ForEach-Object { $queue.Enqueue([pscustomobject]@{ Path = $_.FullName; Depth = ($node.Depth + 1) }) }
    }
}

if ($found.Count -eq 0) {
    Write-Host 'No workspace found. Check that the drive is connected and the marker exists.' -ForegroundColor Yellow
    exit 1
}

$found | Sort-Object Path -Unique | Format-Table -AutoSize
Write-Host ''
Write-Host 'Run the workspace through its own entry point to adopt the current letter:' -ForegroundColor DarkCyan
$found | Sort-Object Path -Unique | ForEach-Object {
    $candidates = @(
        (Join-Path $_.Path 'infra\portable\ws-run.cmd'),
        (Join-Path $_.Path 'portable\ws-run.cmd')
    )
    foreach ($c in $candidates) {
        if (Test-Path -LiteralPath $c) { Write-Host ('  ' + $c) -ForegroundColor DarkCyan; break }
    }
}
