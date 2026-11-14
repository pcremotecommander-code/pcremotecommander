"""Remote entry point preserves the same origin and permission boundaries."""
import json
import pytest
from types import SimpleNamespace

from jan_mcp_commander import remote
from jan_mcp_commander.cli import main as cli_main


def fake_commander(tmp_path):
    return SimpleNamespace(_store=SimpleNamespace(path=tmp_path,tree=SimpleNamespace(
        read=lambda name,limit:(tmp_path/name).read_bytes())))


def test_unconfigured_remote_does_not_create_workspace(tmp_path, monkeypatch, capsys):
    monkeypatch.delenv('JAN_MCP_WORKSPACE', raising=False)
    monkeypatch.setattr(remote.Path, 'home', lambda: tmp_path)
    monkeypatch.setattr(remote, 'configured_workspace', lambda explicit: (_ for _ in ()).throw(ValueError('Select an existing approved workspace with --workspace')))
    assert cli_main(['remote']) == 1
    assert 'Select an existing' in capsys.readouterr().err
    assert list(tmp_path.iterdir()) == []


def test_read_only_remote_reuses_existing_transport(tmp_path, monkeypatch):
    monkeypatch.setattr(remote.cloudflare, 'require_standard_user', lambda: None)
    monkeypatch.setattr(remote.cloudflare, 'binary', lambda *_a, **_kw: tmp_path/'verified')
    monkeypatch.setattr(remote.cloudflare, 'runtime_directory', lambda *_: tmp_path)
    monkeypatch.setattr('jan_mcp_commander.http_server.prepare_backend', lambda *_a, **_kw: (fake_commander(tmp_path), 'private', None))
    calls=[]
    monkeypatch.setattr(remote.cloudflare, 'run', lambda *a, **kw: calls.append((a,kw)))
    assert cli_main(['--workspace',str(tmp_path),'remote']) == 0
    assert calls == [((tmp_path,8866),{'control_capabilities':None,'duration_minutes':60,'headless':False,'browser_channel':'chromium','show_call_details':False})]


def test_capabilities_are_explicit_and_unchanged(tmp_path, monkeypatch):
    monkeypatch.setattr(remote.cloudflare, 'require_standard_user', lambda: None)
    monkeypatch.setattr(remote.cloudflare, 'runtime_directory', lambda *_: tmp_path)
    monkeypatch.setattr(remote.cloudflare, 'binary', lambda *_a,**_kw:tmp_path/'verified')
    monkeypatch.setattr('jan_mcp_commander.http_server.prepare_backend', lambda *_a, **_kw: (fake_commander(tmp_path), 'private', None))
    observed=[]
    monkeypatch.setattr(remote.cloudflare,'run',lambda *a,**kw:observed.append(kw))
    assert cli_main(['remote','--workspace',str(tmp_path),'--capabilities','files,commands','--duration-minutes','12'])==0
    assert observed[0]['control_capabilities']==frozenset({'files','commands'})
    assert observed[0]['duration_minutes']==12
    with pytest.raises(SystemExit):
        cli_main(['remote','--workspace',str(tmp_path),'--capabilities','files,admin'])
    assert len(observed)==1


def test_auto_origin_requires_exact_worker_and_does_not_grant_control(tmp_path,monkeypatch):
    monkeypatch.setattr(remote.cloudflare,'require_standard_user',lambda:None)
    monkeypatch.setattr(remote.cloudflare,'runtime_directory',lambda *_:tmp_path)
    monkeypatch.setattr(remote.cloudflare,'binary',lambda *_a,**_kw:tmp_path/'verified')
    monkeypatch.setattr('jan_mcp_commander.http_server.prepare_backend',lambda *_a,**_kw:(fake_commander(tmp_path),'private',None))
    observed=[]
    monkeypatch.setattr(remote.cloudflare,'run',lambda *a,**kw:observed.append(kw))
    worker='https://jan-gateway.account.workers.dev'
    assert remote.main(['--workspace',str(tmp_path),'--auto-origin',worker])==0
    assert observed[0]['auto_origin']==worker
    assert observed[0]['control_capabilities'] is None
    for invalid in ('https://evil.example','http://jan-gateway.account.workers.dev','https://jan-gateway.account.workers.dev/else'):
        with pytest.raises(SystemExit): remote.main(['--workspace',str(tmp_path),'--auto-origin',invalid])
    assert len(observed)==1


