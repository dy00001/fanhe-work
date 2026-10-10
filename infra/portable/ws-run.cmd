@echo off
rem ===========================================================================
rem  ws-run.cmd  -  cmd.exe entry point for the portable workspace.
rem
rem  Usage:
rem      infra\portable\ws-run.cmd npm install
rem      infra\portable\ws-run.cmd python -m pytest
rem      infra\portable\ws-run.cmd            (prints the active environment)
rem
rem  %~dp0 is this script's own directory, which is how the root is located
rem  without ever hardcoding a drive letter.
rem ===========================================================================
setlocal EnableExtensions

set "WS_PORTABLE=%~dp0"
set "WS_PS=powershell"
where pwsh >nul 2>nul && set "WS_PS=pwsh"

"%WS_PS%" -NoProfile -NoLogo -ExecutionPolicy Bypass -File "%WS_PORTABLE%ws-run.ps1" %*
set "WS_EXIT=%ERRORLEVEL%"

endlocal & exit /b %WS_EXIT%
