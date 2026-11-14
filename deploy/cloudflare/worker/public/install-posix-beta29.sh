#!/usr/bin/env bash
(
set -euo pipefail
umask 077
case "$(uname -s)" in
  Linux|Darwin) ;;
  *) printf '%s\n' 'Use this installer on Linux or macOS.' >&2; exit 1 ;;
esac
if [[ "$EUID" == 0 ]]; then
  printf '%s\n' 'Run setup as your regular user, without sudo.' >&2
  exit 1
fi
if [[ $# == 0 ]]; then set -- setup; fi
case "$1" in setup|--doctor|--uninstall|--cli) ;; *) printf '%s\n' 'Usage: setup [--doctor|--uninstall|--cli CLI_ARGUMENTS...]' >&2; exit 1 ;; esac
if [[ $# -gt 1 && "$1" != --cli ]]; then printf '%s\n' 'Use one installer action at a time.' >&2; exit 1; fi
pcrc_python=python3
if ! command -v python3 >/dev/null || ! python3 -I -c 'import sys, venv, ensurepip, ssl; sys.exit(sys.version_info < (3, 11))'; then
  # Original upstream interpreter only; never install system packages or use sudo.
  case "$(uname -s):$(uname -m)" in
    Linux:x86_64) pcrc_python_target=x86_64-unknown-linux-gnu; pcrc_python_sha=df15fe60d3ff55bf9dcf25824b5572756bb8816ff93865a273d3301d7066a8b7 ;;
    Linux:aarch64|Linux:arm64) pcrc_python_target=aarch64-unknown-linux-gnu; pcrc_python_sha=578d9da1983463ffb0c8c98ab0da2f18177f44069328eb0af847860c1eb05c3e ;;
    Darwin:x86_64) pcrc_python_target=x86_64-apple-darwin; pcrc_python_sha=7412c19d896c99431b74a18a5643e110449a7f9590fbab179c3e5ab27b9aa9e3 ;;
    Darwin:arm64) pcrc_python_target=aarch64-apple-darwin; pcrc_python_sha=8392b6ea51d94391befb2c31ebe75463f045d0b69dfcf5e1bb3234e1f5fa3405 ;;
    *) printf '%s\n' 'Install Python 3.11+ with venv for this CPU/OS and retry.' >&2; exit 1 ;;
  esac
  command -v curl >/dev/null && command -v tar >/dev/null || { printf '%s\n' 'Setup needs curl and tar to prepare Python.' >&2; exit 1; }
  if command -v sha256sum >/dev/null; then pcrc_sha_command=sha256sum
  elif command -v shasum >/dev/null; then pcrc_sha_command=shasum
  else printf '%s\n' 'Setup needs sha256sum or shasum for integrity verification.' >&2; exit 1; fi
  pcrc_home="$(cd -- "$HOME" && pwd -P)"
  for pcrc_directory in "$pcrc_home/.pcrc" "$pcrc_home/.pcrc/tools"; do
    [[ ! -L "$pcrc_directory" && ( ! -e "$pcrc_directory" || ( -d "$pcrc_directory" && -O "$pcrc_directory" ) ) ]] || { printf '%s\n' 'Unsafe user runtime directory.' >&2; exit 1; }
    mkdir -p -- "$pcrc_directory"
    chmod 700 -- "$pcrc_directory"
  done
  pcrc_tools="$pcrc_home/.pcrc/tools"
  pcrc_python_root="$pcrc_tools/python-3.13.18-20261026-$pcrc_python_target"
  pcrc_python_lock="$pcrc_tools/.python-bootstrap.lock"
  pcrc_lock_owned=0
  pcrc_bootstrap_tmp=''
  pcrc_python_cleanup() {
    if [[ -n "$pcrc_bootstrap_tmp" && "$pcrc_bootstrap_tmp" == "$pcrc_tools"/.python-download.* && ! -L "$pcrc_bootstrap_tmp" ]]; then rm -rf -- "$pcrc_bootstrap_tmp"; fi
    if [[ "$pcrc_lock_owned" == 1 ]]; then rmdir -- "$pcrc_python_lock"; fi
  }
  trap pcrc_python_cleanup EXIT
  pcrc_wait=0
  until mkdir -- "$pcrc_python_lock" 2>/dev/null; do
    [[ ! -L "$pcrc_python_lock" && -d "$pcrc_python_lock" && "$pcrc_wait" -lt 120 ]] || { printf '%s\n' 'Python setup is already running or its lock needs inspection. Retry after it finishes.' >&2; exit 1; }
    sleep 1; pcrc_wait=$((pcrc_wait + 1))
  done
  pcrc_lock_owned=1
  [[ ! -L "$pcrc_python_root" && ( ! -e "$pcrc_python_root" || -d "$pcrc_python_root" ) ]] || { printf '%s\n' 'Unsafe Python runtime path.' >&2; exit 1; }
  if [[ ! -d "$pcrc_python_root" ]]; then
    pcrc_bootstrap_tmp="$(mktemp -d "$pcrc_tools/.python-download.XXXXXX")"
    pcrc_python_archive="$pcrc_bootstrap_tmp/python.tar.gz"
    printf '%s\n' 'Preparing checksum-verified Python under your user account...'
    curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --connect-timeout 15 --max-time 180 --max-filesize 104857600 "https://github.com/astral-sh/python-build-standalone/releases/download/20261026/cpython-3.13.18%2B20261026-$pcrc_python_target-install_only_stripped.tar.gz" --output "$pcrc_python_archive"
    if [[ "$pcrc_sha_command" == shasum ]]; then pcrc_actual_sha="$(shasum -a 256 "$pcrc_python_archive")"; else pcrc_actual_sha="$(sha256sum "$pcrc_python_archive")"; fi
    [[ "${pcrc_actual_sha%% *}" == "$pcrc_python_sha" ]] || { printf '%s\n' 'Python download failed integrity verification.' >&2; exit 1; }
    tar -tzf "$pcrc_python_archive" > "$pcrc_bootstrap_tmp/paths"
    awk 'BEGIN{ok=1} !/^python(\/|$)/ || /(^|\/)\.\.(\/|$)/ || /\\/ || /[[:cntrl:]]/ {ok=0} END{exit !(ok && NR>0 && NR<50000)}' "$pcrc_bootstrap_tmp/paths" || { printf '%s\n' 'Python archive contains an unsafe path.' >&2; exit 1; }
    tar -tvzf "$pcrc_python_archive" > "$pcrc_bootstrap_tmp/details"
    awk 'substr($1,1,1)!="-" && substr($1,1,1)!="d" && substr($1,1,1)!="l" {bad=1} / -> / {target=$0;sub(/^.* -> /,"",target);if(target ~ /^\// || target ~ /(^|\/)\.\.(\/|$)/ || target ~ /\\/)bad=1} END{exit bad}' "$pcrc_bootstrap_tmp/details" || { printf '%s\n' 'Python archive contains an unsafe link or special file.' >&2; exit 1; }
    mkdir -- "$pcrc_bootstrap_tmp/extracted"
    tar -xzf "$pcrc_python_archive" -C "$pcrc_bootstrap_tmp/extracted" --no-same-owner
    [[ -d "$pcrc_bootstrap_tmp/extracted/python" && ! -L "$pcrc_bootstrap_tmp/extracted/python" && -x "$pcrc_bootstrap_tmp/extracted/python/bin/python3.13" && ! -L "$pcrc_bootstrap_tmp/extracted/python/bin/python3.13" ]] || { printf '%s\n' 'Python archive is missing its interpreter.' >&2; exit 1; }
    "$pcrc_bootstrap_tmp/extracted/python/bin/python3.13" -I -c 'import sys, venv, ensurepip, ssl; sys.exit(sys.version_info < (3, 11))' || { printf '%s\n' 'This Python runtime is incompatible with your OS. Install Python 3.11+ and retry.' >&2; exit 1; }
    mv -- "$pcrc_bootstrap_tmp/extracted/python" "$pcrc_python_root"
  fi
  pcrc_python="$pcrc_python_root/bin/python3.13"
  [[ ! -L "$pcrc_python" && -x "$pcrc_python" ]] && "$pcrc_python" -I -c 'import sys, venv, ensurepip, ssl; sys.exit(sys.version_info < (3, 11))' || { printf '%s\n' 'Cached Python is unavailable or incompatible. Inspect its user runtime directory before retrying.' >&2; exit 1; }
  export PATH="$pcrc_python_root/bin:$PATH"
  pcrc_python_cleanup
  pcrc_bootstrap_tmp=''; pcrc_lock_owned=0
  trap - EXIT
