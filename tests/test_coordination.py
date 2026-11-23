from contextlib import contextmanager
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
    with store.store.locked():
        outcomes = [record for record in store.load()['operations'].values()
                    if record.get('state') == 'failed']
    assert len(outcomes) == 1
    assert 'before mutation' in outcomes[0]['note']
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
    # A forcibly stopped command may have made partial changes. Reconcile
    # its uncertain operation explicitly instead of treating stop as success.
    reviewed = store.task('reconcile', task_id=lease['id'], reviewed=True)
    assert reviewed['status'] == 'queued'
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



def test_operation_recovery_marks_abandoned_record_for_review_without_replay(pc):
    store = coordinator(pc)
    operation = {
        'id': 'operation-dead',
        'state': 'active',
        'resources': ['file:recovery.txt'],
        'owner': 'dead-process',
        'started_at': 1000,
    }
    with store.store.locked():
        data = store.load()
        data['operations']['operation-dead'] = operation
        store.save(data)

    result = store.recover_operations()
    assert result == {'recovered': ['operation-dead'], 'busy': [], 'changed': []}
    with store.store.locked():
        recovered = store.load()['operations']['operation-dead']
    assert recovered['state'] == 'needs_review'
    assert recovered['owner'] == 'dead-process'
    assert recovered['recovered_at'] > 0
    assert 'never replay' in recovered['note']


def test_operation_recovery_keeps_live_resource_operation_active(pc):
    store = coordinator(pc)
    operation = {
        'id': 'operation-live',
        'state': 'active',
        'resources': ['file:live.txt', 'file:live-child.txt'],
        'owner': 'live-process',
        'started_at': 1000,
    }
    with store.store.locked():
        data = store.load()
        data['operations']['operation-live'] = operation
        store.save(data)

    with store.store.resource_locked('file:live-child.txt'):
        with ThreadPoolExecutor(max_workers=1) as pool:
            result = pool.submit(store.recover_operations).result(timeout=5)
    assert result == {'recovered': [], 'busy': ['operation-live'], 'changed': []}
    with store.store.locked():
        assert store.load()['operations']['operation-live']['state'] == 'active'


def test_operation_recovery_does_not_overwrite_a_changed_record(pc, monkeypatch):
    store = coordinator(pc)
    operation = {
        'id': 'operation-raced',
        'state': 'active',
        'resources': ['file:raced.txt'],
        'owner': 'owner-a',
        'started_at': 1000,
    }
    with store.store.locked():
        data = store.load()
        data['operations']['operation-raced'] = operation
        store.save(data)

    original = store.store.try_resource_locked

    @contextmanager
    def change_during_probe(resource_id):
        with original(resource_id) as acquired:
            if acquired:
                with store.store.locked():
                    latest = store.load()
                    latest['operations']['operation-raced']['owner'] = 'owner-b'
                    store.save(latest)
            yield acquired

    monkeypatch.setattr(store.store, 'try_resource_locked', change_during_probe)
    result = store.recover_operations()
    assert result == {'recovered': [], 'busy': [], 'changed': ['operation-raced']}
    with store.store.locked():
        current = store.load()['operations']['operation-raced']
    assert current['state'] == 'active'
    assert current['owner'] == 'owner-b'



def test_operation_recovery_fails_closed_on_malformed_resource_metadata(pc):
    store = coordinator(pc)
    with store.store.locked():
        data = store.load()
        data['operations']['operation-malformed'] = {
            'id': 'operation-malformed',
            'state': 'active',
            'resources': ['file:../outside'],
            'owner': 'unknown',
            'started_at': 1000,
        }
        store.save(data)

    result = store.recover_operations()
    assert result == {'recovered': [], 'busy': [], 'changed': ['operation-malformed']}
    with store.store.locked():
        assert store.load()['operations']['operation-malformed']['state'] == 'active'



def test_guard_registers_operation_and_keeps_claim_waiting_until_release(pc):
    store = coordinator(pc)
    with store.guard(['file:guarded.txt']):
        with store.store.locked():
            data = store.load()
            active = [r for r in data['operations'].values() if r['state'] == 'active']
        assert len(active) == 1
        assert active[0]['resources'] == ['file:guarded.txt']

        task = store.task('create', title='wait for guarded resource')
        waiting = store.task('claim', task_id=task['id'], agent='worker',
                             resources=['file:guarded.txt'])
        assert waiting['status'] == 'waiting'

    with store.store.locked():
        data = store.load()
        completed = [r for r in data['operations'].values()
                     if r['id'] == active[0]['id']]
    assert len(completed) == 1
    assert completed[0]['state'] == 'completed'
    promoted = store.task('renew', task_id=waiting['id'],
                          lease_token=waiting['lease_token'])
    assert promoted['status'] == 'active'


