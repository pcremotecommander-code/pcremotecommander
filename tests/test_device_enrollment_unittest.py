"""Security regression checks for the optional browser-issued device enrollment."""
import io
import json
from pathlib import Path
from unittest import TestCase
from unittest.mock import patch
import hmac
import hashlib
import sys
from types import ModuleType

from jan_mcp_commander import remote, cloudflare


class FakeTree:
    def __init__(self):
        self.values = {'http-proxy.key': b'A' * 43}

    def read(self, name, limit):
        if name not in self.values:
            raise FileNotFoundError(name)
        return self.values[name]

    def write(self, name, value, overwrite=False):
        if name in self.values and not overwrite:
            raise FileExistsError(name)
        self.values[name] = value


class FakeStore:
    def __init__(self):
        self.tree = FakeTree()
        self.backups = []

    def locked(self):
        from contextlib import nullcontext
        return nullcontext()

    def backup(self, path, data):
        self.backups.append((path, data))


class FakeResponse:
    status = 200
    def __init__(self, value):
        self.value = value
    def __enter__(self):
        return self
    def __exit__(self, *_):
        return False
    def read(self, *_):
        return json.dumps(self.value).encode()


class EnrollmentTests(TestCase):
    def setUp(self):
        self.original_server = sys.modules.get('jan_mcp_commander.http_server')
        if self.original_server is None:
            fake = ModuleType('jan_mcp_commander.http_server')
            fake.prepare_backend = lambda *args, **kwargs: None
            sys.modules['jan_mcp_commander.http_server'] = fake
        self.store = FakeStore()
        self.commander = type('Commander', (), {'_store': self.store})()
        self.worker = 'https://jan-gateway.example.workers.dev'
        self.key = 'B' * 43
        self.device_id = '12345678-1234-1234-1234-123456789abc'

    def tearDown(self):
        if self.original_server is None:
            sys.modules.pop('jan_mcp_commander.http_server',None)

    def test_invalid_code_cannot_contact_worker_or_replace_key(self):
        with patch('jan_mcp_commander.http_server.prepare_backend', return_value=(self.commander, 'A'*43, None)), patch.object(cloudflare, 'runtime_directory', return_value=Path('.')), patch.object(cloudflare, 'binary'), patch.object(remote.webbrowser,'open'), patch('getpass.getpass', return_value='bad'), patch('urllib.request.build_opener') as opener:
            with self.assertRaisesRegex(ValueError, 'Invalid enrollment code'):
                remote.enroll(Path('.'), self.worker, 'Laptop Two')
        opener.assert_not_called()
        self.assertEqual(self.store.tree.values['http-proxy.key'], b'A'*43)

    def test_one_time_code_is_sent_over_https_and_private_key_replaced_after_claim(self):
        captured = {}
        class Opener:
            def open(self, request, timeout):
                captured['url'] = request.full_url
                captured['body'] = json.loads(request.data)
                return FakeResponse({'key': self_key, 'id': self_id, 'name': 'Laptop Two', 'login': 'owner', 'owner_id':'1234'})
        self_key, self_id = self.key, self.device_id
        with patch('jan_mcp_commander.http_server.prepare_backend', return_value=(self.commander, 'A'*43, None)), patch.object(cloudflare, 'runtime_directory', return_value=Path('.')), patch.object(cloudflare, 'binary'), patch.object(remote.webbrowser,'open') as browser, patch('getpass.getpass', return_value='C'*43), patch('urllib.request.build_opener', return_value=Opener()):
            result = remote.enroll(Path('.'), self.worker, 'Laptop Two')
        browser.assert_called_once_with(self.worker+'/devices',new=2)
        self.assertEqual(captured['url'], self.worker+'/devices/claim')
        self.assertEqual(captured['body'], {'code':'C'*43,'name':'Laptop Two'})
        self.assertEqual(result['id'], self.device_id)
        self.assertEqual(result['owner_id'],'1234')
        self.assertEqual(self.store.backups, [('http-proxy.key', b'A'*43)])
        self.assertEqual(self.store.tree.values['http-proxy.key'], b'B'*43)
        self.assertNotIn(self.key, self.store.tree.values['device-session.json'].decode())

    def test_device_registration_binds_id_origin_and_time(self):
        captured = {}
        class Opener:
            def open(self, request, timeout):
                captured.update(json.loads(request.data))
                return FakeResponse({'active':True})
        with patch('urllib.request.build_opener', return_value=Opener()):
            self.assertIs(cloudflare.register_device_origin(self.worker, 'https://a-new-origin.trycloudflare.com', self.key, self.device_id, '1234',timestamp=1792100000), True)
        expected = hmac.new(self.key.encode(), f"JAN_ORIGIN_V3\n1234\n{self.device_id}\n1792100000\nhttps://a-new-origin.trycloudflare.com".encode(), hashlib.sha256).hexdigest()
        self.assertEqual(captured['signature'], expected)
        self.assertEqual(captured['device_id'], self.device_id)
        self.assertEqual(captured['owner_id'],'1234')

    def test_reconnect_uses_saved_worker_without_website_login(self):
        self.store.tree.values['device-session.json']=json.dumps({'id':self.device_id,'name':'Laptop Two','login':'owner','owner_id':'1234','worker':self.worker}).encode()
        with patch.object(remote,'configured_workspace',return_value=Path('.')), patch.object(cloudflare,'require_standard_user'), patch('jan_mcp_commander.http_server.prepare_backend',return_value=(self.commander,self.key,None)), patch.object(cloudflare,'runtime_directory',return_value=Path('.')), patch.object(cloudflare,'binary'), patch.object(cloudflare,'run') as run, patch.object(remote,'enroll') as enroll:
            self.assertEqual(remote.main(['--workspace','.',]),0)
        enroll.assert_not_called()
        self.assertEqual(run.call_args.kwargs['auto_origin'],self.worker)

    def test_reconnect_rejects_different_worker(self):
        self.store.tree.values['device-session.json']=json.dumps({'id':self.device_id,'name':'Laptop Two','login':'owner','owner_id':'1234','worker':self.worker}).encode()
        with patch.object(remote,'configured_workspace',return_value=Path('.')), patch.object(cloudflare,'require_standard_user'), patch('jan_mcp_commander.http_server.prepare_backend',return_value=(self.commander,self.key,None)), patch.object(cloudflare,'run') as run:
            self.assertEqual(remote.main(['--workspace','.','--auto-origin','https://other-gateway.example.workers.dev']),1)
        run.assert_not_called()
