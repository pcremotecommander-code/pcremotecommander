"""Own the loopback origin and a checksum-pinned, outbound-only Quick Tunnel.

No user OAuth tokens or origin credentials are passed on process command lines.
Quick Tunnels are temporary test infrastructure, not a production availability SLA.
"""
from __future__ import annotations
import argparse
from email.utils import parsedate_to_datetime
import hashlib
import hmac
import json
import os
from pathlib import Path
import platform
import queue
import re
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from .safe_fs import SafeTree
from .security import private_directory

VERSION = '2026.10.0-jan.1'
BUNDLE_DIR = Path(__file__).with_name('vendor')
ASSETS = {
    ('Linux', 'amd64'): ('cloudflared-linux-amd64', '35a8457b6ad29707d2390147c86ae9304040f8c6c9c03e8a1e1f62ceafde31f2'),
    ('Linux', 'arm64'): ('cloudflared-linux-arm64', 'f09a9c39fd32d7a3148550b35bbffc40e63ba1fdc5ce6bacc557ec4548c2fd46'),
    ('Windows', 'amd64'): ('cloudflared-windows-amd64.exe', '167cc255e0142a4fe2ebc3d5164dd792db2ded16dd798fad9149b674ebf6f608'),
}
MAX_DOWNLOAD = 100 * 1024 * 1024
URL_PATTERN = re.compile(r'https://[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com(?=[\s/]|$)')
WORKER_PATTERN = re.compile(r'https://[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev')


def asset():
    machine = platform.machine().lower()
    arch = {'x86_64':'amd64','amd64':'amd64','aarch64':'arm64','arm64':'arm64'}.get(machine, machine)
    try:
        return ASSETS[(platform.system(), arch)]
    except KeyError as exc:
        raise ValueError('Supported: Windows x64, Linux x64 and Linux arm64') from exc


def runtime_directory(commander):
    return private_directory(commander._store.path / 'cloudflare-runtime')


def binary(runtime, *, download=False):
    filename, digest = asset()
    name = VERSION + '-' + filename
    tree = SafeTree(runtime, internal=True)
    try:
        data = tree.read(name, MAX_DOWNLOAD)
    except FileNotFoundError:
        if not download:
            raise ValueError('Run jan-mcp-cloudflare --prepare first')
        # --prepare installs only the audited bytes bundled with this PCRC
        # release. No network fallback to the vulnerable vendor release.
        try:
            data = SafeTree(BUNDLE_DIR, internal=True).read(name, MAX_DOWNLOAD)
        except FileNotFoundError as exc:
            raise ValueError('Bundled security rebuild missing; extract or reinstall the complete PCRC release') from exc
        if hashlib.sha256(data).hexdigest() != digest:
            raise ValueError('Bundled tunnel checksum mismatch; nothing installed')
        tree.write(name, data)
    if hashlib.sha256(data).hexdigest() != digest:
        raise ValueError('Installed tunnel checksum mismatch; refusing execution')
    path = runtime / name
    if os.name == 'posix':
        path.chmod(0o700)
    return path


def clean_environment():
    # Drop ambient proxy/tunnel configuration and remote-write toggles.
    keep = {'PATH','SYSTEMROOT','WINDIR','COMSPEC','TEMP','TMP','TMPDIR','LANG','LC_ALL',
            'HOME','USERPROFILE','LOCALAPPDATA','APPDATA','SSL_CERT_FILE','SSL_CERT_DIR',
            'PROGRAMFILES','PROGRAMFILES(X86)','PROGRAMW6432','COMMONPROGRAMFILES','COMMONPROGRAMFILES(X86)'}
    env = {key:value for key,value in os.environ.items() if key.upper() in keep}
    env['JAN_MCP_ALLOW_WRITES'] = '0'
    env['WRANGLER_SEND_METRICS'] = 'false'
    return env


