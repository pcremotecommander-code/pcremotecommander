#!/usr/bin/env bash
set -euo pipefail
jan_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if [[ ! -x "$jan_root/.venv/bin/jan-mcp" ]]; then
  printf '%s\n' 'JAN is not installed in this folder. Run bash setup-linux.sh from the extracted JAN release.' >&2
  exit 1
fi
exec "$jan_root/.venv/bin/jan-mcp" remote "$@"
