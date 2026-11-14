import json
import os
import time
from pathlib import Path

import pytest

from jan_mcp_commander.advanced import AdvancedCommander
from jan_mcp_commander.core import PermissionDenied


@pytest.fixture
def cmd(tmp_path, monkeypatch):
    monkeypatch.setenv('JAN_MCP_ALLOW_WRITES', '1')
    work = tmp_path / 'work'
    work.mkdir()
    return AdvancedCommander(work, tmp_path / 'state' / 'audit.jsonl')


def test_status_advanced(cmd):
    x = cmd.status()
    assert x['stage'] == '2.6' and not x['remote_enabled']
    assert 'start_session' in x['advanced_tools']


def test_file_info(cmd):
    (cmd.workspace / 'a.txt').write_text('abc')
    assert cmd.file_info('a.txt')['bytes'] == 3


def test_reject_file_info_outside(cmd, tmp_path):
    (tmp_path / 'outside').write_text('no')
    with pytest.raises(PermissionDenied):
        cmd.file_info('../outside')


def test_find_files(cmd):
    (cmd.workspace / 'notes.txt').write_text('hello')
    (cmd.workspace / 'nested').mkdir()
    (cmd.workspace / 'nested' / 'notes2.txt').write_text('hello')
    assert len(cmd.find_files('notes')['matches']) == 2


def test_filename_search_can_be_scoped_without_escaping_workspace(cmd):
    (cmd.workspace / 'outside-notes.txt').write_text('unrelated')
    (cmd.workspace / 'qa').mkdir()
    (cmd.workspace / 'qa' / 'notes.txt').write_text('synthetic')
    assert cmd.find_files('notes', path='qa')['matches'] == ['qa/notes.txt']
    for path in ['../outside', '.ssh', 'C:/outside']:
        with pytest.raises(ValueError):
            cmd.find_files('notes', path=path)


def test_find_files_does_not_traverse_symlink(cmd, tmp_path):
    outside = tmp_path / 'outside'; outside.mkdir()
    (outside / 'notes-secret.txt').write_text('secret')
    try:(cmd.workspace / 'outlink').symlink_to(outside, target_is_directory=True)
    except OSError as exc:
        if getattr(exc,'winerror',None)==1314:pytest.skip('Windows user lacks symlink creation privilege')
        raise
    assert cmd.find_files('secret')['matches'] == []


def test_new_write_and_read(cmd):
    assert cmd.write_text('new.txt', 'hello')['backup_id'] is None
    assert cmd.read_text('new.txt')['content'] == 'hello'


@pytest.mark.parametrize('extension', ['py', 'js', 'ts', 'tsx', 'html', 'css', 'json', 'yaml', 'sql', 'rs', 'cpp', 'sh', 'ps1', 'md'])
def test_source_code_extensions_support_read_write_and_recovery(cmd, extension):
    name = 'example.' + extension
    original = '// Unicode source: café — नमस्ते\n'
    cmd.write_text(name, original)
    assert cmd.read_text(name)['content'] == original
    updated = cmd.write_text(name, original + '// changed\n', overwrite=True)
    assert updated['backup_id']
    cmd.restore_backup(updated['backup_id'])
    assert cmd.read_text(name)['content'] == original


def test_no_implicit_overwrite(cmd):
    cmd.write_text('doc.txt', 'first')
    with pytest.raises(PermissionDenied):
        cmd.write_text('doc.txt', 'second')
    assert cmd.read_text('doc.txt')['content'] == 'first'


def test_backup_and_restore(cmd):
    cmd.write_text('doc.txt', 'first')
    item = cmd.write_text('doc.txt', 'second', overwrite=True)
    assert item['backup_id']
    restored = cmd.restore_backup(item['backup_id'])
    assert restored['restored'] == 'doc.txt'
    assert cmd.read_text('doc.txt')['content'] == 'first'
    assert restored['previous_version_backup_id']


def test_reject_bad_backup_id(cmd):
    with pytest.raises(PermissionDenied):
        cmd.restore_backup('../../foo')


def test_reject_write_outside(cmd, tmp_path):
    with pytest.raises(PermissionDenied):
        cmd.write_text('../bad.txt', 'bad')
    assert not (tmp_path / 'bad.txt').exists()


def test_reject_symlink_write(cmd, tmp_path):
    outside = tmp_path / 'outside.txt'; outside.write_text('untouched')
    try:(cmd.workspace / 'link').symlink_to(outside)
    except OSError as exc:
        if getattr(exc,'winerror',None)==1314:pytest.skip('Windows user lacks symlink creation privilege')
        raise
    with pytest.raises(PermissionDenied):
        cmd.write_text('link', 'modified', overwrite=True)
    assert outside.read_text() == 'untouched'


def test_backup_directory_protected(cmd):
    cmd.write_text('file.txt', 'first')
    item = cmd.write_text('file.txt', 'second', overwrite=True)
    with pytest.raises(PermissionDenied):
        cmd.file_info('.jan-mcp-backups/' + item['backup_id'] + '.bak')


def test_reject_big_content(cmd):
    with pytest.raises(PermissionDenied):
        cmd.write_text('big.txt', 'x' * 65537)


def test_sessions_lifecycle(cmd):
    info = cmd.start_session('list_workspace')
    assert len(info['session_id']) == 32
    assert cmd.list_sessions()['sessions']
    for _ in range(30):
        data = cmd.session_output(info['session_id'])
        if not data['running']:
            break
        time.sleep(0.03)
    assert 'output' in data
    assert not data['running']
    assert cmd.stop_session(info['session_id'])['stopped'] == info['session_id']
    assert cmd.list_sessions()['sessions'] == []


def test_unknown_profile_denied(cmd):
    with pytest.raises(PermissionDenied):
        cmd.start_session('rm -rf')


def test_unknown_session_denied(cmd):
    with pytest.raises(PermissionDenied):
        cmd.stop_session('notreal')


def test_audit_records(cmd):
    cmd.write_text('audit.txt', 'ok')
    records = [json.loads(s) for s in cmd.audit_path.read_text().splitlines()]
    assert records[-1]['action'] == 'write_text'
    assert records[-1]['ok'] is True
    if os.name == 'posix':
        assert cmd.audit_path.stat().st_mode & 0o077 == 0


def test_file_info_hashes_small_binary_without_text_decoding(cmd):
    import hashlib
    payload=b'RIFF\x00\xff\x01PCRC_QA'
    (cmd.workspace/'sample.wav').write_bytes(payload)
    result=cmd.file_info('sample.wav')
    assert result['bytes']==len(payload)
    assert result['sha256']==hashlib.sha256(payload).hexdigest()
    (cmd.workspace/'large.wav').write_bytes(b'x'*65537)
    large=cmd.file_info('large.wav')
    assert large['bytes']==65537 and 'sha256' not in large
