import hashlib
import sys
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
import pytest
from starlette.testclient import TestClient
from jan_mcp_commander.http_server import create_app
from jan_mcp_commander.control import ControlCommander
from jan_mcp_commander.coordination import Coordination, CoordinationError, assignment, coordinator


@pytest.fixture
def pc(tmp_path, monkeypatch):
    workspace = tmp_path / 'workspace'
    workspace.mkdir()
    monkeypatch.setenv('JAN_MCP_STATE_DIR', str(tmp_path / 'private'))
    commander = ControlCommander(workspace, enabled={'files', 'commands', 'browser', 'desktop'})
    yield commander
    commander.close_control()


def claim(store, title, resources):
    task = store.task('create', title=title)
    return store.task('claim', task_id=task['id'], agent=title, resources=resources)


def assigned(task, call):
    marker = assignment.set((task['id'], task['lease_token']))
    try:
        return call()
    finally:
        assignment.reset(marker)



def test_claim_reports_review_required_for_expired_reservation_without_queueing(pc):
    now = [1000]
    store = Coordination(pc, clock=lambda: now[0])
    holder = claim(store, 'Previous workspace operation', ['workspace'])
    now[0] += 121
    task = store.task('create', title='Open approved app')
    target = dict(task_id=task['id'], agent='Interactive', resources=['ui'])
    with pytest.raises(CoordinationError) as error:
        store.task('claim', **target)
    assert error.value.code == 'TASK_REVIEW_REQUIRED'
    current = {item['id']: item for item in store.task('list')['tasks']}
    assert current[task['id']]['status'] == 'queued'
    assert current[holder['id']]['status'] == 'needs_review'
    store.task('reconcile', task_id=holder['id'], reviewed=True)
    assert store.task('claim', **target)['status'] == 'active'


def test_single_assistant_mode_allows_only_one_active_assignment(pc):
    store = coordinator(pc)
    first = claim(store, 'first', ['file:first.txt'])
    second = store.task('create', title='second')
    with pytest.raises(CoordinationError) as error:
        store.task('claim', task_id=second['id'], agent='second', resources=['file:second.txt'])
    assert error.value.code == 'TASK_CONFLICT'
    current = {item['id']: item for item in store.task('list')['tasks']}
    assert current[first['id']]['status'] == 'active'
    assert current[second['id']]['status'] == 'queued'
    store.task('finish', task_id=first['id'], lease_token=first['lease_token'], status='completed')
    assigned_second = store.task('claim', task_id=second['id'], agent='second', resources=['file:second.txt'])
    assert assigned_second['status'] == 'active'


def test_conflicting_claims_return_immediately_and_do_not_create_waiters(pc):
    store = coordinator(pc)
    first = claim(store, 'first', ['file:shared.txt'])
    second = store.task('create', title='second')
    independent = store.task('create', title='independent')
    for task, resource_name in ((second, 'file:shared.txt'), (independent, 'file:other.txt')):
        with pytest.raises(CoordinationError) as error:
            store.task('claim', task_id=task['id'], agent='next', resources=[resource_name])
        assert error.value.code == 'TASK_CONFLICT'
        listed = {item['id']: item for item in store.task('list')['tasks']}
        assert listed[task['id']]['status'] == 'queued'
        assert listed[first['id']]['status'] == 'active'
    assigned(first, lambda: pc.write_text('shared.txt', 'before'))
    stale = hashlib.sha256(b'before').hexdigest()
    assigned(first, lambda: pc.edit_text('shared.txt', 'before', 'first result', stale, False))
    store.task('finish', task_id=first['id'], lease_token=first['lease_token'], status='completed')
    second_lease = store.task('claim', task_id=second['id'], agent='next', resources=['file:shared.txt'])
    assert second_lease['status'] == 'active'
    with pytest.raises(ValueError):
        assigned(second_lease, lambda: pc.edit_text('shared.txt', 'before', 'stale overwrite', stale, False))
    with pytest.raises(CoordinationError) as error:
        store.task('claim', task_id=independent['id'], agent='next', resources=['file:other.txt'])
    assert error.value.code == 'TASK_CONFLICT'
    assert 'lease_token' not in str(store.task('list'))


