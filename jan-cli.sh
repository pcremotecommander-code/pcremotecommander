#!/usr/bin/env bash
set -euo pipefail
jan_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if [[ ! -x "$jan_root/.venv/bin/python" ]]; then
  printf '%s\n' 'Run bash setup-linux.sh first.' >&2
  exit 1
fi
exec "$jan_root/.venv/bin/python" -m jan_mcp_commander.cli "$@"