def test_elevated_denial_before_private_state_and_process(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(remote.cloudflare,'require_standard_user',lambda: (_ for _ in ()).throw(ValueError('elevated')))
    monkeypatch.setattr('jan_mcp_commander.http_server.prepare_backend',lambda *_a,**_kw:pytest.fail('No state creation'))
    monkeypatch.setattr(remote.cloudflare,'run',lambda *_a,**_kw:pytest.fail('No launch'))
    assert remote.main(['--workspace',str(tmp_path)])==1
    assert 'elevated' not in capsys.readouterr().err


def test_prepare_uses_bundled_binary_and_does_not_start_transport(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(remote.cloudflare,'require_standard_user',lambda:None)
    commander=fake_commander(tmp_path)
    monkeypatch.setattr('jan_mcp_commander.http_server.prepare_backend',lambda *_a,**kw:(commander,'private',None) if kw.get('initialize') else pytest.fail('Must initialize'))
    monkeypatch.setattr(remote.cloudflare,'runtime_directory',lambda *_:tmp_path)
    downloads=[]
    monkeypatch.setattr(remote.cloudflare,'binary',lambda path,**kw:downloads.append(kw) or tmp_path/'verified')
    monkeypatch.setattr(remote.cloudflare,'run',lambda *_a,**_kw:pytest.fail('Prepare cannot launch'))
    assert remote.main(['--workspace',str(tmp_path),'--prepare'])==0
    assert downloads==[{'download':True}]
    assert json.loads(capsys.readouterr().out)['connected'] is False


def test_live_events_show_tool_outcome_without_arguments(monkeypatch, capsys):
    from jan_mcp_commander.errors import tool_errors
    from jan_mcp_commander.core import PermissionDenied
    monkeypatch.setenv('JAN_REMOTE_LIVE_EVENTS','1')
    commander=type('Commander',(),{})()
    @tool_errors(commander)
    def jan_run_command(command):
        if command=='private token':raise PermissionDenied('private token')
        return {'output':'private token'}
    assert jan_run_command('private token').is_error
    assert jan_run_command('okay')['output']=='private token'
    output=capsys.readouterr().out
    assert 'private token' not in output
    assert 'jan_run_command' in output
    assert 'denied' in output and 'completed' in output


def test_detailed_live_preview_redacts_secrets_and_file_contents(monkeypatch,capsys):
    from jan_mcp_commander.errors import tool_errors
    monkeypatch.setenv('JAN_REMOTE_LIVE_DETAILS','1')
    monkeypatch.setenv('JAN_REMOTE_LIVE_EVENTS','1')
    commander=type('Commander',(),{})()
    @tool_errors(commander)
    def jan_run_command(command, content):
        return {'exit_code':0,'output':'done','content':content}
    jan_run_command('echo hello','hidden file body')
    output=capsys.readouterr().out
    assert 'echo hello' in output and 'done' in output
    assert 'hidden file body' not in output
    assert 'client_info' in output and 'not forwarded by gateway' in output
    jan_run_command('echo bearer example-secret','more private data')
    assert 'example-secret' not in capsys.readouterr().out


def test_broken_terminal_does_not_turn_successful_action_into_failure(monkeypatch):
    from jan_mcp_commander.errors import tool_errors
    monkeypatch.setenv('JAN_REMOTE_LIVE_DETAILS','1')
    monkeypatch.setattr('builtins.print',lambda *_a,**_kw: (_ for _ in ()).throw(OSError('closed terminal')))
    commander=type('Commander',(),{})()
    calls=[]
    @tool_errors(commander)
    def jan_write_text(path, content):
        calls.append((path,content))
        return {'written':True}
    assert jan_write_text('note.txt','value')=={'written':True}
    assert calls==[('note.txt','value')]
