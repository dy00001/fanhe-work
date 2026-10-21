<#
  ws-links.ps1
  Detect and repair pnpm link targets left pointing at a previous workspace root.

  Why this exists
  ---------------
  On Windows pnpm links packages with junctions. A junction carries an absolute
  target and has no relative form, so moving the workspace to another drive
  letter leaves every junction pointing at a path that no longer exists. pnpm
  offers no option to emit relative junctions, therefore there are only two
  remedies: keep the mount path constant, or rewrite the targets after a move.

  This script implements the second remedy and the verification for both.

  What it inspects
  ----------------
    1. every junction under projects/*/node_modules and the workspace root
    2. node_modules/.pnpm-workspace-state-v1.json   (absolute project keys)
    3. node_modules/.modules.yaml                   (absolute storeDir)
    4. the count of top level package links against the declared dependencies

  Usage
  -----
      infra\portable\ws-links.ps1
      infra\portable\ws-links.ps1 -Repair
      infra\portable\ws-links.ps1 -Repair -PreviousRoot 'F:\fanhe Work'

  Parameters
  ----------
      -Root          workspace root, discovered from the .ws-root marker when omitted
      -PreviousRoot  old root; inferred from .pnpm-workspace-state-v1.json when omitted
      -Repair        rewrite targets and state files; without it the pass is read only
      -Quiet         print problems only

  Exit codes
  ----------
      0  no problem found, or every problem was repaired
      1  problems remain
#>
[CmdletBinding()]
param(
    [string]$Root = '',
    [string]$PreviousRoot = '',
    [switch]$Repair,
    [switch]$Quiet
)

$ErrorActionPreference = 'Continue'

$script:Problems = 0
$script:Fixed = 0

function Say {
    param([string]$Message, [string]$Level = 'info')
    switch ($Level) {
        'ok'    { if (-not $Quiet) { Write-Host ('[links] ' + $Message) -ForegroundColor Green } }
        'warn'  { Write-Host ('[links] ' + $Message) -ForegroundColor Yellow; $script:Problems++ }
        'error' { Write-Host ('[links] ' + $Message) -ForegroundColor Red;    $script:Problems++ }
        'done'  { Write-Host ('[links] ' + $Message) -ForegroundColor Green }
        default { if (-not $Quiet) { Write-Host ('[links] ' + $Message) -ForegroundColor DarkGray } }
    }
}

# ---------------------------------------------------------------------------
# 1. Resolve the root from the .ws-root marker, never from a stored path.
# ---------------------------------------------------------------------------
function Get-WsRootPath {
    param([string]$Start)
    $probe = [System.IO.Path]::GetFullPath($Start)
    while ($probe) {
        if (Test-Path -LiteralPath (Join-Path $probe '.ws-root')) { return $probe }
        $parent = Split-Path -Parent $probe
        if ((-not $parent) -or ($parent -eq $probe)) { return $null }
        $probe = $parent
    }
    return $null
}

if (-not $Root) {
    $Root = Get-WsRootPath -Start $PSScriptRoot
}
if (-not $Root) {
    Write-Host '[links] cannot locate the workspace root, no .ws-root marker found' -ForegroundColor Red
    exit 1
}
$Root = [System.IO.Path]::GetFullPath($Root).TrimEnd('\')
Say ('root = ' + $Root)

# ---------------------------------------------------------------------------
# 2. Collect the node_modules directories that carry pnpm links.
#    Depth is capped at two levels below the root, which covers the layout
#    projects/<name>/node_modules without walking the whole workspace.
# ---------------------------------------------------------------------------
function Get-NodeModulesDirs {
    param([string]$WsRoot)
    $found = New-Object System.Collections.Generic.List[string]

    $direct = Join-Path $WsRoot 'node_modules'
    if (Test-Path -LiteralPath $direct) { $found.Add($direct) | Out-Null }

    $level1 = Get-ChildItem -LiteralPath $WsRoot -Directory -Force -ErrorAction SilentlyContinue
    foreach ($a in $level1) {
        $nm = Join-Path $a.FullName 'node_modules'
        if (Test-Path -LiteralPath $nm) { $found.Add($nm) | Out-Null }

        $level2 = Get-ChildItem -LiteralPath $a.FullName -Directory -Force -ErrorAction SilentlyContinue
        foreach ($b in $level2) {
            $nm2 = Join-Path $b.FullName 'node_modules'
            if (Test-Path -LiteralPath $nm2) { $found.Add($nm2) | Out-Null }
        }
    }
    return $found | Select-Object -Unique
}

# ---------------------------------------------------------------------------
# 3. Walk one node_modules tree breadth first.
#    Junctions are recorded and never entered, which keeps the walk finite and
#    avoids following a link into a directory that may not exist.
# ---------------------------------------------------------------------------
function Get-LinkRecords {
    param([string]$Start, [int]$MaxDepth = 7)

    $records = New-Object System.Collections.Generic.List[object]
    $queue = New-Object System.Collections.Generic.Queue[object]
    $queue.Enqueue([pscustomobject]@{ Path = $Start; Depth = 0 })

    while ($queue.Count -gt 0) {
        $node = $queue.Dequeue()
        if ($node.Depth -gt $MaxDepth) { continue }

        $items = Get-ChildItem -LiteralPath $node.Path -Force -ErrorAction SilentlyContinue
        foreach ($it in $items) {
            if ($it.LinkType) {
                $target = ''
                if ($it.Target) {
                    $arr = @($it.Target)
                    if ($arr.Count -gt 0) { $target = [string]$arr[0] }
                }
                $records.Add([pscustomobject]@{
                    Path    = $it.FullName
                    LinkType = $it.LinkType
                    Target  = $target
                    Exists  = ($target -ne '') -and (Test-Path -LiteralPath $target)
                }) | Out-Null
                continue
            }
            if ($it.PSIsContainer) {
                $queue.Enqueue([pscustomobject]@{ Path = $it.FullName; Depth = $node.Depth + 1 })
            }
        }
    }
    return $records
}

# ---------------------------------------------------------------------------
# 4. Infer the previous root from the workspace state file.
#    pnpm writes absolute project keys there, so it is the most reliable record
#    of where the tree was built.
# ---------------------------------------------------------------------------
function Get-InferredPreviousRoot {
    param([string]$NodeModules)
    $stateFile = Join-Path $NodeModules '.pnpm-workspace-state-v1.json'
    if (-not (Test-Path -LiteralPath $stateFile)) { return '' }
    try {
        $state = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
        $keys = @($state.projects.PSObject.Properties.Name)
        if ($keys.Count -eq 0) { return '' }
        $first = [string]$keys[0]
        $idx = $first.IndexOf('\projects\')
        if ($idx -gt 0) { return $first.Substring(0, $idx) }
        return ''
    } catch {
        return ''
    }
}

# ---------------------------------------------------------------------------
# 5. Main pass.
# ---------------------------------------------------------------------------
$allDirs = @(Get-NodeModulesDirs -WsRoot $Root)
if ($allDirs.Count -eq 0) {
    Say 'no node_modules directory found under the workspace root' 'warn'
    Say 'run: infra\portable\ws-run.cmd pnpm install'
    exit 1
}

$totalLinks = 0
$broken = 0
$foreign = 0
$previousRoot = $PreviousRoot
$brokenSamples = New-Object System.Collections.Generic.List[string]

foreach ($nm in $allDirs) {
    Say ('scanning ' + $nm.Substring($Root.Length).TrimStart('\'))
    $records = @(Get-LinkRecords -Start $nm)
    $totalLinks += $records.Count

    if (-not $previousRoot) {
        $inferred = Get-InferredPreviousRoot -NodeModules $nm
        if ($inferred) { $previousRoot = $inferred }
    }

    foreach ($r in $records) {
        if ($r.Exists) { continue }
        $broken++

        $isPrevious = $false
        if ($previousRoot -and $r.Target.StartsWith($previousRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
            $isPrevious = $true
        }

        if (-not $isPrevious) {
            $foreign++
            if ($brokenSamples.Count -lt 5) { $brokenSamples.Add($r.Path + ' -> ' + $r.Target) | Out-Null }
            continue
        }

        if (-not $Repair) { continue }

        $suffix = $r.Target.Substring($previousRoot.Length).TrimStart('\')
        $newTarget = Join-Path $Root $suffix
        if (-not (Test-Path -LiteralPath $newTarget)) {
            if ($brokenSamples.Count -lt 5) {
                $brokenSamples.Add($r.Path + ' -> ' + $newTarget + ' (package entity missing)') | Out-Null
            }
            continue
        }

        try {
            # Directory.Delete with recursive = false removes the reparse point
            # only. Remove-Item -Recurse follows a junction and deletes the
            # contents it points at, which would destroy the package store.
            [System.IO.Directory]::Delete($r.Path, $false)
            if ($r.LinkType -eq 'Junction') {
                New-Item -ItemType Junction -Path $r.Path -Target $newTarget -ErrorAction Stop | Out-Null
            } else {
                New-Item -ItemType SymbolicLink -Path $r.Path -Target $newTarget -ErrorAction Stop | Out-Null
            }
            $script:Fixed++
        } catch {
            Say ('cannot rewrite ' + $r.Path + ': ' + $_.Exception.Message) 'warn'
        }
    }
}

# The summary line carries the verdict. Emitting it as warn when anything is
# broken is what makes the exit code meaningful, and it keeps the count visible
# under -Quiet, where informational lines are suppressed.
if ($broken -gt 0) {
    Say ('links total = ' + $totalLinks + ', broken = ' + $broken + ', of which naming the previous root = ' + ($broken - $foreign)) 'warn'
} else {
    Say ('links total = ' + $totalLinks + ', broken = 0') 'ok'
}
if ($previousRoot) { Say ('previous root = ' + $previousRoot) }
if ($foreign -gt 0) {
    Say ('broken links that do not match the previous root: ' + $foreign) 'warn'
    foreach ($s in $brokenSamples) { Say ('  ' + $s) }
}

# ---------------------------------------------------------------------------
# 6. Rewrite the state files. They also store absolute paths, and pnpm treats a
#    mismatch as "the tree was built elsewhere" and rebuilds everything.
# ---------------------------------------------------------------------------
if ($Repair -and $previousRoot) {
    foreach ($nm in $allDirs) {
        $stateFile = Join-Path $nm '.pnpm-workspace-state-v1.json'
        if (Test-Path -LiteralPath $stateFile) {
            try {
                $raw = Get-Content -LiteralPath $stateFile -Raw
                if ($raw.IndexOf($previousRoot, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
                    $replaced = [regex]::Replace(
                        $raw,
                        [regex]::Escape($previousRoot),
                        $Root.Replace('\', '\\'),
                        [System.Text.RegularExpressions.RegexOptions]::IgnoreCase
                    )
                    Set-Content -LiteralPath $stateFile -Value $replaced -NoNewline -Encoding UTF8
                    Say 'state file rewritten: ' + $nm.Substring($Root.Length).TrimStart('\')
                }
            } catch {
                Say ('cannot rewrite state file: ' + $_.Exception.Message) 'warn'
            }
        }

        $modulesYaml = Join-Path $nm '.modules.yaml'
        if (Test-Path -LiteralPath $modulesYaml) {
            try {
                $raw = Get-Content -LiteralPath $modulesYaml -Raw
                if ($raw.IndexOf($previousRoot, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
                    $replaced = [regex]::Replace(
                        $raw,
                        [regex]::Escape($previousRoot),
                        $Root.Replace('\', '\\'),
                        [System.Text.RegularExpressions.RegexOptions]::IgnoreCase
                    )
                    Set-Content -LiteralPath $modulesYaml -Value $replaced -NoNewline -Encoding UTF8
                    Say 'modules manifest rewritten: ' + $nm.Substring($Root.Length).TrimStart('\')
                }
            } catch {
                Say ('cannot rewrite modules manifest: ' + $_.Exception.Message) 'warn'
            }
        }
    }
}

# ---------------------------------------------------------------------------
# 7. Top level link coverage. A tree whose junctions resolve can still be
#    unusable when the top level links were never created, which is what an
#    interrupted install leaves behind.
# ---------------------------------------------------------------------------
$projectRoot = Join-Path $Root 'projects'
if (Test-Path -LiteralPath $projectRoot) {
    foreach ($proj in (Get-ChildItem -LiteralPath $projectRoot -Directory -Force -ErrorAction SilentlyContinue)) {
        $pkgFile = Join-Path $proj.FullName 'package.json'
        $nm = Join-Path $proj.FullName 'node_modules'
        if ((-not (Test-Path -LiteralPath $pkgFile)) -or (-not (Test-Path -LiteralPath $nm))) { continue }
        try {
            $pkg = Get-Content -LiteralPath $pkgFile -Raw | ConvertFrom-Json
            $declared = 0
            foreach ($field in @('dependencies', 'devDependencies')) {
                if ($pkg.PSObject.Properties.Name -contains $field) {
                    $declared += @($pkg.$field.PSObject.Properties.Name).Count
                }
            }
            $present = 0
            foreach ($it in (Get-ChildItem -LiteralPath $nm -Force -ErrorAction SilentlyContinue)) {
                if ($it.Name -notlike '.*') { $present++ }
            }
            if (($declared -gt 0) -and ($present -lt $declared)) {
                Say ($proj.Name + ': top level links ' + $present + ' of ' + $declared + ' declared dependencies') 'warn'
                Say ('  an interrupted install leaves this shape, run: infra\portable\ws-run.cmd pnpm install') 
            } else {
                Say ($proj.Name + ': top level links ' + $present + ' / declared ' + $declared) 'ok'
            }
        } catch {
            Say ($proj.Name + ': cannot read package.json') 'warn'
        }
    }
}

# ---------------------------------------------------------------------------
# 8. Summary.
# ---------------------------------------------------------------------------
if ($Repair) {
    Say ('rewritten ' + $script:Fixed + ' link(s)') 'done'
}

if ($script:Problems -eq 0) {
    Say 'link check passed, the dependency tree resolves on this host' 'done'
    exit 0
}

if ($Repair -and $script:Fixed -gt 0) {
    Say ('repaired ' + $script:Fixed + ' link(s), re-run without -Repair to confirm') 'done'
    exit 0
}

Say 'problems remain, see the lines above'
exit 1
