@echo off
setlocal enabledelayedexpansion
rem Start the collector browser for ONE shop, keeping a CDP debug port open.
rem
rem Usage:
rem   start-edge.cmd                (default shop: fanhe-main, port 9222)
rem   start-edge.cmd s2             (port 9223)
rem
rem Why this exists as a separate entry:
rem   Edge started inside an automation call dies as soon as that call returns.
rem   A human login therefore needs a browser that outlives the call, which means
rem   it has to be started by a human double-click, not by the collector.
rem   `run-daily.ps1` deliberately starts and stops Edge within one process; this
rem   script is the opposite case and must NOT be folded into it.
rem
rem The port table mirrors shops.config.json (basePort 9222, one port per shop).
rem Keep the two in sync when adding a shop.

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

rem Edge auto-detect: 32-bit, 64-bit, then per-user install
set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=%LOCALAPPDATA%\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" (
  echo Edge not found. Please install Microsoft Edge first.
  pause
  exit /b 1
)

rem One profile per shop. Sharing a profile between shops makes the collector read
rem a logged-in page from the wrong account without any error, so the directory is
rem created up front and the script refuses to continue if that fails.
set "PROFILE=%ROOT%\.browser-profile\%SHOP%"
if not exist "%PROFILE%" mkdir "%PROFILE%"
if not exist "%PROFILE%" (
  echo Cannot create profile directory: %PROFILE%
  pause
  exit /b 1
)

echo Shop    : %SHOP%
echo Port    : %PORT%
echo Profile : %PROFILE%
echo.
echo A browser window will open. Log in to 生意参谋 once; the cookies stay in
echo this profile and later collections reuse them.
echo Keep it open while collecting. Close it when done.
echo.

start "" "%EDGE%" --remote-debugging-port=%PORT% --user-data-dir="%PROFILE%" --no-first-run --no-default-browser-check --new-window "https://sycm.taobao.com"

echo Edge started. This window can be closed.
timeout /t 4 >nul
