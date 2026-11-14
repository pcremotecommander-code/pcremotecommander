"""Single-operator outbound tunnel. Credentials stay in a mounted secret file."""
import os
from pathlib import Path
import re
import stat
import subprocess


def validate(environment, uid=None, secret_path=None):
    uid = os.geteuid() if uid is None else uid
    if uid == 0:
        raise ValueError('JAN cloud must run as a non-root user')
    identifier = environment.get('JAN_TUNNEL_ID', '')
    if not re.fullmatch(r'tunnel_[a-z0-9]{32}', identifier):
        raise ValueError('Set JAN_TUNNEL_ID to the tunnel ID from your OpenAI account')
    if environment.get('JAN_MCP_ALLOW_WRITES', '0') != '0':
        raise ValueError('This cloud profile is read-only. Use a reviewed custom deployment for writes')
    secret = Path(secret_path or '/run/secrets/tunnel_api_key')
    info = secret.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or not 1 <= info.st_size <= 4096:
        raise ValueError('A regular, nonempty tunnel runtime key secret file is required')
    # Mounted secret is opened by the tunnel client, not read into JAN's env.
    if not os.access(secret, os.R_OK):
        raise ValueError('Tunnel secret must be readable by UID 10001')
    return identifier


def main():
    os.umask(0o077)
    identifier = validate(os.environ)
    os.environ.update(JAN_MCP_WORKSPACE='/workspace', JAN_MCP_STATE_DIR='/state', JAN_MCP_ALLOW_WRITES='0', HOME='/tmp/jan-home')  # nosec B108 -- fresh single-user container tmpfs; umask 077
    Path(os.environ['HOME']).mkdir(mode=0o700, exist_ok=True)
    from jan_mcp_commander.portable import PortableCommander
    commander = PortableCommander(Path('/workspace'))
    commander.status()  # Verify workspace/state/audit availability before connecting.
    profile_dir = '/tmp/jan-profiles'  # nosec B108 -- fresh single-user container tmpfs; umask 077
    binary = '/opt/tunnel/tunnel-client'
    subprocess.run([binary, 'init', '--profile-dir', profile_dir, '--profile', 'jan-cloud',
        '--force', '--tunnel-id', identifier, '--sample', 'sample_mcp_stdio_local',
        '--mcp-command', '/opt/venv/bin/python -m jan_mcp_commander.server',
        '--control-plane-api-key-ref', 'file:/run/secrets/tunnel_api_key',
        '--health-listen-addr', '127.0.0.1:8080'], check=True, timeout=30)
    # Explicit environment prevents ambient client flags from changing origin,
    # secret source, transport, listener, or admin settings.
    keep = {'PATH', 'HOME', 'JAN_MCP_WORKSPACE', 'JAN_MCP_STATE_DIR',
            'JAN_MCP_ALLOW_WRITES', 'PYTHONDONTWRITEBYTECODE', 'PYTHONUNBUFFERED'}
    env = {k: v for k, v in os.environ.items() if k in keep}
    os.execve(binary, [binary, 'run', '--profile-dir', profile_dir, '--profile', 'jan-cloud'], env)

if __name__ == '__main__':
    main()
