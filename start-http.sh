#!/usr/bin/env bash
set -euo pipefail
jan_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd -- "$jan_root"
exec "$jan_root/.venv/bin/python" -I -m jan_mcp_commander.http_server "$@"
