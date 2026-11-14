#!/usr/bin/env bash
set -euo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
workspace="${1:?Usage: bash Start-Control.sh /absolute/path/to/approved/workspace}"
echo 'JAN CONTROL: commands can access your Linux account; desktop images share the whole screen.'
echo 'Run without sudo. Ctrl+C stops the origin and tunnel. Wayland desktop input is not supported.'
exec "$root/.venv/bin/python" -I -m jan_mcp_commander.control --workspace "$workspace" --capabilities files,commands,browser,desktop --duration-minutes 60 --transport cloudflare
