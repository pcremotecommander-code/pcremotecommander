"""Regressions for reproduced production-backend vulnerabilities."""
import os
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import pytest
from jan_mcp_commander.portable import PortableCommander
from jan_mcp_commander.core import PermissionDenied
from jan_mcp_commander.security import PrivateStore

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


def test_private_store_resource_locks_allow_independent_resources(cmd):
    barrier = threading.Barrier(2)
    def work(resource):
        with cmd._store.resource_locked(resource):
            barrier.wait(timeout=3)
            return resource
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(work, ('file:a.txt', 'file:b.txt')))
    assert set(results) == {'file:a.txt', 'file:b.txt'}


def test_private_store_resource_lock_serializes_same_resource(cmd):
    entered = threading.Event()
    release = threading.Event()
    second_entered = threading.Event()
    def first():
        with cmd._store.resource_locked('file:shared.txt'):
            entered.set()
            assert release.wait(timeout=3)
    def second():
        assert entered.wait(timeout=3)
        with cmd._store.resource_locked('file:shared.txt'):
            second_entered.set()
    with ThreadPoolExecutor(max_workers=2) as pool:
        first_future = pool.submit(first)
        second_future = pool.submit(second)
        assert entered.wait(timeout=3)
        assert not second_entered.wait(timeout=0.15)
        release.set()
        first_future.result(timeout=3)
        second_future.result(timeout=3)
    assert second_entered.is_set()


def _resource_lock_process_worker(state_dir, workspace, connection):
    try:
        store = PrivateStore(state_dir, workspace)
        with store.resource_locked('file:cross-process.txt'):
            connection.send('acquired')
            if connection.recv() != 'release':
                raise RuntimeError('Unexpected parent message')
    except BaseException as exc:
        connection.send(('error', repr(exc)))
    finally:
        connection.close()



def _resource_lock_crash_worker(state_dir, workspace, connection):
    store = PrivateStore(state_dir, workspace)
    with store.resource_locked('file:crash-recovery.txt'):
        connection.send('acquired')
        connection.recv()


def test_private_store_resource_lock_recovers_after_process_crash(tmp_path):
    import multiprocessing
    ctx = multiprocessing.get_context('spawn')
    workspace = tmp_path / 'workspace'
    state_dir = tmp_path / 'private-state'
    workspace.mkdir()
    store = PrivateStore(state_dir, workspace)
    parent, child = ctx.Pipe()
    process = ctx.Process(target=_resource_lock_crash_worker,
                          args=(state_dir, workspace, child))
    process.start()
    try:
        assert parent.poll(8), 'Child did not acquire resource lock'
        assert parent.recv() == 'acquired'
        with store.try_resource_locked('file:crash-recovery.txt') as acquired:
            assert acquired is False, 'Live child lock was not detected'
        process.terminate()
        process.join(timeout=5)
        assert not process.is_alive(), 'Child process did not terminate'
        with store.try_resource_locked('file:crash-recovery.txt') as acquired:
            assert acquired is True, 'OS lock remained held after child process exit'
    finally:
        if process.is_alive():
            process.terminate()
            process.join(timeout=2)
        parent.close()
        child.close()


def test_private_store_resource_lock_serializes_separate_processes(tmp_path):
    import multiprocessing
    ctx = multiprocessing.get_context('spawn')
    workspace = tmp_path / 'workspace'
    state_dir = tmp_path / 'private-state'
    workspace.mkdir()
    first_parent, first_child = ctx.Pipe()
    second_parent, second_child = ctx.Pipe()
    first = ctx.Process(target=_resource_lock_process_worker,
                        args=(state_dir, workspace, first_child))
    second = ctx.Process(target=_resource_lock_process_worker,
                         args=(state_dir, workspace, second_child))
    first.start()
    try:
        assert first_parent.poll(8), 'First process did not acquire the resource lock'
        first_message = first_parent.recv()
        assert first_message == 'acquired', first_message
        second.start()
        assert not second_parent.poll(0.5), 'Second process acquired a held resource lock'
        first_parent.send('release')
        assert second_parent.poll(8), 'Second process did not acquire after release'
        second_message = second_parent.recv()
        assert second_message == 'acquired', second_message
        second_parent.send('release')
        first.join(timeout=5)
        second.join(timeout=5)
        assert first.exitcode == 0
        assert second.exitcode == 0
    finally:
        for process in (first, second):
            if process.is_alive():
                process.terminate()
            if process.pid is not None:
                process.join(timeout=2)
        first_parent.close()
        second_parent.close()



def test_private_store_try_resource_lock_reports_held_then_available(cmd):
    store = cmd._store
    with store.resource_locked('file:recovery-probe.txt'):
        def probe():
            with store.try_resource_locked('file:recovery-probe.txt') as acquired:
                return acquired
        with ThreadPoolExecutor(max_workers=1) as pool:
            assert pool.submit(probe).result(timeout=3) is False
    with store.try_resource_locked('file:recovery-probe.txt') as acquired:
        assert acquired is True
