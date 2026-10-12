@echo off
rem ===========================================================================
rem  ws-compose.cmd  -  entry point for the containerised stack (T5-01).
rem
rem  Usage:
rem      infra\portable\ws-compose.cmd up            start everything and wait
rem      infra\portable\ws-compose.cmd down          stop, keep containers
rem      infra\portable\ws-compose.cmd logs -f api   follow one service
rem      infra\portable\ws-compose.cmd status        show health of each
rem      infra\portable\ws-compose.cmd ps
rem      infra\portable\ws-compose.cmd <anything else>  passed through
rem
rem  NOTE: this file is ASCII-only on purpose. cmd.exe decodes a .cmd using the
rem  system ANSI code page (GBK on this machine), so non-ASCII comments get
rem  mangled and -- worse -- the mangling can break the line structure, which
rem  makes cmd try to execute fragments of the comments as commands. Same class
rem  of problem as the UTF-8 BOM requirement for .ps1 files. The Chinese
rem  explanation lives in docs/WORK-STATUS.md section 4.1.3 instead.
rem
rem  Why this wrapper exists rather than calling `docker compose` directly:
rem
rem  The compose file reads FANHE_JWT_SECRET from an env file, and compose looks
rem  for `.env` by default -- not `.env.compose`. That name is deliberate: `.env`
rem  at the repo root would be picked up by too many tools at once, and the
rem  development `.env` already lives at apps/api/.env with a different meaning
rem  (it points at 127.0.0.1, which inside a container is the container itself).
rem  So the flag has to be supplied, and supplying it by hand is the kind of step
rem  people forget -- forgetting it produces "required variable
rem  FANHE_JWT_SECRET is missing", which reads like a bug rather than a forgotten
rem  flag.
rem
rem  %~dp0 locates the workspace root without hardcoding a drive letter.
rem ===========================================================================
setlocal EnableExtensions

set "WS_PORTABLE=%~dp0"
set "WS_REPO=%WS_PORTABLE%..\..\projects\fanhe-work"
set "WS_ENV=%WS_REPO%\.env.compose"

if not exist "%WS_REPO%\docker-compose.yml" (
    echo [ws-compose] docker-compose.yml not found under: %WS_REPO%
    echo [ws-compose] This script assumes it lives in the workspace infra\portable\.
    endlocal & exit /b 1
)

if not exist "%WS_ENV%" (
    echo [ws-compose] Missing %WS_ENV%
    echo [ws-compose] Create it and generate a secret with:
    echo [ws-compose]     node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
    endlocal & exit /b 1
)

rem --env-file takes an absolute path: this script may be called from any
rem directory, while compose resolves that path relative to the CURRENT one.
docker compose --env-file "%WS_ENV%" -f "%WS_REPO%\docker-compose.yml" %*
set "WS_EXIT=%ERRORLEVEL%"

endlocal & exit /b %WS_EXIT%