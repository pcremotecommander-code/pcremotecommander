#!/usr/bin/env bash
set -euo pipefail
pcrc_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd -- "$pcrc_root"
if [[ $# == 1 && "$1" == '--doctor' ]]; then
  exec node deploy/npm/jan-commander/bin/doctor.cjs
fi
if [[ "${EUID}" == 0 || ! -x .venv/bin/python || ! -f deploy/mcp-task-server/dist/main.js ]]; then
  printf '%s\n' 'Run PCRC setup first and connect as your normal user.' >&2
  exit 1
fi
if [[ $# -gt 1 || ( $# -eq 1 && "$1" != '--desktop' ) ]]; then
  printf '%s\n' 'Usage: bash pcrc-connect.sh [--desktop|--doctor]' >&2
  exit 1
fi
if [[ "${1:-}" == '--desktop' ]]; then
  case "$(uname -s)" in
    Darwin) ;;
    Linux) [[ "${XDG_SESSION_TYPE:-}" == x11 && -n "${DISPLAY:-}" ]] || { printf '%s\n' 'Desktop control requires a Linux X11 session.' >&2; exit 1; } ;;
    *) exit 1 ;;
  esac
  .venv/bin/python -c 'import pyautogui' || { printf '%s\n' 'Run setup with PCRC_DESKTOP=1 in your desktop session.' >&2; exit 1; }
fi
exec node - "$@" <<'JS'
const pairing = require('./deploy/npm/jan-commander/bin/pair-device.cjs');
const desktop = process.argv.includes('--desktop');
const options = pairing.parseArgs([
  '--gateway', 'https://pc-remote-commander.pcremotecommander.workers.dev',
  '--capabilities', desktop ? 'files,commands,browser,desktop' : 'files,commands,browser',
]);
options.browserChoice = true;
options.autoUpgrade = desktop;
pairing.run(process.cwd(), options).catch(error => {
  console.error('PC Remote Commander: ' + error.message);
  process.exitCode = 1;
});
JS
