#!/usr/bin/env bash
# =============================================================================
#  ws-env.sh
#  Portable workspace environment for bash / Git Bash. Drive-letter agnostic.
#
#  Apply to the current shell:
#      source "portable/ws-env.sh"
#
#  The root is derived from this file's own location, so moving the workspace
#  to another drive letter needs no edit anywhere.
#
#  Path form note: variables consumed by native Windows tools are exported in
#  the mixed form produced by cygpath -m, which keeps forward slashes while
#  adding the drive qualifier, for example <drive>:/fanhe Work/.tmp.
#  That form is understood by both bash and Windows APIs. Exporting the raw
#  POSIX form would make a native tool resolve /e/... against the current
#  drive, which is a silent and hard to diagnose failure.
# =============================================================================

if [ -n "${BASH_SOURCE[0]:-}" ]; then
  _ws_src="${BASH_SOURCE[0]}"
else
  _ws_src="$0"
fi
WS_PORTABLE_DIR="$(cd "$(dirname "$_ws_src")" && pwd)"

# Walk up from the portable directory until a directory containing the .ws-root
# marker is found. Using the marker instead of a fixed relative depth means the
# mechanism keeps working no matter how the layout is reorganised later.
ws_find_root() {
  _probe="$1"
  while [ -n "$_probe" ] && [ "$_probe" != "/" ]; do
    if [ -f "$_probe/.ws-root" ]; then printf '%s' "$_probe"; return 0; fi
    _probe="$(dirname "$_probe")"
  done
  # Fallback for a workspace whose marker is missing, one level above portable.
  (cd "$WS_PORTABLE_DIR/.." && pwd)
}
WS_ROOT_POSIX="$(ws_find_root "$WS_PORTABLE_DIR")"

# Convert a POSIX path to the mixed Windows form accepted by both worlds.
ws_win_path() {
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -m "$1"
  else
    printf '%s' "$1"
  fi
}

ws_mkdir() { mkdir -p "$1" 2>/dev/null || true; }

# --- create every workspace-internal directory (POSIX form) ------------------
# A quoted array expansion is mandatory here. The workspace path contains a
# space, so an unquoted list would split "fanhe Work" into two paths and create
# stray directories, one of them outside the workspace entirely.
_ws_dirs=(
  "$WS_ROOT_POSIX/.tmp"
  "$WS_ROOT_POSIX/.cache"
  "$WS_ROOT_POSIX/.local"
  "$WS_ROOT_POSIX/.config"
  "$WS_ROOT_POSIX/logs"
  "$WS_ROOT_POSIX/.venv"
  "$WS_ROOT_POSIX/runtime"
  "$WS_ROOT_POSIX/.cache/npm"
  "$WS_ROOT_POSIX/.cache/pip"
  "$WS_ROOT_POSIX/.cache/yarn"
  "$WS_ROOT_POSIX/.cache/pnpm-store"
  "$WS_ROOT_POSIX/.cache/go-build"
  "$WS_ROOT_POSIX/.cache/ccache"
  "$WS_ROOT_POSIX/.cache/pycache"
  "$WS_ROOT_POSIX/.cache/ms-playwright"
  "$WS_ROOT_POSIX/.cache/electron"
  "$WS_ROOT_POSIX/.local/npm-global"
  "$WS_ROOT_POSIX/.local/pnpm"
  "$WS_ROOT_POSIX/.local/python"
  "$WS_ROOT_POSIX/.local/yarn"
  "$WS_ROOT_POSIX/.gradle"
  "$WS_ROOT_POSIX/.m2/repository"
  "$WS_ROOT_POSIX/.cargo"
  "$WS_ROOT_POSIX/.rustup"
  "$WS_ROOT_POSIX/.go"
  "$WS_ROOT_POSIX/.nuget/packages"
  "$WS_ROOT_POSIX/.docker"
)
for _d in "${_ws_dirs[@]}"; do ws_mkdir "$_d"; done

# --- export in the mixed Windows form ---------------------------------------
export WS_ROOT="$(ws_win_path "$WS_ROOT_POSIX")"
export WS_ROOT_POSIX
export WS_PORTABLE_DIR

# Process scratch space
export TMP="$(ws_win_path "$WS_ROOT_POSIX/.tmp")"
export TEMP="$TMP"
export WS_LOGS="$(ws_win_path "$WS_ROOT_POSIX/logs")"

# XDG style bases
export XDG_CACHE_HOME="$(ws_win_path "$WS_ROOT_POSIX/.cache")"
export XDG_CONFIG_HOME="$(ws_win_path "$WS_ROOT_POSIX/.config")"
export XDG_DATA_HOME="$(ws_win_path "$WS_ROOT_POSIX/.local")"

# Python
export VIRTUAL_ENV="$(ws_win_path "$WS_ROOT_POSIX/.venv")"
export PIP_CACHE_DIR="$(ws_win_path "$WS_ROOT_POSIX/.cache/pip")"
export PIP_DISABLE_PIP_VERSION_CHECK=1
export PYTHONPYCACHEPREFIX="$(ws_win_path "$WS_ROOT_POSIX/.cache/pycache")"
export PYTHONUSERBASE="$(ws_win_path "$WS_ROOT_POSIX/.local/python")"

