<#
  ws-doctor.ps1
  Audit tool. Answers two questions:
    A. Does any tracked file still contain a hardcoded absolute path?
    B. Has anything been written outside the workspace?

  Usage
      powershell -ExecutionPolicy Bypass -File infra\portable\ws-doctor.ps1
      powershell -ExecutionPolicy Bypass -File infra\portable\ws-doctor.ps1 -Leak
      powershell -ExecutionPolicy Bypass -File infra\portable\ws-doctor.ps1 -Baseline
#>
[CmdletBinding()]
param(
    [string]$Root = '',
    [switch]$Leak,
    [switch]$Baseline
)

$ErrorActionPreference = 'Continue'

if (-not $Root) {
    $probe = $PSScriptRoot
    $found = $null
    while ($probe) {
        if (Test-Path -LiteralPath (Join-Path $probe '.ws-root')) { $found = $probe; break }
        $parent = Split-Path -Parent $probe
        if (-not $parent -or $parent -eq $probe) { break }
        $probe = $parent
    }
    if ($found) {
        $Root = $found.TrimEnd([char]92)
    } else {
        $Root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd([char]92)
    }
}

function Section { param([string]$Title) Write-Host ''; Write-Host ('== ' + $Title + ' ==') -ForegroundColor Cyan }

# ---------------------------------------------------------------------------
# A. Hardcoded absolute path scan.
#    Source and configuration must be free of drive letters. Only files that
#    legitimately carry generated absolute paths are tolerated, and those live
#    under directories excluded below.
# ---------------------------------------------------------------------------
Section 'A. Hardcoded absolute path scan'

$scanExt = @('.json', '.jsonc', '.ps1', '.cmd', '.bat', '.sh', '.yml', '.yaml', '.toml',
             '.ini', '.cfg', '.config', '.props', '.targets', '.sln', '.vcxproj', '.env', '.xml')
$skipDir = @('node_modules', '.venv', 'venv', '.git', '.cache', '.tmp', '.local', 'runtime',
             'dist', 'build', 'out', 'target', '.gradle', '.m2', '.cargo', '.rustup', '.go',
             '.nuget', '.vscode', '.idea', 'logs', '.next', '.nuxt', '__pycache__')

$hits = New-Object System.Collections.Generic.List[string]
Get-ChildItem -LiteralPath $Root -Recurse -File -Force -ErrorAction SilentlyContinue | ForEach-Object {
    $file = $_
    $rel  = $file.FullName.Substring($Root.Length).TrimStart([char]92)
    # A portable\state directory holds machine specific runtime state on purpose.
    # root.json records the absolute root, which is exactly what makes relocation
    # detectable. It is git-ignored and therefore excluded from this scan. The
    # match is suffix based so it survives a reorganisation of the layout.
    if ($rel -like 'portable\state\*' -or $rel -like '*\portable\state\*') { return }
    $parts = $rel -split '\\'
    foreach ($p in $parts) { if ($skipDir -contains $p) { return } }
    if ($scanExt -notcontains $file.Extension.ToLower()) { return }
    if ($file.Length -gt 2MB) { return }
    try {
        $text = Get-Content -LiteralPath $file.FullName -Raw -ErrorAction Stop
        if ($text -match '(?m)(?<![A-Za-z0-9_])[A-Za-z]:[\\/]') {
            $hits.Add($rel) | Out-Null
        }
    } catch { }
}

if ($hits.Count -eq 0) {
    Write-Host 'PASS  no hardcoded absolute paths found in tracked files' -ForegroundColor Green
} else {
    Write-Host ('FAIL  ' + $hits.Count + ' file(s) contain a hardcoded absolute path') -ForegroundColor Red
    $hits | Sort-Object -Unique | ForEach-Object { Write-Host ('      ' + $_) -ForegroundColor Red }
    Write-Host '      Replace drive-letter paths with WS_ROOT-relative paths.'
}