def test_guard_allows_independent_resources_to_overlap(pc):
    store = coordinator(pc)
    entered = []
    from threading import Event, Lock
    first_entered = Event()
    release_first = Event()
    second_entered = Event()
    guard = Lock()

    def first():
        with store.guard(['file:first.txt']):
            with guard:
                entered.append('first')
            first_entered.set()
            assert release_first.wait(5)

    def second():
        assert first_entered.wait(5)
        with store.guard(['file:second.txt']):
            with guard:
                entered.append('second')
            second_entered.set()

    with ThreadPoolExecutor(max_workers=2) as pool:
        one = pool.submit(first)
        two = pool.submit(second)
        assert second_entered.wait(5), 'independent operation was serialized'
        release_first.set()
        one.result(timeout=5)
        two.result(timeout=5)
    assert entered == ['first', 'second']



def test_nested_guard_cannot_widen_outer_resource_scope(pc):
    store = coordinator(pc)
    with store.guard(['file:parent.txt']):
        with store.guard(['file:parent.txt/child.txt']):
            pass
        with pytest.raises(CoordinationError, match='nested operation cannot widen'):
            with store.guard(['file:unrelated.txt']):
                pytest.fail('widened nested operation executed')



def test_operation_reservation_does_not_consume_active_task_quota(pc):
    store = coordinator(pc)
    for index in range(7):
        claim(store, f'active task {index}', [f'file:task-{index}.txt'])

    with store.guard(['file:independent-operation.txt']):
        task = store.task('create', title='eighth task')
        claimed = store.task('claim', task_id=task['id'], agent='worker',
                             resources=['file:eighth-task.txt'])
        assert claimed['status'] == 'active'



def test_task_handoff_and_reconciliation_require_operation_review(pc):
    store = coordinator(pc)
    lease = claim(store, 'operation-owned task', ['file:operation.txt'])
    with store.store.locked():
        data = store.load()
        data['operations']['uncertain-operation'] = {
            'id': 'uncertain-operation',
            'state': 'needs_review',
            'resources': ['file:operation.txt'],
            'owner': {'pid': 999999, 'thread': 1},
            'task_id': lease['id'],
            'started_at': 1000,
            'note': 'simulated interrupted write',
        }
        store.save(data)

    with pytest.raises(CoordinationError, match='coordinated operation'):
        store.task('finish', task_id=lease['id'], lease_token=lease['lease_token'],
                   status='completed')

    with pytest.raises(CoordinationError, match='confirm reconciliation'):
        store.task('reconcile', task_id=lease['id'], reviewed=False)

    reconciled = store.task('reconcile', task_id=lease['id'], reviewed=True)
    assert reconciled['status'] == 'queued'
    with store.store.locked():
        operation = store.load()['operations']['uncertain-operation']
    assert operation['state'] == 'abandoned_after_review'
    assert operation['task_id'] == lease['id']


def test_task_reconciliation_cannot_release_live_operation_lock(pc):
    store = coordinator(pc)
    lease = claim(store, 'live operation task', ['file:live-operation.txt'])
    entered = __import__('threading').Event()
    release = __import__('threading').Event()

    def hold_resource():
        with store.store.resource_locked('file:live-operation.txt'):
            entered.set()
            assert release.wait(5)

    with ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(hold_resource)
        assert entered.wait(5)
        with store.store.locked():
            data = store.load()
            data['operations']['still-live'] = {
                'id': 'still-live',
                'state': 'active',
                'resources': ['file:live-operation.txt'],
                'owner': {'pid': 999999, 'thread': 2},
                'task_id': lease['id'],
                'started_at': 1000,
            }
            store.save(data)
        try:
            with pytest.raises(CoordinationError, match='still holds its resource lock'):
                store.task('reconcile', task_id=lease['id'], reviewed=True)
            with store.store.locked():
                assert store.load()['operations']['still-live']['state'] == 'active'
            assert store.task('renew', task_id=lease['id'],
                              lease_token=lease['lease_token'])['status'] == 'active'
        finally:
            release.set()
            future.result(timeout=5)



def test_reconciliation_cannot_reopen_a_finished_task_for_late_operation_record(pc):
    store = coordinator(pc)
    lease = claim(store, 'finished task', ['file:finished.txt'])
    store.task('finish', task_id=lease['id'], lease_token=lease['lease_token'],
               status='completed')
    with store.store.locked():
        data = store.load()
        data['operations']['late-review'] = {
            'id': 'late-review',
            'state': 'needs_review',
            'resources': ['file:finished.txt'],
            'owner': {'pid': 999999, 'thread': 3},
            'task_id': lease['id'],
            'started_at': 1000,
        }
        store.save(data)

    with pytest.raises(CoordinationError, match='confirm reconciliation'):
        store.task('reconcile', task_id=lease['id'], reviewed=True)
    assert store.task('list')['tasks'][0]['status'] == 'completed'



