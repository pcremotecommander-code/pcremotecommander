import pytest
from starlette.testclient import TestClient
from jan_mcp_commander.http_server import create_app, prepare_backend

@pytest.fixture
def backend(tmp_path, monkeypatch):
    work = tmp_path / 'work'; work.mkdir()
    (work / 'hello.txt').write_text('hello HTTP')
    monkeypatch.setenv('JAN_MCP_STATE_DIR', str(tmp_path / 'state'))
    monkeypatch.setenv('JAN_MCP_ALLOW_WRITES', '1')
    commander, token, path = prepare_backend(work, initialize=True)
    return commander, token, path

def message(method, identifier=1, arguments=None):
    result = {'jsonrpc':'2.0','id':identifier,'method':method}
    if arguments is not None: result['params']=arguments
    return result

def headers(token):
    return {'Authorization':'Bearer '+token,'Accept':'application/json, text/event-stream','Host':'localhost:8866'}

def test_rejects_missing_wrong_and_duplicate_authorization(backend):
    cmd, token, _ = backend
    with TestClient(create_app(cmd, token)) as client:
        for supplied in [{'Host':'localhost:8866'}, headers('x'*43), [('host','localhost:8866'),('authorization','Bearer '+token),('authorization','Bearer '+token)]]:
            response=client.post('/mcp',json=message('tools/list'),headers=supplied)
            assert response.status_code in {400,401}
            assert 'hello.txt' not in response.text

def test_rejects_host_origin_query_and_oversized_body(backend):
    cmd, token, _ = backend
    with TestClient(create_app(cmd, token)) as client:
        for extra in [{'Host':'evil.example'},{'Origin':'https://evil.example'}]:
            assert client.post('/mcp',json=message('tools/list'),headers=dict(headers(token),**extra)).status_code==403
        assert client.post('/mcp?access_token=bad',json=message('tools/list'),headers=headers(token)).status_code==400
        assert client.post('/mcp',content=b'x'*262145,headers=dict(headers(token),**{'Content-Type':'application/json'})).status_code==413

def test_real_http_mcp_readonly_tools(backend):
    cmd, token, _ = backend
    assert not cmd.allow_writes
    with TestClient(create_app(cmd, token)) as client:
        h=headers(token)
        initialized=client.post('/mcp',headers=h,json=message('initialize',arguments={'protocolVersion':'2025-11-25','capabilities':{},'clientInfo':{'name':'JAN test','version':'1'}}))
        assert initialized.status_code==200, initialized.text
        listing=client.post('/mcp',headers=h,json=message('tools/list',2))
        assert len(listing.json()['result']['tools'])==19
        read=client.post('/mcp',headers=h,json=message('tools/call',3,{'name':'jan_read_text','arguments':{'path':'hello.txt'}}))
        assert 'hello HTTP' in read.text
        denied=client.post('/mcp',headers=h,json=message('tools/call',4,{'name':'jan_write_text','arguments':{'path':'denied.txt','content':'blocked'}}))
        assert denied.status_code == 403
        assert not (cmd.workspace/'denied.txt').exists()

def test_key_is_persistent_private_and_not_in_workspace(backend):
    cmd, token, path=backend
    _, other, other_path=prepare_backend(cmd.workspace,initialize=True)
    assert other==token and other_path==path
    assert not path.is_relative_to(cmd.workspace)
    assert len(token)>=43
    if __import__('os').name=='posix': assert path.stat().st_mode & 0o077==0

def test_no_implicit_key_creation(tmp_path,monkeypatch):
    monkeypatch.setenv('JAN_MCP_STATE_DIR',str(tmp_path/'state'))
    work=tmp_path/'work';work.mkdir()
    with pytest.raises(ValueError,match='initialize'):
        prepare_backend(work,initialize=False)
    assert not (tmp_path/'state'/'http-proxy.key').exists()


def test_local_key_rotation_does_not_print_secret(backend,capsys):
    from jan_mcp_commander.http_server import main
    cmd,old,_=backend
    assert main(['--workspace',str(cmd.workspace),'--rotate-proxy-key'])==0
    output=capsys.readouterr().out
    _,new,_=prepare_backend(cmd.workspace)
    assert old!=new and old not in output and new not in output
    assert 'upload_and_restart_required' in output
