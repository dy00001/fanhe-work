# Requires -Version 5.1
<#
.SYNOPSIS
  Register (or remove) the scheduled task that keeps the shop-sync watcher running.

.DESCRIPTION
  Why this exists
    "Sync after binding" only happens if some process polls the pending list.
    That process must survive logoff-free reboots and must not depend on anyone
    remembering to start it. A logon trigger plus an unlimited execution time
    limit is the whole requirement.

  Why the task points at run-hidden.vbs instead of start-sync-watch.cmd
    The launcher owns the node lookup, the single-instance guard and the log
    rotation. Registering node directly would duplicate all three here and they
    would drift. But pointing the task straight at cmd.exe shows a console
    window for as long as the watcher lives (measured 2026-10-24: a black
    window that never closes, and closing it killed the watcher). The VBS
    wrapper starts the same launcher with window style 0.

    The alternative -- "run whether user is logged on or not" (S4U) -- also
    hides the console, but it loads no user profile, so DPAPI and the per-shop
    Edge profile are unavailable and the login state silently reads empty.

  Why a repeating trigger instead of "restart on failure"
    RestartCount only covers failures the scheduler itself reports. Killing the
    process from outside (Task Manager, an OOM kill, a stray Stop-Process) leaves
    the task in Ready with no restart -- verified on 2026-10-23: after the kill
    the state was Ready and no node process existed. Some console control events
    end it the same way (exit code 0xC000013A, seen while heavy host commands
    were running). A repeat trigger plus MultipleInstances=IgnoreNew turns the
    scheduler into a supervisor: every RepeatMinutes it tries to start the
    launcher; if a watcher is alive the scheduler skips the start entirely, if it
    died the new one takes over.

    Default is 1 minute, not 5: when the task is already running the scheduler
    skips the start, so a tight interval costs nothing and caps downtime at one
    minute. Five minutes of silence is enough to make the panel show "offline"
    for no good reason.

  Settings worth knowing
    -ExecutionTimeLimit 0    a daemon must not be killed after the default 3 days
    -RestartCount 3          a crashed watcher is restarted; the launcher already
                             refuses to start twice, so this cannot double up
    -StartWhenAvailable      a missed logon trigger (machine off) still runs later

  Usage
    powershell -ExecutionPolicy Bypass -File install-sync-task.ps1
    powershell -ExecutionPolicy Bypass -File install-sync-task.ps1 -Interval 30
    powershell -ExecutionPolicy Bypass -File install-sync-task.ps1 -Remove
    powershell -ExecutionPolicy Bypass -File install-sync-task.ps1 -Status
#>
[CmdletBinding()]
param(
  [int]$Interval = 60,
  [int]$RepeatMinutes = 1,
  [switch]$Remove,
  [switch]$Status
)

$ErrorActionPreference = 'Stop'
$TaskName = 'fanhe-sync-watch'
$Launcher = Join-Path $PSScriptRoot 'start-sync-watch.cmd'
$HiddenRunner = Join-Path $PSScriptRoot 'run-hidden.vbs'

function Get-Task {
  Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
}

if ($Remove) {
  $existing = Get-Task
  if ($null -eq $existing) {
    Write-Host "task $TaskName is not registered"
    exit 0
  }
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "removed task $TaskName"
  exit 0
}

if ($Status) {
  $task = Get-Task
  if ($null -eq $task) {
    Write-Host "task $TaskName is not registered"
    exit 0
  }
  $info = Get-ScheduledTaskInfo -TaskName $TaskName
  Write-Host "task      : $TaskName"
  Write-Host "state     : $($task.State)"
  Write-Host "last run  : $($info.LastRunTime)"
  Write-Host "last code : $($info.LastTaskResult)"
  Write-Host "next run  : $($info.NextRunTime)"
  exit 0
}

if (-not (Test-Path $Launcher)) {
  Write-Error "launcher not found: $Launcher"
}
if (-not (Test-Path $HiddenRunner)) {
  Write-Error "hidden runner not found: $HiddenRunner"
}

# wscript runs the VBS with no console; the interval is forwarded to the launcher.
$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('"{0}" {1}' -f $HiddenRunner, $Interval)

# The account name has to come from the identity, not from USERDOMAIN\USERNAME:
# USERDOMAIN is the NetBIOS domain, which on a machine that never joined one is
# not the same string the task scheduler expects, and Register-ScheduledTask
# then fails with a bare "parameter is incorrect" pointing at the UserId.
$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

# Two triggers, on purpose.
#
# Repetition attached to the logon trigger is stored but never fires outside a
# logon session: NextRunTime stays empty and a killed watcher is not restarted
# (measured 2026-10-23). A separate Once trigger that starts one minute from now
# and repeats is live immediately, which is what makes the supervisor behaviour
# work at all. The logon trigger stays for the boot case.
#
# 3650 days stands in for "indefinitely": TimeSpan::MaxValue is rejected by some
# builds of New-ScheduledTaskTrigger.
$logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
$repeatTrigger = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(1)) `
  -RepetitionInterval (New-TimeSpan -Minutes $RepeatMinutes) `
  -RepetitionDuration (New-TimeSpan -Days 3650)

$principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -MultipleInstances IgnoreNew

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $logonTrigger, $repeatTrigger `
  -Principal $principal `
  -Settings $settings `
  -Description 'Keeps tools/collector/scripts/sync-shops.mjs polling for stores that asked for a sync.' `
  -Force | Out-Null

Write-Host "registered task $TaskName"
Write-Host "  runner   : $HiddenRunner (no console window)"
Write-Host "  launcher : $Launcher"
Write-Host "  interval : $Interval seconds"
Write-Host "  trigger  : at logon of $currentUser, repeated every $RepeatMinutes min"
Write-Host ""
Write-Host "start it now with:  Start-ScheduledTask -TaskName $TaskName"
Write-Host "remove it with:     powershell -ExecutionPolicy Bypass -File install-sync-task.ps1 -Remove"
