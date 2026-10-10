#!/usr/bin/env bash
# =============================================================================
#  ws-run.sh
#  bash / Git Bash entry point. Applies the portable environment, then runs the
#  command inside the workspace root.
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

cd "$WS_ROOT"
exec "$@"
