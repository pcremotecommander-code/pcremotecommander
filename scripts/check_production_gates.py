"""Fail closed until a maintainer records evidence for every release gate."""
import json
from pathlib import Path
import sys

REQUIRED = {'upstream_tunnel_findings_reviewed', 'container_built_and_scanned',
            'target_host_hardened', 'live_tunnel_authenticated',
            'chatgpt_tools_verified', 'recovery_and_disconnect_verified'}

def check(path, staging=False):
    report = json.loads(Path(path).read_text())
    gates = report.get('gates', {})
    required = REQUIRED - {'live_tunnel_authenticated', 'chatgpt_tools_verified', 'recovery_and_disconnect_verified'} if staging else REQUIRED
    return [name for name in sorted(required) if gates.get(name, {}).get('passed') is not True
            or not gates.get(name, {}).get('evidence')]

if __name__ == '__main__':
    path = Path(__file__).resolve().parents[1] / 'docs/release-status.json'
    blocked = check(path, staging='--stage' in sys.argv[1:])
    print(json.dumps({'production_ready': not blocked, 'blocked_gates': blocked}, indent=2))
    sys.exit(1 if blocked else 0)
