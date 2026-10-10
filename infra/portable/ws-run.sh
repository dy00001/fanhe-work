#!/usr/bin/env bash
# =============================================================================
#  ws-run.sh
#  bash / Git Bash entry point. Applies the portable environment, then runs the
#  command in the caller's directory. Falls back to the workspace root only when
#  invoked from outside the workspace.
#
#  Usage:
#      ./portable/ws-run.sh npm install
#      ./portable/ws-run.sh python -m pytest
# =============================================================================
set -e

_ws_src="${BASH_SOURCE[0]}"
WS_PORTABLE_DIR="$(cd "$(dirname "$_ws_src")" && pwd)"
# shellcheck source=ws-env.sh
. "$WS_PORTABLE_DIR/ws-env.sh"

if [ "$#" -eq 0 ]; then
  echo "[ws] no command supplied. Environment applied."
  echo "[ws] root = $WS_ROOT"
  echo "[ws] start an interactive shell with:  bash --rcfile <(cat ~/.bashrc; cat '$WS_PORTABLE_DIR/ws-env.sh')"
  exit 0
fi

# Keep the caller's working directory when it is already inside the workspace,
# and fall back to the root only when invoked from outside. The redirection is
# applied through process-level environment variables, so the working directory
# has nothing to do with it.
#
# Forcing a cd to the root used to be harmless because projects lived at the top
# level. Once they moved under projects/<name>/ it stopped being harmless: the
# root has no package.json, so `pnpm install` and friends ran in the wrong
# directory without printing anything about it.
_ws_cwd="$(pwd -P)"
case "$_ws_cwd" in
  "$WS_ROOT_POSIX" | "$WS_ROOT_POSIX"/*) ;;
  *) cd "$WS_ROOT_POSIX" ;;
esac

exec "$@"
