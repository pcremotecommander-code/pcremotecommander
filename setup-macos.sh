#!/usr/bin/env bash
set -euo pipefail
pcrc_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec bash "$pcrc_root/setup-linux.sh" "$@"
