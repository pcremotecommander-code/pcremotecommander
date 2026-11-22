"""The preview credential has its own private file and validates explicit permissions."""
import io
import json
from types import SimpleNamespace
import pytest
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.serialization import Encoding, PrivateFormat, NoEncryption
from jan_mcp_commander import pairing_state


def credential():
    private = ec.generate_private_key(ec.SECP256R1()).private_bytes(Encoding.PEM, PrivateFormat.PKCS8, NoEncryption()).decode()
    return {'privateKey':private, 'session':{'protocol':2, 'worker':'https://pairing.example.workers.dev',
        'id':'c3e35d88-9749-4af8-8c13-0d097e89f77b', 'owner_id':'1234', 'name':'Test PC', 'capabilities':['read']}}


def test_inspect_is_redacted_and_does_not_initialize_state(tmp_path, monkeypatch, capsys):
    workspace=tmp_path/'workspace';workspace.mkdir()
    private=tmp_path/'private'
    monkeypatch.setenv('JAN_MCP_STATE_DIR',str(private))
    monkeypatch.setattr(pairing_state,'require_standard_user',lambda:None)
    assert pairing_state.main(['inspect','--workspace',str(workspace)])==0
    assert json.loads(capsys.readouterr().out)=={'paired':False,'gateway':None,'local_agent':False}
    assert not private.exists()
    assert pairing_state.main(['prepare','--workspace',str(workspace)])==0
    capsys.readouterr()
    value=credential()
    monkeypatch.setattr(pairing_state.sys,'stdin',SimpleNamespace(buffer=io.BytesIO(json.dumps(value).encode())))
    assert pairing_state.main(['save','--workspace',str(workspace)])==0
    capsys.readouterr()
    before={p.name:p.read_bytes() for p in private.iterdir() if p.is_file()}
    assert pairing_state.main(['inspect','--workspace',str(workspace)])==0
    output=capsys.readouterr().out
    assert json.loads(output)=={'paired':True,'gateway':value['session']['worker'],'local_agent':False}
    assert all(secret not in output for secret in [value['privateKey'],value['session']['owner_id'],value['session']['id'],'localKey'])
    assert {p.name:p.read_bytes() for p in private.iterdir() if p.is_file()}==before


def test_inspect_rejects_tampered_state_without_replacing_it(tmp_path, monkeypatch):
    workspace=tmp_path/'workspace';workspace.mkdir()
    private=tmp_path/'private'
    monkeypatch.setenv('JAN_MCP_STATE_DIR',str(private))
    from jan_mcp_commander.http_server import prepare_backend
    commander,_,_=prepare_backend(workspace,initialize=True)
    pairing_state.write_credential(commander._store,credential(),overwrite=False)
    blob=commander._store.tree.read(pairing_state.FILE,8256)
    commander._store.tree.write(pairing_state.FILE,blob[:-1]+bytes([blob[-1]^1]),overwrite=True)
    with pytest.raises(ValueError,match='authentication'):
        pairing_state.inspect_state(workspace)


def test_inspect_with_port_uses_existing_local_key(tmp_path, monkeypatch):
    import urllib.request
    from jan_mcp_commander.http_server import prepare_backend

    workspace = tmp_path / 'workspace'
    workspace.mkdir()
    monkeypatch.setenv('JAN_MCP_STATE_DIR', str(tmp_path / 'private'))
    assert pairing_state.inspect_state(workspace, 45000)['local_agent'] is False
    commander, local_key, _ = prepare_backend(workspace, initialize=True)
    pairing_state.write_credential(commander._store, credential(), overwrite=False)

    def connect(request, timeout):
        assert request.full_url == 'http://127.0.0.1:45000/healthz'
        assert request.get_header('Authorization') == 'Bearer ' + local_key
        response = io.BytesIO(b'{"status":"ok"}')
        response.status = 200
        return response

    monkeypatch.setattr(urllib.request, 'build_opener', lambda *args: SimpleNamespace(open=connect))
    assert pairing_state.inspect_state(workspace, 45000)['local_agent'] is True


