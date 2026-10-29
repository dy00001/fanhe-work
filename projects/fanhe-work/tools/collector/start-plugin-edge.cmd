@echo off
setlocal
rem ===========================================================================
rem  start-plugin-edge.cmd - collector browser WITH the bridge extension loaded
rem
rem  Why this exists
rem    The plugin chain (2026-10-26) reads shop data through the taobao-cli
rem    bridge extension, so the extension must live inside the same browser
rem    that holds the shop login. On this machine neither Chrome 155 (profile
rem    "Default") nor the daily Edge profile had the bridge installed, and
rem    Chrome no longer honours --load-extension. Edge still does, so this
rem    entry loads extension\unpacked from runtime\sycm-cli directly.
rem
rem    A browser started from an automation call dies as soon as that call
rem    returns, and a login needs a window that outlives the call. That is why
rem    the login step must be a human double-click on THIS file.
rem
rem  Usage
rem    start-plugin-edge.cmd            (default shop: fanhe-main, port 9222)
rem    start-plugin-edge.cmd s2         (port 9223)
rem
rem  After it opens: log in to sycm.taobao.com in that window, keep it open,
rem  then run scripts\run-plugin-daily.ps1 (or ask the agent to collect).
rem ===========================================================================

set "SHOP=%~1"
if "%SHOP%"=="" set "SHOP=fanhe-main"

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

if /i "%SHOP%"=="fanhe-main" set "PORT=9222"
if /i "%SHOP%"=="s2" set "PORT=9223"
if /i "%SHOP%"=="s3" set "PORT=9224"
if /i "%SHOP%"=="s4" set "PORT=9225"
if /i "%SHOP%"=="s5" set "PORT=9226"
if "%PORT%"=="" (
  echo Unknown shop code: %SHOP%
  echo Known codes: fanhe-main, s2, s3, s4, s5
  pause
  exit /b 1
)

set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=%LOCALAPPDATA%\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" (
  echo Edge not found. Please install Microsoft Edge first.
  pause
  exit /b 1
)

rem One profile per shop. Sharing a profile silently swaps accounts: the bridge
rem still sees a logged-in page, only the shop behind it has changed.
set "PROFILE=%ROOT%\.browser-profile\%SHOP%"
if not exist "%PROFILE%" mkdir "%PROFILE%"

rem Workspace root is four levels up from tools\collector.
set "EXT=%ROOT%\..\..\..\..\runtime\sycm-cli\extension\unpacked"
if not exist "%EXT%\manifest.json" (
  echo Bridge extension not found at:
  echo   %EXT%
  echo Copy runtime\sycm-cli from the delivery package first.
  pause
  exit /b 1
)

echo shop    : %SHOP%
echo profile : %PROFILE%
echo port    : %PORT%
echo plugin  : %EXT%
echo.

start "" "%EDGE%" --remote-debugging-port=%PORT% --user-data-dir="%PROFILE%" --load-extension="%EXT%" --no-first-run --no-default-browser-check --new-window "https://sycm.taobao.com/portal/home.htm"

echo Edge started. Log in to sycm.taobao.com in that window and keep it open.
echo Then run:  scripts\run-plugin-daily.ps1 -Date <yyyy-MM-dd>
echo.
pause