def command(binary_path, port):
    if type(port) is not int or not 1024 <= port <= 65535:
        raise ValueError('Use an unprivileged TCP port')
    return [str(binary_path), 'tunnel', '--no-autoupdate', '--metrics', '127.0.0.1:0',
            '--management-diagnostics=false', '--url', f'http://127.0.0.1:{port}',
            '--http-host-header', f'localhost:{port}', '--protocol', 'http2', '--loglevel', 'info']


def spawn(args, env, *, output=False, cwd=None):
    opts = {'creationflags':subprocess.CREATE_NEW_PROCESS_GROUP} if os.name == 'nt' else {'start_new_session':True}
    return subprocess.Popen(args, env=env, cwd=cwd, stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE if output else subprocess.DEVNULL, stderr=subprocess.STDOUT,
        text=True, encoding='utf-8', errors='replace', **opts)


def stop(process):
    if process is None or process.poll() is not None:
        return
    try:
        process.send_signal(signal.CTRL_BREAK_EVENT) if os.name == 'nt' else os.killpg(process.pid, signal.SIGTERM)
        process.wait(timeout=8)
    except (OSError, subprocess.TimeoutExpired):
        if os.name == 'nt':
            # Only this owned PID tree; no process-name termination.
            subprocess.run(['taskkill','/PID',str(process.pid),'/T','/F'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
        else:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        process.wait(timeout=5)
    finally:
        if process.stdout:
            process.stdout.close()


def local_health(port, token):
    # Never let an ambient HTTP_PROXY receive the loopback service credential.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    request = urllib.request.Request(f'http://127.0.0.1:{port}/healthz', headers={'Authorization':'Bearer '+token})
    try:
        with opener.open(request, timeout=1) as response:
            return response.status == 200 and json.loads(response.read(1024)).get('status') == 'ok'
    except (OSError, ValueError, urllib.error.URLError):
        return False


def tunnel_event(line):
    """Parse only public routing/readiness metadata, never relay raw logs."""
    line = line[:8192]
    metrics = re.search(r'Starting metrics server on 127\.0\.0\.1:([0-9]{1,5})/metrics', line)
    if metrics and 1024 <= int(metrics.group(1)) <= 65535:
        return ('metrics', f'http://127.0.0.1:{metrics.group(1)}/ready')
    match = URL_PATTERN.search(line)
    if match:
        return ('origin', match.group(0))
    return None


def tunnel_ready(endpoint):
    if not re.fullmatch(r'http://127\.0\.0\.1:[0-9]{4,5}/ready', endpoint):
        return False
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(endpoint, timeout=1) as response:
            return response.status == 200
    except (OSError, ValueError, urllib.error.URLError):
        return False


def public_origin_ready(origin):
    """Prove public ingress reaches PCRC's auth guard without sending a key."""
    if not URL_PATTERN.fullmatch(origin):
        return False
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    request = urllib.request.Request(origin + '/mcp', data=b'{}',
        headers={'Content-Type':'application/json'})
    try:
        with opener.open(request, timeout=3):
            return False  # An unauthenticated success would violate the contract.
    except urllib.error.HTTPError as exc:
        try:
            return exc.code == 401 and exc.headers.get('WWW-Authenticate') == 'Bearer realm="PCRC local origin"'
        finally:
            exc.close()
    except (OSError, ValueError, urllib.error.URLError):
        return False


def register_origin(worker, origin, token, *, timestamp=None):
    """Publish only a verified Quick Tunnel using the existing private origin key."""
    if not WORKER_PATTERN.fullmatch(worker) or not URL_PATTERN.fullmatch(origin):
        raise ValueError('Invalid Worker or tunnel origin')
    # Dual-boot hosts can retain a wrong wall clock after changing OSes.
    # Bootstrap time over TLS from the exact Worker before signing anything.
    stamp = worker_timestamp(worker) if timestamp is None else timestamp
    if stamp is None:
        return False
    if type(stamp) is not int or stamp < 0:
        raise ValueError('Invalid registration timestamp')
    message = f'JAN_ORIGIN_V1\n{stamp}\n{origin}'.encode('ascii')
    signature = hmac.new(token.encode('ascii'), message, hashlib.sha256).hexdigest()
    payload = json.dumps({'origin':origin,'timestamp':stamp,'signature':signature}).encode('ascii')
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args):
            return None
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    request = urllib.request.Request(worker + '/jan-origin', data=payload,
        headers={'Content-Type':'application/json','User-Agent':'JAN-Commander/0.6.2'}, method='POST')
    try:
        with opener.open(request, timeout=5) as response:
            return response.status == 204
    except (OSError, ValueError, urllib.error.URLError):
        return False


def register_device_origin(worker, origin, token, device_id, owner_id, *, timestamp=None):
    """Renew one enrolled device without sharing its key with other devices."""
    if not WORKER_PATTERN.fullmatch(worker) or not URL_PATTERN.fullmatch(origin) or not re.fullmatch(r'[a-f0-9-]{36}', device_id) or not re.fullmatch(r'(?:[0-9]{1,20}|s-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})',owner_id):
        raise ValueError('Invalid device registration')
    stamp = worker_timestamp(worker) if timestamp is None else timestamp
    if type(stamp) is not int or stamp < 0:
        return None
    message = f'JAN_ORIGIN_V3\n{owner_id}\n{device_id}\n{stamp}\n{origin}'.encode('ascii')
    signature = hmac.new(token.encode('ascii'), message, hashlib.sha256).hexdigest()
    payload = json.dumps({'device_id':device_id,'owner_id':owner_id,'origin':origin,'timestamp':stamp,'signature':signature}).encode('ascii')
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args):
            return None
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    request = urllib.request.Request(worker + '/jan-device-origin', data=payload,
        headers={'Content-Type':'application/json','User-Agent':'JAN-Commander/0.7'}, method='POST')
    try:
        with opener.open(request, timeout=5) as response:
            if response.status != 200:
                return None
            value = json.loads(response.read(128))
            return value['active'] if type(value.get('active')) is bool else None
    except (OSError, ValueError, KeyError, urllib.error.URLError):
        return None


