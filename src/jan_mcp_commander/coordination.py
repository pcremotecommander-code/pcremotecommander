"""Account-local task reservations, persisted outside the approved workspace."""
from contextlib import contextmanager, ExitStack
from contextvars import ContextVar
from functools import wraps
import inspect
import json
import os
import secrets
import threading
import time
import uuid
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from .core import OperationNotApplied, PermissionDenied
from .safe_fs import parts
from .security import PrivateStore

assignment = ContextVar('pcrc_assignment', default=None)
MAX_ACTIVE_ASSIGNMENTS = 8
MAX_OPERATION_RECORDS = 500


class CoordinationError(PermissionDenied):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


class SafeCoordinationError(CoordinationError, OperationNotApplied):
    """A coordination rejection proven to occur before external work begins."""


def resource(value):
    if value in {'workspace', 'ui'}:
        return value
    if not isinstance(value, str) or not value.startswith('file:'):
        raise ValueError('Use workspace, ui or file:relative/path resources')
    path = '/'.join(parts(value[5:]))
    if not path:
        return 'workspace'
    return 'file:' + (path.casefold() if os.name == 'nt' else path)


def overlaps(left, right):
    if 'workspace' in {left, right}:
        return True
    if left == 'ui' or right == 'ui':
        return left == right
    return left == right or left.startswith(right + '/') or right.startswith(left + '/')


def covers(reservation, target):
    return reservation == target or reservation == 'workspace' and target != 'ui' or target.startswith(reservation + '/')