def test_expired_owner_blocks_new_claims_until_review_and_fences_old_token(pc):
    now = [1000]
    store = Coordination(pc, clock=lambda: now[0])
    first = claim(store, 'first', ['file:shared.txt'])
    second = store.task('create', title='second')
    now[0] = 1121
    state = {task['id']: task for task in store.task('list')['tasks']}
    assert state[first['id']]['status'] == 'needs_review'
    with pytest.raises(CoordinationError) as error:
        store.task('claim', task_id=second['id'], agent='next', resources=['file:shared.txt'])
    assert error.value.code == 'TASK_REVIEW_REQUIRED'
    assert next(task for task in store.task('list')['tasks'] if task['id'] == second['id'])['status'] == 'queued'
    store.task('reconcile', task_id=first['id'], reviewed=True)
    fresh = store.task('claim', task_id=second['id'], agent='next', resources=['file:shared.txt'])
    assert fresh['status'] == 'active'
    with pytest.raises(CoordinationError):
        store.validate(store.load()['tasks'][first['id']], first['lease_token'])


def test_legacy_waiting_records_are_migrated_and_old_tokens_fenced(pc):
    store = coordinator(pc)
    holder = claim(store, 'holder', ['workspace'])
    old_token = 'L' * 43
    with store.store.locked():
        data = store.load()
        data['tasks']['legacy'] = {
            'id': 'legacy', 'title': 'legacy waiter', 'status': 'waiting',
            'resources': ['workspace'], 'expires_at': 9999999999,
            'queue_order': 2, 'agent': 'old assistant',
            'lease_token': old_token, 'revision': 1, 'note': '',
        }
        store.save(data)
    legacy = next(task for task in store.task('list')['tasks'] if task['id'] == 'legacy')
    assert legacy['status'] == 'queued'
    assert legacy['resources'] == []
    assert 'agent' not in legacy and 'queue_order' not in legacy
    with store.store.locked():
        assert store.load()['tasks']['legacy']['lease_token'] == ''
    with pytest.raises(CoordinationError):
        store.task('renew', task_id='legacy', lease_token=old_token)
    with pytest.raises(CoordinationError) as error:
        store.task('claim', task_id='legacy', agent='next', resources=['workspace'])
    assert error.value.code == 'TASK_CONFLICT'
    store.task('finish', task_id=holder['id'], lease_token=holder['lease_token'], status='completed')
    fresh = store.task('claim', task_id='legacy', agent='next', resources=['workspace'])
    assert fresh['status'] == 'active'
    assert fresh['lease_token'] != old_token


def test_handoff_releases_single_active_slot_without_automatic_promotion(pc):
    store = coordinator(pc)
    first = claim(store, 'first', ['file:a.txt'])
    second = store.task('create', title='second')
    with pytest.raises(CoordinationError) as error:
        store.task('claim', task_id=second['id'], agent='next', resources=['file:b.txt'])
    assert error.value.code == 'TASK_CONFLICT'
    store.task('finish', task_id=first['id'], lease_token=first['lease_token'], status='queued')
    assert next(task for task in store.task('list')['tasks'] if task['id'] == second['id'])['status'] == 'queued'
    fresh = store.task('claim', task_id=second['id'], agent='next', resources=['file:b.txt'])
    assert fresh['status'] == 'active'


def test_simultaneous_disjoint_claims_have_one_winner_and_no_waiter(pc):
    store = coordinator(pc)
    identifiers = [store.task('create', title=str(i))['id'] for i in range(2)]
    peers = [Coordination(pc), Coordination(pc)]
    def reserve(pair):
        peer, identifier = pair
        try:
            return peer.task('claim', task_id=identifier, agent='single-assistant', resources=[f'file:{identifier}.txt'])
        except CoordinationError as error:
            return error.code
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(reserve, zip(peers, identifiers)))
    assert sum(isinstance(result, dict) and result['status'] == 'active' for result in results) == 1
    assert results.count('TASK_CONFLICT') == 1
    statuses = {task['id']: task['status'] for task in store.task('list')['tasks']}
    assert sorted(statuses.values()) == ['active', 'queued']
    assert 'waiting' not in statuses.values()