def test_two_recovery_workers_cannot_both_reconcile_same_operation(pc):
    store = coordinator(pc)
    operation = {
        'id': 'operation-double-recovery',
        'state': 'active',
        'resources': ['file:double-recovery.txt'],
        'owner': {'pid': 999999, 'thread': 1},
        'started_at': 1000,
    }
    with store.store.locked():
        data = store.load()
        data['operations'][operation['id']] = operation
        store.save(data)

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: store.recover_operations(), range(2)))

    assert sum(result['recovered'] == [operation['id']] for result in results) == 1
    assert sum(result['busy'] == [operation['id']] for result in results) == 1
    with store.store.locked():
        assert store.load()['operations'][operation['id']]['state'] == 'needs_review'


def test_operation_registration_and_task_claim_are_mutually_exclusive(pc):
    store = coordinator(pc)
    task = store.task('create', title='race operation against reservation')
    barrier = __import__('threading').Barrier(2)
    entered = __import__('threading').Event()
    release = __import__('threading').Event()

    def operation():
        barrier.wait(timeout=5)
        try:
            with store.guard(['file:race-registration.txt']):
                entered.set()
                assert release.wait(5)
                return 'operation'
        except CoordinationError as exc:
            assert exc.code == 'TASK_CONFLICT'
            return 'blocked'

    def reservation():
        barrier.wait(timeout=5)
        return store.task('claim', task_id=task['id'], agent='racing-claim',
                          resources=['file:race-registration.txt'])

    with ThreadPoolExecutor(max_workers=2) as pool:
        operation_future = pool.submit(operation)
        claim_future = pool.submit(reservation)
        claimed = claim_future.result(timeout=5)
        if claimed['status'] == 'active':
            assert operation_future.result(timeout=5) == 'blocked'
        else:
            assert claimed['status'] == 'waiting'
            assert entered.wait(5)
            release.set()
            assert operation_future.result(timeout=5) == 'operation'
            promoted = store.task('renew', task_id=claimed['id'],
                                  lease_token=claimed['lease_token'])
            assert promoted['status'] == 'active'
    release.set()



def test_orphaned_operation_requires_explicit_review_to_release(pc):
    store = coordinator(pc)
    operation_id = 'orphaned-operation'
    with store.store.locked():
        data = store.load()
        data['operations'][operation_id] = {
            'id': operation_id,
            'state': 'active',
            'resources': ['file:orphaned-resource.txt'],
            'owner': {'pid': 999999, 'thread': 9},
            'task_id': None,
            'started_at': 1000,
        }
        store.save(data)

    with pytest.raises(CoordinationError, match='explicitly confirm'):
        store.task('reconcile_operation', operation_id=operation_id, reviewed=False)

    result = store.task('reconcile_operation', operation_id=operation_id, reviewed=True)
    assert result == {'operation_id': operation_id,
                      'state': 'abandoned_after_review', 'task_id': None}
    with store.store.locked():
        record = store.load()['operations'][operation_id]
    assert record['state'] == 'abandoned_after_review'
    assert record['reviewed_at'] > 0


def test_orphaned_operation_cannot_be_reconciled_while_resource_lock_is_live(pc):
    store = coordinator(pc)
    operation_id = 'live-orphaned-operation'
    with store.store.locked():
        data = store.load()
        data['operations'][operation_id] = {
            'id': operation_id,
            'state': 'active',
            'resources': ['file:live-orphaned-resource.txt'],
            'owner': {'pid': 999999, 'thread': 10},
            'task_id': None,
            'started_at': 1000,
        }
        store.save(data)

    with store.store.resource_locked('file:live-orphaned-resource.txt'):
        with pytest.raises(CoordinationError, match='not in a reviewable state'):
            store.task('reconcile_operation', operation_id=operation_id, reviewed=True)
        with store.store.locked():
            assert store.load()['operations'][operation_id]['state'] == 'active'



def test_synchronous_command_keeps_outer_workspace_operation_scope(pc, monkeypatch):
    store = coordinator(pc)
    done = __import__('threading').Event()
    done.set()
    pc._sessions['fake-session'] = {'profile': 'operator_command', 'done': done}
    observed = {}

    def fake_start_process(command, shell):
        observed['scope'] = store.depth.get()
        return {'session_id': 'fake-session'}

    monkeypatch.setattr(pc, 'start_process', fake_start_process)
    monkeypatch.setattr(pc, 'session_output', lambda session_id: {'exit_code': 0})
    monkeypatch.setattr(pc, 'stop_session', lambda session_id: {'stopped': session_id})

    result = pc.run_command('true')
    assert result['exit_code'] == 0
    assert observed['scope'] == ('workspace',)
    with store.store.locked():
        records = [r for r in store.load()['operations'].values()
                   if r.get('resources') == ['workspace']]
    assert records[-1]['state'] == 'completed'


