@echo off
setlocal
rem Launch Edge with CDP debugging on a dedicated automation profile.
rem Keep this window open while the agent is working.
rem
rem The workspace lives on a removable USB drive, so the drive letter changes
rem between machines (E: on one PC, F: on another). Everything below is derived
rem from this script's own location. Never hard-code a drive letter here.

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

rem Edge auto-detect: 32-bit, 64-bit, then per-user install
set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=%LOCALAPPDATA%\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" (
  echo Edge not found. Please install Microsoft Edge first.
  pause
  exit /b 1
)

set "PROFILE=%ROOT%\.browser-profile"
if not exist "%PROFILE%" mkdir "%PROFILE%"

start "" "%EDGE%" --remote-debugging-port=9222 --user-data-dir="%PROFILE%" --no-first-run --no-default-browser-check --new-window "https://sycm.taobao.com"
timeout /t 3 >nul
echo.
echo Edge started with debugging on port 9222.
echo Workspace: %ROOT%
echo Profile: %PROFILE%
echo Keep this window open. Close it when the task is done.
pause
