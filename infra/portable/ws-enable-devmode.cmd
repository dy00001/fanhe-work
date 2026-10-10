@echo off
rem ===========================================================================
rem  ws-enable-devmode.cmd
rem  Host level setup wrapper. Enables Windows Developer Mode and NTFS long
rem  path support, both of which live in HKLM and need administrator rights.
rem
rem  The script re-launches itself with a UAC prompt when it is not already
rem  elevated, so it can be double clicked or started from any shell.
rem
rem  Usage
rem      infra\portable\ws-enable-devmode.cmd
rem
rem  %~dp0 is this script's own directory and %~f0 its full path, so no drive
rem  letter is ever written into the file.
rem ===========================================================================
setlocal EnableExtensions

net session >nul 2>&1
if not "%errorlevel%"=="0" (
    echo Requesting administrator rights...
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

set "WS_PS=powershell"
where pwsh >nul 2>nul && set "WS_PS=pwsh"

"%WS_PS%" -NoProfile -NoLogo -ExecutionPolicy Bypass -File "%~dp0ws-enable-devmode.ps1"
set "WS_EXIT=%ERRORLEVEL%"

echo.
pause
endlocal & exit /b %WS_EXIT%
