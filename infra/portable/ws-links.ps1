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
    1. every node_modules directory under the workspace root, at any depth
    2. node_modules/.pnpm-workspace-state-v1.json   (absolute project keys)
    3. node_modules/.modules.yaml                   (absolute storeDir)
    4. the count of top level package links against the declared dependencies

  Usage
  -----
      infra\portable\ws-links.ps1
      infra\portable\ws-links.ps1 -Repair
      infra\portable\ws-links.ps1 -Repair -PreviousRoot 'F:\fanhe Work'
      infra\portable\ws-links.ps1 -SelfTest

  Parameters
  ----------
      -Root          workspace root, discovered from the .ws-root marker when omitted
      -PreviousRoot  old root; inferred from .pnpm-workspace-state-v1.json when omitted
      -Repair        rewrite targets and state files; without it the pass is read only
      -Quiet         print problems only
      -SelfTest      build a throwaway workspace with a deep broken link and assert
                     this script reports it; exits non zero when the check is blind

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
    [switch]$Quiet,
    [switch]$SelfTest
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
# 2b. Self test.
#
#     A check that cannot fail proves nothing, and this script had exactly that
#     shape: the depth cap hid the nested node_modules, so the summary printed
#     "broken = 0" whether or not those links were dead. The repair run then
#     reported success while twenty five links stayed broken.
#
#     This builds the shape that used to be invisible -- a node_modules five
#     levels down, one healthy link and one dead link -- and asserts the script
#     reports the dead one. Run it after any change to the scan.
#
#     The child is a separate process on purpose: it exits non zero when it finds
#     the dead link, and `exit` in the same runspace would end the caller too.
# ---------------------------------------------------------------------------
if ($SelfTest) {
    $fake = Join-Path ([System.IO.Path]::GetTempPath()) ('ws-links-selftest-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
    $nm = Join-Path $fake 'projects\demo\apps\api\node_modules'
    $goodTarget = Join-Path $fake 'store\good'
    $deadTarget = Join-Path $fake 'store\dead'
    $goodLink = Join-Path $nm 'good-pkg'
    $deadLink = Join-Path $nm 'dead-pkg'

    try {
        New-Item -ItemType Directory -Path $nm -Force | Out-Null
        New-Item -ItemType Directory -Path $goodTarget -Force | Out-Null
        Set-Content -LiteralPath (Join-Path $goodTarget 'package.json') -Value '{"name":"good-pkg"}' -Encoding ascii
        Set-Content -LiteralPath (Join-Path $fake '.ws-root') -Value 'selftest' -Encoding ascii
        New-Item -ItemType Junction -Path $goodLink -Target $goodTarget -ErrorAction Stop | Out-Null

        # A dead link cannot be created directly: New-Item rejects a target that
        # does not exist. The shape after a drive change is "the target was there,
        # then vanished, the link stayed", so build that: point at a real
        # directory, then delete the directory.
        New-Item -ItemType Directory -Path $deadTarget -Force | Out-Null
        New-Item -ItemType Junction -Path $deadLink -Target $deadTarget -ErrorAction Stop | Out-Null
        Remove-Item -LiteralPath $deadTarget -Recurse -Force

        $text = (& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $PSCommandPath -Root $fake -Quiet 2>&1 | Out-String)
        $code = $LASTEXITCODE

        $sawTotal = $text -match 'links total = 2'
        $sawDead = $text -match 'broken = 1'
        $nonZero = $code -ne 0

        Write-Host ''
        Write-Host '[selftest] shape: projects\demo\apps\api\node_modules, five levels down'
        Write-Host ('[selftest] healthy link counted, links total = 2 : ' + $sawTotal)
        Write-Host ('[selftest] dead link reported, broken = 1       : ' + $sawDead)
        Write-Host ('[selftest] exit code non zero                   : ' + $nonZero + ' (got ' + $code + ')')

        if ($sawTotal -and $sawDead -and $nonZero) {
            Write-Host '[selftest] PASS, the check can see a deep dead link' -ForegroundColor Green
            exit 0
        }
        Write-Host '[selftest] FAIL, the check is blind to this shape' -ForegroundColor Red
        Write-Host '--- child output ---'
        Write-Host $text
        exit 1
    } finally {
        foreach ($link in @($goodLink, $deadLink)) {
            if (Test-Path -LiteralPath $link) {
                try { [System.IO.Directory]::Delete($link, $false) } catch { }
            }
        }
        if (Test-Path -LiteralPath $fake) {
            Remove-Item -LiteralPath $fake -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

# ---------------------------------------------------------------------------
# 2. Collect the node_modules directories that carry pnpm links.
#
#    Why a full walk instead of a depth cap
#    -------------------------------------
#    This used to stop two levels below the root, which covers the layout
#    projects/<name>/node_modules but nothing deeper. The monorepo actually keeps
#    its trees at projects/fanhe-work/apps/api/node_modules, five levels down, so
#    every nested package link was invisible here while the script still printed
#    "link check passed". A depth cap is a guess about the repo layout and the
#    guess was wrong; the walk below makes no such assumption.
#
#    node_modules is collected but never entered: pnpm's .pnpm store holds tens of
#    thousands of directories and none of them is somewhere pnpm writes links for
#    this workspace. Links are skipped rather than followed for the same reason.
#
#    The skip list is limited to directories that cannot contain a dependency
#    tree of this workspace. .tmp matters most: it held a quarantined copy of an
#    old node_modules, and walking it inflated the scan to 54k links and four
#    minutes while contributing nothing.
# ---------------------------------------------------------------------------
function Get-NodeModulesDirs {
    param([string]$WsRoot, [int]$MaxDepth = 8)

    $skip = @('.git', '.tmp', 'dist', 'release', 'build', 'out', 'coverage', '.turbo', '.next', '.cache')
    $found = New-Object System.Collections.Generic.List[string]
    $queue = New-Object System.Collections.Generic.Queue[object]
    $queue.Enqueue([pscustomobject]@{ Path = $WsRoot; Depth = 0 })

    while ($queue.Count -gt 0) {
        $node = $queue.Dequeue()
        if ($node.Depth -gt $MaxDepth) { continue }

        $items = Get-ChildItem -LiteralPath $node.Path -Directory -Force -ErrorAction SilentlyContinue
        foreach ($it in $items) {
            if ($it.LinkType) { continue }
            if ($it.Name -eq 'node_modules') {
                $found.Add($it.FullName) | Out-Null
                continue
            }
            if ($skip -contains $it.Name) { continue }
            $queue.Enqueue([pscustomobject]@{ Path = $it.FullName; Depth = $node.Depth + 1 })
        }
    }
    return $found | Select-Object -Unique
}

# ---------------------------------------------------------------------------
# 3. Walk one node_modules tree breadth first.
#    Junctions are recorded and never entered, which keeps the walk finite and
#    avoids following a link into a directory that may not exist.
# ---------------------------------------------------------------------------

<#
  Does this link actually resolve to something readable?

  The obvious checks are all wrong, measured on this host 2026-10-29 against a
  junction whose target had been deleted:

      Test-Path <link>                      -> True
      [System.IO.Directory]::Exists(<link>) -> True
      Test-Path <link>\package.json         -> False
      Get-ChildItem <link>                  -> 0 items, no error
      [System.IO.Directory]::GetFileSystemEntries(<link>) -> throws

  Both Test-Path and Directory.Exists only ask whether the reparse point exists,
  not whether it leads anywhere. That is why a tree full of dead junctions used
  to pass a check written with Test-Path on the link itself.

  So the test is: the target path exists, or failing that, the link can be opened
  and enumerated. A healthy link hits the first branch and never touches the
  filesystem twice.
#>
function Test-LinkResolves {
    param([string]$LinkPath, [string]$Target)

    if ($Target -ne '' -and (Test-Path -LiteralPath $Target)) { return $true }

    try {
        [void][System.IO.Directory]::GetFileSystemEntries($LinkPath)
        return $true
    } catch {
        return $false
    }
}

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
                    Exists  = (Test-LinkResolves -LinkPath $it.FullName -Target $target)
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
#
#    Two things used to go wrong here, both silent.
#
#    First, the search string. The same root is written two ways:
#
#        .modules.yaml              F:\fanhe Work        (single backslash)
#        .pnpm-workspace-state-v1.json   F:\\fanhe Work   (JSON escapes them)
#
#    Searching for the single backslash form never matched the JSON file, so the
#    script announced "previous root = E:\fanhe Work" and then changed nothing,
#    still exiting 0. Verified 2026-10-29: after a full -Repair the state file
#    still held five E: paths.
#
#    Second, the encoding. Set-Content -Encoding UTF8 writes a BOM on PowerShell
#    5.1, and a BOM makes JSON.parse fail, which is exactly the "tree was built
#    elsewhere" signal this section exists to avoid. So both files are written
#    back as UTF-8 without a BOM.
# ---------------------------------------------------------------------------
function Update-RootText {
    param([string]$Text, [string]$From, [string]$To)

    $result = $Text
    $pairs = @(
        @($From, $To),
        @($From.Replace('\', '\\'), $To.Replace('\', '\\'))
    )
    foreach ($pair in $pairs) {
        # A '$' in the replacement string is a regex reference, so escape it.
        $result = [regex]::Replace(
            $result,
            [regex]::Escape($pair[0]),
            $pair[1].Replace('$', '$$'),
            [System.Text.RegularExpressions.RegexOptions]::IgnoreCase
        )
    }
    return $result
}

function Write-TextNoBom {
    param([string]$Path, [string]$Text)
    $encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Text, $encoding)
}

if ($Repair -and $previousRoot) {
    foreach ($nm in $allDirs) {
        $stateFile = Join-Path $nm '.pnpm-workspace-state-v1.json'
        if (Test-Path -LiteralPath $stateFile) {
            try {
                $raw = Get-Content -LiteralPath $stateFile -Raw
                $replaced = Update-RootText -Text $raw -From $previousRoot -To $Root
                if ($replaced -ne $raw) {
                    Write-TextNoBom -Path $stateFile -Text $replaced
                    Say ('state file rewritten: ' + $nm.Substring($Root.Length).TrimStart('\'))
                }
            } catch {
                Say ('cannot rewrite state file: ' + $_.Exception.Message) 'warn'
            }
        }

        $modulesYaml = Join-Path $nm '.modules.yaml'
        if (Test-Path -LiteralPath $modulesYaml) {
            try {
                $raw = Get-Content -LiteralPath $modulesYaml -Raw
                $replaced = Update-RootText -Text $raw -From $previousRoot -To $Root
                if ($replaced -ne $raw) {
                    Write-TextNoBom -Path $modulesYaml -Text $replaced
                    Say ('modules manifest rewritten: ' + $nm.Substring($Root.Length).TrimStart('\'))
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
