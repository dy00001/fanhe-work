<#
  ws-repair.ps1
  Repair and toolchain health check for the portable workspace.

  Invoked automatically by ws-state.ps1 when either of these is true.
    relocation  the resolved root differs from the recorded root
    host        the resolved host differs from the recorded host

  The host signal exists because a new computer can assign the same drive letter.
  In that case the root comparison stays silent, while host dependent artifacts
  such as the venv base interpreter recorded in pyvenv.cfg may be broken.

  Also runnable on demand, read only:
      infra\portable\ws-repair.ps1 -CheckOnly

  Parameters
      -Root          workspace root, discovered from the .ws-root marker when omitted
      -PreviousRoot  root recorded before a relocation, in mixed form
      -Reason        relocation, host or manual
      -CheckOnly     report findings, change nothing
#>
[CmdletBinding()]
param(
    [string]$Root = '',
    [string]$PreviousRoot = '',
    [ValidateSet('relocation', 'host', 'manual')][string]$Reason = 'manual',
    [switch]$CheckOnly
)

$ErrorActionPreference = 'Continue'

$script:Warnings = 0

function Say {
    param([string]$Message, [string]$Level = 'info')
    switch ($Level) {
        'ok'    { Write-Host ('[repair] ' + $Message) -ForegroundColor Green }
        'warn'  { Write-Host ('[repair] ' + $Message) -ForegroundColor Yellow; $script:Warnings++ }
        'error' { Write-Host ('[repair] ' + $Message) -ForegroundColor Red;    $script:Warnings++ }
        default { Write-Host ('[repair] ' + $Message) -ForegroundColor DarkGray }
    }
}

# ---------------------------------------------------------------------------
# 0. Resolve the root when it was not supplied.
# ---------------------------------------------------------------------------
if (-not $Root) {
    $probe = $PSScriptRoot
    $found = $null
    while ($probe) {
        if (Test-Path -LiteralPath (Join-Path $probe '.ws-root')) { $found = $probe; break }
        $parent = Split-Path -Parent $probe
        if (-not $parent -or $parent -eq $probe) { break }
        $probe = $parent
    }
    if ($found) { $Root = $found.TrimEnd([char]92) }
    else { $Root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd([char]92) }
}
$Root = [System.IO.Path]::GetFullPath($Root).TrimEnd([char]92)

$mode = 'apply'
if ($CheckOnly) { $mode = 'check only' }
Say ('reason = ' + $Reason + '   mode = ' + $mode)
Say ('root = ' + $Root)
Say ('host = ' + $env:COMPUTERNAME + ' / ' + $env:USERNAME)

# ---------------------------------------------------------------------------
# 1. Relocation only. Rewrite stale absolute roots in generated artifacts.
#    Source code is deliberately excluded, source must never contain absolute
#    paths in the first place.
# ---------------------------------------------------------------------------
if ($PreviousRoot) {
    $previousNative = $PreviousRoot -replace '/', '\'
    if ($previousNative -ne $Root) {
        if ($CheckOnly) {
            Say ('would rewrite stale paths ' + $previousNative + ' -> ' + $Root)
        } else {
            $textExt = @('.cfg', '.ini', '.json', '.pth', '.props', '.targets', '.ps1', '.cmd', '.bat', '.sh', '.env', '.txt')
            $searchRoots = @(
                (Join-Path $Root '.venv'),
                (Join-Path $Root '.vscode'),
                (Join-Path $Root '.idea'),
                (Join-Path $Root 'infra\portable\state')
            )
            $rewritten = 0
            foreach ($r in $searchRoots) {
                if (-not (Test-Path -LiteralPath $r)) { continue }
                Get-ChildItem -LiteralPath $r -Recurse -File -Force -ErrorAction SilentlyContinue | ForEach-Object {
                    if ($textExt -notcontains $_.Extension.ToLower()) { return }
                    if ($_.Length -gt 4MB) { return }
                    try {
                        $content = Get-Content -LiteralPath $_.FullName -Raw -ErrorAction Stop
                        if ($content -and $content.Contains($previousNative)) {
                            [System.IO.File]::WriteAllText($_.FullName, $content.Replace($previousNative, $Root), (New-Object System.Text.UTF8Encoding($false)))
                            $rewritten++
                        }
                    } catch { }
                }
            }
            Say ('rewrote ' + $rewritten + ' generated file(s)')
        }
    }
}

# ---------------------------------------------------------------------------
# 2. Toolchain health check. This is the part that covers the same drive letter
#    case, where a path comparison cannot see that the host changed.
# ---------------------------------------------------------------------------
Say 'toolchain health check'

# Run a native command and return its streams as plain text.
# The .NET process API is used instead of the call operator because PowerShell
# wraps a native tool's stderr in an ErrorRecord, so a missing interpreter would
# bury its one line message under a multi line stack trace. Reading both streams
# through tasks avoids the pipe buffer deadlock that a sequential ReadToEnd can
# hit when a tool writes a lot to stderr.
function Invoke-NativeCapture {
    param([string]$Exe, [string[]]$Arguments, [string]$WorkingDirectory = '')
    try {
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName               = $Exe
        $psi.Arguments              = ($Arguments -join ' ')
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError  = $true
        $psi.UseShellExecute        = $false
        $psi.CreateNoWindow         = $true
        if ($WorkingDirectory) { $psi.WorkingDirectory = $WorkingDirectory }
        $proc = New-Object System.Diagnostics.Process
        $proc.StartInfo = $psi
        $proc.Start() | Out-Null
        $outTask = $proc.StandardOutput.ReadToEndAsync()
        $errTask = $proc.StandardError.ReadToEndAsync()
        $proc.WaitForExit()
        return [pscustomobject]@{
            ExitCode = $proc.ExitCode
            StdOut   = [string]$outTask.Result
            StdErr   = [string]$errTask.Result
        }
    } catch {
        return [pscustomobject]@{ ExitCode = -1; StdOut = ''; StdErr = $_.Exception.Message }
    }
}

