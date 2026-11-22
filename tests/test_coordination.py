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


def test_immediate_claim_respects_review_without_entering_the_waiting_queue(pc):
    now = [1000]
    store = Coordination(pc, clock=lambda: now[0])
    holder = claim(store, 'Previous workspace operation', ['workspace'])
    now[0] += 121
    task = store.task('create', title='Open approved app')
    target = dict(task_id=task['id'], agent='Interactive', resources=['ui'], wait=False)
    with pytest.raises(CoordinationError) as error:
        store.task('claim', **target)
    assert error.value.code == 'TASK_CONFLICT'
    current = {item['id']: item for item in store.task('list')['tasks']}
    assert current[task['id']] == task
    assert current[holder['id']]['status'] == 'needs_review'
    store.task('reconcile', task_id=holder['id'], reviewed=True)
    assert store.task('claim', **target)['status'] == 'active'


def test_eight_assignments_and_capacity_queue_promote_after_release(pc):
    store=coordinator(pc)
    active=[claim(store,str(i),[f'file:{i}.txt']) for i in range(8)]
    assert all(task['status']=='active' for task in active)
    waiting=claim(store,'ninth',['file:ninth.txt'])
    assert waiting['status']=='waiting'
    with pytest.raises(CoordinationError):
        assigned(waiting,lambda:pc.write_text('ninth.txt','not authorized yet'))
    store.task('finish',task_id=active[0]['id'],lease_token=active[0]['lease_token'],status='completed')
    assert store.task('renew',task_id=waiting['id'],lease_token=waiting['lease_token'])['status']=='active'
    assigned(waiting,lambda:pc.write_text('ninth.txt','assigned after release'))


def test_same_file_queue_is_fifo_persistent_and_never_replays_stale_edits(pc):
    store=coordinator(pc)
    first=claim(store,'first',['file:shared.txt'])
    second=claim(store,'second',['file:shared.txt'])
    third=claim(store,'third',['file:shared.txt'])
    independent=claim(store,'independent',['file:other.txt'])
    assert [second['status'],third['status'],independent['status']]==['waiting','waiting','active']
    assigned(first,lambda:pc.write_text('shared.txt','before'))
    stale=hashlib.sha256(b'before').hexdigest()
    assigned(first,lambda:pc.edit_text('shared.txt','before','first result',stale,False))
    store.task('finish',task_id=first['id'],lease_token=first['lease_token'],status='completed')
    reopened=Coordination(pc)
    assert reopened.task('renew',task_id=second['id'],lease_token=second['lease_token'])['status']=='active'
    assert reopened.task('renew',task_id=third['id'],lease_token=third['lease_token'])['status']=='waiting'
    with pytest.raises(ValueError):
        assigned(second,lambda:pc.edit_text('shared.txt','before','stale overwrite',stale,False))
    assert (pc.workspace/'shared.txt').read_text()=='first result'
    reopened.task('finish',task_id=second['id'],lease_token=second['lease_token'],status='completed')
    assert reopened.task('renew',task_id=third['id'],lease_token=third['lease_token'])['status']=='active'
    assert 'lease_token' not in str(reopened.task('list'))


def test_uncertain_owner_blocks_queue_until_review_and_old_token_stays_fenced(pc):
    now=[1000];store=Coordination(pc,clock=lambda:now[0])
    first=claim(store,'first',['file:shared.txt'])
    second=claim(store,'second',['file:shared.txt'])
    now[0]=1090
    assert store.task('renew',task_id=second['id'],lease_token=second['lease_token'])['status']=='waiting'
    now[0]=1121
    state={t['id']:t for t in store.task('list')['tasks']}
    assert state[first['id']]['status']=='needs_review'
    assert state[second['id']]['status']=='waiting'
    store.task('reconcile',task_id=first['id'],reviewed=True)
    assert store.task('renew',task_id=second['id'],lease_token=second['lease_token'])['status']=='active'
    with pytest.raises(CoordinationError):store.validate(store.load()['tasks'][first['id']],first['lease_token'])


def test_waiting_expiry_and_cancellation_never_grant_stale_token_access(pc):
    now=[1000];store=Coordination(pc,clock=lambda:now[0])
    first=claim(store,'first',['file:shared.txt'])
    expired=claim(store,'expired',['file:shared.txt'])
    now[0]=1100;store.task('renew',task_id=first['id'],lease_token=first['lease_token'])
    now[0]=1121
    assert next(t for t in store.task('list')['tasks'] if t['id']==expired['id'])['status']=='queued'
    with pytest.raises(CoordinationError):store.task('renew',task_id=expired['id'],lease_token=expired['lease_token'])
    waiting=claim(store,'cancelled',['file:shared.txt'])
    with pytest.raises(CoordinationError):store.task('finish',task_id=waiting['id'],lease_token=waiting['lease_token'],status='completed')
    assert store.task('finish',task_id=waiting['id'],lease_token=waiting['lease_token'],status='failed')['status']=='failed'
    with pytest.raises(CoordinationError):store.task('renew',task_id=waiting['id'],lease_token=waiting['lease_token'])