def test_browser_teaching_runs_inside_ui_operation_scope(pc, monkeypatch):
    store = coordinator(pc)
    from jan_mcp_commander import browser_teaching

    def fake_workflow(commander, action, options):
        return {'scope': coordinator(commander).depth.get(), 'action': action}

    monkeypatch.setattr(browser_teaching, 'workflow_action', fake_workflow)
    result = pc.browser_workflow('inspect', {})
    assert result == {'scope': ('ui',), 'action': 'inspect'}
    with store.store.locked():
        records = [r for r in store.load()['operations'].values()
                   if r.get('resources') == ['ui']]
    assert records[-1]['state'] == 'completed'



def test_live_owned_command_blocks_workspace_but_allows_its_stdin(pc):
    import queue
    from threading import Event
    store = coordinator(pc)
    done = Event()
    input_queue = queue.Queue(maxsize=4)
    pc._sessions['live-command'] = {
        'profile': 'operator_command',
        'done': done,
        'input_queue': input_queue,
        'input_closed': False,
    }
    try:
        with pytest.raises(CoordinationError, match='owned command is still running'):
            with store.guard(['file:while-command-runs.txt']):
                pytest.fail('workspace operation entered during live command')

        queued = pc.process_input('live-command', 'continue')
        assert queued == {'queued': True, 'delivery_verified': False}
        assert input_queue.get_nowait() == b'continue\n'

        done.set()
        with store.guard(['file:after-command.txt']):
            pass
    finally:
        pc._sessions.pop('live-command', None)


def test_detached_command_reservation_survives_request_process_scope(pc):
    import time
    store = coordinator(pc)
    result = pc.start_program(
        sys.executable, ['-c', 'import sys,time; sys.stdin.readline(); time.sleep(1)'],
        timeout_seconds=10)
    entry = pc._sessions[result['session_id']]
    assert result['pid'] == entry['child_pid']
    assert result['supervisor_pid'] == entry['supervisor_pid']

    other = ControlCommander(pc.workspace, enabled={'files', 'commands', 'browser', 'desktop'})
    try:
        with coordinator(other).store.locked():
            records = [record for record in coordinator(other).load()['operations'].values()
                       if record.get('kind') == 'detached_command'
                       and record.get('state') == 'active']
        assert len(records) == 1
        assert records[0]['resources'] == ['workspace']
        assert records[0]['owner']['supervisor_pid'] == result['supervisor_pid']
        assert records[0]['owner']['child_pid'] == result['pid']
        assert records[0]['lock_resources'] == [entry['process'].pcrc_lock_resource, entry['process'].pcrc_owner_lock_resource]
        assert pc.process_input(result['session_id'], 'still-running')['queued'] is True
        with pytest.raises(CoordinationError, match='another or uncertain operation'):
            with coordinator(other).guard(['file:while-child-runs.txt']):
                pytest.fail('another commander entered while detached child was running')

        assert entry['done'].wait(10)
        with coordinator(other).store.locked():
            completed = coordinator(other).load()['operations'][records[0]['id']]
        assert completed['state'] == 'completed', (completed.get('note'), entry['process'].returncode, getattr(entry['process'], 'pcrc_terminated', False), entry.get('callback_error'))
        with coordinator(other).guard(['file:after-child-exits.txt']):
            pass
    finally:
        other.close_control()


def test_supervisor_crash_keeps_child_lock_until_child_exits(pc):
    store = coordinator(pc)
    result = pc.start_program(sys.executable, ['-c', 'import time; time.sleep(2)'],
                              timeout_seconds=10)
    entry = pc._sessions[result['session_id']]
    with store.store.locked():
        data = store.load()
        record_id = next(key for key, value in data['operations'].items()
                         if value.get('kind') == 'detached_command'
                         and value.get('state') == 'active')
    # Kill only the supervisor. On POSIX the child inherited the OS lock;
    # on Windows the session finalizer uses the current process-tree cleanup path.
    entry['process'].kill()
    entry['process'].wait(timeout=10)
    first_probe = store.recover_operations()
    if first_probe.get('busy'):
        assert record_id in first_probe['busy']
    assert entry['done'].wait(10)

    store.recover_operations()
    with store.store.locked():
        record = store.load()['operations'][record_id]
    assert record['state'] == 'needs_review'
    assert 'never replay' in record['note'].lower()


