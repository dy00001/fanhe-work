@echo off
rem Double click this file once to remove the daily catch-up task from Task Scheduler.
rem
rem Why it exists: the collection task now runs as a WorkBuddy automation instead
rem (visible in the app, with run history and failure notices). Leaving the old
rem Windows task enabled would mean two schedulers waking the same collector at
rem the same time, and two collectors fighting over one Edge profile is exactly
rem how shop data ends up filed under the wrong shop name.
rem
rem Removing a task needs administrator rights, which the agent sandbox does not
rem have, so this launcher re-starts itself elevated and then calls
rem register-daily-task.ps1 -Remove next to it.
setlocal
net session >nul 2>&1
if not "%errorlevel%"=="0" (
  echo Requesting administrator rights...
  powershell -NoProfile -Command "Start-Process -FilePath 'cmd.exe' -ArgumentList '/c','\"%~f0\" %*' -Verb RunAs"
  exit /b 0
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0register-daily-task.ps1" -Remove %*
echo.
pause