def worker_timestamp(worker):
    """Get a fresh HTTP Date and verify this is PCRC's configured Worker."""
    if not WORKER_PATTERN.fullmatch(worker):
        return None
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args):
            return None
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    request = urllib.request.Request(worker + '/.well-known/oauth-protected-resource/mcp',
        headers={'User-Agent':'JAN-Commander/0.6.2','Cache-Control':'no-store'})
    try:
        with opener.open(request, timeout=5) as response:
            if response.status != 200 or json.loads(response.read(1024)).get('resource') != worker + '/mcp':
                return None
            date = parsedate_to_datetime(response.headers['Date'])
            if date.tzinfo is None or date.utcoffset().total_seconds() != 0:
                return None
            return int(date.timestamp())
    except (OSError, ValueError, TypeError, KeyError, IndexError, urllib.error.URLError):
        return None


def _windows_elevated():
    import win32api
    import win32con
    import win32security
    token = win32security.OpenProcessToken(win32api.GetCurrentProcess(), win32con.TOKEN_QUERY)
    try:
        return bool(win32security.GetTokenInformation(token, win32security.TokenElevation))
    finally:
        token.Close()


def require_standard_user():
    """Refuse public transport under root/elevation; failure to inspect also denies."""
    try:
        system = platform.system()
        if system == 'Windows':
            elevated = _windows_elevated()
        elif system == 'Linux':
            elevated = os.geteuid() == 0
        else:
            raise RuntimeError('Unsupported privilege inspection platform')
    except Exception as exc:
        raise RuntimeError('Cannot verify process privileges; public tunnel was not started') from exc
    if elevated:
        raise ValueError('Start PCRC Cloudflare from a standard-user terminal, without administrator elevation or sudo; public tunnel was not started')


