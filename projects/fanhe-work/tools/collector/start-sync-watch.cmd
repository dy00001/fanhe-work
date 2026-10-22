@echo off
setlocal enabledelayedexpansion
rem Start the shop-sync watcher (binding-triggered auto sync).
rem
rem Usage:
rem   start-sync-watch.cmd            poll every 60 seconds
rem   start-sync-watch.cmd 30         poll every 30 seconds
rem
rem Why a separate launcher:
rem   The watcher must outlive the console that started it. Double-clicking this
rem   file, or letting the scheduled task start it, keeps it alive; typing
rem   `node scripts\...` into a console ends it when that console closes.
rem   install-sync-task.ps1 points the task at THIS file, so the node lookup,
rem   the single-instance guard and the log redirection live in one place.
rem
rem Single instance:
rem   Two watchers would poll the same shop at once. collect-daily.mjs is not
rem   safe under that: both drive the same Edge debug port and write into the
rem   same output folder, and the second one silently wins. The guard lives in
rem   watch-guard.ps1 because cmd's `for /f` cannot carry a pipe and a quoted
rem   filter at the same time without mangling the quotes.
rem
rem Node lookup order:
rem   1. NODE_EXE environment variable
rem   2. `node` on PATH
rem   3. the portable runtime under %USERPROFILE%\.workbuddy\binaries\node
rem No drive letter is hardcoded: the workspace lives on a removable disk and
rem its letter changes between machines.
rem
rem Log: data\sync-watch.log, rotated to .1 once it passes 5 MB.

set "INTERVAL=%~1"
if "%INTERVAL%"=="" set "INTERVAL=60"

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

if not exist "%ROOT%\data" mkdir "%ROOT%\data"
set "LOG=%ROOT%\data\sync-watch.log"

rem ---- single instance -------------------------------------------------------
set "STATE="
for /f "delims=" %%R in ('powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%\watch-guard.ps1"') do set "STATE=%%R"
if /i "!STATE!"=="running" (
  echo [sync-watch] already running, nothing to do
  exit /b 0
)

rem ---- node ------------------------------------------------------------------
set "NODE="
if not "%NODE_EXE%"=="" if exist "%NODE_EXE%" set "NODE=%NODE_EXE%"

if "%NODE%"=="" (
  for /f "delims=" %%N in ('where node 2^>nul') do if not defined NODE set "NODE=%%N"
)

if "%NODE%"=="" (
  for /d %%D in ("%USERPROFILE%\.workbuddy\binaries\node\versions\*") do (
    if exist "%%D\node.exe" set "NODE=%%D\node.exe"
  )
)

if "%NODE%"=="" (
  echo [sync-watch] cannot find node.exe
  echo   set NODE_EXE to a full path, or put node on PATH
  exit /b 2
)

rem ---- log rotation ----------------------------------------------------------
if exist "%LOG%" (
  for %%F in ("%LOG%") do if %%~zF GTR 5242880 move /y "%LOG%" "%LOG%.1" >nul
)

rem ISO timestamp from PowerShell: %DATE% %TIME% come out in the OEM code page,
rem which turns the weekday into mojibake in the log file and makes the line
rem useless for correlating with the database timestamps (which are UTC).
set "STAMP="
for /f "delims=" %%T in ('powershell -NoProfile -Command "Get-Date -Format s"') do set "STAMP=%%T"

echo [sync-watch] node=%NODE%
echo [sync-watch] interval=%INTERVAL%s log=%LOG%
echo [sync-watch] started %STAMP% >>"%LOG%"

cd /d "%ROOT%"
"%NODE%" "scripts\sync-shops.mjs" --watch %INTERVAL% >>"%LOG%" 2>&1

rem Reaching here means the watcher exited. Record the code so a crash loop
rem leaves a trail instead of silently restarting forever.
echo [sync-watch] exited with code %ERRORLEVEL% >>"%LOG%"
exit /b %ERRORLEVEL%