# Node and the JavaScript ecosystem
export npm_config_cache="$(ws_win_path "$WS_ROOT_POSIX/.cache/npm")"
export npm_config_prefix="$(ws_win_path "$WS_ROOT_POSIX/.local/npm-global")"
export npm_config_userconfig="$(ws_win_path "$WS_PORTABLE_DIR/config/.npmrc")"
export NODE_REPL_HISTORY="$(ws_win_path "$WS_ROOT_POSIX/.cache/node_repl_history")"
export YARN_CACHE_FOLDER="$(ws_win_path "$WS_ROOT_POSIX/.cache/yarn")"
export PNPM_HOME="$(ws_win_path "$WS_ROOT_POSIX/.local/pnpm")"
export npm_config_store_dir="$(ws_win_path "$WS_ROOT_POSIX/.cache/pnpm-store")"

# JVM ecosystem
export GRADLE_USER_HOME="$(ws_win_path "$WS_ROOT_POSIX/.gradle")"
export MAVEN_OPTS="-Dmaven.repo.local=$(ws_win_path "$WS_ROOT_POSIX/.m2/repository")"

# Rust
export CARGO_HOME="$(ws_win_path "$WS_ROOT_POSIX/.cargo")"
export RUSTUP_HOME="$(ws_win_path "$WS_ROOT_POSIX/.rustup")"

# Go
export GOPATH="$(ws_win_path "$WS_ROOT_POSIX/.go")"
export GOCACHE="$(ws_win_path "$WS_ROOT_POSIX/.cache/go-build")"
export GOMODCACHE="$(ws_win_path "$WS_ROOT_POSIX/.go/pkg/mod")"

# Other build and tool caches
export CCACHE_DIR="$(ws_win_path "$WS_ROOT_POSIX/.cache/ccache")"
export DOCKER_CONFIG="$(ws_win_path "$WS_ROOT_POSIX/.docker")"
export PLAYWRIGHT_BROWSERS_PATH="$(ws_win_path "$WS_ROOT_POSIX/.cache/ms-playwright")"
export NUGET_PACKAGES="$(ws_win_path "$WS_ROOT_POSIX/.nuget/packages")"

# Electron. Three separate variables, not interchangeable. See the matching
# block in ws-env.ps1 for the full reasoning. The short version is that the
# `electron` npm package reads electron_config_cache, not ELECTRON_CACHE, and
# @electron/get has no ELECTRON_CACHE fallback, so without it the binary is
# written to the system drive.
export ELECTRON_CACHE="$(ws_win_path "$WS_ROOT_POSIX/.cache/electron")"
export ELECTRON_CONFIG_CACHE="$(ws_win_path "$WS_ROOT_POSIX/.cache/electron")"
export electron_config_cache="$(ws_win_path "$WS_ROOT_POSIX/.cache/electron")"
export ELECTRON_BUILDER_CACHE="$(ws_win_path "$WS_ROOT_POSIX/.cache/electron/builder")"

# Mirror the binary downloads, following the npm registry host already pinned
# in infra/portable/config/.npmrc.
export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
export ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"

# Git on a removable, permission-less filesystem. exFAT has no execute bit, no
# symlink support and a 260 character path limit unless long paths are enabled.
# These are injected for this shell only and do not override the user's own
# global git configuration.
export GIT_CONFIG_COUNT=4
export GIT_CONFIG_KEY_0=core.filemode   GIT_CONFIG_VALUE_0=false
export GIT_CONFIG_KEY_1=core.autocrlf   GIT_CONFIG_VALUE_1=false
export GIT_CONFIG_KEY_2=core.symlinks   GIT_CONFIG_VALUE_2=false
export GIT_CONFIG_KEY_3=core.longpaths  GIT_CONFIG_VALUE_3=true

# Prefer workspace-local runtimes and shims when present.
_ws_prepend="$WS_ROOT_POSIX/runtime/node:$WS_ROOT_POSIX/runtime/python:$WS_ROOT_POSIX/.venv/Scripts:$WS_ROOT_POSIX/.local/npm-global"
case ":$PATH:" in
  *":$WS_ROOT_POSIX/runtime/node:"*) ;;
  *) export PATH="$_ws_prepend:$PATH" ;;
esac

# --- change detection: delegate to the shared state manager ------------------
# ws-state.ps1 owns the detection logic for every entry point, so this shell
# runs it as a child process rather than reimplementing the JSON handling in
# bash. A child process is used because the state manager writes JSON and needs
# the mixed path form; parsing that with grep/sed would duplicate the logic and
# drift out of sync with the PowerShell side.
# Set WS_NO_REPAIR=1 to detect and record without running the repair routine.
_ws_state="$WS_PORTABLE_DIR/ws-state.ps1"
if [ -f "$_ws_state" ]; then
  _ws_ps=""
  for _c in powershell.exe pwsh.exe; do
    if command -v "$_c" >/dev/null 2>&1; then _ws_ps="$_c"; break; fi
  done
  if [ -z "$_ws_ps" ] && [ -x "/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe" ]; then
    _ws_ps="/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"
  fi
  if [ -n "$_ws_ps" ]; then
    _ws_psargs=(-NoProfile -ExecutionPolicy Bypass -File "$(ws_win_path "$_ws_state")" -Root "$WS_ROOT")
    [ -n "${WS_NO_REPAIR:-}" ] && _ws_psargs+=(-NoRepair)
    [ -n "${WS_QUIET:-}" ] && _ws_psargs+=(-Quiet)
    "$_ws_ps" "${_ws_psargs[@]}"
  else
    echo "[ws] PowerShell not found, workspace state check skipped" >&2
  fi
fi

unset _ws_src _ws_dirs _d _ws_prepend _ws_state _ws_ps _ws_psargs _c
