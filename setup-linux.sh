#!/usr/bin/env bash
set -euo pipefail
umask 077
pcrc_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd -- "$pcrc_root"
case "$(uname -s)" in
  Linux|Darwin) ;;
  *) printf '%s\n' 'This installer requires Linux or macOS.' >&2; exit 1 ;;
esac
if [[ "${EUID}" == 0 ]]; then
  printf '%s\n' 'Run PCRC setup from your normal user account.' >&2
  exit 1
fi
if ! command -v npm >/dev/null || ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) < 20 ? 1 : 0)'; then
  printf '%s\n' 'Install Node.js 20 or newer with npm, then retry.' >&2
  exit 1
fi
if ! python3 -c 'import sys, venv; sys.exit(sys.version_info < (3, 11))'; then
  printf '%s\n' 'Install Python 3.11 or newer with venv support, then retry.' >&2
  exit 1
fi
if [[ ! -x .venv/bin/python ]]; then
  python3 -m venv .venv
fi
.venv/bin/python -m pip install --disable-pip-version-check 'pip==26.2.1'
.venv/bin/python -m pip install --require-hashes -r requirements-linux.lock
extras='browser'
if [[ "${PCRC_DESKTOP:-0}" == 1 ]]; then
  extras='browser,desktop'
fi
.venv/bin/python -m pip install -e ".[$extras]"
.venv/bin/python -m pip check
.venv/bin/python -m playwright install chromium
npm --prefix deploy/npm/jan-commander ci --omit=dev --ignore-scripts
npm --prefix deploy/mcp-task-server ci --ignore-scripts
npm --prefix deploy/mcp-task-server run build
.venv/bin/python - "${1:-}" <<'PY'
import json, os, sys
from pathlib import Path
config = Path('connection.json')
prior = json.loads(config.read_text(encoding='utf-8-sig')) if config.exists() else {}
selected = sys.argv[1] or os.environ.get('JAN_MCP_WORKSPACE') or prior.get('workspace') or str(Path.home() / 'PCRC-Workspace')
workspace = Path(selected).expanduser()
resolved = workspace.resolve()
installation = Path.cwd().resolve()
if resolved.is_relative_to(installation) or installation.is_relative_to(resolved):
    raise SystemExit('Keep the workspace separate from the PCRC installation directory.')
workspace.mkdir(parents=True, exist_ok=True)
prior['workspace'] = str(workspace.resolve(strict=True))
config.write_text(json.dumps(prior, indent=2), encoding='utf-8')
print('Approved workspace:', prior['workspace'])
PY
.venv/bin/python scripts/verify_install.py
printf '%s\n' 'PCRC installed. Pair and connect: bash pcrc-connect.sh' 'Local MCP: bash jan-cli.sh serve'
