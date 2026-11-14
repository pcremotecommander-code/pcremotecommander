"""Regressions for reproduced production-backend vulnerabilities."""
import os
from pathlib import Path
import pytest
from jan_mcp_commander.portable import PortableCommander
from jan_mcp_commander.core import PermissionDenied

@pytest.fixture
def cmd(tmp_path, monkeypatch):
    monkeypatch.setenv('JAN_MCP_ALLOW_WRITES', '1')
    work = tmp_path / 'work'
    work.mkdir()
    return PortableCommander(work, tmp_path / 'state' / 'audit.jsonl')

def test_secret_file_denied(cmd):
    (cmd.workspace / '.env').write_text('API_TOKEN=synthetic-test-only')
    with pytest.raises(PermissionDenied):
        cmd.read_text('.env')
    assert '.env' not in [x['name'] for x in cmd.list_files()['entries']]


@pytest.mark.skipif(os.name != 'nt', reason='Windows short-name aliases')
def test_sensitive_file_short_alias_denied(cmd):
    import ctypes
    path = cmd.workspace / '.env.production'
    path.write_text('SYNTHETIC_ONLY')
    buffer = ctypes.create_unicode_buffer(32768)
    assert ctypes.windll.kernel32.GetShortPathNameW(str(path), buffer, len(buffer))
    alias = Path(buffer.value).name
    if '~' not in alias:
        pytest.skip('8.3 aliases disabled on this volume')
    with pytest.raises(PermissionDenied):
        cmd.read_text(alias)

def test_hardlink_denied(cmd, tmp_path):
    outside = tmp_path / 'outside.txt'
    outside.write_text('synthetic-test-only')
    os.link(outside, cmd.workspace / 'alias.txt')
    with pytest.raises(PermissionDenied):
        cmd.read_text('alias.txt')

def test_backup_symlink_does_not_write_outside(cmd, tmp_path):
    outside = tmp_path / 'outside'; outside.mkdir()
    try:
        (cmd.workspace / '.jan-mcp-backups').symlink_to(outside, target_is_directory=True)
    except OSError as exc:
        pytest.skip('OS did not permit creation of a test symlink: ' + str(exc))
    cmd.write_text('a.txt', 'first')
    cmd.write_text('a.txt', 'second', overwrite=True)
    assert list(outside.iterdir()) == []

def test_audit_failure_prevents_mutation(cmd, tmp_path):
    blocked = tmp_path / 'blocked'; blocked.write_text('file')
    cmd.audit_path = blocked / 'audit.jsonl'
    with pytest.raises(PermissionDenied):
        cmd.write_text('must-not-exist.txt', 'test')
    assert not (cmd.workspace / 'must-not-exist.txt').exists()

def test_read_only_default(tmp_path, monkeypatch):
    monkeypatch.delenv('JAN_MCP_ALLOW_WRITES', raising=False)
    work = tmp_path / 'work'; work.mkdir()
    cmd = PortableCommander(work, tmp_path / 'state' / 'audit.jsonl')
    with pytest.raises(PermissionDenied, match='Read-only'):
        cmd.write_text('a.txt', 'blocked')
    assert not (work / 'a.txt').exists()
    assert cmd.status()['read_only']

def test_encrypted_backup_and_tamper_denied(cmd):
    cmd.write_text('a.txt', 'synthetic confidential recovery text')
    identifier = cmd.write_text('a.txt', 'new', True)['backup_id']
    blob = cmd._store.path / (identifier + '.enc')
    data = blob.read_bytes()
    assert b'synthetic confidential recovery text' not in data
    blob.write_bytes(data[:-1] + bytes([data[-1] ^ 1]))
    with pytest.raises(PermissionDenied):
        cmd.restore_backup(identifier)
    assert cmd.read_text('a.txt')['content'] == 'new'

@pytest.mark.parametrize('name', ['.env.local', 'sub/../a', '.ssh/id_rsa', 'NUL.txt', 'a:stream', 'a\\b', 'key.pem', 'a\x1b.txt'])
def test_denied_write_paths(cmd, name):
    with pytest.raises(PermissionDenied):
        cmd.write_text(name, 'test')

def test_exclusive_create_race_does_not_overwrite(cmd, monkeypatch):
    if os.name != 'posix':
        pytest.skip('POSIX exclusive-link race; Windows uses exclusive rename')
    link = os.link
    def race(source, target, **kwargs):
        (cmd.workspace / 'race.txt').write_text('appeared concurrently')
        return link(source, target, **kwargs)
    monkeypatch.setattr(os, 'link', race)
    with pytest.raises(PermissionDenied):
        cmd.write_text('race.txt', 'must not replace')
    assert (cmd.workspace / 'race.txt').read_text() == 'appeared concurrently'

def test_audit_symlink_denied_before_mutation(cmd, tmp_path):
    outside = tmp_path / 'external-log'; outside.write_text('untouched')
    audit = cmd.audit_path
    try:
        audit.symlink_to(outside)
    except OSError as exc:
        pytest.skip('OS did not permit creation of a test symlink: ' + str(exc))
    with pytest.raises(PermissionDenied):
        cmd.write_text('no.txt', 'blocked')
    assert outside.read_text() == 'untouched'
    assert not (cmd.workspace / 'no.txt').exists()

def test_file_size_limit_and_private_key_content(cmd):
    for data in ['x' * 65537, '-----BEGIN PRIVATE KEY-----\nsynthetic']:
        with pytest.raises(PermissionDenied):
            cmd.write_text('a.txt', data)

def test_rate_limit(cmd):
    for _ in range(120):
        cmd.list_files()
    with pytest.raises(PermissionDenied, match='Request limit'):
        cmd.list_files()

def test_secret_names_not_leaked_by_profile(cmd):
    (cmd.workspace / '.env').write_text('synthetic')
    assert '.env' not in cmd.run_profile('list_workspace')['output']

def test_git_execution_disabled(cmd):
    with pytest.raises(PermissionDenied):
        cmd.start_session('git_status')

def test_authenticated_audit_records_detect_content_changes(cmd):
    import importlib.util
    script = Path(__file__).resolve().parents[1] / 'scripts/security_check.py'
    spec = importlib.util.spec_from_file_location('jan_security_check', script)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    cmd.status()
    assert module.verify_audit(cmd)
    cmd.audit_path.write_bytes(cmd.audit_path.read_bytes().replace(b'local status', b'altered text'))
    assert not module.verify_audit(cmd)

def test_state_cannot_be_inside_workspace(tmp_path, monkeypatch):
    monkeypatch.setenv('JAN_MCP_STATE_DIR', str(tmp_path / 'private'))
    with pytest.raises(PermissionDenied):
        PortableCommander(tmp_path)
    assert not (tmp_path / 'private').exists()

def test_backup_is_bound_to_canonical_workspace(cmd, tmp_path):
    cmd.write_text('a.txt', 'first')
    identifier = cmd.write_text('a.txt', 'second', True)['backup_id']
    other = tmp_path / 'other-workspace'; other.mkdir()
    other_cmd = PortableCommander(other, cmd.audit_path)
    with pytest.raises(PermissionDenied):
        other_cmd.restore_backup(identifier)
    assert not (other / 'a.txt').exists()