@pytest.mark.skipif(sys.platform != 'linux', reason='Linux subreaper descendant containment')
def test_detached_grandchild_is_terminated_before_workspace_reservation_releases(pc, tmp_path):
    import os
    import time

    store = coordinator(pc)
    pid_file = tmp_path / 'escaped-grandchild.pid'
    grandchild = (
        "import time; "
        "f=open(" + repr(str(pid_file)) + ", 'w'); "
        "f.write(str(__import__('os').getpid())); f.flush(); f.close(); "
        "time.sleep(30)"
    )
    parent = (
        "import subprocess,sys,time; "
        "subprocess.Popen([sys.executable,'-c'," + repr(grandchild) + "], "
        "start_new_session=True, close_fds=True, "
        "stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); "
        "time.sleep(0.3)"
    )
    result = pc.start_program(sys.executable, ['-c', parent], timeout_seconds=10)
    entry = pc._sessions[result['session_id']]
    assert entry['done'].wait(10)
    assert pid_file.exists(), 'detached grandchild did not start'
    pid = int(pid_file.read_text())
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            break
        time.sleep(0.05)
    else:
        pytest.fail('escaped grandchild survived supervisor cleanup')
    with store.store.locked():
        records = [record for record in store.load()['operations'].values()
                   if record.get('kind') == 'detached_command']
    assert records[-1]['state'] == 'needs_review'


@pytest.mark.skipif(sys.platform != 'linux', reason='Linux subreaper parent-death containment')
def test_parent_crash_keeps_reservation_until_escaped_descendants_exit(pc, tmp_path):
    import multiprocessing
    import os
    import select
    import time

    state_dir = str(pc._store.path)
    pid_file = tmp_path / 'parent-death-grandchild.pid'
    context = multiprocessing.get_context('spawn')
    receive, send = context.Pipe(duplex=False)
    worker = context.Process(
        target=_linux_parent_death_worker,
        args=(state_dir, str(pc.workspace), str(pid_file), send),
    )
    worker.start()
    send.close()
    try:
        child_info = receive.recv()
        assert 'child_pid' in child_info, child_info
        grandchild_info = receive.recv()
        assert 'grandchild_pid' in grandchild_info, grandchild_info
        worker.join(15)
        assert worker.exitcode == 0

        for pid in (child_info['child_pid'], grandchild_info['grandchild_pid']):
            try:
                pidfd = os.pidfd_open(pid, 0)
            except ProcessLookupError:
                continue  # Already exited and reaped.
            try:
                ready, _, _ = select.select([pidfd], [], [], 10)
                assert ready, f'process {pid} survived PCRC parent death'
            finally:
                os.close(pidfd)

        store = coordinator(pc)
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            recovery = store.recover_operations()
            if recovery.get('recovered'):
                break
            time.sleep(0.05)
        with store.store.locked():
            records = [record for record in store.load()['operations'].values()
                       if record.get('kind') == 'detached_command']
        assert records and records[-1]['state'] == 'needs_review'
    finally:
        if worker.is_alive():
            worker.terminate()
            worker.join(5)
        receive.close()


@pytest.mark.skipif(sys.platform != 'win32', reason='Windows Job Object parent-death containment')
def test_windows_parent_crash_terminates_job_descendants(pc, tmp_path):
    import ctypes
    import multiprocessing
    import time

    pid_file = tmp_path / 'windows-parent-death-grandchild.pid'
    context = multiprocessing.get_context('spawn')
    parent, child = context.Pipe(duplex=True)
    worker = context.Process(
        target=_windows_parent_death_worker,
        args=(str(pc._store.path), str(pc.workspace), str(pid_file), child),
    )
    worker.start()
    child.close()
    handles = []
    try:
        child_info = parent.recv()
        assert 'child_pid' in child_info, child_info
        grandchild_info = parent.recv()
        assert 'grandchild_pid' in grandchild_info, grandchild_info

        kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel32.OpenProcess.argtypes = [ctypes.c_uint32, ctypes.c_int, ctypes.c_uint32]
        kernel32.OpenProcess.restype = ctypes.c_void_p
        kernel32.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
        kernel32.WaitForSingleObject.restype = ctypes.c_uint32
        kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
        for pid in (child_info['child_pid'], grandchild_info['grandchild_pid']):
            handle = kernel32.OpenProcess(0x00100000, False, pid)  # SYNCHRONIZE
            assert handle, f'could not open live process {pid} before parent death'
            handles.append(handle)

        parent.send('exit')
        worker.join(15)
        assert worker.exitcode == 0
        for handle in handles:
            assert kernel32.WaitForSingleObject(handle, 10000) == 0, (
                'a Job Object descendant survived PCRC parent death'
            )

        store = coordinator(pc)
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            recovery = store.recover_operations()
            if recovery.get('recovered'):
                break
            time.sleep(0.05)
        with store.store.locked():
            records = [record for record in store.load()['operations'].values()
                       if record.get('kind') == 'detached_command']
        assert records and records[-1]['state'] == 'needs_review'
    finally:
        for handle in handles:
            kernel32.CloseHandle(handle)
        if worker.is_alive():
            worker.terminate()
            worker.join(5)
        parent.close()


