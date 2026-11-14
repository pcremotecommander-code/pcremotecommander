"""Local private-state verification. Does not certify remote production readiness."""
import argparse
import hashlib
import hmac
import json
from pathlib import Path
from jan_mcp_commander.cli import workspace_path
from jan_mcp_commander.portable import PortableCommander
from jan_mcp_commander.security import AUDIT_LIMIT


def verify_audit(commander):
    try:
        data = commander._store.tree.read('audit.jsonl', AUDIT_LIMIT)
    except FileNotFoundError:
        return True
    for line in data.splitlines():
        try:
            record = json.loads(line)
            tag = record.pop('hmac_sha256')
            body = json.dumps(record, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode()
            expected = hmac.new(commander._store.audit_key, body, hashlib.sha256).hexdigest()
            if not hmac.compare_digest(tag, expected):
                return False
        except (ValueError, KeyError, TypeError):
            return False
    return True

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--workspace')
    args = parser.parse_args()
    try:
        cmd = PortableCommander(workspace_path(args.workspace))
        intact = verify_audit(cmd)
        print(json.dumps({'local_audit_records_authenticated': intact,
            'read_only': not cmd.allow_writes, 'private_state_initialized': True,
            'legacy_plaintext_backups_present': (cmd.workspace / '.jan-mcp-backups').exists(),
            'live_remote_verified': False, 'production_ready': False}, indent=2))
        raise SystemExit(0 if intact else 1)
    except (ValueError, OSError):
        print(json.dumps({'local_security_check_passed': False, 'production_ready': False}))
        raise SystemExit(1)
