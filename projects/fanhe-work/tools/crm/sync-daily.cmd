@echo off
rem Daily customer sync entry.
rem Usage: sync-daily.cmd [--dry-run] [--verbose]
rem
rem WHAT IT DOES
rem   Re-reads every group file in the Obsidian chat archive and refreshes the
rem   activity columns of the customer platform: message count, first/last message
rem   time, skipped image/voice counts, source group file name. Optionally updates
rem   the stage, but only for customers still pending review whose stage came from
rem   the AI or the ledger.
rem
rem ORDERING MATTERS
rem   Run this AFTER the 17:00 chat archive job rewrites the .md files. Running it
rem   before only re-reads yesterday's snapshot: the job exits 0, the log says
rem   "no change", and nothing looks wrong.
rem
rem KEEP THIS FILE ASCII ONLY
rem   Comments in Chinese break cmd.exe: the parser reads the file with the OEM
rem   codepage (936 here), so UTF-8 bytes get read as GBK and a comment line can
rem   turn into a command. That is how this script once printed four lines of
rem   "is not recognized as an internal or external command" while still working.
rem
rem WHY THE DATABASE CHECK
rem   The sync connects to Postgres. When the container is down Prisma fails with a
rem   connection error, which reads like a code bug and sends you looking in the
rem   wrong place. Check first, say so plainly, exit 1.
rem
rem WHY THE LOG FILE
rem   A scheduled task has no console. Without the log a failed run leaves nothing
rem   behind, and "no output" is indistinguishable from "no change".
setlocal
chcp 65001 >nul
cd /d "%~dp0..\.."

set "LOG=data\customer-sync.log"
if not exist "data" mkdir "data"
>>"%LOG%" echo.
>>"%LOG%" echo ==== %DATE% %TIME% ====

rem The orchestrator wrapper owns node/pnpm selection; calling pnpm directly here
rem fails with ERR_PNPM_UNEXPECTED_STORE and no useful message.
set "WSRUN=..\..\infra\portable\ws-run.cmd"
if not exist "%WSRUN%" (
  >>"%LOG%" echo ws-run.cmd not found at %WSRUN%
  exit /b 1
)

set "DBUP="
for /f "delims=" %%D in ('docker ps --filter "name=fanhe-work-db" --format "{{.Names}}" 2^>nul') do set "DBUP=%%D"
if not defined DBUP (
  >>"%LOG%" echo database container fanhe-work-db is not running; sync skipped
  exit /b 1
)

call "%WSRUN%" pnpm db:customer-sync %* >>"%LOG%" 2>&1
set "RC=%ERRORLEVEL%"
rem Redirection first on purpose: "echo exit=%RC%>>log" fuses the digit with the
rem operator, so 0>> and 2>> become handle redirections and the line vanishes
rem exactly on success and on the DB-error case.
>>"%LOG%" echo exit=%RC%

exit /b %RC%
