"""Private IPC helper for the Node pairing agent; stdout is consumed by its parent only."""
from __future__ import annotations
import argparse
import json
import os
import re
import sys
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from .cloudflare import require_standard_user, WORKER_PATTERN
from .http_server import prepare_backend
from .remote import configured_workspace

FILE = 'pc-device-credential.enc'
LEGACY_FILE = 'pc-device-credential.json'
AAD = b'JAN_DEVICE_CREDENTIAL_V1'


def read_credential(store):
    try:
        blob = store.tree.read(FILE, 8256)
    except FileNotFoundError:
        try:
            old = validate(json.loads(store.tree.read(LEGACY_FILE, 8192)))
        except FileNotFoundError:
            return None
        write_credential(store, old, overwrite=False)
        store.tree.unlink_file(LEGACY_FILE)
        return old
    if len(blob) < 29 or blob[:1] != b'\x01':
        raise ValueError('Invalid encrypted device credential')
    raw = AESGCM(store.key).decrypt(blob[1:13], blob[13:], AAD + store.context)
    value = validate(json.loads(raw))
    try:
        store.tree.unlink_file(LEGACY_FILE)
    except FileNotFoundError:
        pass
    return value


def write_credential(store, credential, *, overwrite):
    nonce = os.urandom(12)
    raw = json.dumps(credential, ensure_ascii=True).encode('ascii')
    blob = b'\x01' + nonce + AESGCM(store.key).encrypt(nonce, raw, AAD + store.context)
    store.tree.write(FILE, blob, overwrite=overwrite)


def inspect_state(workspace, port=None):
    """Inspect existing encrypted state without creating keys or returning credentials."""
    import hashlib
    from .core import state_directory
    from .safe_fs import SafeTree, check
    path = state_directory(workspace).expanduser().absolute()
    if path.is_relative_to(workspace):
        raise ValueError('Private state must remain outside the workspace')
    value = {'paired': False, 'gateway': None, 'local_agent': False}
    if not path.exists():
        return value
    for parent in (path, *path.parents):
        check(parent.lstat(), directory=True)
    if os.name == 'posix' and (path.stat().st_uid != os.getuid() or path.stat().st_mode & 0o077):
        raise ValueError('Private state permissions denied')
    tree = SafeTree(path, internal=True)
    try:
        blob = tree.read(FILE, 8256)
    except FileNotFoundError:
        blob = None
    if blob is not None:
        key = tree.read('state.key', 32)
        if len(key) != 32 or len(blob) < 29 or blob[:1] != b'\x01':
            raise ValueError('Invalid private state')
        if os.name == 'posix' and tree.info('state.key').st_mode & 0o077:
            raise ValueError('Private key permissions denied')
        from cryptography.exceptions import InvalidTag
        try:
            credential = validate(json.loads(AESGCM(key).decrypt(blob[1:13], blob[13:], AAD + hashlib.sha256(str(workspace).encode()).digest())))
        except InvalidTag as exc:
            raise ValueError('Private state authentication failed') from exc
        value.update(paired=True, gateway=credential['session']['worker'])
    if port is not None:
        if not 1024 <= port <= 65535:
            raise ValueError('Invalid local port')
        try:
            from urllib.request import build_opener, ProxyHandler, HTTPRedirectHandler, Request
            class NoRedirect(HTTPRedirectHandler):
                def redirect_request(self, *args, **kwargs):
                    return None
            token = tree.read('http-proxy.key', 128).decode('ascii')
            if not re.fullmatch(r'[A-Za-z0-9_-]{43,128}', token):
                raise ValueError('Invalid local key')
            request = Request(f'http://127.0.0.1:{port}/healthz', headers={'Authorization': 'Bearer ' + token})
            with build_opener(ProxyHandler({}), NoRedirect()).open(request, timeout=1) as response:
                value['local_agent'] = response.status == 200 and json.loads(response.read(1024)).get('status') == 'ok'
        except (OSError, ValueError):
            pass
    return value


def validate(value):
    if not isinstance(value, dict) or set(value) != {'session', 'privateKey'}:
        raise ValueError('Invalid device credential')
    session = value['session']
    caps = session.get('capabilities') if isinstance(session, dict) else None
    control = caps[2:] if isinstance(caps, list) and caps[:2] == ['read', 'control'] else []
    valid_caps = caps == ['read'] or (bool(control) and all(isinstance(c, str) for c in control)
                   and control == sorted(set(control))
                   and set(control) <= {'files', 'commands', 'browser', 'desktop'})
    if (not isinstance(session, dict) or session.get('protocol') != 2
            or not WORKER_PATTERN.fullmatch(str(session.get('worker', '')))
            or not re.fullmatch(r'[a-f0-9-]{36}', str(session.get('id', '')))
            or not re.fullmatch(r'(?:[0-9]{1,20}|s-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})', str(session.get('owner_id', '')))
            or not valid_caps):
        raise ValueError('Invalid device session')
    from cryptography.hazmat.primitives.serialization import load_pem_private_key
    from cryptography.hazmat.primitives.asymmetric.ec import EllipticCurvePrivateKey, SECP256R1
    key = load_pem_private_key(str(value['privateKey']).encode('ascii'), password=None)
    if not isinstance(key, EllipticCurvePrivateKey) or not isinstance(key.curve, SECP256R1):
        raise ValueError('Invalid device key')
    return value


def main(argv=None):
    parser = argparse.ArgumentParser(description='PC Remote Commander private agent state')
    parser.add_argument('action', choices=('prepare', 'save', 'replace', 'inspect'))
    parser.add_argument('--workspace')
    parser.add_argument('--port', type=int)
    args = parser.parse_args(argv)
    try:
        require_standard_user()
        workspace = configured_workspace(args.workspace)
        if args.action == 'inspect':
            print(json.dumps(inspect_state(workspace, args.port)))
            return 0
        commander, local_key, _ = prepare_backend(workspace, initialize=True)
        store = commander._store
        with store.locked():
            if args.action in ('save', 'replace'):
                raw = sys.stdin.buffer.read(8193)
                if len(raw) > 8192:
                    raise ValueError('Credential too large')
                data = json.loads(raw)
                expected = None
                if args.action == 'replace':
                    if not isinstance(data, dict) or set(data) != {'credential', 'expectedId'}:
                        raise ValueError('Invalid replacement')
                    expected = data['expectedId']
                    value = validate(data['credential'])
                else:
                    value = validate(data)
                # Never let simultaneous pairing processes replace a different device identity.
                previous = read_credential(store)
                if args.action == 'replace' and (not previous or previous.get('session', {}).get('id') != expected):
                    raise ValueError('Saved device changed; restart enrollment')
                if previous is not None and previous != value and args.action != 'replace':
                    raise ValueError('A different device credential is already saved')
                if previous != value:
                    write_credential(store, value, overwrite=previous is not None)
                print('{"saved":true}')
            else:
                credential = read_credential(store)
                print(json.dumps({'workspace':str(workspace), 'localKey':local_key, 'credential':credential}))
        return 0
    except (OSError, ValueError, RuntimeError):
        print('PC Remote Commander private state unavailable; check setup and normal-user launch.', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