function Get-NativeVersion {
    param([string]$Exe, [string[]]$Arguments)
    $r = Invoke-NativeCapture $Exe $Arguments
    return (($r.StdOut + ' ' + $r.StdErr) -replace '\s+', ' ').Trim()
}

# Resolve a command to something the process API can actually start.
# Get-Command returns the PowerShell shim first on Windows, for example npm.ps1,
# which is a script rather than an executable, so candidates are filtered down
# to .exe/.cmd/.bat. A Microsoft Store app execution alias also resolves on PATH
# but is not an interpreter, so those are dropped as well.
function Get-RealCommand {
    param([string]$Name)
    $candidates = Get-Command $Name -All -ErrorAction SilentlyContinue
    if (-not $candidates) { return $null }
    foreach ($c in $candidates) {
        if (-not $c.Source) { continue }
        if ($c.Source -like '*\WindowsApps\*') { continue }
        if ($c.Source -match '\.(exe|cmd|bat)$') { return $c }
    }
    return $null
}

$pythonCmd = Get-RealCommand 'python'
if ($pythonCmd) {
    $pv = Get-NativeVersion $pythonCmd.Source @('--version')
    Say ('python: ' + $pv + '   at ' + $pythonCmd.Source) 'ok'
} else {
    Say 'python: not found on PATH' 'warn'
}

$venv    = Join-Path $Root '.venv'
$venvCfg = Join-Path $venv 'pyvenv.cfg'
if (Test-Path -LiteralPath $venvCfg) {
    $baseHome = $null
    Get-Content -LiteralPath $venvCfg | ForEach-Object {
        if ($_ -match '^\s*home\s*=\s*(.+?)\s*$') { $baseHome = $Matches[1] }
    }
    if ($baseHome) {
        $baseExe = Join-Path $baseHome 'python.exe'
        if (Test-Path -LiteralPath $baseExe) {
            Say ('venv: base interpreter present at ' + $baseExe) 'ok'
            if (-not $CheckOnly) {
                Say 'venv: regenerating console script shims'
                $r = Invoke-NativeCapture $baseExe @('-m', 'venv', '--upgrade', $venv)
                ($r.StdOut + $r.StdErr) -split "`r?`n" | Where-Object { $_ } | ForEach-Object { Say ('  ' + $_) }
            }
        } else {
            Say 'venv: the base interpreter recorded in pyvenv.cfg is MISSING on this host' 'warn'
            Say ('      recorded home = ' + $baseHome) 'warn'
            Say '      the virtual environment must be rebuilt here' 'warn'
            Say ('      python -m venv "' + $venv + '"') 'warn'
            Say '      then reinstall dependencies from your lock file or requirements.txt' 'warn'
        }
    } else {
        Say 'venv: pyvenv.cfg carries no home entry, cannot verify the base interpreter' 'warn'
    }
} else {
    Say 'venv: no .venv present'
}

$nodeCmd = Get-RealCommand 'node'
$npmCmd  = Get-RealCommand 'npm'
if ($nodeCmd) { Say ('node: ' + (Get-NativeVersion $nodeCmd.Source @('--version'))) 'ok' } else { Say 'node: not found on PATH' 'warn' }
if ($npmCmd)  { Say ('npm:  ' + (Get-NativeVersion $npmCmd.Source @('--version'))) 'ok' } else { Say 'npm: not found on PATH' 'warn' }

$nodeModules = Join-Path $Root 'node_modules'
if (Test-Path -LiteralPath $nodeModules) {
    if ($npmCmd) {
        if ($CheckOnly) {
            Say 'node_modules: present, would run npm rebuild'
        } else {
            Say 'node_modules: regenerating .bin shims (npm rebuild)'
            $r = Invoke-NativeCapture $npmCmd.Source @('rebuild') $Root
            ($r.StdOut + $r.StdErr) -split "`r?`n" | Where-Object { $_ } | ForEach-Object { Say ('  ' + $_) }
            if ($r.ExitCode -ne 0) { Say ('  npm rebuild exited with ' + $r.ExitCode) 'warn' }
        }
    } else {
        Say 'node_modules: present but npm is unavailable, run npm rebuild manually' 'warn'
    }
} else {
    Say 'node_modules: none present'
}

# ---------------------------------------------------------------------------
# 3. Summary
# ---------------------------------------------------------------------------
if ($script:Warnings -eq 0) {
    Say 'health check passed, nothing requires attention on this host' 'ok'
} else {
    # The format operator is used because an int on the left of + would make
    # PowerShell try to coerce the right hand string to int and throw.
    Say ('{0} item(s) require attention on this host' -f $script:Warnings) 'warn'
}
Say 'repair pass finished'
