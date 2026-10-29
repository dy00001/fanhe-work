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

rem Node lookup: probe a list of candidates instead of hardcoding one path.
rem A single hardcoded path breaks on every machine change; this file used to
rem pin C:\Users\dy\... which no longer exists, so the whole chain exited 1
rem before doing anything and the log stayed empty.
set "NODE="
for %%C in (
  "%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"
  "C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"
) do (
  if not defined NODE if exist "%%~C" set "NODE=%%~C"
)
if not defined NODE (
  for /f "delims=" %%N in ('where node 2^>nul') do (
    if not defined NODE set "NODE=%%N"
  )
)
if not defined NODE (
  echo Node not found. Add its path to the candidate list in this file.
  exit /b 1
)

set "LOG=tools\collector\data\daily-catchup.log"
if not exist "tools\collector\data" mkdir "tools\collector\data"

echo.>>"%LOG%"
echo ==== %DATE% %TIME% ====>>"%LOG%"

"%NODE%" "tools\collector\scripts\daily-catchup.mjs" %* >>"%LOG%" 2>&1
set "RC=%ERRORLEVEL%"
rem Redirection goes first on purpose. Written as "echo exit=%RC%>>log" the
rem expanded digit fuses with the redirect operator: 0>> and 2>> are parsed as
rem handle redirections (stdin / stderr), so the exit line silently disappears
rem exactly on success (0) and on failure (2) -- the two cases worth logging.
>>"%LOG%" echo exit=%RC%

exit /b %RC%