@pytest.mark.skipif(sys.platform != 'win32', reason='Windows short-name aliases')
def test_short_alias_cannot_bypass_reservation(pc):
    import ctypes
    path = pc.workspace / 'CollaborationLongFileName.txt'
    path.write_text('before')
    buffer = ctypes.create_unicode_buffer(32768)
    assert ctypes.windll.kernel32.GetShortPathNameW(str(path), buffer, len(buffer))
    alias = Path(buffer.value).name
    if '~' not in alias:
        pytest.skip('8.3 aliases disabled on this volume')
    claim(coordinator(pc), 'reserved', ['file:' + path.name])
    with pytest.raises(ValueError, match='short-name'):
        pc.edit_text(alias, 'before', 'after', hashlib.sha256(b'before').hexdigest(), False)
    assert path.read_text() == 'before'


@pytest.mark.skipif(sys.platform != 'win32', reason='Windows short-name aliases')
def test_short_alias_rejected_by_shared_path_policy(pc):
    from jan_mcp_commander.safe_fs import parts
    for path in ('LONGFI~1.TXT', 'LONGDI~1/new.txt', 'file~1.txt'):
        with pytest.raises(ValueError, match='short-name'):
            parts(path)
    assert parts('normal-file.txt') == ('normal-file.txt',)



def test_conflict_scope_hash_and_tokens_are_enforced_in_single_assistant_mode(pc):
    store = coordinator(pc)
    first = claim(store, 'ChatGPT', ['file:a.txt'])
    second = store.task('create', title='second task')
    assigned(first, lambda: pc.write_text('a.txt', 'before'))
    with pytest.raises(CoordinationError, match='owns this resource'):
        pc.write_text('a.txt', 'other')
    with pytest.raises(CoordinationError, match='exceeds'):
        assigned(first, lambda: pc.write_text('b.txt', 'wrong'))
    with pytest.raises(CoordinationError):
        assigned({**first, 'lease_token': 'wrong'}, lambda: pc.write_text('a.txt', 'wrong'))
    stale = hashlib.sha256(b'before').hexdigest()
    (pc.workspace / 'a.txt').write_text('changed by user')
    with pytest.raises(ValueError):
        assigned(first, lambda: pc.edit_text('a.txt', 'before', 'after', stale, False))
    assert (pc.workspace / 'a.txt').read_text() == 'changed by user'
    assert 'lease_token' not in str(store.task('list'))
    with pytest.raises(CoordinationError) as error:
        store.task('claim', task_id=second['id'], agent='second', resources=['file:b.txt'])
    assert error.value.code == 'TASK_CONFLICT'
    store.task('finish', task_id=first['id'], lease_token=first['lease_token'], status='completed')
    second_lease = store.task('claim', task_id=second['id'], agent='second', resources=['file:b.txt'])
    assigned(second_lease, lambda: pc.write_text('b.txt', 'independent'))
    assert (pc.workspace / 'b.txt').read_text() == 'independent'


def test_simultaneous_claims_have_one_winner_and_block_workspace_commands(pc):
    store = coordinator(pc)
    identifiers = [store.task('create', title=str(i))['id'] for i in range(2)]
    peers = [Coordination(pc), Coordination(pc)]
    def attempt(pair):
        peer, identifier = pair
        try:
            return peer.task('claim', task_id=identifier, agent='single-assistant', resources=['workspace'])
        except CoordinationError as error:
            return error.code
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(attempt, zip(peers, identifiers)))
    assert sum(isinstance(result, dict) and result['status'] == 'active' for result in results) == 1
    assert results.count('TASK_CONFLICT') == 1
    with pytest.raises(CoordinationError):
        pc.start_program('not-run', [])