@pytest.mark.skipif(sys.platform != 'win32', reason='Windows nested Job Object compatibility')
def test_windows_detached_command_runs_inside_existing_parent_job(pc):
    import ctypes
    import multiprocessing
    from ctypes import wintypes
    from jan_mcp_commander.session_guard import create_windows_job_handle, close_windows_job_handle

    context = multiprocessing.get_context('spawn')
    receive, send = context.Pipe(duplex=True)
    worker = context.Process(
        target=_windows_nested_job_worker,
        args=(str(pc._store.path), str(pc.workspace), send),
    )
    parent_job = create_windows_job_handle()
    process_handle = None
    try:
        worker.start()
        send.close()
        assert receive.recv() == {'ready': True}

        kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel32.OpenProcess.restype = wintypes.HANDLE
        kernel32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
        kernel32.AssignProcessToJobObject.restype = wintypes.BOOL
        process_handle = kernel32.OpenProcess(
            0x0100 | 0x0001 | 0x0400, False, worker.pid)  # SET_QUOTA | TERMINATE | QUERY
        assert process_handle, 'could not open nested-job worker process'
        if not kernel32.AssignProcessToJobObject(wintypes.HANDLE(parent_job), process_handle):
            error = ctypes.get_last_error()
            raise AssertionError(f'Windows runner does not permit nested Job Objects (error {error})')

        receive.send(True)
        result = receive.recv()
        assert 'error' not in result, result
        assert result['exit_code'] == 0, result
        assert 'nested-job-ok' in result['output'], result
        worker.join(15)
        assert worker.exitcode == 0
    finally:
        if worker.is_alive():
            worker.terminate()
            worker.join(5)
        if process_handle:
            kernel32.CloseHandle(process_handle)
        close_windows_job_handle(parent_job)
        receive.close()


@pytest.mark.skipif(sys.platform != 'win32', reason='Windows Job Object containment')
def test_windows_job_terminates_descendant_when_direct_command_exits(pc, tmp_path):
    import ctypes
    import time

    store = coordinator(pc)
    pid_file = tmp_path / 'job-descendant.pid'
    release_file = tmp_path / 'release-parent-command'
    grandchild = (
        "import time; "
        "f=open(" + repr(str(pid_file)) + ", 'w'); "
        "f.write(str(__import__('os').getpid())); f.flush(); f.close(); "
        "time.sleep(30)"
    )
    wait_for_grandchild = (
        "while (not os.path.exists(" + repr(str(pid_file)) +
        ") or os.path.getsize(" + repr(str(pid_file)) +
        ") == 0) and time.monotonic()<deadline: time.sleep(0.01)"
    )
    wait_for_release = (
        "while not os.path.exists(" + repr(str(release_file)) +
        ") and time.monotonic()<deadline: time.sleep(0.01)"
    )
    parent = (
        "import subprocess,sys,time,os; "
        "subprocess.Popen([sys.executable,'-c'," + repr(grandchild) + "], "
        "stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); "
        "deadline=time.monotonic()+10; exec(" + repr(wait_for_grandchild) + "); "
        "deadline=time.monotonic()+10; exec(" + repr(wait_for_release) + ")"
    )
    result = pc.start_program(sys.executable, ['-c', parent], timeout_seconds=30)
    entry = pc._sessions[result['session_id']]
    deadline = time.monotonic() + 10
    while (not pid_file.exists() or pid_file.stat().st_size == 0) and time.monotonic() < deadline:
        time.sleep(0.01)
    assert pid_file.exists() and pid_file.stat().st_size > 0, 'Job Object descendant did not start'
    pid = int(pid_file.read_text())
    kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel32.OpenProcess.argtypes = [ctypes.c_uint32, ctypes.c_int, ctypes.c_uint32]
    kernel32.OpenProcess.restype = ctypes.c_void_p
    kernel32.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
    kernel32.WaitForSingleObject.restype = ctypes.c_uint32
    kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
    handle = kernel32.OpenProcess(0x00100000, False, pid)  # SYNCHRONIZE
    assert handle, 'could not open live descendant before releasing direct command'
    try:
        release_file.write_text('release')
        assert entry['done'].wait(15)
        assert kernel32.WaitForSingleObject(handle, 5000) == 0, (
            'descendant remained alive after direct command exit'
        )
    finally:
        kernel32.CloseHandle(handle)
    with store.store.locked():
        records = [record for record in store.load()['operations'].values()
                   if record.get('kind') == 'detached_command']
    assert records[-1]['state'] == 'needs_review'


