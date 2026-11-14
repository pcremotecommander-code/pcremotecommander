import hashlib
import hmac
import json
import os
from pathlib import Path
import subprocess
import sys
import pytest
from jan_mcp_commander import cloudflare as cf
from jan_mcp_commander.http_server import prepare_backend


def test_origin_header_and_metrics_are_loopback_only():
    args=cf.command(Path('cloudflared'),8866)
    assert args[args.index('--http-host-header')+1]=='localhost:8866'
    assert args[args.index('--url')+1]=='http://127.0.0.1:8866'
    assert args[args.index('--metrics')+1]=='127.0.0.1:0'
    assert '--management-diagnostics=false' in args
    with pytest.raises(ValueError):cf.command(Path('cloudflared'),80)


def test_signed_worker_registration_never_redirects_or_uses_proxy(monkeypatch):
    seen=[]
    class Reply:
        status=204
        def __enter__(self):return self
        def __exit__(self,*_):pass
    class Opener:
        def open(self,request,timeout):
            seen.append((request,timeout))
            return Reply()
    monkeypatch.setattr(cf.urllib.request,'build_opener',lambda *handlers: (seen.append(handlers),Opener())[1])
    worker='https://jan-gateway.account.workers.dev';origin='https://synthetic-tunnel.trycloudflare.com'
    assert cf.register_origin(worker,origin,'private-synthetic',timestamp=1234)
    request,_=seen[1]
    assert request.full_url==worker+'/jan-origin' and request.get_method()=='POST'
    assert request.get_header('User-agent')=='JAN-Commander/0.6.2'
    body=json.loads(request.data)
    expected=hmac.new(b'private-synthetic',f'JAN_ORIGIN_V1\n1234\n{origin}'.encode(),hashlib.sha256).hexdigest()
    assert body=={'origin':origin,'timestamp':1234,'signature':expected}
    assert len(seen[0])==2
    with pytest.raises(ValueError):cf.register_origin('https://evil.example',origin,'private-synthetic')


def test_registration_uses_verified_worker_time_when_host_clock_is_wrong(monkeypatch):
    worker='https://jan-gateway.account.workers.dev'
    origin='https://synthetic-tunnel.trycloudflare.com'
    seen=[]
    class Reply:
        status=200
        headers={'Date':'Fri, 16 Oct 2026 09:15:04 GMT'}
        def __init__(self,status):self.status=status
        def read(self,limit):return json.dumps({'resource':worker+'/mcp'}).encode()
        def __enter__(self):return self
        def __exit__(self,*_):pass
    class Opener:
        def open(self,request,timeout):
            seen.append(request)
            return Reply(200 if request.get_method()=='GET' else 204)
    monkeypatch.setattr(cf.urllib.request,'build_opener',lambda *handlers:Opener())
    monkeypatch.setattr(cf.time,'time',lambda:0)
    assert cf.register_origin(worker,origin,'private-synthetic')
    assert len(seen)==2 and seen[0].get_method()=='GET' and seen[1].get_method()=='POST'
    assert seen[0].get_header('Cache-control')=='no-store'
    assert seen[0].data is None
    body=json.loads(seen[1].data)
    assert body['timestamp']==int(cf.parsedate_to_datetime('Fri, 16 Oct 2026 09:15:04 GMT').timestamp())
    expected=hmac.new(b'private-synthetic',f"JAN_ORIGIN_V1\n{body['timestamp']}\n{origin}".encode(),hashlib.sha256).hexdigest()
    assert body['signature']==expected
    assert cf.worker_timestamp('https://evil.example') is None
    class WrongWorker(Opener):
        def open(self,request,timeout):
            seen.append(request)
            response=Reply(200)
            response.read=lambda limit:b'{"resource":"https://evil.example/mcp"}'
            return response
    monkeypatch.setattr(cf.urllib.request,'build_opener',lambda *handlers:WrongWorker())
    assert not cf.register_origin(worker,origin,'private-synthetic')
    assert len(seen)==3 and seen[-1].get_method()=='GET'