def test_private_pairing_state_roundtrip_preserves_legacy_enrollment(tmp_path, monkeypatch, capsys):
    workspace = tmp_path/'workspace'; workspace.mkdir()
    monkeypatch.setenv('JAN_MCP_STATE_DIR', str(tmp_path/'private'))
    monkeypatch.setattr(pairing_state,'require_standard_user',lambda:None)
    assert pairing_state.main(['prepare','--workspace',str(workspace)]) == 0
    prepared = json.loads(capsys.readouterr().out)
    assert prepared['credential'] is None
    from jan_mcp_commander.http_server import prepare_backend
    commander, _, _ = prepare_backend(workspace)
    commander._store.tree.write('device-session.json',b'{"legacy":true}')
    value = credential()
    monkeypatch.setattr(pairing_state.sys,'stdin',SimpleNamespace(buffer=io.BytesIO(json.dumps(value).encode())))
    assert pairing_state.main(['save','--workspace',str(workspace)]) == 0
    assert json.loads(capsys.readouterr().out) == {'saved':True}
    assert commander._store.tree.read('device-session.json',1024) == b'{"legacy":true}'
    assert pairing_state.main(['prepare','--workspace',str(workspace)]) == 0
    restored = json.loads(capsys.readouterr().out)
    assert restored['credential'] == value
    assert restored['localKey'] == prepared['localKey']
    assert not (workspace/pairing_state.FILE).exists()
    # A second pending process cannot replace the identity saved by the first.
    monkeypatch.setattr(pairing_state.sys,'stdin',SimpleNamespace(buffer=io.BytesIO(json.dumps(credential()).encode())))
    assert pairing_state.main(['save','--workspace',str(workspace)]) == 1
    blob = commander._store.tree.read(pairing_state.FILE,8256)
    assert b'PRIVATE KEY' not in blob
    assert pairing_state.read_credential(commander._store) == value
    replacement=credential()
    monkeypatch.setattr(pairing_state.sys,'stdin',SimpleNamespace(buffer=io.BytesIO(json.dumps({'credential':replacement,'expectedId':'wrong-id'}).encode())))
    assert pairing_state.main(['replace','--workspace',str(workspace)]) == 1
    monkeypatch.setattr(pairing_state.sys,'stdin',SimpleNamespace(buffer=io.BytesIO(json.dumps({'credential':replacement,'expectedId':value['session']['id']}).encode())))
    assert pairing_state.main(['replace','--workspace',str(workspace)]) == 0
    assert pairing_state.read_credential(commander._store) == replacement


def test_plaintext_device_credential_migrates_to_authenticated_encryption(tmp_path, monkeypatch, capsys):
    workspace=tmp_path/'workspace';workspace.mkdir()
    monkeypatch.setenv('JAN_MCP_STATE_DIR',str(tmp_path/'private'))
    monkeypatch.setattr(pairing_state,'require_standard_user',lambda:None)
    from jan_mcp_commander.http_server import prepare_backend
    commander,_,_=prepare_backend(workspace,initialize=True)
    value=credential()
    commander._store.tree.write(pairing_state.LEGACY_FILE,json.dumps(value).encode())
    assert pairing_state.main(['prepare','--workspace',str(workspace)]) == 0
    assert json.loads(capsys.readouterr().out)['credential'] == value
    assert not (tmp_path/'private'/pairing_state.LEGACY_FILE).exists()
    blob=commander._store.tree.read(pairing_state.FILE,8256)
    assert b'PRIVATE KEY' not in blob
    commander._store.tree.write(pairing_state.FILE,blob[:-1]+bytes([blob[-1]^1]),overwrite=True)
    with pytest.raises(Exception):
        pairing_state.read_credential(commander._store)


def test_pairing_state_rejects_malformed_control_grants_and_oversized_credentials(tmp_path, monkeypatch, capsys):
    workspace=tmp_path/'workspace';workspace.mkdir()
    monkeypatch.setenv('JAN_MCP_STATE_DIR',str(tmp_path/'private'))
    monkeypatch.setattr(pairing_state,'require_standard_user',lambda:None)
    value=credential();value['session']['capabilities']=['read','control']
    invalid=[value]
    for caps in (['read','control','admin'],['read','control','files','files'],['read','control','files','commands']):
        item=credential();item['session']['capabilities']=caps;invalid.append(item)
    for raw in [*(json.dumps(item).encode() for item in invalid),b'x'*8193]:
        monkeypatch.setattr(pairing_state.sys,'stdin',SimpleNamespace(buffer=io.BytesIO(raw)))
        assert pairing_state.main(['save','--workspace',str(workspace)]) == 1
        captured=capsys.readouterr();assert captured.out == '';assert 'PRIVATE KEY' not in captured.err
    assert not (tmp_path/'private'/pairing_state.FILE).exists()


def test_explicit_canonical_control_grant_is_storable():
    value=credential();value['session']['capabilities']=['read','control','commands','files']
    assert pairing_state.validate(value)==value


def test_privilege_denial_precedes_pairing_state_creation(tmp_path,monkeypatch,capsys):
    monkeypatch.setattr(pairing_state,'require_standard_user',lambda:(_ for _ in ()).throw(ValueError('elevated')))
    monkeypatch.setattr(pairing_state,'prepare_backend',lambda *_a,**_k:(_ for _ in ()).throw(AssertionError('State touched')))
    assert pairing_state.main(['prepare','--workspace',str(tmp_path)]) == 1
    assert 'elevated' not in capsys.readouterr().err


@pytest.mark.parametrize("owner_id", ["1234", "s-12345678-1234-4123-8123-123456789abc"])
def test_pairing_state_supports_distinct_email_and_github_account_ids(owner_id):
    value = credential()
    value["session"]["owner_id"] = owner_id
    assert pairing_state.validate(value) == value


@pytest.mark.parametrize("owner_id", ["s-1234", "s-12345678-1234-4123-8123-123456789abx", "../1234", "1234\n", "s-12345678-1234-4123-8123-123456789abc/other"])
def test_pairing_state_rejects_malformed_email_account_ids(owner_id):
    value = credential()
    value["session"]["owner_id"] = owner_id
    with pytest.raises(ValueError):
        pairing_state.validate(value)