def test_detached_command_exit_cannot_be_held_open_by_inherited_output_pipe(pc, tmp_path):
    import os
    import time

    store = coordinator(pc)
    pid_file = tmp_path / 'inherited-output-descendant.pid'
    grandchild = (
        "import time; "
        "f=open(" + repr(str(pid_file)) + ", 'w'); "
        "f.write(str(__import__('os').getpid())); f.flush(); f.close(); "
        "time.sleep(30)"
    )
    wait_for_pid = (
        "deadline=time.monotonic()+10\n"
        "while (not os.path.exists(" + repr(str(pid_file)) +
        ") or os.path.getsize(" + repr(str(pid_file)) + ") == 0) and time.monotonic()<deadline:\n"
        "    time.sleep(0.01)\n"
        "if not os.path.exists(" + repr(str(pid_file)) +
        ") or os.path.getsize(" + repr(str(pid_file)) + ") == 0: raise SystemExit(9)"
    )
    parent = (
        "import subprocess,sys; "
        "subprocess.Popen([sys.executable,'-c'," + repr(grandchild) + "]); "
        "exec(" + repr(wait_for_pid) + ")"
    )
    result = pc.start_program(sys.executable, ['-c', parent], timeout_seconds=15)
    entry = pc._sessions[result['session_id']]
    deadline = time.monotonic() + 10
    while (not pid_file.exists() or pid_file.stat().st_size == 0) and time.monotonic() < deadline:
        time.sleep(0.01)
    assert pid_file.exists() and pid_file.stat().st_size > 0, 'background descendant did not start'
    pid = int(pid_file.read_text())

    process_handle = None
    pidfd = None
    if os.name == 'nt':
        import ctypes
        kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel32.OpenProcess.argtypes = [ctypes.c_uint32, ctypes.c_int, ctypes.c_uint32]
        kernel32.OpenProcess.restype = ctypes.c_void_p
        kernel32.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
        kernel32.WaitForSingleObject.restype = ctypes.c_uint32
        kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
        process_handle = kernel32.OpenProcess(0x00100000, False, pid)
    elif hasattr(os, 'pidfd_open'):
        try:
            pidfd = os.pidfd_open(pid, 0)
        except ProcessLookupError:
            pass

    assert entry['done'].wait(10), 'inherited output pipe delayed supervisor cleanup'
    if process_handle:
        try:
            assert kernel32.WaitForSingleObject(process_handle, 5000) == 0, (
                'Windows descendant survived direct-command exit'
            )
        finally:
            kernel32.CloseHandle(process_handle)
    elif pidfd is not None:
        import select
        try:
            ready, _, _ = select.select([pidfd], [], [], 5)
            assert ready, 'Linux descendant survived direct-command exit'
        finally:
            os.close(pidfd)
    else:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            pass
        else:
            pytest.fail('background descendant survived direct-command exit')

    with store.store.locked():
        records = [record for record in store.load()['operations'].values()
                   if record.get('kind') == 'detached_command']
    assert records[-1]['state'] == 'needs_review'


def _linux_parent_death_worker(state_dir, workspace, pid_file, connection):
    import os
    import time
    from jan_mcp_commander.control import ControlCommander

    os.environ['JAN_MCP_STATE_DIR'] = state_dir
    commander = ControlCommander(Path(workspace),
                                 enabled={'files', 'commands', 'browser', 'desktop'})
    grandchild = (
        "import time; "
        "f=open(" + repr(pid_file) + ", 'w'); "
        "f.write(str(__import__('os').getpid())); f.flush(); f.close(); "
        "time.sleep(30)"
    )
    command = (
        "import subprocess,sys,time; "
        "subprocess.Popen([sys.executable,'-c'," + repr(grandchild) + "], "
        "start_new_session=True, close_fds=True, "
        "stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); "
        "time.sleep(30)"
    )
    result = commander.start_program(sys.executable, ['-c', command], timeout_seconds=60)
    connection.send({'child_pid': result['pid']})
    deadline = time.monotonic() + 10
    while (time.monotonic() < deadline and
           (not Path(pid_file).exists() or Path(pid_file).stat().st_size == 0)):
        time.sleep(0.02)
    if not Path(pid_file).exists() or Path(pid_file).stat().st_size == 0:
        connection.send({'error': 'grandchild did not start'})
        os._exit(2)
    connection.send({'grandchild_pid': int(Path(pid_file).read_text())})
    # Simulate abrupt PCRC parent death: skip all Python cleanup.
    os._exit(0)


