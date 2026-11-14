#!/usr/bin/env bash
set -euo pipefail
jan_cloud_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd -- "$jan_cloud_root"
command -v docker >/dev/null || { printf '%s\n' 'Docker with Compose v2 is required on the target Linux server.' >&2; exit 2; }
docker compose version >/dev/null
docker info >/dev/null
[[ -f .env ]] || { printf '%s\n' 'Create deploy/cloud/.env from .env.example.' >&2; exit 2; }
[[ -f secrets/tunnel_api_key ]] || { printf '%s\n' 'Install the runtime key as described in docs/cloud-deployment.md.' >&2; exit 2; }
jan_mode=()
if [[ "${1:-}" == --stage ]]; then jan_mode=(--stage);
elif [[ -n "${1:-}" ]]; then printf '%s\n' 'Usage: bash deploy.sh [--stage]' >&2; exit 2; fi
python3 ../../scripts/check_production_gates.py "${jan_mode[@]}"
docker compose --env-file .env config --quiet
docker compose --env-file .env up -d --build --wait --wait-timeout 180
docker compose ps
