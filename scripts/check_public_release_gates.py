"""Fail closed on the separate multi-user public release gates."""
import json
from pathlib import Path
import sys

REQUIRED = {
    'local_two_account_runtime',
    'live_two_account_isolation',
    'distributed_abuse_controls',
    'desktop_distribution',
    'independent_security_review',
    'operations_and_recovery',
    'client_interoperability',
    'target_host_hardened',
}


def check(path):
    report = json.loads(Path(path).read_text(encoding='utf-8'))
    gates = report.get('public_multiuser', {}).get('gates', {})
    return [name for name in sorted(REQUIRED)
            if gates.get(name, {}).get('passed') is not True
            or not gates.get(name, {}).get('evidence')]


if __name__ == '__main__':
    status = Path(__file__).resolve().parents[1] / 'docs/release-status.json'
    blocked = check(status)
    print(json.dumps({'release': 'public_multiuser', 'production_ready': not blocked,
                      'blocked_gates': blocked}, indent=2))
    sys.exit(bool(blocked))
