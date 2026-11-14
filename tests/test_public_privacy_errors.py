"""Privacy denials are actionable without echoing sensitive command input or output."""
import json
import pytest
from jan_mcp_commander.core import PermissionDenied
from jan_mcp_commander.errors import public_error,tool_errors
from jan_mcp_commander.privacy import assert_public_text,RULES


def test_local_throttling_is_not_reported_as_workspace_permission_failure(tmp_path,monkeypatch):
    from jan_mcp_commander.control import ControlCommander
    import time
    monkeypatch.setenv('JAN_MCP_STATE_DIR',str(tmp_path/'private'))
    workspace=tmp_path/'workspace';workspace.mkdir()
    pc=ControlCommander(workspace,enabled={'files'})
    try:
        pc._requests=[time.monotonic()]*120
        with pytest.raises(PermissionDenied) as denied:pc._rate()
        result=public_error(denied.value)
        assert result['error_code']=='RATE_LIMITED'
        assert '60 seconds' in result['error']
        assert len(pc._requests)==120
    finally:pc.close_control()


def test_media_worker_timeout_is_not_reported_as_invalid_user_arguments(monkeypatch):
    import subprocess
    from jan_mcp_commander import media_tools
    monkeypatch.setattr(media_tools,'options',lambda *a,**k:{})
    monkeypatch.setattr(media_tools,'snapshot',lambda *a,**k:(b'synthetic',{}))
    def timeout(*args,**kwargs):raise subprocess.TimeoutExpired('synthetic-media-worker',15)
    monkeypatch.setattr(media_tools.subprocess,'run',timeout)
    with pytest.raises(ValueError) as denied:media_tools.process_media(None,None,'fixture.wav','transcribe','audio')
    assert public_error(denied.value)['error_code']=='MEDIA_PROCESSING_TIMEOUT'


def test_privacy_denial_has_specific_code_and_safe_fixed_message():
    with pytest.raises(ValueError) as denied:
        assert_public_text('password=synthetic-private-fixture')
    result=public_error(denied.value)
    assert result['error_code']=='SENSITIVE_CONTENT_BLOCKED'
    assert 'synthetic-private-fixture' not in json.dumps(result)
    assert 'before retrying' in result['error']


def test_wrapped_privacy_denial_keeps_its_category_without_cause_text():
    try:
        try:raise ValueError(RULES['error'])
        except ValueError as exc:raise ValueError('wrapper synthetic detail') from exc
    except ValueError as exc:result=public_error(exc)
    assert result['error_code']=='SENSITIVE_CONTENT_BLOCKED'
    assert 'synthetic detail' not in json.dumps(result)


def test_unrelated_input_errors_are_not_reclassified_as_privacy():
    result=public_error(ValueError('password=synthetic-untrusted-error'))
    assert result['error_code']=='INVALID_ARGUMENT'
    assert 'synthetic-untrusted-error' not in json.dumps(result)


def test_mcp_guard_returns_specific_privacy_error_without_content():
    class Commander:pass
    @tool_errors(Commander())
    def operation():assert_public_text('password=synthetic-mcp-fixture')
    result=operation()
    value=result.model_dump(by_alias=True)
    assert value['isError']
    assert value['structuredContent']['error_code']=='SENSITIVE_CONTENT_BLOCKED'
    assert 'synthetic-mcp-fixture' not in result.model_dump_json()


@pytest.mark.skipif(__import__('os').name!='nt',reason='Windows compound PowerShell command')
def test_compound_command_output_privacy_denial_does_not_claim_no_execution(tmp_path,monkeypatch):
    from jan_mcp_commander.control import ControlCommander
    workspace=tmp_path/'workspace';workspace.mkdir()
    monkeypatch.setenv('JAN_MCP_STATE_DIR',str(tmp_path/'private'))
    commander=ControlCommander(workspace,enabled={'commands'})
    command="Set-Content -LiteralPath marker.txt -Value 'public-marker'; Write-Output ('pass'+'word='+'synthetic-command-fixture')"
    try:
        with pytest.raises(ValueError) as denied:commander.run_command(command,shell='powershell')
        result=public_error(denied.value)
        assert result['error_code']=='SENSITIVE_CONTENT_BLOCKED'
        assert 'synthetic-command-fixture' not in json.dumps(result)
        assert 'inspect the action state before retrying' in result['error']
        assert (workspace/'marker.txt').read_text().strip()=='public-marker'
        assert not commander._sessions
    finally:commander.close_control()
