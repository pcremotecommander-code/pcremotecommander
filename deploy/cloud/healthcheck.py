"""Health is loopback only and requires a successful control-plane poll."""
import subprocess
import sys

if __name__ == '__main__':
    result = subprocess.run(['/opt/tunnel/tunnel-client', 'health', '--url',
        'http://127.0.0.1:8080', '--require-control-plane-poll', '--json'],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=4)
    sys.exit(result.returncode)
