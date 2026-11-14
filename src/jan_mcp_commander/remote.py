"""Single local entry point for PCRC's existing Cloudflare remote transport."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys
import getpass
import platform
import re
import urllib.request
import webbrowser

from . import cloudflare


def configured_workspace(explicit: str | None) -> Path:
    """Remote startup must never create an implicit workspace."""
    chosen = explicit or os.environ.get('JAN_MCP_WORKSPACE')
    if not chosen:
        config = Path(__file__).resolve().parents[2] / 'connection.json'
        if config.is_file():
            data = json.loads(config.read_text(encoding='utf-8-sig'))
            if not isinstance(data, dict) or not isinstance(data.get('workspace'), str):
                raise ValueError('connection.json needs an existing workspace path')
            chosen = data['workspace']
    if not chosen:
        raise ValueError('Select an existing approved workspace with --workspace')
    workspace = Path(chosen).expanduser().resolve(strict=True)
    if not workspace.is_dir():
        raise ValueError('Workspace must be an existing directory')
    return workspace


def enroll(workspace: Path, worker: str, name: str | None = None) -> dict:
    """Claim a short-lived browser-issued code; keep credentials out of argv."""
    if not cloudflare.WORKER_PATTERN.fullmatch(worker):
        raise ValueError('Use an exact HTTPS workers.dev origin for enrollment')
    label = name or platform.node()[:64]
    if not re.fullmatch(r'[\w .-]{1,64}', label):
        raise ValueError('Device name must use letters, numbers, spaces, dots or hyphens')
    from .http_server import prepare_backend
    commander, _, _ = prepare_backend(workspace, initialize=True)
    store = commander._store
    with store.locked():
        try:
            store.tree.read('device-session.json', 1024)
        except FileNotFoundError:
            pass
        else:
            raise ValueError('This workspace is already enrolled; use its existing PCRC device session')
    cloudflare.binary(cloudflare.runtime_directory(commander), download=True)
    print('Opening your PCRC device website. Sign in there and choose Add a computer.',flush=True)
    webbrowser.open(worker+'/devices',new=2)
    code = getpass.getpass('Enter the one-time code shown on your PCRC website: ')
    if not re.fullmatch(r'[A-Za-z0-9_-]{43}', code):
        raise ValueError('Invalid enrollment code')
    payload = json.dumps({'code':code,'name':label}).encode('utf-8')
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args):
            return None
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    request = urllib.request.Request(worker+'/devices/claim', data=payload,
        headers={'Content-Type':'application/json','User-Agent':'JAN-Commander/0.7'}, method='POST')
    try:
        with opener.open(request, timeout=15) as response:
            if response.status != 200: raise ValueError('Enrollment denied')
            result = json.loads(response.read(1024))
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        raise ValueError('Enrollment expired or unavailable; create a new code on your PCRC website') from exc
    key, identifier, login, owner_id = result.get('key'), result.get('id'), result.get('login'), result.get('owner_id')
    if not isinstance(key,str) or not re.fullmatch(r'[A-Za-z0-9_-]{43}', key) or not isinstance(identifier,str) or not re.fullmatch(r'[a-f0-9-]{36}',identifier) or not isinstance(login,str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,100}',login) or not isinstance(owner_id,str) or not re.fullmatch(r'(?:[0-9]{1,20}|s-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})',owner_id):
        raise ValueError('Invalid enrollment response')
    session = {'id':identifier,'name':label,'login':login,'owner_id':owner_id,'worker':worker}
    with store.locked():
        previous = store.tree.read('http-proxy.key', 128)
        store.backup('http-proxy.key',previous)
        store.tree.write('http-proxy.key',key.encode('ascii'),overwrite=True)
        store.tree.write('device-session.json',json.dumps(session).encode('ascii'))
    return session


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description='Start PCRC remote MCP using the existing Cloudflare gateway')
    parser.add_argument('--workspace', help='Existing approved workspace; required if no saved configuration')
    parser.add_argument('--port', type=int, default=8866)
    parser.add_argument('--prepare', action='store_true', help='Install the checksum-pinned bundled tunnel in private state, then exit')
    parser.add_argument('--capabilities', help='Explicit local grant: comma-separated files,commands,browser,desktop')
    parser.add_argument('--duration-minutes', type=int, default=60)
    parser.add_argument('--browser-channel', choices=('chromium','msedge','chrome'), default='chromium')
    parser.add_argument('--headless', action='store_true')
    parser.add_argument('--show-call-details', action='store_true', help='Show bounded redacted call arguments/results on this terminal; never persisted by this switch')
    parser.add_argument('--auto-origin', help='Worker HTTPS origin; remembered after enrollment for later runs')
    parser.add_argument('--enroll', action='store_true', help='Pair this computer using a one-time code from the owner website')
    parser.add_argument('--device-name', help='Name shown in the owner website for a new device')
    args = parser.parse_args(argv)
    if not 1024 <= args.port <= 65535:
        parser.error('Use an unprivileged TCP port')
    if not 1 <= args.duration_minutes <= 480:
        parser.error('Capability duration must be 1..480 minutes')
    capabilities = None
    if args.capabilities is not None:
        from .control import CAPABILITIES
        names = args.capabilities.split(',')
        if not names or any(name not in CAPABILITIES for name in names) or len(names) != len(set(names)):
            parser.error('Select unique capabilities from files,commands,browser,desktop')
        capabilities = frozenset(names)
    if args.headless and (not capabilities or 'browser' not in capabilities):
        parser.error('--headless requires the browser capability')
    if args.auto_origin and not cloudflare.WORKER_PATTERN.fullmatch(args.auto_origin):
        parser.error('Use an exact HTTPS workers.dev origin for --auto-origin')
    if args.enroll and (args.prepare or not args.auto_origin):
        parser.error('--enroll requires --auto-origin and cannot be combined with --prepare')
    try:
        workspace = configured_workspace(args.workspace)
        # Never initialize credentials, grant capabilities, or spawn a public
        # process before the normal-user privilege check.
        cloudflare.require_standard_user()
        if args.enroll:
            device = enroll(workspace,args.auto_origin,args.device_name)
            print(f"  [PCRC] Device paired: {device['name']} ({device['id']})",flush=True)
        from .http_server import prepare_backend
        commander, _, _ = prepare_backend(workspace, initialize=args.prepare)
        try:
            device = json.loads(commander._store.tree.read('device-session.json', 1024))
        except FileNotFoundError:
            device = None
        if device and (not isinstance(device,dict) or not cloudflare.WORKER_PATTERN.fullmatch(str(device.get('worker',''))) or not re.fullmatch(r'(?:[0-9]{1,20}|s-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})',str(device.get('owner_id','')))):
            raise ValueError('Invalid private device session')
        auto_origin = args.auto_origin or (device['worker'] if device else None)
        if device and auto_origin != device['worker']:
            raise ValueError('Paired Worker address does not match saved device identity')
        if args.prepare:
            installed = cloudflare.binary(cloudflare.runtime_directory(commander), download=True)
            print(json.dumps({'prepared':True,'binary':str(installed),'connected':False}))
            return 0
        cloudflare.binary(cloudflare.runtime_directory(commander))
        print('PCRC remote: local execution on this machine. Keep this terminal open; Ctrl+C stops it.', flush=True)
        if auto_origin:
            print('PCRC will synchronize its verified Quick Tunnel with the configured Worker. Connect the AI client to the stable Worker /mcp URL.', flush=True)
        else:
            print('After PCRC prints a public origin, update the existing Worker JAN_ORIGIN. Connect the AI client to its stable /mcp URL and sign in through the client OAuth flow.', flush=True)
        print('A tunnel URL is not proof that ChatGPT is connected. Control requires both an OAuth control grant and a live local capability lease.', flush=True)
        cloudflare.run(workspace, args.port, control_capabilities=capabilities,
                       duration_minutes=args.duration_minutes, headless=args.headless,
                       browser_channel=args.browser_channel, show_call_details=args.show_call_details,
                       **({'auto_origin':auto_origin} if auto_origin else {}))
        return 0
    except KeyboardInterrupt:
        print('PCRC remote stopped.')
        return 0
    except (OSError, ValueError, RuntimeError, json.JSONDecodeError) as exc:
        # Avoid reflecting arbitrary OS paths or credential-bearing exception text.
        message = str(exc) if isinstance(exc, ValueError) and str(exc) in {
            'Select an existing approved workspace with --workspace',
            'Workspace must be an existing directory',
            'connection.json needs an existing workspace path',
            'This workspace is already enrolled; use its existing PCRC device session',
            'Invalid private device session',
            'Paired Worker address does not match saved device identity',
            'Enrollment expired or unavailable; create a new code on your PCRC website',
            'Invalid enrollment code',
            'Invalid enrollment response',
            'Device name must use letters, numbers, spaces, dots or hyphens'} else 'PCRC remote setup failed; inspect the configured workspace, private origin key, bundled tunnel and normal-user launch.'
        print(message, file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