fi
if ! command -v npm >/dev/null || ! command -v node >/dev/null || ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) < 20 ? 1 : 0)'; then
  export PCRC_BOOTSTRAP_NODE=1
fi
exec "$pcrc_python" -I - '0.7.0-beta.29' 'c27f20c4b40155d0f8041081eb8b4dccbf9e1e37da7a69bf5861390840d01451' "$@" <<'PY'
import fcntl
import hashlib
import io
import os
from pathlib import Path, PurePosixPath
import shutil
import stat
import subprocess
import sys
import tempfile
import platform
import tarfile
import json
from urllib.request import urlopen
from zipfile import ZipFile

version, expected, action, *action_args = sys.argv[1:]
home = Path.home().resolve()
pcrc = home / '.pcrc'
base = pcrc / 'releases'
for path in (pcrc, base):
    if path.is_symlink() or path.exists() and not path.is_dir():
        sys.exit('PCRC installation path must be a normal directory.')
base.mkdir(parents=True, exist_ok=True, mode=0o700)
target = base / (version + '-' + expected[:12])
marker = target / '.setup-complete'
variant = 'desktop' if os.environ.get('PCRC_DESKTOP') == '1' else 'standard'
workspace_file = pcrc / 'workspace.json'
def saved_workspace(path, *, strict=False):
    if path.is_symlink():
        sys.exit('Unsafe workspace configuration. Nothing was removed.')
    if not path.exists():
        return None
    if not path.is_file() or path.stat().st_nlink != 1 or path.stat().st_size > 4096:
        sys.exit('Invalid workspace configuration. Nothing was removed.')
    if strict and os.name == 'posix' and (path.stat().st_uid != os.getuid() or path.stat().st_mode & 0o077):
        sys.exit('Workspace setting must be private to your user account.')
    try:
        value = json.loads(path.read_text(encoding='utf-8-sig'))
        if (not isinstance(value, dict) or not isinstance(value.get('workspace'), str)
                or strict and set(value) != {'workspace'} or not Path(value['workspace']).is_absolute()):
            raise ValueError()
        return Path(value['workspace']).expanduser().resolve()
    except (OSError, ValueError, UnicodeError):
        sys.exit('Invalid workspace configuration. Nothing was removed.')

