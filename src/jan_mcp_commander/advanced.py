"""Stage 2 local controls: bounded sessions, workspace files, and recovery.

Not a security sandbox against other local OS users: run as an unprivileged account.
"""
from __future__ import annotations
import hashlib
import base64
import json
import os
from pathlib import Path
import shutil
import signal
import stat
import subprocess
import threading
import time
import uuid
from datetime import datetime, timezone
from .core import Commander, OperationNotApplied, PermissionDenied, COMMAND_PROFILES, MAX_READ_BYTES
from .safe_fs import parts, unsupported_content

MAX_WRITE = 65536
MAX_OUTPUT = 16384
MAX_SESSIONS = 4
SESSION_LIFETIME = 60


class AdvancedCommander(Commander):
    def __init__(self, workspace: Path, audit_path: Path | None = None):
        super().__init__(workspace, audit_path)
        self._sessions = {}
        self._lock = threading.RLock()
        self._backup_root = self.workspace / '.jan-mcp-backups'

    def read_pdf(self, path):
        from .pdf_tools import process_pdf
        self._rate()
        self._audit('read_pdf', True, path)
        return process_pdf(self._tree, path)

    def rewrite_pdf(self, path, destination, expected_sha256, pages, rotation=0,
                    overwrite=False, expected_destination_sha256=None):
        from .pdf_tools import process_pdf
        deadline=time.monotonic()+15
        self._rate()
        if not self.allow_writes or type(overwrite) is not bool:
            raise PermissionDenied('PDF write requires explicit local write permission')
        if not isinstance(destination, str) or not destination.casefold().endswith('.pdf'):
            raise PermissionDenied('Choose a relative PDF destination')
        if overwrite and not expected_destination_sha256:
            raise PermissionDenied('Inspect the overwrite destination first; its SHA-256 is required')
        try:
            value = process_pdf(self._tree, path, pages=pages, rotation=rotation,deadline=deadline)
            if value['sha256'] != expected_sha256:
                raise OperationNotApplied('File changed; read it again before modifying')
        except OperationNotApplied:
            raise
        except (PermissionDenied, ValueError) as exc:
            # PDF parsing and validation are read-only; the write starts below.
            raise OperationNotApplied(str(exc)) from exc
        result = self._write_binary(destination, value['bytes'], overwrite=overwrite,
                                    expected_sha256=expected_destination_sha256,deadline=deadline)
        return {**result, 'page_count': value['page_count'], 'source_sha256': value['sha256']}

    def _path(self, name: str, *, exists: bool = True) -> Path:
        from .safe_fs import parts
        try:
            if not parts(name):
                raise ValueError('File path required')
            with self._tree.parent(name):
                pass
            if exists:
                self._tree.info(name)
            return self.workspace / name
        except (OSError, ValueError) as exc:
            raise PermissionDenied('Workspace path denied') from exc

    def file_info(self, path: str) -> dict:
        self._rate()
        self._audit('file_info', True, path)
        try:
            st = self._tree.info(path)
            result = {'path': path, 'kind': 'directory' if stat.S_ISDIR(st.st_mode) else 'file',
                      'bytes': st.st_size, 'modified_utc': datetime.fromtimestamp(st.st_mtime, timezone.utc).isoformat()}
            if result['kind'] == 'file' and st.st_size <= MAX_READ_BYTES:
                from .privacy import assert_public_text
                data=self._tree.read(path,MAX_READ_BYTES)
                assert_public_text(data)
                result['sha256'] = hashlib.sha256(data).hexdigest()
            return result
        except (OSError, ValueError) as exc:
            raise PermissionDenied('File information denied') from exc

    def find_files(self, term: str, max_results: int = 50, path: str = '.') -> dict:
        self._rate()
        if not isinstance(term, str) or not term or len(term) > 100 or type(max_results) is not int or not 1 <= max_results <= 100:
            raise PermissionDenied('Invalid search')
        from .privacy import assert_public_text
        assert_public_text(term)
        self._audit('find_files', True, f'query-length={len(term)}')
        root = '/'.join(parts(path)) or '.'
        # Validate the requested root before the bounded scan's skip-on-error handling.
        if not stat.S_ISDIR(self._tree.info(root).st_mode):
            raise ValueError('Search root must be a directory')
        matches, pending, scanned = [], [root], 0
        deadline = time.monotonic() + 2
        while pending and scanned < 10000 and time.monotonic() < deadline and len(matches) < max_results:
            directory = pending.pop()
            try:
                entries = self._tree.entries(directory, limit=min(1000, 10000-scanned), scan_limit=min(1000, 10000-scanned))
            except (OSError, ValueError):
                continue
            scanned += max(1, len(entries))
            for entry in entries:
                name = entry['name'] if directory == '.' else directory + '/' + entry['name']
                if entry['kind'] == 'directory':
                    if name.count('/') < 15:
                        pending.append(name)
                elif term.lower() in entry['name'].lower():
                    matches.append(name)
                    if len(matches) >= max_results:
                        break
        return {'matches': matches, 'limit': max_results, 'bounded_search': True}

    def _write(self, path, content, overwrite):
        data = content.encode('utf-8')
        if len(data) > MAX_WRITE or unsupported_content(data):
            raise OperationNotApplied('Text exceeds limit or contains binary/private key data')
        # Validate the path and parent before entering the mutation section. A
        # missing/unsafe parent is a definite precondition failure, not an
        # uncertain write outcome.
        try:
            with self._tree.parent(path):
                pass
        except FileNotFoundError as exc:
            # Keep the public parent-directory diagnostic while marking this
            # verified pre-mutation failure as safe to retry after correction.
            raise OperationNotApplied('Write denied') from exc
        except (OSError, ValueError) as exc:
            raise OperationNotApplied('Write path is unavailable or unsafe') from exc
        # Preflight audit must succeed before backup or workspace mutation.
        self._audit('write_intent', True, path)
        with self._lock, self._store.locked():
            backup_id = None
            try:
                old = self._tree.read(path)
            except FileNotFoundError:
                old = None
            if old is not None:
                if unsupported_content(old):
                    raise PermissionDenied('Existing binary/private key file cannot be replaced')
                if not overwrite:
                    raise PermissionDenied('Overwrite must be explicitly approved')
                backup_id = self._store.backup(path, old)
            self._tree.write(path, data, overwrite=overwrite)
        self._audit('write_text', True, f'{path};backup={backup_id}')
        return {'path': path, 'bytes': len(data), 'backup_id': backup_id}

    def write_text(self, path: str, content: str, overwrite: bool = False) -> dict:
        self._rate()
        if not self.allow_writes:
            raise PermissionDenied('Read-only mode; operator must set JAN_MCP_ALLOW_WRITES=1 or use --allow-writes locally')
        if type(content) is not str or type(overwrite) is not bool:
            raise PermissionDenied('Invalid write options')
        try:
            return self._write(path, content, overwrite)
        except OperationNotApplied:
            raise
        except (OSError, ValueError) as exc:
            raise PermissionDenied('Write denied') from exc

    def restore_backup(self, identifier: str) -> dict:
        self._rate()
        if not self.allow_writes:
            raise PermissionDenied('Read-only mode')
        try:
            self._audit('restore_intent', True, str(identifier))
            with self._store.locked():
                meta = self._store.restore(identifier)
            if meta.get('encoding') == 'base64':
                result = self._write_binary(meta['path'], base64.b64decode(meta['content'], validate=True), overwrite=True)
            else:
                result = self._write(meta['path'], meta['content'], True)
            self._audit('restore_backup', True, identifier)
            return {'restored': meta['path'], 'previous_version_backup_id': result['backup_id']}
        except Exception as exc:
            # Authentication failures deliberately have the same public error.
            raise PermissionDenied('Restore denied') from exc

    def _require_binary_write(self):
        if not self.allow_writes:raise PermissionDenied('Binary write permission disabled')

    def _write_binary(self, path, data, *, overwrite=False, expected_sha256=None, deadline=None):
        """Internal media writer; explicit overwrite keeps an encrypted binary backup."""
        self._require_binary_write()
        if not self.allow_writes or not isinstance(data, bytes) or len(data) > 8 * 1024 * 1024:
            raise PermissionDenied('Binary write denied or exceeds 8 MiB')
        from .privacy import assert_public_text
        assert_public_text(data)
        if str(path).casefold().endswith(('.xlsx','.docx')):
            from .office_documents import package
            package(data)
        if str(path).casefold().endswith('.pdf'):
            from .pdf_tools import inspect_pdf_bytes
            inspect_pdf_bytes(data,deadline=deadline)
        self._audit('media_write_intent', True, path)
        with self._lock, self._store.locked():
            self._require_binary_write()
            try:
                old = self._tree.read(path, 8 * 1024 * 1024)
            except FileNotFoundError:
                old = None
            if old is not None:
                assert_public_text(old)
                if str(path).casefold().endswith(('.xlsx','.docx')):package(old)
                if str(path).casefold().endswith('.pdf'):inspect_pdf_bytes(old,deadline=deadline)
                if not overwrite:
                    raise FileExistsError('Choose a new media destination')
                if expected_sha256 is not None and hashlib.sha256(old).hexdigest() != expected_sha256:
                    raise PermissionDenied('File changed; read it again before modifying')
            elif expected_sha256 is not None:
                raise PermissionDenied('File changed; read it again before modifying')
            backup = self._store.backup(path, old, binary=True) if old is not None else None
            self._require_binary_write()
            if deadline is not None and time.monotonic()>=deadline:
                raise PermissionDenied('Processing deadline exceeded; no output saved')
            self._tree.write(path, data, overwrite=overwrite)
        self._audit('media_write', True, path)
        return {'path': path, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest(), 'backup_id': backup}

    def _refresh(self):
        now = time.monotonic()
        for key, entry in list(self._sessions.items()):
            proc = entry['process']
            lifetime = entry.get('lifetime', SESSION_LIFETIME)
            if proc.poll() is None and now - entry['started'] > lifetime:
                self._terminate(proc)
            if proc.poll() is not None and now - entry['started'] > lifetime + 300:
                self._sessions.pop(key, None)

    @staticmethod
    def _terminate(proc):
        if proc.poll() is None:
            try:
                os.killpg(proc.pid, signal.SIGTERM)
                proc.wait(timeout=1)
            except (ProcessLookupError, subprocess.TimeoutExpired):
                try: os.killpg(proc.pid, signal.SIGKILL)
                except ProcessLookupError: pass

    def start_session(self, profile: str) -> dict:
        if profile not in COMMAND_PROFILES:
            self._audit('start_session', False, profile)
            raise PermissionDenied('Only predefined profiles allowed')
        with self._lock:
            self._refresh()
            if sum(x['process'].poll() is None for x in self._sessions.values()) >= MAX_SESSIONS:
                raise PermissionDenied('Too many running sessions')
            argv = self._argv(profile)
            self._audit('session_intent', True, profile)
            p = subprocess.Popen(argv, cwd=self.workspace, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                 stderr=subprocess.STDOUT, start_new_session=True, shell=False,
                                 env={'PATH':'/usr/bin:/bin', 'LANG':'C', 'HOME':str(self.workspace),
                                      'GIT_CONFIG_NOSYSTEM':'1','GIT_CONFIG_GLOBAL':'/dev/null',
                                      'GIT_OPTIONAL_LOCKS':'0','GIT_NO_LAZY_FETCH':'1'})
            os.set_blocking(p.stdout.fileno(), False)
            key = uuid.uuid4().hex
            self._sessions[key] = {'process':p,'profile':profile,'started':time.monotonic(),'output':bytearray(),'truncated':False}
        self._audit('start_session', True, profile)
        return {'session_id':key,'profile':profile,'pid':p.pid,'max_runtime_seconds':SESSION_LIFETIME}

    def session_output(self, session_id: str) -> dict:
        with self._lock:
            self._refresh()
            entry = self._sessions.get(session_id)
            if entry is None:
                raise PermissionDenied('Unknown session')
            p = entry['process']
            while len(entry['output']) < MAX_OUTPUT:
                try: chunk = os.read(p.stdout.fileno(), min(4096,MAX_OUTPUT-len(entry['output'])))
                except BlockingIOError: break
                if not chunk: break
                entry['output'].extend(chunk)
            if len(entry['output']) >= MAX_OUTPUT:
                entry['truncated'] = True
                self._terminate(p)
            result = {'session_id':session_id,'profile':entry['profile'], 'running':p.poll() is None,
                      'exit_code':p.poll(), 'output':bytes(entry['output']).decode('utf-8','replace'),
                      'truncated':entry['truncated']}
        self._audit('session_output', True, session_id)
        return result

    def list_sessions(self) -> dict:
        self._rate()
        with self._lock:
            self._refresh()
            items = [{'session_id':id,'profile':e['profile'],'pid':e['process'].pid,
                      'running':e['process'].poll() is None} for id,e in self._sessions.items()]
        self._audit('list_sessions', True, str(len(items)))
        return {'sessions':items}

    def stop_session(self, session_id: str) -> dict:
        with self._lock:
            entry = self._sessions.get(session_id)
            if entry is None: raise PermissionDenied('Unknown session')
            self._terminate(entry['process'])
            self._sessions.pop(session_id)
        self._audit('stop_session', True, session_id)
        return {'stopped':session_id}

    def status(self) -> dict:
        result = super().status()
        result['stage'] = '2.6'
        result['advanced_tools'] = ['file_info','find_files','write_text','restore_backup','start_session','session_output','list_sessions','stop_session']
        return result
