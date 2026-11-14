"""Authenticated loopback MCP origin for the Cloudflare OAuth gateway.

The local proxy key is a service credential, not an OAuth token accepted from
end users. End-user OAuth is enforced by the separate Cloudflare Worker.
"""
from __future__ import annotations
import argparse
import asyncio
from contextlib import asynccontextmanager
import json
import os
from pathlib import Path
import re
import secrets
from .portable import PortableCommander
from .server import build_server
from mcp.server.transport_security import TransportSecuritySettings

MAX_BODY = 262144


def prepare_backend(workspace: Path, *, initialize=False):
    """Create the key only during explicit local setup; never print its value."""
    if not workspace.is_dir():
        raise ValueError('Workspace missing; initialize an existing approved workspace first')
    commander = PortableCommander(workspace)
    # Remote file mutation is deliberately unavailable in this transport.
    commander.allow_writes = False
    store = commander._store
    with store.locked():
        try:
            data = store.tree.read('http-proxy.key', 128)
        except FileNotFoundError as exc:
            if not initialize:
                raise ValueError('Run jan-mcp-http --initialize before starting HTTP') from exc
            data = secrets.token_urlsafe(32).encode('ascii')
            store.tree.write('http-proxy.key', data)
        if not re.fullmatch(rb'[A-Za-z0-9_-]{43,128}', data):
            raise ValueError('Invalid proxy key; operator recovery required')
        info = store.tree.info('http-proxy.key')
        if os.name == 'posix' and (info.st_uid != os.getuid() or info.st_mode & 0o077):
            raise ValueError('Proxy key must have current-user ownership and mode 0600')
    return commander, data.decode('ascii'), store.path / 'http-proxy.key'


class OriginGuard:
    def __init__(self, app, token, port):
        self.app = app
        self.token = token.encode('ascii')
        self.hosts = {f'localhost:{port}'.encode(), f'127.0.0.1:{port}'.encode()}
        self.origins = {b'http://' + host for host in self.hosts}
        self.semaphore = asyncio.Semaphore(4)

    @staticmethod
    async def reply(send, status, detail):
        headers = [(b'content-type', b'application/json'), (b'cache-control', b'no-store'),
                   (b'x-content-type-options', b'nosniff')]
        if status == 401:
            headers.append((b'www-authenticate', b'Bearer realm="PCRC local origin"'))
        await send({'type':'http.response.start','status':status,'headers':headers})
        await send({'type':'http.response.body','body':json.dumps({'status':'ok','remote_connected':False} if status == 200 else {'error':detail}).encode()})

    async def __call__(self, scope, receive, send):
        if scope['type'] != 'http':
            return await self.app(scope, receive, send)
        raw = scope.get('headers', [])
        for name in (b'authorization', b'host', b'origin', b'content-length', b'content-type', b'x-jan-control'):
            if sum(k.lower() == name for k, _ in raw) > 1:
                return await self.reply(send, 400, 'Duplicate security header')
        headers = {k.lower():v for k,v in raw}
        if headers.get(b'host', b'').lower() not in self.hosts:
            return await self.reply(send, 403, 'Host denied')
        if b'origin' in headers and headers[b'origin'] not in self.origins:
            return await self.reply(send, 403, 'Origin denied')
        auth = headers.get(b'authorization', b'')
        if len(auth) > 256 or auth[:7].lower() != b'bearer ' or not secrets.compare_digest(auth[7:], self.token):
            return await self.reply(send, 401, 'Authentication required')
        if scope.get('query_string'):
            return await self.reply(send, 400, 'Query parameters are disabled')
        if scope['path'] == '/healthz' and scope['method'] == 'GET':
            return await self.reply(send, 200, 'Local origin ready; remote connection not verified')
        if scope['path'] != '/mcp':
            return await self.reply(send, 404, 'Not found')
        if scope['method'] != 'POST':
            return await self.reply(send, 405, 'Stateless MCP uses POST')
        if headers.get(b'content-type', b'').split(b';',1)[0].strip().lower() != b'application/json':
            return await self.reply(send, 415, 'JSON required')
        try:
            length = int(headers.get(b'content-length', b'0'))
            if length < 0:
                raise ValueError()
        except ValueError:
            return await self.reply(send, 400, 'Invalid content length')
        if length > MAX_BODY:
            return await self.reply(send, 413, 'Request too large')
        body = bytearray()
        try:
            async with asyncio.timeout(5):
                while True:
                    event = await receive()
                    if event['type'] == 'http.disconnect':
                        return
                    body.extend(event.get('body', b''))
                    if len(body) > MAX_BODY:
                        return await self.reply(send, 413, 'Request too large')
                    if not event.get('more_body', False):
                        break
        except TimeoutError:
            return await self.reply(send, 408, 'Request timed out')
        # A service bearer alone defaults to read-only. The OAuth gateway sets
        # this header from the validated access-token scope, never caller input.
        from .control import READ_TOOLS
        try:
            message = json.loads(body)
            if not isinstance(message, dict) or message.get('jsonrpc') != '2.0':
                raise ValueError('Object required')
            method = message.get('method')
            if method == 'tools/call':
                params = message.get('params')
                if not isinstance(params, dict) or not isinstance(params.get('name'), str):
                    raise ValueError('Tool required')
                if params['name'] not in READ_TOOLS and headers.get(b'x-jan-control') != b'1':
                    return await self.reply(send, 403, 'jan:control permission required')
            elif method not in {'initialize', 'notifications/initialized', 'ping', 'tools/list'}:
                return await self.reply(send, 403, 'MCP method denied')
        except (ValueError, TypeError):
            return await self.reply(send, 400, 'Invalid MCP message')
        consumed = False
        async def buffered():
            nonlocal consumed
            if not consumed:
                consumed = True
                return {'type':'http.request','body':bytes(body),'more_body':False}
            return await receive()
        try:
            await asyncio.wait_for(self.semaphore.acquire(), timeout=0.1)
        except TimeoutError:
            return await self.reply(send, 429, 'Too many requests')
        async def secure_send(message):
            if message['type'] == 'http.response.start':
                message = dict(message)
                message['headers'] = list(message.get('headers', [])) + [
                    (b'cache-control',b'no-store'), (b'x-content-type-options',b'nosniff')]
            await send(message)
        try:
            await self.app(scope, buffered, secure_send)
        finally:
            self.semaphore.release()


