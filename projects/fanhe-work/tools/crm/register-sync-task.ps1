# register-sync-task.ps1
#
# Registers the daily customer sync task in Windows Task Scheduler.
#
# Why a separate script
# ---------------------
# Registering a task requires elevation. The agent sandbox runs unelevated and the
# scheduler refuses with "Access is denied", so this has to be started once by hand.
# Double click register-sync-task.cmd (it re-launches itself elevated).
#
# Why 17:30
# ---------
# The chat archive automation rewrites the .md files at 17:00. This task must run
# after it, otherwise it re-reads the previous day's snapshot, reports "no change",
# and exits 0 -- a failure that looks exactly like success.
#
# What the task does
# ------------------
# Runs sync-daily.cmd, which refreshes message counts, first/last message times and
# skipped-attachment counts for every customer whose group file exists, creates a
# pending-review customer for any new group, and reports (but never deletes)
# customers whose file disappeared.
#
# Usage
#   powershell -ExecutionPolicy Bypass -File register-sync-task.ps1
#   powershell -ExecutionPolicy Bypass -File register-sync-task.ps1 -At 18:10
#   powershell -ExecutionPolicy Bypass -File register-sync-task.ps1 -DryRun
#   powershell -ExecutionPolicy Bypass -File register-sync-task.ps1 -Remove

[CmdletBinding()]
param(
    [string]$TaskName = 'fanhe-customer-sync',
    [string]$At = '17:30',
    [switch]$DryRun,
    [switch]$Remove
)

$ErrorActionPreference = 'Stop'

$crmDir = $PSScriptRoot
$repo = Split-Path -Parent (Split-Path -Parent $crmDir)
$entry = Join-Path $crmDir 'sync-daily.cmd'

Write-Host ('task name   : ' + $TaskName)
Write-Host ('entry       : ' + $entry)
Write-Host ('working dir : ' + $repo)

if ($Remove) {
    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($null -eq $existing) {
        Write-Host 'task not found, nothing to remove' -ForegroundColor Yellow
        exit 0
    }
    if ($DryRun) {
        Write-Host '-DryRun: would unregister the task' -ForegroundColor Yellow
        exit 0
    }
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host 'task removed' -ForegroundColor Green
    exit 0
}

if (-not (Test-Path -LiteralPath $entry)) {
    Write-Host ('entry script missing: ' + $entry) -ForegroundColor Red
    exit 1
}

$action = New-ScheduledTaskAction -Execute 'cmd.exe' `
    -Argument ('/c "' + $entry + '"') `
    -WorkingDirectory $repo

$trigger = New-ScheduledTaskTrigger -Daily -At $At

# StartWhenAvailable makes a missed run recoverable: the sync is idempotent, so
# running late is harmless, while skipping a day leaves the dashboard stale until
# someone notices a number that never moves.
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 30)

if ($DryRun) {
    Write-Host ''
    Write-Host ('action   : cmd.exe /c "' + $entry + '"')
    Write-Host ('trigger  : daily at ' + $At)
    Write-Host 'settings : StartWhenAvailable, IgnoreNew, 30min limit'
    Write-Host '-DryRun: nothing registered' -ForegroundColor Yellow
    exit 0
}

Register-ScheduledTask -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Description 'Refresh customer platform activity fields from the Obsidian chat archive.' `
    -Force | Out-Null

# Read back instead of trusting the registration call: a task can be stored with a
# trigger in the past or an action path that silently fails to resolve, and the only
# way to notice is to ask the scheduler what it actually saved.
$task = Get-ScheduledTask -TaskName $TaskName
$info = Get-ScheduledTaskInfo -TaskName $TaskName
Write-Host ''
Write-Host ('registered  : ' + $task.TaskName + '  state=' + $task.State) -ForegroundColor Green
Write-Host ('action      : ' + $task.Actions[0].Execute + ' ' + $task.Actions[0].Arguments)
Write-Host ('workdir     : ' + $task.Actions[0].WorkingDirectory)
Write-Host ('trigger     : ' + $task.Triggers[0].StartBoundary)
Write-Host ('next run    : ' + $info.NextRunTime)
Write-Host ''
Write-Host ('Done. The first automatic run is the next ' + $At + '.') -ForegroundColor Green
Write-Host 'Log: data\customer-sync.log'
