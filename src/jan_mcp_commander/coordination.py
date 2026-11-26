"""Account-local task reservations, persisted outside the approved workspace."""
from contextlib import contextmanager
from contextvars import ContextVar
from functools import wraps
import inspect
import json
import os
import secrets
import time
import uuid
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from .core import PermissionDenied
from .safe_fs import parts
from .security import PrivateStore

assignment = ContextVar('pcrc_assignment', default=None)


class CoordinationError(PermissionDenied):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


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
        self.depth = ContextVar('pcrc_coordination_depth', default=False)

    def load(self):
        try:
            blob = self.store.tree.read('tasks.enc', 2 * 1024 * 1024)
        except FileNotFoundError:
            return {'tasks': {}, 'workflows': {}, 'runs': {}}
        return json.loads(AESGCM(self.store.key).decrypt(blob[:12], blob[12:], self.store.context))

    def save(self, data):
        raw = json.dumps(data, ensure_ascii=True).encode()
        if len(raw) > 1024 * 1024:
            raise CoordinationError('TASK_CAPACITY', 'Private task storage is full. Review completed tasks locally.')
        nonce = os.urandom(12)
        self.store.tree.write('tasks.enc', nonce + AESGCM(self.store.key).encrypt(nonce, raw, self.store.context), overwrite=True)

    def expire(self, data):
        changed = False
        for task in data['tasks'].values():
            if task['status'] == 'active' and task['expires_at'] <= self.clock():
                task['status'] = 'needs_review'
                task['note'] = 'Reservation expired. Inspect actual results before reconciling; do not replay uncertain writes.'
                changed = True
            elif task['status'] == 'waiting':
                task.update(
                    status='queued',
                    resources=[],
                    lease_token='',
                    note='Legacy waiting assignment canceled in single-assistant mode; no work was authorized. Claim again when ready.',
                )
                task.pop('agent', None)
                task.pop('expires_at', None)
                task.pop('queue_order', None)
                changed = True
        if changed:
            self.save(data)

    @staticmethod
    def public(task):
        return {key: value for key, value in task.items() if key != 'lease_token'}

    def task(self, action, **args):
        with self.store.locked():
            data = self.load()
            self.expire(data)
            tasks = data['tasks']
            if action == 'list':
                held = [t for t in tasks.values() if t['status'] in {'active', 'needs_review','waiting'}]
                recent = [t for t in tasks.values() if t['status'] not in {'active', 'needs_review','waiting'}]
                shown = held + recent[-max(1, 20 - len(held)):]
                return {'tasks': [{**self.public(t), 'note': t['note'][:400]} for t in shown[:20]], 'truncated': len(tasks) > 20}
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
            if action == 'claim':
                if task['status'] == 'needs_review':
                    raise CoordinationError(
                        'TASK_REVIEW_REQUIRED',
                        'This task has an expired or uncertain reservation. Inspect list_tasks and the actual file/process/UI state, then reconcile_task after review.',
                    )
                if task['status'] != 'queued':
                    raise CoordinationError('TASK_CONFLICT', 'Task is already assigned or is not available for a new claim.')
                agent = args.get('agent', '')
                resources = args.get('resources', [])
                if not isinstance(agent, str) or not 1 <= len(agent) <= 80 or not isinstance(resources, list) or not 1 <= len(resources) <= 20:
                    raise ValueError('Agent label and 1..20 resources required')
                resources = sorted(set(resource(r) for r in resources))
                if any(
                    entry.get('profile') == 'operator_command' and not entry['done'].is_set()
                    for entry in self.commander._sessions.values()
                ):
                    raise CoordinationError(
                        'TASK_CONFLICT',
                        'A PCRC-owned command is still running. Inspect or finish that operation before creating an assignment; no task was queued.',
                    )
                holder = next(
                    (other for other in tasks.values()
                     if other is not task and other['status'] in {'active', 'needs_review'}),
                    None,
                )
                if holder:
                    code = 'TASK_REVIEW_REQUIRED' if holder['status'] == 'needs_review' else 'TASK_CONFLICT'
                    raise CoordinationError(
                        code,
                        f"Task {holder['id']} is {holder['status']}. Single-assistant mode allows one active assignment; no waiting request was saved.",
                    )
                task.update(
                    agent=agent,
                    resources=resources,
                    status='active',
                    expires_at=self.clock() + 120,
                    lease_token=secrets.token_urlsafe(32),
                    revision=task['revision'] + 1,
                )
                self.save(data)
                return {
                    **self.public(task),
                    'lease_token': task['lease_token'],
                    'instructions': 'Assignment is active. Use only the approved operations within its resources. Reinspect files and hashes before editing. Include task_id and lease_token on each assigned operation.',
                }
            if action in {'renew', 'finish'}:
                self.validate(task, args.get('lease_token'))
                if action == 'renew':
                    task['expires_at'] = self.clock() + 120
                else:
                    if unresolved:
                        raise CoordinationError('TASK_REVIEW_REQUIRED', 'A browser run is uncertain or failed verification. Inspect it and reconcile_task after review before handoff.')
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
                self.save(data)
                return self.public(task)
            if action == 'reconcile':
                if not (task['status'] == 'needs_review' or task['status'] == 'active' and unresolved) or args.get('reviewed') is not True or self.running(task['id']):
                    raise CoordinationError('TASK_REVIEW_REQUIRED', 'Inspect the uncertain task, stop any owned process, then confirm reconciliation. No action will be replayed.')
                for run in unresolved:
                    run['status'] = 'abandoned_after_review'
                task.update(status='queued', resources=[], lease_token='')
                if getattr(self.commander, '_teaching', None) and self.commander._teaching['task_id'] == task['id']:
                    self.commander._teaching = None
                self.save(data)
                return self.public(task)
            raise ValueError('Unknown task action')

    def validate(self, task, token):
        if task['status'] != 'active' or task['expires_at'] <= self.clock() or not isinstance(token, str) or not secrets.compare_digest(task.get('lease_token', ''), token):
            raise CoordinationError('TASK_LEASE_REQUIRED', 'Assignment expired or token does not match. Inspect list_tasks; uncertain operations require reconciliation.')

    def running(self, task_id):
        return any(entry.get('task_id') == task_id and not entry['done'].is_set() for entry in self.commander._sessions.values())

    @contextmanager
    def guard(self, resources):
        if self.depth.get():
            yield
            return
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
                if any(not any(covers(r, target) for r in own['resources']) for target in resources):
                    raise CoordinationError('TASK_SCOPE_DENIED', 'This operation exceeds the assignment. Finish and claim an appropriate reservation before continuing.')
            for task in data['tasks'].values():
                if task is own or task['status'] not in {'active', 'needs_review'}:
                    continue
                if any(overlaps(a, b) for a in task['resources'] for b in resources):
                    if task['status'] == 'needs_review':
                        raise CoordinationError(
                            'TASK_REVIEW_REQUIRED',
                            f"Task {task['id']} has an expired or uncertain reservation. Inspect actual file/process/UI state before reconciling; no operation was run.",
                        )
                    raise CoordinationError(
                        'TASK_CONFLICT',
                        f"Task {task['id']} currently owns this resource. Finish it before retrying; no operation was run.",
                    )
            marker = self.depth.set(True)
            try:
                yield
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
            targets = [resource('file:' + bound.arguments[p]) for p in paths] if paths else [kind]
            with coordinator(self).guard(targets):
                result = method(self, *args, **kwargs)
                if assignment.get() and method.__name__ in {'start_process', 'start_program', 'prepare_media'} and isinstance(result, dict):
                    entry = self._sessions.get(result.get('session_id'))
                    if entry is not None:
                        entry['task_id'] = assignment.get()[0]
                return result
        return guarded
    return decorate