def test_environment_drops_ambient_secrets_proxy_and_tunnel_config(monkeypatch):
    for key in ('TUNNEL_TOKEN','TUNNEL_LOGLEVEL','HTTP_PROXY','PYTHONPATH','JAN_MCP_ALLOW_WRITES','GITHUB_TOKEN'):
        monkeypatch.setenv(key,'unsafe')
    env=cf.clean_environment()
    assert not {'TUNNEL_TOKEN','TUNNEL_LOGLEVEL','HTTP_PROXY','PYTHONPATH','GITHUB_TOKEN'} & env.keys()
    assert env['JAN_MCP_ALLOW_WRITES']=='0'


def test_existing_binary_checksum_is_required(tmp_path,monkeypatch):
    tmp_path.chmod(0o700)
    monkeypatch.setattr(cf,'asset',lambda:('test-binary',hashlib.sha256(b'correct').hexdigest()))
    path=tmp_path/(cf.VERSION+'-test-binary');path.write_bytes(b'correct')
    assert cf.binary(tmp_path)==path
    path.write_bytes(b'replaced')
    with pytest.raises(ValueError,match='checksum'):cf.binary(tmp_path)


def test_download_not_implicit(tmp_path,monkeypatch):
    tmp_path.chmod(0o700)
    monkeypatch.setattr(cf,'asset',lambda:('absent','0'*64))
    with pytest.raises(ValueError,match='prepare'):cf.binary(tmp_path)


def test_owned_child_is_stopped():
    process=cf.spawn([sys.executable,'-I','-c','import time;time.sleep(60)'],cf.clean_environment())
    cf.stop(process)
    assert process.poll() is not None
    cf.stop(process)


def test_runtime_and_origin_record_are_outside_workspace(tmp_path,monkeypatch):
    work=tmp_path/'work';work.mkdir()
    monkeypatch.setenv('JAN_MCP_STATE_DIR',str(tmp_path/'private'))
    commander,_,_=prepare_backend(work,initialize=True)
    runtime=cf.runtime_directory(commander)
    assert not runtime.is_relative_to(work)
    if os.name=='posix':assert runtime.stat().st_mode & 0o077==0


def test_prepare_uses_only_bundled_verified_bytes(tmp_path,monkeypatch):
    runtime=tmp_path/'runtime';runtime.mkdir(mode=0o700)
    bundle=tmp_path/'bundle';bundle.mkdir()
    expected=b'synthetic-binary-for-test'
    monkeypatch.setattr(cf,'asset',lambda:('test-binary',hashlib.sha256(expected).hexdigest()))
    monkeypatch.setattr(cf,'BUNDLE_DIR',bundle)
    (bundle/(cf.VERSION+'-test-binary')).write_bytes(expected)
    monkeypatch.setattr(cf.urllib.request,'urlopen',lambda *_a,**_kw:pytest.fail('prepare must not download a vendor binary'))
    path=cf.binary(runtime,download=True)
    assert path.read_bytes()==expected


def test_prepare_rejects_corrupted_bundle(tmp_path,monkeypatch):
    runtime=tmp_path/'runtime';runtime.mkdir(mode=0o700)
    bundle=tmp_path/'bundle';bundle.mkdir()
    monkeypatch.setattr(cf,'asset',lambda:('test-binary','0'*64))
    monkeypatch.setattr(cf,'BUNDLE_DIR',bundle)
    (bundle/(cf.VERSION+'-test-binary')).write_bytes(b'changed')
    with pytest.raises(ValueError,match='checksum mismatch'):cf.binary(runtime,download=True)
    assert not list(runtime.iterdir())


@pytest.mark.skipif(os.environ.get('PCRC_SOURCE_ONLY_TESTS') == '1', reason='Source-only checkout excludes release binary artifacts; distribution gates must verify them separately')
def test_bundled_platform_digests_and_provenance_agree():
    import json
    provenance=json.loads((cf.BUNDLE_DIR/'build-provenance.json').read_text())
    assert provenance['go_version']=='go1.26.9'
    assert provenance['source_commit']=='18cdfe0a6fc7b72a0702d255a1f984e776ce0498'
    for filename,digest in cf.ASSETS.values():
        name=cf.VERSION+'-'+filename
        data=(cf.BUNDLE_DIR/name).read_bytes()
        assert hashlib.sha256(data).hexdigest()==digest==provenance['artifacts'][name]['sha256']
        assert b'golang.org/x/crypto/openpgp' not in data