class Coordination:
    def __init__(self, commander, clock=time.time):
        self.commander = commander
        self.store = PrivateStore(commander._store.path / 'coordination', commander.workspace)
        self.clock = clock
        self.depth = ContextVar('pcrc_coordination_resources', default=None)

    def load(self):
        try:
            blob = self.store.tree.read('tasks.enc', 2 * 1024 * 1024)
        except FileNotFoundError:
            return {'tasks': {}, 'workflows': {}, 'runs': {}, 'operations': {}}
        data = json.loads(AESGCM(self.store.key).decrypt(blob[:12], blob[12:], self.store.context))
        data.setdefault('operations', {})
        return data

    def save(self, data):
        raw = json.dumps(data, ensure_ascii=True).encode()
        if len(raw) > 1024 * 1024:
            raise CoordinationError('TASK_CAPACITY', 'Private task storage is full. Review completed tasks locally.')
        nonce = os.urandom(12)
        self.store.tree.write('tasks.enc', nonce + AESGCM(self.store.key).encrypt(nonce, raw, self.store.context), overwrite=True)


    def recover_operations(self):
        """Two-phase recovery of abandoned operation records.

        Phase one snapshots candidate records under the metadata lock. Phase
        two probes every canonical resource without holding that lock. Phase
        three reacquires metadata, verifies the record is unchanged, and
        marks it review-required while the successful probe locks are still
        held. Records are never deleted and actions are never replayed.
        """
        with self.store.locked():
            data = self.load()
            candidates = [
                (identifier, dict(record))
                for identifier, record in data.get('operations', {}).items()
                if isinstance(record, dict) and record.get('state') == 'active'
            ]

        recovered = []
        busy = []
        changed = []
        for identifier, snapshot in candidates:
            resources = snapshot.get('resources')
            lock_resources = snapshot.get('lock_resources', resources)
            try:
                valid_resources = (
                    isinstance(resources, list) and bool(resources)
                    and all(isinstance(item, str) and item for item in resources)
                    and [resource(item) for item in resources] == resources
                    and isinstance(lock_resources, list) and bool(lock_resources)
                    and all(
                        isinstance(item, str) and (
                            (item.startswith('session:') and len(item) == 40
                             and all(ch in '0123456789abcdef' for ch in item[8:]))
                            or (item.startswith('session-owner:') and len(item) == 46
                                and all(ch in '0123456789abcdef' for ch in item[14:]))
                            or resource(item) == item
                        )
                        for item in lock_resources
                    )
                )
            except (TypeError, ValueError):
                valid_resources = False
            if not valid_resources:
                # Malformed metadata is not safe to release or reinterpret.
                changed.append(identifier)
                continue
            with ExitStack() as locks:
                acquired_all = True
                for item in sorted(set(lock_resources)):
                    acquired = locks.enter_context(self.store.try_resource_locked(item))
                    if not acquired:
                        acquired_all = False
                        break
                if not acquired_all:
                    busy.append(identifier)
                    continue

                with self.store.locked():
                    latest = self.load()
                    current = latest.get('operations', {}).get(identifier)
                    if current != snapshot or current.get('state') != 'active':
                        changed.append(identifier)
                        continue
                    current['state'] = 'needs_review'
                    current['recovered_at'] = self.clock()
                    current['note'] = (
                        'Owner no longer holds the registered resource locks. '
                        'Inspect actual effects before releasing reservations; never replay this operation.'
                    )
                    self.save(latest)
                    recovered.append(identifier)

        return {'recovered': recovered, 'busy': busy, 'changed': changed}

    def _hold_review_operation_locks(self, stack, operation):
        resources = operation.get('resources')
        lock_resources = operation.get('lock_resources', resources)
        try:
            valid = (
                isinstance(resources, list) and bool(resources)
                and all(isinstance(item, str) and item for item in resources)
                and [resource(item) for item in resources] == resources
                and isinstance(lock_resources, list) and bool(lock_resources)
                and all(
                    isinstance(item, str) and (
                        (item.startswith('session:') and len(item) == 40
                         and all(ch in '0123456789abcdef' for ch in item[8:]))
                        or (item.startswith('session-owner:') and len(item) == 46
                            and all(ch in '0123456789abcdef' for ch in item[14:]))
                        or resource(item) == item
                    )
                    for item in lock_resources
                )
            )
        except (TypeError, ValueError):
            valid = False
        if not valid:
            raise CoordinationError(
                'TASK_REVIEW_REQUIRED',
                'Operation lock metadata is malformed. Inspect private coordination state; no reservation was released.',
            )
        for item in sorted(set(lock_resources)):
            acquired = stack.enter_context(self.store.try_resource_locked(item))
            if not acquired:
                raise CoordinationError(
                    'TASK_REVIEW_REQUIRED',
                    'Operation still holds a resource lock. Wait for it to stop before reconciliation.',
                )

    def reconcile_operation(self, identifier, reviewed):
        self.recover_operations()
        if reviewed is not True:
            raise CoordinationError(
                'TASK_REVIEW_REQUIRED',
                'Inspect the operation effects and explicitly confirm reviewed=true. No action will be replayed.',
            )
        with self.store.locked():
            snapshot = self.load().get('operations', {}).get(identifier)
            if not isinstance(snapshot, dict) or snapshot.get('state') != 'needs_review':
                raise CoordinationError(
                    'TASK_REVIEW_REQUIRED',
                    'Operation is not in a reviewable state. Live or malformed operations cannot be released.',
                )
            snapshot = dict(snapshot)

        with ExitStack() as locks:
            self._hold_review_operation_locks(locks, snapshot)
            with self.store.locked():
                data = self.load()
                operation = data.get('operations', {}).get(identifier)
                if operation != snapshot or operation.get('state') != 'needs_review':
                    raise CoordinationError(
                        'TASK_REVIEW_REQUIRED',
                        'Operation changed during reconciliation. Inspect it again; no reservation was released.',
                    )
                operation.update(
                    state='abandoned_after_review',
                    reviewed_at=self.clock(),
                    note='Operator confirmed review. Operation was not replayed; inspect its effects before any new write.',
                )
                self.promote(data)
                self.save(data)
                return {
                    'operation_id': identifier,
                    'state': operation['state'],
                    'task_id': operation.get('task_id'),
                }

    def reconcile_task(self, task_id, reviewed):
        self.recover_operations()
        if reviewed is not True:
            raise CoordinationError(
                'TASK_REVIEW_REQUIRED',
                'Inspect the uncertain task, stop any owned process, then confirm reconciliation. No action will be replayed.',
            )
        with self.store.locked():
            data = self.load()
            self.expire(data)
            task = data['tasks'].get(task_id)
            if task is None:
                raise CoordinationError('TASK_NOT_FOUND', 'Task not found. Call list_tasks and use its task ID.')
            unresolved = [
                (identifier, dict(run))
                for identifier, run in data['runs'].items()
                if run['task_id'] == task_id and run['status'] in {'unknown', 'failed'}
            ]
            operations = [
                (identifier, dict(operation))
                for identifier, operation in data.get('operations', {}).items()
                if isinstance(operation, dict) and operation.get('task_id') == task_id
                and operation.get('state') in {'active', 'needs_review'}
            ]
            if any(operation.get('state') == 'active' for _, operation in operations):
                raise CoordinationError(
                    'TASK_REVIEW_REQUIRED',
                    'A coordinated operation still holds its resource lock. Wait for it to finish or stop; no reservation will be released.',
                )
            eligible = (
                task['status'] == 'needs_review'
                or task['status'] == 'active' and (unresolved or operations)
            )
            if not eligible or self.running(task_id):
                raise CoordinationError(
                    'TASK_REVIEW_REQUIRED',
                    'Inspect the uncertain task, stop any owned process, then confirm reconciliation. No action will be replayed.',
                )
            # Reconciliation spans two lock phases. Capture the full lease
            # identity so a concurrent renewal or scope/state change cannot
            # be silently overwritten by the second phase.
            task_identity = (
                task['id'],
                task.get('revision'),
                task.get('lease_token'),
                task.get('status'),
                task.get('expires_at'),
                tuple(task.get('resources', ())),
            )

        with ExitStack() as locks:
            for _, operation in operations:
                self._hold_review_operation_locks(locks, operation)
            with self.store.locked():
                data = self.load()
                self.expire(data)
                task = data['tasks'].get(task_id)
                if task is None or (
                    task['id'],
                    task.get('revision'),
                    task.get('lease_token'),
                    task.get('status'),
                    task.get('expires_at'),
                    tuple(task.get('resources', ())),
                ) != task_identity:
                    raise CoordinationError(
                        'TASK_REVIEW_REQUIRED',
                        'Task assignment changed during reconciliation. Inspect it again; no reservation was released.',
                    )
                unresolved_now = [
                    (identifier, run)
                    for identifier, run in data['runs'].items()
                    if run['task_id'] == task_id and run['status'] in {'unknown', 'failed'}
                ]
                operations_now = [
                    (identifier, operation)
                    for identifier, operation in data.get('operations', {}).items()
                    if isinstance(operation, dict) and operation.get('task_id') == task_id
                    and operation.get('state') in {'active', 'needs_review'}
                ]
                if (
                    any(operation.get('state') == 'active' for _, operation in operations_now)
                    or [(identifier, operation) for identifier, operation in operations_now]
                    != operations
                    or unresolved_now != unresolved
                    or not (
                        task['status'] == 'needs_review'
                        or task['status'] == 'active' and (unresolved_now or operations_now)
                    )
                    or self.running(task_id)
                ):
                    raise CoordinationError(
                        'TASK_REVIEW_REQUIRED',
                        'Task or operation state changed during reconciliation. Inspect it again; no reservation was released.',
                    )
                for _, run in unresolved_now:
                    run['status'] = 'abandoned_after_review'
                for _, operation in operations_now:
                    operation.update(
                        state='abandoned_after_review',
                        reviewed_at=self.clock(),
                        note='Operator confirmed review. Operation was not replayed; inspect its effects before any new write.',
                    )
                task.update(status='queued', resources=[], lease_token='')
                if getattr(self.commander, '_teaching', None) and self.commander._teaching['task_id'] == task_id:
                    self.commander._teaching = None
                self.promote(data)
                self.save(data)
                return self.public(task)


    def register_detached_operation(self, lock_resource, owner_lock_resource, *, supervisor_pid=None):
        """Publish a durable workspace reservation backed by a supervisor lock.

        The caller must already be inside a coordinated outer operation. The
        supervisor acquires its unique lock before this record is published,
        so recovery cannot mistake a startup gap for a crashed command.
        """
        targets = self.depth.get()
        if not targets:
            raise CoordinationError('TASK_SCOPE_DENIED', 'Detached commands must start inside a coordinated workspace operation.')
        if (not isinstance(lock_resource, str) or not lock_resource.startswith('session:')
                or len(lock_resource) != 40
                or any(ch not in '0123456789abcdef' for ch in lock_resource[8:])
                or not isinstance(owner_lock_resource, str)
                or not owner_lock_resource.startswith('session-owner:')
                or len(owner_lock_resource) != 46
                or any(ch not in '0123456789abcdef' for ch in owner_lock_resource[14:])):
            raise ValueError('Invalid detached session lock identifier')
        with self.store.locked():
            data = self.load()
            self.expire(data)
            current = assignment.get()
            task_id = None
            if current:
                own = data['tasks'].get(current[0])
                if own is None:
                    raise CoordinationError('TASK_NOT_FOUND', 'Task not found; call list_tasks.')
                self.validate(own, current[1])
                if any(not any(covers(allowed, target) for allowed in own['resources'])
                       for target in targets):
                    raise CoordinationError('TASK_SCOPE_DENIED', 'Detached command exceeds its task reservation.')
                task_id = current[0]
            for task in data['tasks'].values():
                if task['status'] in {'active', 'needs_review'} and task['id'] != task_id:
                    if any(overlaps(a, b) for a in task['resources'] for b in targets):
                        raise CoordinationError('TASK_CONFLICT', 'Another task reserved this detached command resource.')
            operations = data.setdefault('operations', {})
            if len(operations) >= MAX_OPERATION_RECORDS:
                completed = sorted(
                    ((record.get('finished_at', 0), key) for key, record in operations.items()
                     if isinstance(record, dict) and record.get('state') in {'completed', 'failed'}),
                )
                while len(operations) >= MAX_OPERATION_RECORDS and completed:
                    _, old_id = completed.pop(0)
                    operations.pop(old_id, None)
                if len(operations) >= MAX_OPERATION_RECORDS:
                    raise CoordinationError('OPERATION_CAPACITY', 'Private operation history is full of unresolved records.')
            identifier = uuid.uuid4().hex
            operations[identifier] = {
                'id': identifier,
                'state': 'active',
                'resources': list(targets),
                'lock_resources': [lock_resource, owner_lock_resource],
                'owner': {'pid': os.getpid(), 'thread': threading.get_ident(),
                          'supervisor_pid': supervisor_pid},
                'task_id': task_id,
                'started_at': self.clock(),
                'kind': 'detached_command',
            }
            self.save(data)
            return identifier

    def set_detached_child_identity(self, operation_id, child_pid):
        if type(child_pid) is not int or child_pid <= 0:
            raise ValueError('Invalid detached child process identifier')
        with self.store.locked():
            data = self.load()
            record = data.get('operations', {}).get(operation_id)
            if not isinstance(record, dict) or record.get('state') != 'active':
                raise CoordinationError('TASK_REVIEW_REQUIRED', 'Detached operation changed before child identity was recorded.')
            record.setdefault('owner', {})['child_pid'] = child_pid
            self.save(data)

    def finish_detached_operation(self, operation_id, *, success, exit_code=None, terminated=False):
        """Finalize a detached command only after its lifetime lock is free."""
        with self.store.locked():
            data = self.load()
            record = data.get('operations', {}).get(operation_id)
            if not isinstance(record, dict) or record.get('state') != 'active':
                return False
            if success:
                record.update(
                    state='completed',
                    note=f'Detached command and its inherited resource-lock holders exited (exit_code={exit_code}).',
                    finished_at=self.clock(),
                )
            else:
                record.update(
                    state='needs_review',
                    note=f'Detached command stopped or exited unsuccessfully (exit_code={exit_code}, terminated={terminated}). Inspect actual effects before releasing reservations; never replay.',
                    recovered_at=self.clock(),
                )
            self.save(data)
            return True

    def _session_snapshot(self):
        """Return a stable best-effort session view without taking the session lock.

        Coordination paths may already hold the private-store lock. Acquiring
        the commander session lock here would invert the start/stop lock order.
        If the registry changes during iteration, callers fail closed instead.
        """
        try:
            return tuple(self.commander._sessions.values())
        except RuntimeError:
            return None

    def expire(self, data):
        changed = False
        for task in data['tasks'].values():
            if task['status'] == 'active' and task['expires_at'] <= self.clock():
                task['status'] = 'needs_review'
                task['note'] = 'Reservation expired. Inspect actual results before reconciling; do not replay uncertain writes.'
                changed = True
            elif task['status'] == 'waiting' and task['expires_at'] <= self.clock():
                task.update(status='queued',resources=[],lease_token='',note='Queue request expired before assignment; no work was authorized. Claim again if still needed.')
                changed = True
        changed = self.promote(data) or changed
        if changed:
            self.save(data)

    def promote(self, data):
        sessions = self._session_snapshot()
        if sessions is None or any(
            entry.get('profile') == 'operator_command' and not entry['done'].is_set()
            for entry in sessions
        ):
            return False
        tasks=data['tasks'].values()
        held=[t for t in tasks if t['status'] in {'active','needs_review'}]
        operation_reservations = []
        for operation in data.get('operations', {}).values():
            if not isinstance(operation, dict):
                operation_reservations.append({'resources': ['workspace']})
                continue
            if operation.get('state') in {'active', 'needs_review'}:
                resources = operation.get('resources')
                try:
                    valid = (isinstance(resources, list) and bool(resources)
                             and all(isinstance(item, str) and item and resource(item) == item
                                     for item in resources))
                except (TypeError, ValueError):
                    valid = False
                operation_reservations.append({'resources': resources if valid else ['workspace']})
        blocked=[]
        changed=False
        for task in sorted((t for t in tasks if t['status']=='waiting'),key=lambda t:t['queue_order']):
            if len(held)>=MAX_ACTIVE_ASSIGNMENTS or any(overlaps(a,b) for other in held+operation_reservations+blocked for a in other['resources'] for b in task['resources']):
                blocked.append(task)
                continue
            task.update(status='active',expires_at=self.clock()+120)
            held.append(task)
            changed=True
        return changed

    @staticmethod
    def public(task):
        return {key: value for key, value in task.items() if key != 'lease_token'}

    def task(self, action, **args):
        if action == 'reconcile_operation':
            return self.reconcile_operation(args.get('operation_id'), args.get('reviewed'))
        if action == 'reconcile':
            return self.reconcile_task(args.get('task_id'), args.get('reviewed'))
        with self.store.locked():
            data = self.load()
            self.expire(data)
            tasks = data['tasks']
            if action == 'list':
                held = [t for t in tasks.values() if t['status'] in {'active', 'needs_review','waiting'}]
                recent = [t for t in tasks.values() if t['status'] not in {'active', 'needs_review','waiting'}]
                shown = held + recent[-max(1, 20 - len(held)):]
                unresolved = []
                for identifier, operation in data.get('operations', {}).items():
                    if not isinstance(operation, dict):
                        unresolved.append({
                            'operation_id': identifier,
                            'state': 'malformed',
                            'kind': 'unknown',
                            'task_id': None,
                            'resource_scopes': ['workspace'],
                        })
                        continue
                    if operation.get('state') not in {'active', 'needs_review'}:
                        continue
                    resources = operation.get('resources')
                    scopes = set()
                    if not isinstance(resources, list) or not resources:
                        scopes.add('workspace')
                    else:
                        for item in resources:
                            if item == 'workspace' or item == 'ui':
                                scopes.add(item)
                            elif isinstance(item, str) and item.startswith('file:'):
                                scopes.add('files')
                            else:
                                scopes.add('unknown')
                    summary = {
                        'operation_id': identifier,
                        'state': operation.get('state'),
                        'kind': operation.get('kind') if isinstance(operation.get('kind'), str) else 'unknown',
                        'task_id': operation.get('task_id'),
                        'resource_scopes': sorted(scopes) or ['unknown'],
                    }
                    owner = operation.get('owner')
                    if isinstance(owner, dict):
                        for process_field in ('supervisor_pid', 'child_pid'):
                            process_id = owner.get(process_field)
                            if type(process_id) is int and process_id > 0:
                                summary[process_field] = process_id
                    if isinstance(operation.get('started_at'), (int, float)):
                        summary['started_at'] = operation['started_at']
                    if isinstance(operation.get('note'), str):
                        summary['note'] = operation['note'][:240]
                    unresolved.append(summary)
                unresolved.sort(key=lambda item: (item.get('started_at', 0), item['operation_id']))
                return {
                    'tasks': [{**self.public(t), 'note': t['note'][:400]} for t in shown[:20]],
                    'truncated': len(tasks) > 20,
                    # MAX_OPERATION_RECORDS bounds the full unresolved
                    # list, so every recovery ID remains discoverable.
                    'operations': unresolved,
                }
            if action == 'create':
                title = args.get('title', '')
                if len(tasks) >= 100:
                    finished = next((key for key, task in tasks.items() if task['status'] in {'completed', 'failed'}), None)
                    if finished:
                        del tasks[finished]
                if not isinstance(title, str) or not 1 <= len(title) <= 160 or len(tasks) >= 100:
                    raise ValueError('Task title must be 1..160 characters; maximum 100 tasks')
                identifier = uuid.uuid4().hex
                tasks[identifier] = {'id': identifier, 'title': title, 'status': 'queued', 'resources': [], 'revision': 0, 'note': ''}
                self.save(data)
                return self.public(tasks[identifier])
            task = tasks.get(args.get('task_id'))
            if task is None:
                raise CoordinationError('TASK_NOT_FOUND', 'Task not found. Call list_tasks and use its task ID.')
            unresolved = [run for run in data['runs'].values() if run['task_id'] == task['id'] and run['status'] in {'unknown', 'failed'}]
            unresolved_operations = [(identifier, operation) for identifier, operation in data.get('operations', {}).items() if isinstance(operation, dict) and operation.get('task_id') == task['id'] and operation.get('state') in {'active', 'needs_review'}]
            if action == 'claim':
                if task['status'] not in {'queued'}:
                    raise CoordinationError('TASK_CONFLICT', 'Task is assigned or requires review. Inspect list_tasks before continuing.')
                agent = args.get('agent', '')
                resources = args.get('resources', [])
                wait = args.get('wait', True)
                if type(wait) is not bool:
                    raise ValueError('wait must be true or false')
                if not isinstance(agent, str) or not 1 <= len(agent) <= 80 or not isinstance(resources, list) or not 1 <= len(resources) <= 20:
                    raise ValueError('Agent label and 1..20 resources required')
                resources = sorted(set(resource(r) for r in resources))
                order=max((t.get('queue_order',0) for t in tasks.values()),default=0)+1
                task.update(agent=agent, resources=resources, status='waiting', expires_at=self.clock() + 120,queue_order=order,
                            lease_token=secrets.token_urlsafe(32), revision=task['revision'] + 1)
                self.promote(data)
                if not wait and task['status'] == 'waiting':
                    raise CoordinationError(
                        'TASK_CONFLICT',
                        'The requested assignment is busy. No waiting request was saved. Inspect list_tasks before trying again.',
                    )
                self.save(data)
                instructions = (
                    'Waiting grants no execution access. Poll renew_task within 120 seconds until active. '
                    if task['status'] == 'waiting' else
                    'Assignment is active. Use only the approved operations within its resources. '
                )
                return {**self.public(task), 'lease_token': task['lease_token'],
                        'instructions': instructions + 'Reinspect files and hashes before editing. Include task_id and lease_token on each assigned operation.'}
            if action in {'renew', 'finish'}:
                self.validate(task, args.get('lease_token'),waiting=True)
                if action == 'renew':
                    task['expires_at'] = self.clock() + 120
                else:
                    if task['status']=='waiting' and args.get('status') not in {'queued','failed'}:
                        raise CoordinationError('TASK_LEASE_REQUIRED','A waiting assignment has not executed work. Cancel it with failed or queued; do not mark it completed.')
                    if unresolved:
                        raise CoordinationError('TASK_REVIEW_REQUIRED', 'A browser run is uncertain or failed verification. Inspect it and reconcile_task after review before handoff.')
                    if unresolved_operations:
                        raise CoordinationError('TASK_REVIEW_REQUIRED', 'A coordinated operation is active or uncertain. Stop the owned process, inspect its result, then reconcile_task after review before handoff.')
                    if self.running(task['id']):
                        raise CoordinationError('TASK_PROCESS_RUNNING', 'Stop the task-owned process and inspect its output before finishing.')
                    if getattr(self.commander, '_teaching', None) and self.commander._teaching['task_id'] == task['id']:
                        raise CoordinationError('TASK_REVIEW_REQUIRED', 'Finish or cancel this task recording before releasing its UI reservation.')
                    status = args.get('status')
                    if status not in {'completed', 'failed', 'queued'}:
                        raise ValueError('Choose completed, failed or queued for handoff')
                    if status != 'queued':
                        for run in data['runs'].values():
                            if run['task_id'] == task['id'] and run['status'] == 'ready':
                                run['status'] = 'abandoned_after_review'
                    task.update(status=status, resources=[], lease_token='')
                    note = args.get('note', '')
                    if not isinstance(note, str) or len(note) > 2000:
                        raise ValueError('Handoff note exceeds limit')
                    task['note'] = note
                self.promote(data)
                self.save(data)
                return self.public(task)
            raise ValueError('Unknown task action')

    def validate(self, task, token, *, waiting=False):
        if task['status'] not in ({'active','waiting'} if waiting else {'active'}) or task['expires_at'] <= self.clock() or not isinstance(token, str) or not secrets.compare_digest(task.get('lease_token', ''), token):
            raise CoordinationError('TASK_LEASE_REQUIRED', 'Assignment expired or token does not match. Inspect list_tasks; uncertain operations require reconciliation.')

    def running(self, task_id):
        sessions = self._session_snapshot()
        if sessions is None:
            return True
        for entry in sessions:
            if entry.get('task_id') != task_id:
                continue
            done = entry.get('done')
            if done is not None:
                if not done.is_set():
                    return True
                continue
            process = entry.get('process')
            if process is not None and process.poll() is None:
                return True
        return False

    @contextmanager
    def guard(self, resources, *, allow_active_sessions=False, defer_task_scope=False, operation_kind=None):
        targets = sorted(set(resource(item) for item in resources))
        outer_resources = self.depth.get()
        if outer_resources is not None:
            # Revalidate the task lease and its own resource scope even for
            # nested calls. The outer reservation is an additional boundary,
            # not a substitute for the assigned task's narrower permissions.
            current = assignment.get()
            if current and not defer_task_scope:
                with self.store.locked():
                    data = self.load()
                    self.expire(data)
                    own = data['tasks'].get(current[0])
                    if own is None:
                        raise CoordinationError('TASK_NOT_FOUND', 'Task not found; call list_tasks.')
                    self.validate(own, current[1])
                    if any(not any(covers(allowed, target) for allowed in own['resources'])
                           for target in targets):
                        raise CoordinationError('TASK_SCOPE_DENIED', 'This operation exceeds the assignment. Finish and claim an appropriate reservation before continuing.')
            if any(not any(covers(allowed, target) for allowed in outer_resources)
                   for target in targets):
                raise CoordinationError('TASK_SCOPE_DENIED', 'A nested operation cannot widen its outer resource reservation.')
            yield
            return
        if (not allow_active_sessions
                and any(target == 'workspace' or target.startswith('file:') for target in targets)):
            sessions = self._session_snapshot()
            if sessions is None:
                raise CoordinationError(
                    'TASK_CONFLICT',
                    'The session registry changed during inspection. Inspect or stop active sessions before retrying this workspace operation.',
                )
            if any(
                entry.get('profile') == 'operator_command' and not entry['done'].is_set()
                for entry in sessions
            ):
                raise CoordinationError(
                    'TASK_CONFLICT',
                    'An owned command is still running with workspace access. Inspect or stop that session before starting another workspace operation.',
                )
        operation_id = uuid.uuid4().hex
        # Acquire resource locks before publishing the active record. A crash
        # before publication cannot have entered user work; after publication,
        # recovery will observe these OS locks while the operation is alive.
        with ExitStack() as resource_locks:
            for target in targets:
                resource_locks.enter_context(self.store.resource_locked(target))

            with self.store.locked():
                data = self.load()
                self.expire(data)
                current = assignment.get()
                own = None
                if current:
                    own = data['tasks'].get(current[0])
                    if own is None:
                        raise CoordinationError('TASK_NOT_FOUND', 'Task not found; call list_tasks.')
                    self.validate(own, current[1])
                    if not defer_task_scope and any(
                        not any(covers(r, target) for r in own['resources']) for target in targets
                    ):
                        raise CoordinationError('TASK_SCOPE_DENIED', 'This operation exceeds the assignment. Finish and claim an appropriate reservation before continuing.')
                for task in data['tasks'].values():
                    if task is own or task['status'] not in {'active', 'needs_review'}:
                        continue
                    if any(overlaps(a, b) for a in task['resources'] for b in targets):
                        raise CoordinationError('TASK_CONFLICT', 'Resource reserved by another or uncertain task. Call list_tasks; do not retry the write automatically.')
                for existing_id, existing in data.get('operations', {}).items():
                    if not isinstance(existing, dict):
                        raise CoordinationError('TASK_REVIEW_REQUIRED', 'An operation record is malformed. Inspect private coordination state before continuing.')
                    if existing.get('state') not in {'active', 'needs_review'}:
                        continue
                    # process_input is the sole decorated method allowed to
                    # bypass a detached command's workspace reservation. It
                    # can only enqueue stdin for a session owned by this
                    # commander; it cannot touch workspace files.
                    if allow_active_sessions and existing.get('kind') == 'detached_command':
                        continue
                    existing_resources = existing.get('resources')
                    try:
                        valid = (isinstance(existing_resources, list) and bool(existing_resources)
                                 and all(isinstance(item, str) and item and resource(item) == item
                                         for item in existing_resources))
                    except (TypeError, ValueError):
                        valid = False
                    if not valid:
                        raise CoordinationError('TASK_REVIEW_REQUIRED', 'An operation record is malformed. Inspect private coordination state before continuing.')
                    if any(overlaps(a, b) for a in existing_resources for b in targets):
                        if existing.get('kind') == 'browser_workflow' and existing.get('state') == 'needs_review':
                            raise CoordinationError('TASK_CONFLICT', 'A prior run has an uncertain browser outcome. Inspect the page and workflow receipt before starting another run.')
                        raise CoordinationError('TASK_CONFLICT', 'Resource is held by another or uncertain operation. Inspect its result before retrying; do not replay automatically.')
                operations = data.setdefault('operations', {})
                if len(operations) >= MAX_OPERATION_RECORDS:
                    completed = sorted(
                        ((record.get('finished_at', 0), key) for key, record in operations.items()
                         if record.get('state') in {'completed', 'failed'}),
                    )
                    while len(operations) >= MAX_OPERATION_RECORDS and completed:
                        _, old_id = completed.pop(0)
                        operations.pop(old_id, None)
                    if len(operations) >= MAX_OPERATION_RECORDS:
                        raise CoordinationError('OPERATION_CAPACITY', 'Private operation history is full of unresolved records. Review them before starting more work.')
                operations[operation_id] = {
                    'id': operation_id,
                    'state': 'active',
                    'kind': operation_kind,
                    'resources': targets,
                    'owner': {'pid': os.getpid(), 'thread': threading.get_ident()},
                    'task_id': current[0] if current else None,
                    'started_at': self.clock(),
                }
                self.save(data)

            marker = self.depth.set(tuple(targets))
            try:
                yield
            except OperationNotApplied:
                with self.store.locked():
                    data = self.load()
                    record = data.get('operations', {}).get(operation_id)
                    if record and record.get('state') == 'active':
                        record.update(
                            state='failed',
                            note='A precondition rejected the operation before mutation. No write was applied.',
                            finished_at=self.clock(),
                        )
                        self.save(data)
                raise
            except CoordinationError as exc:
                # Coordination rejections are pre-dispatch by contract. The
                # browser workflow uses WORKFLOW_OUTCOME_UNKNOWN only when a
                # replay step may already have reached the page; that one must
                # retain its reservation for explicit review.
                state = 'needs_review' if exc.code == 'WORKFLOW_OUTCOME_UNKNOWN' else 'failed'
                note = ('A browser step may have been dispatched; inspect actual effects before retrying.'
                        if state == 'needs_review' else
                        'Coordination rejected the operation before external work began.')
                with self.store.locked():
                    data = self.load()
                    record = data.get('operations', {}).get(operation_id)
                    if record and record.get('state') == 'active':
                        record.update(state=state, note=note, finished_at=self.clock())
                        self.save(data)
                raise
            except BaseException:
                with self.store.locked():
                    data = self.load()
                    record = data.get('operations', {}).get(operation_id)
                    if record and record.get('state') == 'active':
                        record.update(
                            state='needs_review',
                            note='Operation raised after entry. Inspect actual effects before retrying; never replay automatically.',
                            finished_at=self.clock(),
                        )
                        self.save(data)
                raise
            else:
                with self.store.locked():
                    data = self.load()
                    record = data.get('operations', {}).get(operation_id)
                    if record and record.get('state') == 'active':
                        record.update(state='completed', finished_at=self.clock())
                        self.save(data)
            finally:
                self.depth.reset(marker)



def coordinator(commander):
    with commander._lock:
        if not hasattr(commander, '_coordination'):
            commander._coordination = Coordination(commander)
        return commander._coordination


def coordinated(kind, *paths):
    def decorate(method):
        signature = inspect.signature(method)
        @wraps(method)
        def guarded(self, *args, **kwargs):
            bound = signature.bind(self, *args, **kwargs)
            bound.apply_defaults()
            targets = [resource('file:' + bound.arguments[p]) for p in paths] if paths else [kind]
            with coordinator(self).guard(
                targets,
                allow_active_sessions=method.__name__ == 'process_input',
                # Document preview schedules work only. Its worker checks each
                # source and destination path before reading any file.
                defer_task_scope=method.__name__ in {'preview_document_workflow', 'apply_document_workflow'},
                operation_kind=method.__name__,
            ):
                result = method(self, *args, **kwargs)
                current = assignment.get()
                if current and method.__name__ in {'start_process', 'start_program'} and isinstance(result, dict):
                    entry = self._sessions.get(result.get('session_id'))
                    if entry is not None:
                        entry['task_id'] = current[0]
                        entry['task_lease_token'] = current[1]
                        self._watch_task_lease(result.get('session_id'))
                return result
        return guarded
    return decorate