def test_expiry_requires_review_and_reconciliation_fences_old_token(pc):
    now = [1000]
    store = Coordination(pc, clock=lambda: now[0])
    old = claim(store, 'old', ['file:nested'])
    other = store.task('create', title='other')
    now[0] += 121
    assert store.task('list')['tasks'][0]['status'] == 'needs_review'
    with pytest.raises(CoordinationError) as error:
        store.task('claim', task_id=other['id'], agent='next', resources=['file:nested/a.txt'])
    assert error.value.code == 'TASK_REVIEW_REQUIRED'
    assert next(task for task in store.task('list')['tasks'] if task['id'] == other['id'])['status'] == 'queued'
    reopened = Coordination(pc, clock=lambda: now[0])
    assert reopened.task('list')['tasks'][0]['status'] == 'needs_review'
    reopened.task('reconcile', task_id=old['id'], reviewed=True)
    fresh = reopened.task('claim', task_id=old['id'], agent='new', resources=['file:nested'])
    assert fresh['lease_token'] != old['lease_token']
    with pytest.raises(CoordinationError):
        reopened.task('renew', task_id=old['id'], lease_token=old['lease_token'])


def test_single_active_assignment_and_path_traversal_are_enforced(pc):
    store = coordinator(pc)
    first = claim(store, 'first', ['file:0.txt'])
    second = store.task('create', title='second')
    with pytest.raises(CoordinationError) as error:
        store.task('claim', task_id=second['id'], agent='next', resources=['file:1.txt'])
    assert error.value.code == 'TASK_CONFLICT'
    unsafe = store.task('create', title='unsafe')
    with pytest.raises(ValueError):
        store.task('claim', task_id=unsafe['id'], agent='unsafe', resources=['file:../outside'])
    store.task('finish', task_id=first['id'], lease_token=first['lease_token'], status='completed')
    assert store.task('claim', task_id=second['id'], agent='next', resources=['file:1.txt'])['status'] == 'active'


def test_running_process_must_stop_before_handoff_or_new_assignments(pc):
    store = coordinator(pc)
    lease = claim(store, 'process worker', ['workspace'])
    result = assigned(lease, lambda: pc.start_program(sys.executable, ['-c', 'import time; time.sleep(30)']))
    second = store.task('create', title='parallel')
    try:
        with pytest.raises(CoordinationError, match='Stop'):
            store.task('finish', task_id=lease['id'], lease_token=lease['lease_token'], status='completed')
        with pytest.raises(CoordinationError) as error:
            store.task('claim', task_id=second['id'], agent='next', resources=['file:x.txt'])
        assert error.value.code == 'TASK_CONFLICT'
        assert next(task for task in store.task('list')['tasks'] if task['id'] == second['id'])['status'] == 'queued'
    finally:
        pc.stop_session(result['session_id'])
    assert store.task('finish', task_id=lease['id'], lease_token=lease['lease_token'], status='completed')['status'] == 'completed'
    assigned_second = store.task('claim', task_id=second['id'], agent='next', resources=['file:x.txt'])
    assert assigned_second['status'] == 'active'

def test_recent_history_prunes_only_finished_tasks(pc):
    store = coordinator(pc)
    with store.store.locked():
        data = store.load()
        for i in range(100):
            data['tasks'][str(i)] = {'id': str(i), 'title': 'history', 'status': 'completed' if i == 0 else 'queued', 'resources': [], 'revision': 0, 'note': ''}
        store.save(data)
    created = store.task('create', title='New task')
    with store.store.locked():
        data = store.load()
        assert '0' not in data['tasks']
        assert created['id'] in data['tasks']
        assert '1' in data['tasks'] and len(data['tasks']) == 100


def test_active_reservations_remain_visible_when_history_grows(pc):
    store = coordinator(pc)
    lease = claim(store, 'Must stay visible', ['ui'])
    for i in range(25):
        store.task('create', title=f'queued {i}')
    listed = store.task('list')
    assert listed['tasks'][0]['id'] == lease['id']
    assert len(listed['tasks']) == 20 and listed['truncated']


