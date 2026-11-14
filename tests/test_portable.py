import json
import pytest
from jan_mcp_commander.portable import PortableCommander
from jan_mcp_commander.core import PermissionDenied

@pytest.fixture
def cmd(tmp_path, monkeypatch):
    monkeypatch.setenv('JAN_MCP_ALLOW_WRITES', '1')
    work = tmp_path / 'work'
    work.mkdir()
    return PortableCommander(work, tmp_path / 'audit.jsonl')

def test_recovery_and_protected_backup(cmd):
    cmd.write_text('a.txt', 'before')
    backup = cmd.write_text('a.txt', 'after', True)['backup_id']
    with pytest.raises(PermissionDenied):
        cmd.read_text('.jan-mcp-backups/' + backup + '.bak')
    cmd.restore_backup(backup)
    assert cmd.read_text('a.txt')['content'] == 'before'

@pytest.mark.parametrize('path', ['../outside', 'a.txt:stream', 'C:\\Windows\\a.txt'])
def test_portable_paths_denied(cmd, path):
    with pytest.raises(PermissionDenied):
        cmd.write_text(path, 'no')

def test_profiles_and_sessions(cmd):
    cmd.write_text('hello.txt', 'hello')
    result = cmd.run_profile('list_workspace')
    assert result['exit_code'] == 0 and 'hello.txt' in result['output']
    assert not result['running'] and not result['timed_out']
    assert not cmd.list_sessions()['sessions']
    result = cmd.run_profile('disk_usage')
    assert json.loads(result['output'])['free'] >= 0

def test_unknown_command_and_timeout_denied(cmd):
    with pytest.raises(PermissionDenied):
        cmd.start_session('powershell')
    with pytest.raises(PermissionDenied):
        cmd.run_profile('list_workspace', True)

def test_audit_failure_prevents_launch(cmd, monkeypatch):
    cmd.audit_path = cmd.workspace / 'no-parent' / 'audit'
    (cmd.workspace / 'no-parent').write_text('blocked')
    def unexpected(*a, **k):
        pytest.fail('Must not launch when audit is unavailable')
    monkeypatch.setattr('subprocess.Popen', unexpected)
    with pytest.raises(PermissionDenied):
        cmd.start_session('list_workspace')

def test_background_deadline_without_polling(cmd, monkeypatch):
    import sys
    import time
    monkeypatch.setattr('jan_mcp_commander.portable.SESSION_LIFETIME', 0.1)
    monkeypatch.setattr(cmd, '_argv', lambda _: [sys.executable, '-c', 'import time; time.sleep(30)'])
    info = cmd.start_session('test')
    entry = cmd._sessions[info['session_id']]
    assert entry['done'].wait(5), 'Deadline must terminate idle sessions without client polling'
    assert entry['timed_out'] and entry['process'].poll() is not None
    cmd.stop_session(info['session_id'])

def test_output_cap_terminates_process(cmd, monkeypatch):
    import sys
    from jan_mcp_commander.advanced import MAX_OUTPUT
    monkeypatch.setattr(cmd, '_argv', lambda _: [sys.executable, '-c', 'import sys,time; sys.stdout.write("x"*100000); sys.stdout.flush(); time.sleep(30)'])
    info = cmd.start_session('test')
    entry = cmd._sessions[info['session_id']]
    assert entry['done'].wait(5)
    assert entry['truncated'] and len(entry['output']) == MAX_OUTPUT
    cmd.stop_session(info['session_id'])

def test_written_bytes_and_reported_size_match_on_each_os(cmd):
    text = 'Tamil: தமிழ்\nsecond line\r\nlast line'
    result = cmd.write_text('text.txt', text)
    assert (cmd.workspace / 'text.txt').read_bytes() == text.encode('utf-8')
    assert result['bytes'] == len(text.encode('utf-8'))
    assert cmd.read_text('text.txt')['content'] == text


@pytest.mark.skipif(__import__('os').name != 'nt', reason='Windows path semantics')
def test_windows_relative_separators(cmd):
    (cmd.workspace / 'nested').mkdir()
    cmd.write_text(r'nested\sample.txt', 'before')
    assert cmd.read_text('nested/sample.txt')['content'] == 'before'
    assert cmd.file_info(r'nested\sample.txt')['sha256'] == cmd.file_info('nested/sample.txt')['sha256']
    backup = cmd.write_text(r'nested\sample.txt', 'after', overwrite=True)['backup_id']
    assert cmd.read_text(r'nested\sample.txt')['content'] == 'after'
    cmd.restore_backup(backup)
    assert cmd.read_text('nested/sample.txt')['content'] == 'before'
    from jan_mcp_commander.coordination import resource
    assert resource(r'file:nested\sample.txt') == resource('file:nested/sample.txt')

@pytest.mark.parametrize('name', [r'..\escape.txt', r'nested\..\escape.txt', r'C:\escape.txt', r'\\server\share\file.txt', r'nested\sample.txt:stream', r'nested\.env', r'nested\NUL'])
def test_windows_separator_escape_denied(cmd, name):
    with pytest.raises((PermissionDenied, ValueError)):
        cmd.write_text(name, 'denied')
