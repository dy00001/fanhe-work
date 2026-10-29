@echo off
rem Double click this file once to register the daily catch-up task.
rem
rem Task registration needs administrator rights and the agent sandbox runs
rem unelevated, so this launcher re-starts itself elevated and then calls
rem register-daily-task.ps1 next to it.
rem
rem Unregister with:  register-daily-task.cmd -Remove
setlocal
net session >nul 2>&1
if not "%errorlevel%"=="0" (
  echo Requesting administrator rights...
  powershell -NoProfile -Command "Start-Process -FilePath 'cmd.exe' -ArgumentList '/c','\"%~f0\" %*' -Verb RunAs"
  exit /b 0
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0register-daily-task.ps1" %*
echo.
pause