def create_app(commander, token, port=8866):
    if type(port) is not int or not 1024 <= port <= 65535:
        raise ValueError('Use an unprivileged TCP port')
    if not re.fullmatch(r'[A-Za-z0-9_-]{43,128}', token):
        raise ValueError('Invalid proxy key')
    from .control import ControlCommander
    if not isinstance(commander, ControlCommander):
        commander.allow_writes = False
    commander._transport = 'http'
    server = build_server(commander)
    app = server.streamable_http_app(stateless_http=True, json_response=True,
        max_request_body_size=MAX_BODY, max_sessions=4, host='127.0.0.1',
        transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=True,
            allowed_hosts=[f'localhost:{port}',f'127.0.0.1:{port}'],
            allowed_origins=[f'http://localhost:{port}',f'http://127.0.0.1:{port}']))
    existing_lifespan = app.router.lifespan_context
    @asynccontextmanager
    async def lifespan(application):
        try:
            async with existing_lifespan(application):
                yield
        finally:
            from .cli import Console
            if isinstance(commander, ControlCommander):
                commander.close_control()
            else:
                Console(commander).close()
    app.router.lifespan_context = lifespan
    return OriginGuard(app, token, port)


def main(argv=None):
    parser = argparse.ArgumentParser(description='PCRC authenticated loopback HTTP origin')
    parser.add_argument('--workspace')
    parser.add_argument('--initialize', action='store_true', help='Create a private proxy key and exit')
    parser.add_argument('--port', type=int, default=8866)
    parser.add_argument('--rotate-proxy-key', action='store_true', help='Locally replace the proxy key; stop services first, then upload the new key and restart')
    args = parser.parse_args(argv)
    from .cli import workspace_path
    try:
        commander, token, key_path = prepare_backend(workspace_path(args.workspace), initialize=args.initialize)
        if args.rotate_proxy_key:
            with commander._store.locked():
                commander._store.tree.write('http-proxy.key', secrets.token_urlsafe(32).encode('ascii'), overwrite=True)
            print(json.dumps({'rotated':True,'upload_and_restart_required':True,'secret_printed':False,'remote_connected':False}))
            return 0
        if args.initialize:
            print(json.dumps({'initialized':True,'proxy_key_file':str(key_path),'secret_printed':False,'remote_connected':False}))
            return 0
        import uvicorn
        configuration = uvicorn.Config(create_app(commander, token, args.port), host='127.0.0.1', port=args.port,
            access_log=False, proxy_headers=False, log_level='warning', limit_concurrency=8,
            timeout_keep_alive=5, h11_max_incomplete_event_size=16384)
        server = uvicorn.Server(configuration)
        if os.name == 'nt':
            import signal
            # The launcher sends CTRL_BREAK to this owned process group. Let the
            # ASGI lifespan stop diagnostic children rather than abrupt exit.
            signal.signal(signal.SIGBREAK, lambda *_: setattr(server, 'should_exit', True))
        server.run()
        return 0
    except (OSError, ValueError) as exc:
        parser.exit(1, 'PCRC HTTP: '+str(exc)+'\n')

if __name__ == '__main__':
    raise SystemExit(main())
