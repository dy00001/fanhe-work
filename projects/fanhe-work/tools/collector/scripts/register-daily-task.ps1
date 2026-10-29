# register-daily-task.ps1
#
# Registers the daily catch-up task in Windows Task Scheduler.
#
# Why this is a separate script rather than one command
# ----------------------------------------------------
# Registering a task requires elevation. The agent sandbox runs unelevated and the
# task scheduler refuses with "Access is denied", so this has to be started once by
# hand. Double click register-daily-task.cmd (it re-launches itself elevated) and
# accept the UAC prompt.
#
# What the task does
# ------------------
# Every day at 09:00 it runs run-daily-catchup.cmd, which looks back seven days for
# missing collection days, fills them, then imports everything into the database.
# Seven days is what makes a missed day self healing: today's run also picks up
# yesterday.
#
# The task runs in the interactive session on purpose. The collector talks to a
# browser extension, so a background session with no desktop would have nothing to
# connect to. The collector starts Edge itself when the extension is offline.
#
# Usage
#   powershell -ExecutionPolicy Bypass -File register-daily-task.ps1
#   powershell -ExecutionPolicy Bypass -File register-daily-task.ps1 -At 08:30
#   powershell -ExecutionPolicy Bypass -File register-daily-task.ps1 -DryRun
#   powershell -ExecutionPolicy Bypass -File register-daily-task.ps1 -Remove

[CmdletBinding()]
param(
    [string]$TaskName = 'fanhe-daily-catchup',
    [string]$At = '09:00',
    [switch]$DryRun,
    [switch]$Remove
)

$ErrorActionPreference = 'Stop'

$collectorDir = Split-Path -Parent $PSScriptRoot
$repo = Split-Path -Parent (Split-Path -Parent $collectorDir)
$entry = Join-Path $PSScriptRoot 'run-daily-catchup.cmd'

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

# StartWhenAvailable is what makes a missed run recoverable: if the machine was off
# at 09:00, the task starts as soon as it is available instead of skipping the day.
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Hours 1)

if ($DryRun) {
    Write-Host ''
    Write-Host 'action   : cmd.exe /c "' -NoNewline
    Write-Host ($entry + '"')
    Write-Host ('trigger  : daily at ' + $At)
    Write-Host 'settings : StartWhenAvailable, IgnoreNew, 1h limit'
    Write-Host '-DryRun: nothing registered' -ForegroundColor Yellow
    exit 0
}

Register-ScheduledTask -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Description 'Fill missing SYCM collection days for the last 7 days and import them into the ops dashboard.' `
    -Force | Out-Null

# Read back instead of trusting the registration call. A task can be written with a
# trigger in the past or an action whose path silently failed to resolve, and the
# only way to notice is to ask the scheduler what it actually stored.
$task = Get-ScheduledTask -TaskName $TaskName
$info = Get-ScheduledTaskInfo -TaskName $TaskName
Write-Host ''
Write-Host ('registered  : ' + $task.TaskName + '  state=' + $task.State) -ForegroundColor Green
Write-Host ('action      : ' + $task.Actions[0].Execute + ' ' + $task.Actions[0].Arguments)
Write-Host ('workdir     : ' + $task.Actions[0].WorkingDirectory)
Write-Host ('trigger     : ' + $task.Triggers[0].StartBoundary)
Write-Host ('next run    : ' + $info.NextRunTime)
Write-Host ''
Write-Host 'Done. The first automatic run is the next 09:00.' -ForegroundColor Green
Write-Host 'Log: tools\collector\data\daily-catchup.log'