def test_earlier_overlapping_waiter_cannot_be_bypassed_but_cancellation_unblocks(pc):
    store=coordinator(pc)
    first=claim(store,'first',['file:a.txt'])
    exclusive=claim(store,'exclusive',['workspace'])
    later=claim(store,'later',['file:b.txt'])
    assert exclusive['status']==later['status']=='waiting'
    store.task('finish',task_id=exclusive['id'],lease_token=exclusive['lease_token'],status='failed')
    assert store.task('renew',task_id=later['id'],lease_token=later['lease_token'])['status']=='active'
    assert store.task('renew',task_id=first['id'],lease_token=first['lease_token'])['status']=='active'


def test_eight_simultaneous_independent_claims_are_persisted_without_overlap(pc):
    store=coordinator(pc)
    ids=[store.task('create',title=str(i))['id'] for i in range(8)]
    def reserve(pair):
        index,identifier=pair
        return Coordination(pc).task('claim',task_id=identifier,agent=str(index),resources=[f'file:{index}.txt'])
    with ThreadPoolExecutor(max_workers=8) as pool:
        results=list(pool.map(reserve,enumerate(ids)))
    assert all(t['status']=='active' for t in results)
    assert len({t['lease_token'] for t in results})==8
    assert len(Coordination(pc).task('list')['tasks'])==8


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


def test_conflict_scope_hash_and_tokens_are_enforced_on_old_tools(pc):
    store = coordinator(pc)
    a = claim(store, 'ChatGPT', ['file:a.txt'])
    b = claim(store, 'Claude', ['file:b.txt'])
    assigned(a, lambda: pc.write_text('a.txt', 'before'))
    assigned(b, lambda: pc.write_text('b.txt', 'independent'))
    with pytest.raises(CoordinationError, match='reserved'):
        pc.write_text('a.txt', 'other')
    with pytest.raises(CoordinationError, match='exceeds'):
        assigned(b, lambda: pc.write_text('a.txt', 'wrong'))
    with pytest.raises(CoordinationError):
        assigned({**a, 'lease_token': 'wrong'}, lambda: pc.write_text('a.txt', 'wrong'))
    stale = hashlib.sha256(b'before').hexdigest()
    (pc.workspace / 'a.txt').write_text('changed by user')
    with pytest.raises(ValueError):
        assigned(a, lambda: pc.edit_text('a.txt', 'before', 'after', stale, False))
    assert (pc.workspace / 'a.txt').read_text() == 'changed by user'
    assert 'lease_token' not in str(store.task('list'))
    assert b'ChatGPT' not in store.store.tree.read('tasks.enc')


def test_simultaneous_claim_one_winner_and_ui_commands_exclusion(pc):
    store = coordinator(pc)
    ids = [store.task('create', title=str(i))['id'] for i in range(2)]
    peers = [Coordination(pc), Coordination(pc)]
    def attempt(pair):
        peer, identifier = pair
        try:
            return peer.task('claim', task_id=identifier, agent='worker', resources=['ui'])
        except CoordinationError:
            return None
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(attempt, zip(peers, ids)))
    assert sorted(r['status'] for r in results)==['active','waiting']
    assert claim(store, 'shell', ['workspace'])['status']=='waiting'
    with pytest.raises(CoordinationError):
        pc.start_program('not-run', [])


def test_expiry_persists_uncertainty_and_reconciliation_fences_old_token(pc):
    now = [1000]
    store = Coordination(pc, clock=lambda: now[0])
    old = claim(store, 'old', ['file:nested'])
    now[0] += 121
    assert store.task('list')['tasks'][0]['status'] == 'needs_review'
    other=claim(store, 'other', ['file:nested/a.txt'])
    assert other['status']=='waiting'
    reopened = Coordination(pc, clock=lambda: now[0])
    assert reopened.task('list')['tasks'][0]['status'] == 'needs_review'
    reopened.task('finish',task_id=other['id'],lease_token=other['lease_token'],status='failed')
    reopened.task('reconcile', task_id=old['id'], reviewed=True)
    fresh = reopened.task('claim', task_id=old['id'], agent='new', resources=['file:nested'])
    assert fresh['lease_token'] != old['lease_token']
    with pytest.raises(CoordinationError):
        reopened.task('renew', task_id=old['id'], lease_token=old['lease_token'])


def test_more_than_three_independent_assignments_and_traversal_denied(pc):
    store = coordinator(pc)
    for i in range(3):
        claim(store, str(i), [f'file:{i}.txt'])
    assert claim(store, 'fourth', ['file:fourth.txt'])['status']=='active'
    with pytest.raises(ValueError):
        claim(Coordination(pc), 'unsafe', ['file:../outside'])


def test_running_process_must_stop_before_handoff_or_new_assignments(pc):
    store = coordinator(pc)
    lease = claim(store, 'process worker', ['workspace'])
    result = assigned(lease, lambda: pc.start_program(sys.executable, ['-c', 'import time; time.sleep(30)']))
    try:
        with pytest.raises(CoordinationError, match='Stop'):
            store.task('finish', task_id=lease['id'], lease_token=lease['lease_token'], status='completed')
        waiting=claim(store, 'parallel', ['file:x.txt'])
        assert waiting['status']=='waiting'
    finally:
        pc.stop_session(result['session_id'])
    assert store.task('finish', task_id=lease['id'], lease_token=lease['lease_token'], status='completed')['status'] == 'completed'
    assert store.task('renew',task_id=waiting['id'],lease_token=waiting['lease_token'])['status']=='active'


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
