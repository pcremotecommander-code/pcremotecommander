"""Cloudflare is a separate transport: never clear the old OpenAI tunnel gates."""
import json
from pathlib import Path
import sys
REQUIRED={'vendor_binary_findings_reviewed','worker_runtime_tests','windows_http_verified',
          'target_host_hardened','live_owner_oauth_verified','live_chatgpt_tools_verified',
          'live_disconnect_and_recovery_verified'}

def check(path):
    report=json.loads(Path(path).read_text())
    gates=report.get('cloudflare',{}).get('gates',{})
    return [name for name in sorted(REQUIRED) if gates.get(name,{}).get('passed') is not True or not gates.get(name,{}).get('evidence')]

if __name__=='__main__':
    blocked=check(Path(__file__).resolve().parents[1]/'docs/release-status.json')
    print(json.dumps({'transport':'cloudflare','production_ready':not blocked,'blocked_gates':blocked},indent=2))
    sys.exit(bool(blocked))
