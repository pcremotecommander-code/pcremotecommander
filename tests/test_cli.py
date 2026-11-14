import json
from pathlib import Path
import subprocess
import sys
import pytest
from jan_mcp_commander.cli import Console, Request, main, parse_request, workspace_path
from jan_mcp_commander.core import PermissionDenied
from jan_mcp_commander.portable import PortableCommander


@pytest.fixture
def cmd(tmp_path, monkeypatch):
    monkeypatch.setenv('JAN_MCP_ALLOW_WRITES', '1')
    work = tmp_path / 'workspace'
    work.mkdir()
    return PortableCommander(work, tmp_path / 'audit.jsonl')


@pytest.mark.parametrize(('text', 'expected'), [
    ('show status', Request('status')),
    ('LIST FILES', Request('list', '.')),
    ('list files in "Reports 2026"', Request('list', 'Reports 2026')),
    ('read file "My Notes.txt"', Request('read', 'My Notes.txt')),
    ('find files named Report', Request('find', 'Report')),
    ('show disk space', Request('disk')),
    ('git status', Request('git')),
    ('overwrite file Notes.txt', Request('overwrite', 'Notes.txt')),
])
def test_english_aliases(text, expected):
    assert parse_request(text) == expected


@pytest.mark.parametrize('text', ['powershell Get-Process', 'rm -rf /', 'disk usage; whoami', 'fix my computer', 'restore ../../x'])
def test_no_shell_fallback(text, monkeypatch):
    monkeypatch.setattr(subprocess, 'Popen', lambda *a, **k: pytest.fail('Must not execute unknown commands'))
    with pytest.raises(ValueError):
        parse_request(text)


def test_multiline_write_and_explicit_overwrite_restore(cmd):
    lines = iter(['line one', '', '..end', '.end'])
    console = Console(cmd, reader=lambda _: next(lines), writer=lambda _: None)
    console.execute(parse_request('write file "My Notes.txt"'), interactive=True)
    assert cmd.read_text('My Notes.txt')['content'] == 'line one\n\n.end'
    with pytest.raises(PermissionDenied):
        console.execute(parse_request('write My Notes.txt'), content='unapproved replacement')
    result = console.execute(parse_request('overwrite My Notes.txt'), content='new')
    console.execute(parse_request('restore ' + result['backup_id']))
    assert cmd.read_text('My Notes.txt')['content'] == 'line one\n\n.end'


def test_cancelled_and_oversize_writes_have_no_effect(cmd):
    for values in [['some text', '.cancel'], ['x' * 65537]]:
        lines = iter(values)
        console = Console(cmd, reader=lambda _: next(lines), writer=lambda _: None)
        with pytest.raises(ValueError):
            console.execute(parse_request('write cancelled.txt'), interactive=True)
        assert not (cmd.workspace / 'cancelled.txt').exists()


def test_cli_path_boundaries_and_noninteractive_write(cmd):
    console = Console(cmd)
    with pytest.raises(PermissionDenied):
        console.execute(parse_request('write ../outside'), content='bad')
    with pytest.raises(ValueError, match='--content'):
        console.execute(parse_request('write note.txt'))
    with pytest.raises(ValueError, match='interactive'):
        console.execute(parse_request('start session list_workspace'))


def test_repl_recovers_and_closes_owned_sessions(cmd):
    commands = iter(['start session list_workspace', 'unknown request', 'show status', 'exit'])
    output = []
    console = Console(cmd, reader=lambda _: next(commands), writer=output.append)
    console.run()
    assert not cmd._sessions
    assert any('Command not understood' in line for line in output)
    assert any('interactive-cli' in line for line in output)


def test_terminal_content_controls_are_escaped(cmd):
    cmd.write_text('unsafe.txt', '\x1b[2Jclear\x07')
    output = []
    console = Console(cmd, writer=output.append)
    console.show(console.execute(parse_request('read unsafe.txt')))
    assert '\x1b' not in output[0] and '\x07' not in output[0]
    assert '\\x1b' in output[0]


def test_json_cli_writes_reads_and_returns_failure(cmd, capsys):
    base = ['--workspace', str(cmd.workspace), '--json']
    assert main(base + ['--command', 'write Notes.txt', '--content', 'hello\nworld']) == 0
    assert json.loads(capsys.readouterr().out)['bytes'] == 11
    assert main(base + ['read', 'Notes.txt']) == 0
    assert json.loads(capsys.readouterr().out)['content'] == 'hello\nworld'
    assert main(base + ['--command', 'read ../outside']) == 1
    assert 'error' in json.loads(capsys.readouterr().out)


def test_workspace_flag_and_environment_precedence(tmp_path, monkeypatch):
    monkeypatch.setenv('JAN_MCP_WORKSPACE', str(tmp_path / 'from-env'))
    assert workspace_path() == tmp_path / 'from-env'
    assert workspace_path(str(tmp_path / 'explicit')) == tmp_path / 'explicit'


def test_real_cli_process_on_current_os(cmd):
    invocation = [sys.executable, '-m', 'jan_mcp_commander.cli', '--workspace', str(cmd.workspace)]
    proc = subprocess.run(invocation, input='write hello.txt\nfrom interactive CLI\n.end\nread hello.txt\nexit\n',
                          text=True, capture_output=True, timeout=20)
    assert proc.returncode == 0, proc.stderr
    assert 'from interactive CLI' in proc.stdout
    assert (cmd.workspace / 'hello.txt').read_text() == 'from interactive CLI'
    result = subprocess.run(invocation + ['--json', '--command', 'disk usage'],
                            text=True, capture_output=True, timeout=20)
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout)['exit_code'] == 0


def test_exit_stops_owned_process_when_audit_becomes_unavailable(cmd, monkeypatch):
    monkeypatch.setattr(cmd, '_argv', lambda _: [sys.executable, '-c', 'import time; time.sleep(30)'])
    session = cmd.start_session('test')
    entry = cmd._sessions[session['session_id']]
    def unavailable(*a, **k):
        raise PermissionDenied('Audit unavailable')
    monkeypatch.setattr(cmd, '_audit', unavailable)
    Console(cmd).close()
    assert entry['process'].poll() is not None
    assert not cmd._sessions


def test_new_default_workspace_is_pcrc_and_existing_configuration_is_preserved(tmp_path,monkeypatch):
    import jan_mcp_commander.cli as cli
    monkeypatch.delenv('JAN_MCP_WORKSPACE',raising=False)
    monkeypatch.setattr(cli,'__file__',str(tmp_path/'src'/'package'/'cli.py'))
    monkeypatch.setattr(Path,'home',classmethod(lambda cls:tmp_path/'home'))
    assert cli.workspace_path()==tmp_path/'home'/'PCRC-Workspace'
    saved=tmp_path/'existing'/'JAN-Workspace'
    (tmp_path/'connection.json').write_text(json.dumps({'workspace':str(saved)}))
    assert cli.workspace_path()==saved
    assert not saved.exists()