with os.fdopen(os.open(base / '.install.lock', os.O_CREAT | os.O_APPEND | os.O_WRONLY | getattr(os, 'O_NOFOLLOW', 0), 0o600), 'a') as lock:
    lock_info = os.fstat(lock.fileno())
    if not stat.S_ISREG(lock_info.st_mode) or lock_info.st_nlink != 1:
        sys.exit('Unsafe PCRC installation lock.')
    fcntl.flock(lock, fcntl.LOCK_EX)
    if target.is_symlink() or target.resolve().parent != base.resolve():
        sys.exit('Unsafe PCRC release path.')
    if marker.is_symlink() or marker.exists() and (not marker.is_file() or marker.stat().st_nlink != 1):
        sys.exit('Unsafe PCRC installation marker.')
    prior_workspace = saved_workspace(workspace_file, strict=True)
    current_workspace = saved_workspace(target / 'connection.json')
    if action == '--uninstall':
        if any(workspace is not None and workspace.is_relative_to(target.resolve()) for workspace in (current_workspace, prior_workspace)):
            sys.exit('Removal refused: this release contains your configured workspace. Move it yourself after backing up and update the workspace setting first. Nothing was removed.')
        if target.exists():
            shutil.rmtree(target)
        print('PCRC version removed. Workspace files, saved pairing and shared Node tools were preserved. Revoke the device in your dashboard to remove its access.')
        sys.exit(0)
    requested = os.environ.get('JAN_MCP_WORKSPACE')
    workspace = Path(requested).expanduser().resolve() if requested else current_workspace or prior_workspace or home / 'PCRC-Workspace'
    if workspace.is_relative_to(pcrc.resolve()) or pcrc.resolve().is_relative_to(workspace):
        sys.exit('Keep the approved workspace separate from the PCRC installation directory.')
    if action == '--doctor' and not marker.is_file():
        sys.exit('This PCRC version is not installed. Run setup first.')
    if os.environ.get('PCRC_BOOTSTRAP_NODE') == '1':
        pins = {
            ('Linux', 'x86_64'): ('linux-x64', '855d581f8a4eb1a8117e3426de25fe02770592febcfb31369aee1ffbfee9e8ec'),
            ('Linux', 'aarch64'): ('linux-arm64', '3515603e2487879a39bc75716f1a2affd027500c64ba50e845cf72cb33219013'),
            ('Darwin', 'x86_64'): ('darwin-x64', '9e5b2644cf107befb6aefca676b96d3296bc10138096f022ed378d6233ed81f4'),
            ('Darwin', 'arm64'): ('darwin-arm64', '40e5607e5ecb3db9192723776da2d75d966260fc74a7a9e731c1bd67dda96bc8'),
        }
        selected = pins.get((platform.system(), platform.machine()))
        if not selected:
            sys.exit('Install Node.js 20+ with npm for this CPU/OS, then retry PCRC.')
        variant_node, node_sha = selected
        tools = pcrc / 'tools'
        if tools.is_symlink():
            sys.exit('Unsafe PCRC tools directory.')
        tools.mkdir(mode=0o700, exist_ok=True)
        name = 'node-v24.20.0-' + variant_node
        node_root = tools / name
        if node_root.is_symlink():
            sys.exit('Unsafe Node.js installation directory.')
        if not node_root.exists():
            node_url = 'https://nodejs.org/dist/v24.20.0/' + name + '.tar.gz'
            print('Preparing a checksum-verified Node.js runtime under your user account...', flush=True)
            with urlopen(node_url, timeout=60) as response:
                if response.url != node_url:
                    sys.exit('Unexpected Node.js download redirect.')
                node_data = response.read(100 * 1024 * 1024 + 1)
            if len(node_data) > 100 * 1024 * 1024 or hashlib.sha256(node_data).hexdigest() != node_sha:
                sys.exit('Node.js download failed integrity verification.')
            with tempfile.TemporaryDirectory(prefix='.node-', dir=tools) as temporary, tarfile.open(fileobj=io.BytesIO(node_data), mode='r:gz') as archive:
                members = archive.getmembers()
                if len(members) > 20000 or sum(item.size for item in members) > 512 * 1024 * 1024:
                    sys.exit('Node.js archive exceeds extraction limits.')
                seen = set()
                for item in members:
                    path = PurePosixPath(item.name)
                    if not path.parts or path.parts[0] != name or path.is_absolute() or '..' in path.parts or chr(92) in item.name or ':' in item.name or item.name.casefold() in seen:
                        sys.exit('Node.js archive contains an unsafe path.')
                    seen.add(item.name.casefold())
                    destination = Path(temporary).joinpath(*path.parts)
                    if item.isdir():
                        destination.mkdir(parents=True, exist_ok=True)
                    elif item.isfile():
                        destination.parent.mkdir(parents=True, exist_ok=True)
                        with archive.extractfile(item) as source, destination.open('xb') as output:
                            shutil.copyfileobj(source, output)
                        destination.chmod(0o755 if item.mode & 0o111 else 0o644)
                    elif not item.issym():
                        sys.exit('Node.js archive contains an unsupported entry.')
                extracted = Path(temporary) / name
                for required in ('bin/node','lib/node_modules/npm/bin/npm-cli.js','lib/node_modules/npm/bin/npx-cli.js'):
                    if not (extracted / required).is_file():
                        sys.exit('Node.js archive is missing required runtime files.')
                for executable in ('npm', 'npx'):
                    (extracted / 'bin' / executable).symlink_to('../lib/node_modules/npm/bin/' + executable + '-cli.js')
                extracted.rename(node_root)
        os.environ['PATH'] = str(node_root / 'bin') + os.pathsep + os.environ.get('PATH', '')
        try:
            subprocess.run(['node', '-e', 'process.exit(Number(process.versions.node.split(".")[0]) < 20 ? 1 : 0)'], check=True, timeout=5)
        except (OSError, subprocess.SubprocessError):
            sys.exit('The user-scoped Node.js runtime cannot run on this OS. Install a compatible Node.js 20+ distribution and retry.')
    if action == '--doctor':
        os.chdir(target)
        os.execvp('node', ['node', 'deploy/npm/jan-commander/bin/doctor.cjs'])
    if not target.exists():
        url = f'https://pc-remote-commander.pcremotecommander.workers.dev/downloads/posix/pcremotecommander-{version}-posix.zip'
        with urlopen(url, timeout=30) as response:
            if response.url != url:
                sys.exit('Unexpected PCRC download redirect.')
            payload = response.read(8 * 1024 * 1024 + 1)
        if len(payload) > 8 * 1024 * 1024 or hashlib.sha256(payload).hexdigest() != expected:
            sys.exit('PCRC package failed integrity verification.')
        with tempfile.TemporaryDirectory(prefix='.extract-', dir=base) as temporary, ZipFile(io.BytesIO(payload)) as archive:
            entries = archive.infolist()
            if len(entries) > 1000 or sum(entry.file_size for entry in entries) > 24 * 1024 * 1024:
                sys.exit('PCRC package exceeds its extraction limits.')
            seen = set()
            for entry in entries:
                name = PurePosixPath(entry.filename)
                key = name.as_posix().casefold()
                if (name.is_absolute() or any(part in ('..', '.') for part in name.parts)
                        or not name.parts or chr(92) in entry.filename or ':' in entry.filename
                        or stat.S_ISLNK(entry.external_attr >> 16) or key in seen or entry.is_dir()):
                    sys.exit('PCRC package contains an unsafe path.')
                seen.add(key)
                destination = Path(temporary).joinpath(*name.parts)
                destination.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(entry) as source, destination.open('xb') as output:
                    shutil.copyfileobj(source, output)
            Path(temporary).rename(target)
    installed = marker.read_text(encoding='utf-8') if marker.is_file() else ''
    if installed != variant and installed != 'desktop':
        subprocess.run(['bash', 'setup-linux.sh', str(workspace)], cwd=target, stdin=subprocess.DEVNULL, check=True)
        marker.write_text(variant, encoding='utf-8')
    configured = saved_workspace(target / 'connection.json')
    if configured is None or configured.is_relative_to(pcrc.resolve()) or pcrc.resolve().is_relative_to(configured):
        sys.exit('PCRC setup did not save a safe workspace configuration.')
    workspace.mkdir(parents=True, exist_ok=True)
    for destination in (target / 'connection.json', workspace_file):
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', prefix='.workspace-', dir=destination.parent, delete=False) as output:
            temporary_workspace = Path(output.name)
            output.write(json.dumps({'workspace': str(workspace)}))
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary_workspace, destination)
os.chdir(target)
try:
    with open('/dev/tty', 'rb') as terminal:
        os.dup2(terminal.fileno(), 0)
except OSError:
    pass
if action == '--cli':
    executable = str(target / '.venv/bin/python')
    os.execv(executable, [executable, '-m', 'jan_mcp_commander.cli', *action_args])
os.execvp('bash', ['bash', 'pcrc-connect.sh', *(['--desktop'] if variant == 'desktop' else [])])
PY
)