# ---------------------------------------------------------------------------
# B. Workspace footprint. Everything the project produces should appear here.
# ---------------------------------------------------------------------------
Section 'B. Workspace footprint'
$total = 0
Get-ChildItem -LiteralPath $Root -Directory -Force -ErrorAction SilentlyContinue | ForEach-Object {
    try {
        $size = (Get-ChildItem -LiteralPath $_.FullName -Recurse -File -Force -ErrorAction SilentlyContinue |
                 Measure-Object -Property Length -Sum).Sum
        if (-not $size) { $size = 0 }
        $total += $size
        [pscustomobject]@{ Directory = $_.Name; SizeMB = [math]::Round($size / 1MB, 1) }
    } catch { }
} | Sort-Object SizeMB -Descending | Format-Table -AutoSize
Write-Host ('  total tracked footprint: ' + [math]::Round($total / 1MB, 1) + ' MB')

# ---------------------------------------------------------------------------
# C. External leak check.
#    These locations belong to the host machine. Comparing against a baseline
#    captured with -Baseline reveals growth caused by this project.
# ---------------------------------------------------------------------------
if ($Leak -or $Baseline) {
    Section 'C. External location check'
    $candidates = @(
        (Join-Path $env:LOCALAPPDATA 'npm-cache'),
        (Join-Path $env:APPDATA 'npm'),
        (Join-Path $env:LOCALAPPDATA 'pip\cache'),
        (Join-Path $env:USERPROFILE '.gradle'),
        (Join-Path $env:USERPROFILE '.m2'),
        (Join-Path $env:USERPROFILE '.cargo'),
        (Join-Path $env:USERPROFILE '.rustup'),
        (Join-Path $env:USERPROFILE 'go'),
        (Join-Path $env:LOCALAPPDATA 'Yarn\Cache'),
        (Join-Path $env:LOCALAPPDATA 'pnpm'),
        (Join-Path $env:LOCALAPPDATA 'ms-playwright'),
        (Join-Path $env:APPDATA 'Code\Cache'),
        (Join-Path $env:APPDATA 'Code\CachedData')
    )
    $baselineFile = Join-Path $Root 'infra\portable\state\leak-baseline.json'
    $baseline = $null
    if (Test-Path -LiteralPath $baselineFile) {
        try { $baseline = Get-Content -LiteralPath $baselineFile -Raw | ConvertFrom-Json } catch { $baseline = $null }
    }

    $snapshot = [ordered]@{}
    foreach ($c in $candidates) {
        $size = 0
        if (Test-Path -LiteralPath $c) {
            try {
                $size = (Get-ChildItem -LiteralPath $c -Recurse -File -Force -ErrorAction SilentlyContinue |
                         Measure-Object -Property Length -Sum).Sum
                if (-not $size) { $size = 0 }
            } catch { $size = 0 }
        }
        $snapshot[$c] = [int64]$size
    }

    if ($Baseline) {
        $dir = Split-Path -Parent $baselineFile
        if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        [System.IO.File]::WriteAllText($baselineFile, ($snapshot | ConvertTo-Json), (New-Object System.Text.UTF8Encoding($false)))
        Write-Host 'baseline recorded' -ForegroundColor Green
        $snapshot.GetEnumerator() | ForEach-Object { Write-Host ('  ' + [math]::Round($_.Value / 1MB, 1) + ' MB  ' + $_.Key) }
    } else {
        $rows = @()
        foreach ($c in $candidates) {
            $now = [int64]$snapshot[$c]
            $before = 0
            if ($baseline -and $baseline.PSObject.Properties[$c]) { $before = [int64]$baseline.PSObject.Properties[$c].Value }
            $delta = $now - $before
            if ($now -gt 0) {
                $flag = ''
                if ($delta -gt 5MB) { $flag = 'GROWING' }
                $rows += [pscustomobject]@{
                    Location = $c
                    NowMB    = [math]::Round($now / 1MB, 1)
                    DeltaMB  = [math]::Round($delta / 1MB, 1)
                    Flag     = $flag
                }
            }
        }
        if ($rows.Count -eq 0) {
            Write-Host 'PASS  no populated external cache locations detected' -ForegroundColor Green
        } else {
            $rows | Format-Table -AutoSize
            if ($rows | Where-Object { $_.Flag -eq 'GROWING' }) {
                Write-Host 'NOTE  a location grew since the baseline. Confirm it is not this project writing there.' -ForegroundColor Yellow
            }
        }
    }
} else {
    Write-Host ''
    Write-Host 'Tip: run with -Baseline once, then -Leak later to detect external growth.' -ForegroundColor DarkGray
}

Write-Host ''
Write-Host ('doctor finished for ' + $Root) -ForegroundColor Cyan
