@echo off
rem Daily catch-up entry. Fills the missing days in the last N days, then imports.
rem Usage: run-daily-catchup.cmd [--days 7] [--dry-run]
rem
rem Why a wrapper: the scheduled task runs with a minimal environment, where
rem node is not on PATH (the workspace toolchain keeps it under the user's
rem .workbuddy directory). Hard-coding the interpreter here keeps the task
rem definition short and avoids depending on PATH at all.
setlocal
chcp 65001 >nul
cd /d "%~dp0..\..\.."

set "NODE=%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"
if not exist "%NODE%" (
  echo Node not found at %NODE%
  echo Edit this file and point NODE at your node.exe
  exit /b 1
)

"%NODE%" "tools\collector\scripts\daily-catchup.mjs" %*
exit /b %ERRORLEVEL%