def test_failed_workflow_requires_review_before_task_release_and_new_lease(pc):
    store = coordinator(pc)
    lease = claim(store, 'uncertain workflow', ['ui'])
    with store.store.locked():
        data = store.load()
        data['runs']['synthetic'] = {'task_id': lease['id'], 'status': 'unknown', 'workflow': {'id': 'workflow'}}
        store.save(data)
    with pytest.raises(CoordinationError, match='browser run'):
        store.task('finish', task_id=lease['id'], lease_token=lease['lease_token'], status='queued')
    store.task('reconcile', task_id=lease['id'], reviewed=True)
    with store.store.locked():
        assert store.load()['runs']['synthetic']['status'] == 'abandoned_after_review'
    with pytest.raises(CoordinationError):
        store.task('renew', task_id=lease['id'], lease_token=lease['lease_token'])


def test_finishing_abandons_only_unstarted_remaining_steps_while_handoff_preserves_them(pc):
    store = coordinator(pc)
    lease = claim(store, 'handoff workflow', ['ui'])
    with store.store.locked():
        data = store.load()
        data['runs']['ready'] = {'task_id': lease['id'], 'status': 'ready'}
        store.save(data)
    store.task('finish', task_id=lease['id'], lease_token=lease['lease_token'], status='queued')
    with store.store.locked():
        assert store.load()['runs']['ready']['status'] == 'ready'
    fresh = store.task('claim', task_id=lease['id'], agent='next assistant', resources=['ui'])
    store.task('finish', task_id=fresh['id'], lease_token=fresh['lease_token'], status='completed')
    with store.store.locked():
        assert store.load()['runs']['ready']['status'] == 'abandoned_after_review'


def test_coordinated_capture_preserves_mcp_image_content_without_real_screen_access(pc, monkeypatch):
    store = coordinator(pc)
    lease = claim(store, 'synthetic image', ['ui'])
    monkeypatch.setattr(pc, '_browser_action', lambda *args: {'mime_type': 'image/png', 'data': 'aGVsbG8=', 'width': 1})
    token = 'x' * 43
    headers = {'Authorization': 'Bearer ' + token, 'Accept': 'application/json, text/event-stream', 'Host': 'localhost:8866', 'X-JAN-Control': '1'}
    with TestClient(create_app(pc, token)) as client:
        response = client.post('/mcp', headers=headers, json={'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call', 'params': {'name': 'jan_coordinated_call', 'arguments': {'name': 'jan_browser', 'arguments': {'action': 'screenshot'}, 'task_id': lease['id'], 'lease_token': lease['lease_token']}}})
        result = response.json()['result']
        assert not result.get('isError'), result
        assert result['content'][1] == {'type': 'image', 'data': 'aGVsbG8=', 'mimeType': 'image/png'}


def test_concurrent_same_file_edits_allow_one_hash_checked_writer(pc):
    lease = claim(coordinator(pc), 'shared assignment', ['file:shared.txt'])
    assigned(lease, lambda: pc.write_text('shared.txt', 'before'))
    digest = hashlib.sha256(b'before').hexdigest()
    def edit(value):
        try:
            return assigned(lease, lambda: pc.edit_text('shared.txt', 'before', value, digest, False))
        except ValueError:
            return None
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(edit, ['first writer', 'second writer']))
    assert sum(result is not None for result in results) == 1
    assert (pc.workspace / 'shared.txt').read_text() in {'first writer', 'second writer'}


def test_interrupted_assignment_blocks_legacy_writes_until_review(pc):
    now = [1000]
    store = Coordination(pc, clock=lambda: now[0])
    setattr(pc, '_coordination', store)
    lease = claim(store, 'interrupted worker', ['file:abandoned.txt'])
    now[0] += 121
    assert store.task('list')['tasks'][0]['status'] == 'needs_review'
    with pytest.raises(CoordinationError):
        assigned(lease, lambda: pc.write_text('abandoned.txt', 'must not execute'))
    with pytest.raises(CoordinationError):
        pc.write_text('abandoned.txt', 'must not execute')
    assert not (pc.workspace / 'abandoned.txt').exists()
    store.task('reconcile', task_id=lease['id'], reviewed=True)
    fresh = store.task('claim', task_id=lease['id'], agent='replacement', resources=['file:abandoned.txt'])
    assigned(fresh, lambda: pc.write_text('abandoned.txt', 'reviewed replacement'))
    assert (pc.workspace / 'abandoned.txt').read_text() == 'reviewed replacement'
