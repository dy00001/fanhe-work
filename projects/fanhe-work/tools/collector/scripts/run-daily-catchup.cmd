@echo off
rem Daily catch-up entry. Fills the missing days in the last N days, then imports.
rem Usage: run-daily-catchup.cmd [--days 7] [--dry-run]
rem
rem Why a wrapper: the scheduled task runs with a minimal environment, where
rem node is not on PATH (the workspace toolchain keeps it under the user's
rem .workbuddy directory). The path is fixed rather than derived from
rem %USERPROFILE%, because the task and the interactive shell can resolve that
rem variable to different users on this machine.
rem
rem Why the log file: a scheduled task has no console, so a non-zero exit
rem leaves no evidence of what failed. Everything goes to data\daily-catchup.log.
setlocal
chcp 65001 >nul
cd /d "%~dp0..\..\.."

set "NODE=C:\Users\dy\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"
if not exist "%NODE%" (
  echo Node not found at %NODE%
  echo Edit this file and point NODE at your node.exe
  exit /b 1
)

set "LOG=tools\collector\data\daily-catchup.log"
if not exist "tools\collector\data" mkdir "tools\collector\data"

echo.>>"%LOG%"
echo ==== %DATE% %TIME% ====>>"%LOG%"

"%NODE%" "tools\collector\scripts\daily-catchup.mjs" %* >>"%LOG%" 2>&1
set "RC=%ERRORLEVEL%"
echo exit=%RC%>>"%LOG%"

exit /b %RC%