def _windows_parent_death_worker(state_dir, workspace, pid_file, connection):
    import os
    import time
    from jan_mcp_commander.control import ControlCommander

    os.environ['JAN_MCP_STATE_DIR'] = state_dir
    commander = ControlCommander(Path(workspace),
                                 enabled={'files', 'commands', 'browser', 'desktop'})
    grandchild = (
        "import time; "
        "open(" + repr(pid_file) + ", 'w').write(str(__import__('os').getpid())); "
        "time.sleep(30)"
    )
    command = (
        "import subprocess,sys,time; "
        "subprocess.Popen([sys.executable,'-c'," + repr(grandchild) + "], "
        "stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); "
        "time.sleep(30)"
    )
    result = commander.start_program(sys.executable, ['-c', command], timeout_seconds=60)
    connection.send({'child_pid': result['pid']})
    deadline = time.monotonic() + 10
    while (time.monotonic() < deadline and
           (not Path(pid_file).exists() or Path(pid_file).stat().st_size == 0)):
        time.sleep(0.02)
    if not Path(pid_file).exists() or Path(pid_file).stat().st_size == 0:
        connection.send({'error': 'grandchild did not start'})
        os._exit(2)
    connection.send({'grandchild_pid': int(Path(pid_file).read_text())})
    # The test opens stable process handles before allowing abrupt parent exit.
    connection.recv()
    os._exit(0)


def _windows_nested_job_worker(state_dir, workspace, connection):
    import os
    from jan_mcp_commander.control import ControlCommander

    os.environ['JAN_MCP_STATE_DIR'] = state_dir
    connection.send({'ready': True})
    if connection.recv() is not True:
        os._exit(3)
    commander = ControlCommander(Path(workspace),
                                 enabled={'files', 'commands', 'browser', 'desktop'})
    try:
        result = commander.start_program(
            sys.executable, ['-c', "print('nested-job-ok')"], timeout_seconds=15)
        entry = commander._sessions[result['session_id']]
        if not entry['done'].wait(15):
            connection.send({'error': 'nested Job Object command did not finish'})
            os._exit(4)
        connection.send({
            'exit_code': entry['process'].poll(),
            'output': commander.process_output(result['session_id'])['output'],
        })
    except BaseException as exc:
        connection.send({'error': type(exc).__name__, 'message': str(exc)})
        os._exit(5)
    finally:
        commander.close_control()


def _cross_process_recovery_worker(state_dir, workspace, start, connection):
    from types import SimpleNamespace
    from jan_mcp_commander.coordination import Coordination

    commander = SimpleNamespace(
        _store=SimpleNamespace(path=Path(state_dir)),
        workspace=Path(workspace),
    )
    try:
        start.wait(timeout=15)
        connection.send(Coordination(commander).recover_operations())
    except BaseException as exc:
        connection.send({'worker_error': type(exc).__name__, 'message': str(exc)})
    finally:
        connection.close()


def test_two_process_recovery_workers_never_double_recover_one_operation(pc):
    import multiprocessing

    store = coordinator(pc)
    operation_id = 'cross-process-recovery-race'
    with store.store.locked():
        data = store.load()
        data['operations'][operation_id] = {
            'id': operation_id,
            'state': 'active',
            'resources': ['file:cross-process-race.txt'],
            'owner': {'pid': 999999, 'thread': 1},
            'started_at': 1000,
        }
        store.save(data)

    context = multiprocessing.get_context('spawn')
    start = context.Event()
    workers = []
    receivers = []
    try:
        for _ in range(2):
            receive, send = context.Pipe(duplex=False)
            process = context.Process(
                target=_cross_process_recovery_worker,
                args=(str(pc._store.path), str(pc.workspace), start, send),
            )
            process.start()
            send.close()
            workers.append(process)
            receivers.append(receive)

        start.set()
        results = []
        for receive in receivers:
            assert receive.poll(20), 'recovery worker did not return'
            results.append(receive.recv())
        for process in workers:
            process.join(20)
            assert process.exitcode == 0
        assert all('worker_error' not in result for result in results), results
        assert sum(result['recovered'] == [operation_id] for result in results) == 1
        with store.store.locked():
            assert store.load()['operations'][operation_id]['state'] == 'needs_review'
    finally:
        start.set()
        for process in workers:
            if process.is_alive():
                process.terminate()
                process.join(5)
        for receive in receivers:
            receive.close()