def run(workspace, port, *, control_capabilities=None, duration_minutes=60, headless=False, browser_channel='chromium', show_call_details=False, auto_origin=None):
    from .http_server import prepare_backend
    require_standard_user()
    if auto_origin is not None and not WORKER_PATTERN.fullmatch(auto_origin):
        raise ValueError('Use an exact HTTPS workers.dev origin for automatic registration')
    commander, token, _ = prepare_backend(workspace)
    try:
        device = json.loads(commander._store.tree.read('device-session.json', 1024))
    except FileNotFoundError:
        device = None
    if device is not None and (not isinstance(device, dict) or
        not re.fullmatch(r'[a-f0-9-]{36}', str(device.get('id',''))) or
        not WORKER_PATTERN.fullmatch(str(device.get('worker',''))) or
        not re.fullmatch(r'(?:[0-9]{1,20}|s-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})',str(device.get('owner_id','')))):
        raise ValueError('Invalid private device session')
    if device and auto_origin and device['worker'] != auto_origin:
        raise ValueError('Enrolled device Worker does not match --auto-origin')
    if device and not auto_origin:
        raise ValueError('An enrolled device requires its paired Worker --auto-origin')
    runtime = runtime_directory(commander)
    executable = binary(runtime)
    # Preflight prevents trusting a different already-running service on this port.
    import socket
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', port))
    env = clean_environment()
    env['JAN_MCP_WORKSPACE'] = str(workspace)
    env['JAN_MCP_STATE_DIR'] = str(commander._store.path)
    env['JAN_REMOTE_LIVE_EVENTS'] = '1'
    if show_call_details:
        env['JAN_REMOTE_LIVE_DETAILS'] = '1'
    origin_args = [sys.executable,'-I','-m','jan_mcp_commander.http_server','--workspace',str(workspace),'--port',str(port)]
    if control_capabilities:
        from .control import CAPABILITIES
        if not frozenset(control_capabilities) <= CAPABILITIES:
            raise ValueError('Invalid control capabilities')
        origin_args = [sys.executable,'-I','-m','jan_mcp_commander.control','--workspace',str(workspace),
                       '--port',str(port),'--transport','http','--capabilities',','.join(sorted(control_capabilities)),
                       '--duration-minutes',str(duration_minutes),'--browser-channel',browser_channel]
        if headless:
            origin_args.append('--headless')
        # GUI access is propagated only to the explicitly selected control origin.
        for key in ('DISPLAY', 'XAUTHORITY', 'XDG_SESSION_TYPE', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR'):
            if key in os.environ:
                env[key] = os.environ[key]
    origin = tunnel = None
    events = queue.Queue(maxsize=8)
    def read_lines(process):
        try:
            for line in process.stdout:
                event = tunnel_event(line)
                if event:
                    try:
                        events.put_nowait(event)
                    except queue.Full:
                        pass
        except (OSError, ValueError):
            pass
    def read_origin_events(process):
        try:
            for line in process.stdout:
                if not line.startswith('JAN_EVENT ') or len(line)>8192:
                    continue
                try:
                    event=json.loads(line[10:])
                except ValueError:
                    continue
                if not isinstance(event,dict) or not isinstance(event.get('tool'),str) or not re.fullmatch(r'jan_[a-z_]{1,40}',event['tool']):
                    continue
                if set(event)=={'tool','status'} and event['status'] in ('completed','denied','failed'):
                    print(f"  [PCRC] {event['tool']}: {event['status']}",flush=True)
                elif (show_call_details and set(event)=={'tool','phase','call_id','data'} and
                      event['phase'] in ('received','completed','denied','failed') and
                      isinstance(event['call_id'],str) and re.fullmatch(r'[a-f0-9]{32}',event['call_id'])):
                    label='Received tool call' if event['phase']=='received' else 'Tool call '+event['phase']
                    print(f"  [PCRC] {label} {event['call_id']}: {event['tool']} {json.dumps(event['data'],ensure_ascii=True)}",flush=True)
        except (OSError, ValueError):
            pass
    try:
        origin = spawn(origin_args, env, output=True)
        threading.Thread(target=read_origin_events, args=(origin,), daemon=True).start()
        for _ in range(60):
            if origin.poll() is not None:
                raise RuntimeError('Local HTTP origin exited; run Start-HTTP to inspect configuration')
            if local_health(port, token):
                break
            time.sleep(0.2)
        else:
            raise RuntimeError('Local HTTP origin did not become healthy')
        print('  [PCRC] Local MCP origin: ready', flush=True)
        # Existing user .cloudflared config is neither read nor changed.
        tunnel_env = dict(env, HOME=str(runtime), USERPROFILE=str(runtime))
        tunnel_env.pop('JAN_MCP_WORKSPACE', None)
        tunnel = spawn(command(executable, port), tunnel_env, output=True, cwd=runtime)
        threading.Thread(target=read_lines, args=(tunnel,), daemon=True).start()
        deadline = time.monotonic() + 90
        published = False
        url = ready_endpoint = None
        last_ready = None
        last_public = None
        last_public_check = 0
        last_check = 0
        last_registration = 0
        registered = False
        last_active = None
        print('Starting outbound Cloudflare Quick Tunnel. Keep this window open.', flush=True)
        while origin.poll() is None and tunnel.poll() is None:
            try:
                kind, value = events.get(timeout=0.25)
                if kind == 'origin':
                    url = value
                elif kind == 'metrics':
                    ready_endpoint = value
            except queue.Empty:
                pass
            if ready_endpoint and time.monotonic() - last_check >= 2:
                last_check = time.monotonic()
                ready = tunnel_ready(ready_endpoint)
                if url and ready and time.monotonic()-last_public_check >= (15 if published else 2):
                    last_public_check = time.monotonic()
                    public = public_origin_ready(url)
                    if published and public != last_public:
                        print(json.dumps({'public_origin_ready':public,'remote_connected':False,
                            'note':'Public PCRC auth guard reachable' if public else 'Public route unavailable despite connector readiness; Cloudflare may return 1033'}), flush=True)
                    last_public = public
                if url and ready and last_public and not published:
                    commander._store.tree.write('cloudflare-origin.json', json.dumps({'origin':url,'recorded_at':int(time.time()),'connector_ready':True,'public_origin_ready':True,'remote_connected':False}).encode(), overwrite=True)
                    print('  [PCRC] Outbound tunnel: connected',flush=True)
                    print('  [PCRC] Public origin auth guard: reachable',flush=True)
                    next_step = ('Wait for Worker origin synchronization, then use the existing ChatGPT /mcp connection.'
                                 if auto_origin else 'Update Worker JAN_ORIGIN and deploy. Connect ChatGPT to the Worker /mcp URL.')
                    print(json.dumps({'origin':url,'connector_ready':True,'public_origin_ready':True,'next':next_step,'remote_connected':False}), flush=True)
                    published = True
                if auto_origin and url and ready and last_public and time.monotonic()-last_registration >= (45 if registered else 15):
                    last_registration = time.monotonic()
                    active = register_device_origin(auto_origin, url, token, device['id'],device['owner_id']) if device else None
                    accepted = active is not None if device else register_origin(auto_origin, url, token)
                    if accepted and not registered:
                        print('  [PCRC] Worker origin: synchronized', flush=True)
                        if device:
                            print(f"  [PCRC] User: {device['login']} (GitHub ID {device['owner_id']})\n  [PCRC] Device ID: {device['id']}\n  [PCRC] Device Name: {device['name']}\n  [PCRC] Status: {'Ready' if active else 'Online; select this device on the PCRC website'}", flush=True)
                    elif device and accepted and active != last_active:
                        print('  [PCRC] Status: '+('Ready' if active else 'Online; select this device on the PCRC website'),flush=True)
                    elif not accepted and registered:
                        print('  [PCRC] Worker origin: synchronization lost; retrying', flush=True)
                    elif not accepted:
                        print('  [PCRC] Worker origin: synchronization failed; retrying', flush=True)
                    registered = accepted
                    last_active = active
                elif published and ready != last_ready:
                    print(json.dumps({'connector_ready':ready,'remote_connected':False,
                        'note':'Connector recovered; OAuth/ChatGPT still unverified' if ready else 'Connector lost its Cloudflare connection; keep this window open while it reconnects'}), flush=True)
                last_ready = ready
            if not published and time.monotonic() > deadline:
                raise RuntimeError('Quick Tunnel readiness failed: connector and public PCRC auth guard must both be reachable. Check Cloudflare routing/network status and outbound TCP 7844.')
        raise RuntimeError('Origin or tunnel exited; both services have been stopped')
    finally:
        stop(tunnel)
        stop(origin)


def upload_key(workspace, worker, config=None):
    """An operator-triggered upload over Wrangler stdin; never argv or stdout."""
    from .http_server import prepare_backend
    _, token, _ = prepare_backend(workspace)
    worker = Path(worker).resolve(strict=True)
    script = worker / 'node_modules/wrangler/bin/wrangler.js'
    if not script.is_file():
        raise ValueError('Run npm ci --ignore-scripts in the Worker directory first')
    import shutil
    node = shutil.which('node')
    if not node:
        raise ValueError('Node.js is required for the Worker deployment')
    args = [node,str(script),'secret','put','JAN_PROXY_KEY']
    if config:
        selected = Path(config).resolve(strict=True)
        args += ['--config',str(selected)]
    result = subprocess.run(args, cwd=worker, input=token+'\n', text=True, capture_output=True,
        env=dict(os.environ, WRANGLER_SEND_METRICS='false'), timeout=120, check=False)
    if result.returncode:
        raise RuntimeError('Secret upload failed. Check Wrangler login and deployment configuration; secret was not printed.')
    print('Private origin key uploaded to your Worker. No secret printed.')


def main(argv=None):
    parser = argparse.ArgumentParser(description='PCRC Cloudflare transport (temporary Quick Tunnel)')
    parser.add_argument('--workspace')
    parser.add_argument('--port', type=int, default=8866)
    parser.add_argument('--prepare', action='store_true', help='Create private key and install the bundled checksum-pinned PCRC security rebuild')
    parser.add_argument('--upload-key', metavar='WORKER_DIRECTORY', help='Upload private origin key to your configured Worker through Wrangler stdin')
    parser.add_argument('--config', help='Wrangler config for --upload-key')
    args = parser.parse_args(argv)
    if not 1024 <= args.port <= 65535:
        parser.error('Use an unprivileged TCP port')
    if args.prepare and args.upload_key:
        parser.error('Use --prepare or --upload-key separately')
    from .cli import workspace_path
    try:
        workspace = workspace_path(args.workspace).resolve(strict=True)
        if args.prepare:
            from .http_server import prepare_backend
            commander, _, _ = prepare_backend(workspace, initialize=True)
            installed = binary(runtime_directory(commander), download=True)
            print(json.dumps({'prepared':True,'tunnel_version':VERSION,'binary':str(installed),'remote_connected':False}))
        elif args.upload_key:
            upload_key(workspace, args.upload_key, args.config)
        else:
            run(workspace, args.port)
        return 0
    except KeyboardInterrupt:
        print('PCRC HTTP origin and tunnel stopped.')
        return 0
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as exc:
        print('PCRC Cloudflare: '+str(exc), file=sys.stderr)
        return 1

if __name__ == '__main__':
    raise SystemExit(main())