@pytest.mark.parametrize('system', ['Windows', 'Linux'])
def test_public_transport_denies_elevated_and_allows_standard_user(monkeypatch,system):
    monkeypatch.setattr(cf.platform,'system',lambda:system)
    monkeypatch.setattr(cf,'_windows_elevated',lambda:True)
    monkeypatch.setattr(cf.os,'geteuid',lambda:0,raising=False)
    with pytest.raises(ValueError,match='standard-user terminal'):
        cf.require_standard_user()
    monkeypatch.setattr(cf,'_windows_elevated',lambda:False)
    monkeypatch.setattr(cf.os,'geteuid',lambda:1000,raising=False)
    cf.require_standard_user()


def test_privilege_inspection_failure_denies_launch(monkeypatch):
    monkeypatch.setattr(cf.platform,'system',lambda:'Windows')
    def unavailable():raise OSError('Token inspection failed')
    monkeypatch.setattr(cf,'_windows_elevated',unavailable)
    with pytest.raises(RuntimeError,match='Cannot verify process privileges'):
        cf.require_standard_user()


def test_privilege_gate_runs_before_state_or_process_creation(tmp_path,monkeypatch):
    monkeypatch.setattr(cf.platform,'system',lambda:'Windows')
    monkeypatch.setattr(cf,'_windows_elevated',lambda:True)
    monkeypatch.setattr('jan_mcp_commander.http_server.prepare_backend',lambda *_a,**_k:pytest.fail('State must not be created'))
    monkeypatch.setattr(cf,'spawn',lambda *_a,**_k:pytest.fail('Process must not be started'))
    with pytest.raises(ValueError,match='standard-user terminal'):
        cf.run(tmp_path,8866)


def test_tunnel_event_and_readiness_use_only_fixed_loopback_metadata(monkeypatch):
    assert cf.tunnel_event('INFO Starting metrics server on 127.0.0.1:45678/metrics')==('metrics','http://127.0.0.1:45678/ready')
    assert cf.tunnel_event('https://example-test.trycloudflare.com ') == ('origin','https://example-test.trycloudflare.com')
    assert cf.tunnel_event('INFO Starting metrics server on 0.0.0.0:45678/metrics') is None
    assert cf.tunnel_event('INFO Starting metrics server on 127.0.0.1:99999/metrics') is None
    assert cf.tunnel_event('raw secret-looking unrelated log line') is None
    monkeypatch.setattr(cf.urllib.request,'build_opener',lambda *_:pytest.fail('Unsafe readiness endpoint was fetched'))
    assert not cf.tunnel_ready('https://evil.example/ready')
    assert not cf.tunnel_ready('http://127.0.0.1:45678/ready?token=x')


def test_public_readiness_requires_jan_401_and_sends_no_credentials(monkeypatch):
    import io
    from email.message import Message
    class Opener:
        def __init__(self,status,realm):self.status,self.realm=status,realm
        def open(self,request,timeout):
            assert request.full_url=='https://example-test.trycloudflare.com/mcp'
            assert request.headers.get('Authorization') is None
            headers=Message();headers['WWW-Authenticate']=self.realm
            raise cf.urllib.error.HTTPError(request.full_url,self.status,'synthetic',headers,io.BytesIO())
    monkeypatch.setattr(cf.urllib.request,'build_opener',lambda *_:Opener(401,'Bearer realm="PCRC local origin"'))
    assert cf.public_origin_ready('https://example-test.trycloudflare.com')
    for status,realm in [(530,''),(401,'Bearer realm="other"')]:
        monkeypatch.setattr(cf.urllib.request,'build_opener',lambda *_,s=status,r=realm:Opener(s,r))
        assert not cf.public_origin_ready('https://example-test.trycloudflare.com')
    assert not cf.public_origin_ready('https://example.com')
