"""Explicitly enabled computer control. This is an operator agent, NOT an OS sandbox."""
from __future__ import annotations

import argparse
import base64
from concurrent.futures import ThreadPoolExecutor
from contextvars import copy_context
import io
import json
import os
import queue
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import threading
import time
import uuid
from urllib.parse import urlsplit

from .core import OperationNotApplied, OperationNotAppliedFileExists, PermissionDenied
from .portable import PortableCommander
from .coordination import coordinated, coordinator, assignment

CAPABILITIES = frozenset({'files', 'commands', 'browser', 'desktop'})
# Shared with OriginGuard; the gateway keeps an independent fail-closed policy.
READ_TOOLS = frozenset({'jan_inspect_document_pdf','jan_preview_document_workflow','jan_get_document_workflow','jan_preview_spreadsheet','jan_inspect_office','jan_inspect_media','jan_transcribe_audio','jan_read_pdf','jan_task_state', 'jan_workflow_state', 'jan_status', 'jan_list_files', 'jan_read_text', 'jan_diagnostic',
    'jan_run_profile', 'jan_file_info', 'jan_find_files', 'jan_search_text', 'jan_skills', 'jan_route_skill', 'jan_skill_guide', 'jan_feedback_status'})


def capabilities(value):
    selected = frozenset(value.split(',')) if value else frozenset()
    if not selected or not selected <= CAPABILITIES:
        raise ValueError('Choose capabilities from files,commands,browser,desktop')
    return selected


def jpeg(image):
    image = image.convert('RGB')
    original = image.size
    image.thumbnail((1280, 800))
    stream = io.BytesIO()
    image.save(stream, format='JPEG', quality=65)
    data = stream.getvalue()
    if len(data) > 500000:
        raise PermissionDenied('Screenshot exceeds response limit')
    return {'mime_type': 'image/jpeg', 'data': base64.b64encode(data).decode(),
            'width': image.width, 'height': image.height,
            'screen_width': original[0], 'screen_height': original[1]}


class ControlCommander(PortableCommander):
    def _development(self):
        from .development import Development
        with self._lock:
            if not hasattr(self, '_development_manager'):
                self._development_manager=Development(self)
            return self._development_manager

    @coordinated('workspace')
    def inspect_development(self, action, options=None):
        self._check('commands');self._require_capability('files')
        self._audit('development_inspect',True,action)
        return self._development().inspect(action,options or {})

    @coordinated('workspace')
    def preview_development_change(self, action, options):
        self._check('commands');self._require_capability('files')
        self._audit('development_preview',True,action)
        try:
            return self._development().preview(action,options)
        except FileExistsError as exc:
            raise OperationNotAppliedFileExists(str(exc)) from exc
        except ValueError as exc:
            raise OperationNotApplied(str(exc)) from exc

    @coordinated('workspace')
    def apply_development_change(self, plan_id, review_sha256):
        self._check('commands');self._require_capability('files');self._require_binary_write()
        self._audit('development_apply',True,plan_id)
        try:
            return self._development().apply(plan_id,review_sha256)
        except ValueError as exc:
            # The synchronous apply path only validates and queues a worker;
            # all actual workspace mutations occur later inside guarded steps.
            raise OperationNotApplied(str(exc)) from exc

    def get_development_change(self, plan_id):
        # Polling the private operation receipt must remain available while
        # its detached worker owns the workspace reservation. This method
        # reads only PCRC state, not workspace files.
        self._check('commands');self._require_capability('files')
        return self._development().get(plan_id)

    def _documents(self):
        from .document_workflow import DocumentWorkflow
        with self._lock:
            if not hasattr(self, '_document_workflow'):
                self._document_workflow = DocumentWorkflow(self)
            return self._document_workflow

    @coordinated('workspace')
    def preview_document_workflow(self, jobs):
        self._check('files')
        self._audit('document_preview', True, 'bounded document review')
        return self._documents().preview(jobs)

    @coordinated('workspace')
    def apply_document_workflow(self, plan_id, review_sha256, review):
        self._check('files')
        self._require_binary_write()
        self._audit('document_apply', True, plan_id)
        return self._documents().apply(plan_id, review_sha256, review)

    @coordinated('workspace')
    def get_document_workflow(self, plan_id):
        self._check('files')
        return self._documents().get(plan_id)

    @coordinated('files','path')
    def inspect_document_pdf(self, path, pages=None):
        import hashlib
        from .document_workflow import worker
        from .security_scan import scan_bytes
        self._check('files')
        if not isinstance(path,str) or not path.casefold().endswith('.pdf'):
            raise ValueError('Choose a workspace PDF')
        deadline=time.monotonic()+14
        data=self._tree.read(path,8*1024*1024);scan=scan_bytes(data,'.pdf',deadline=deadline)
        result=worker({'kind':'inspect_pdf','path':path,'pages':[1] if pages is None else pages},{path:data},deadline)
        return {**result['review'],'images':result['images'],'path':path,'sha256':hashlib.sha256(data).hexdigest(),'security_scan':scan}

    def _require_binary_write(self):
        self._require_capability('files')
        super()._require_binary_write()

    @coordinated('files','path')
    def inspect_office(self,path,sheet='',start_row=1,max_rows=50):
        from .office_documents import process_office
        self._check('files')
        self._audit('inspect_office',True,path)
        return process_office(self._tree,path,sheet=sheet,start_row=start_row,max_rows=max_rows)

    def preview_spreadsheet(self,path,sheet,changes,expected_sha256):
        return self.edit_spreadsheet(path,sheet,changes,expected_sha256,dry_run=True)

    @coordinated('files','path')
    def edit_spreadsheet(self,path,sheet,changes,expected_sha256,dry_run=True):
        from .office_documents import process_office
        self._check('files')
        if type(dry_run) is not bool or not isinstance(path,str) or not path.casefold().endswith('.xlsx'):
            raise PermissionDenied('Choose an XLSX file and boolean dry_run')
        result=process_office(self._tree,path,sheet=sheet,changes=changes,dry_run=dry_run)
        if result['sha256']!=expected_sha256:
            raise PermissionDenied('File changed; inspect it again before editing')
        if dry_run:
            return result
        write=self._write_binary(path,result.pop('bytes'),overwrite=True,expected_sha256=expected_sha256)
        return {**result,**write,'source_sha256':expected_sha256}

    @coordinated('files','path')
    def inspect_media(self,path,kind,start=0,seconds=10):
        self._check('files')
        from .media_tools import process_media
        self._audit('inspect_media',True,path)
        return process_media(self._tree,self._store.path/'media',path,'inspect',kind,start=start,seconds=seconds)

    @coordinated('files','path')
    def transcribe_audio(self,path,start=0,seconds=10):
        self._check('files')
        from .media_tools import process_media
        self._audit('transcribe_audio',True,path)
        return process_media(self._tree,self._store.path/'media',path,'transcribe','audio',start=start,seconds=seconds)

    @coordinated('files','path','destination')
    def edit_media(self,path,destination,kind,expected_sha256,start=0,seconds=10,width=1280,height=720,
                   rotation=0,overwrite=False,expected_destination_sha256=None):
        deadline=time.monotonic()+15
        self._check('files')
        from .media_tools import process_media
        extensions={'image':'.jpg','audio':'.wav','video':'.mp4'}
        if kind not in extensions or not isinstance(destination,str) or not destination.casefold().endswith(extensions[kind]):
            raise PermissionDenied('Use a relative .jpg image, .wav audio or .mp4 video destination')
        if overwrite and not expected_destination_sha256:
            raise PermissionDenied('Inspect overwrite destination first; its SHA-256 is required')
        value=process_media(self._tree,self._store.path/'media',path,'edit',kind,start=start,seconds=seconds,
                            width=width,height=height,rotation=rotation,deadline=deadline)
        if value['sha256']!=expected_sha256:raise PermissionDenied('Source changed; inspect it again')
        result=self._write_binary(destination,value.pop('bytes'),overwrite=overwrite,expected_sha256=expected_destination_sha256,deadline=deadline)
        return {**value,**result,'source_sha256':expected_sha256}

    @coordinated('workspace')
    def prepare_media(self,speech=False):
        self._check('commands')
        if type(speech) is not bool:raise PermissionDenied('Speech option must be boolean')
        return self.start_program(sys.executable,['-I','-m','jan_mcp_commander.media_install',
            '--root',str(self._store.path/'media'),*(['--speech'] if speech else [])],timeout_seconds=3600)

    @coordinated('files', 'destination')
    def create_pdf(self, destination, text):
        from .pdf_tools import create_text_pdf
        self._check('files')
        self._rate()
        if not isinstance(destination, str) or not destination.casefold().endswith('.pdf'):
            raise PermissionDenied('Choose a relative PDF destination')
        data, pages = create_text_pdf(text)
        return {**self._write_binary(destination, data), 'page_count': pages}

    @coordinated('files','path')
    def read_pdf(self, path):
        self._check('files')
        return super().read_pdf(path)

    @coordinated('files', 'path', 'destination')
    def rewrite_pdf(self, path, destination, expected_sha256, pages, rotation=0,
                    overwrite=False, expected_destination_sha256=None):
        self._check('files')
        return super().rewrite_pdf(path, destination, expected_sha256, pages, rotation,
                                    overwrite, expected_destination_sha256)

    def __init__(self, workspace, *, enabled, duration_minutes=60, headless=False, browser_channel='chromium',foreground=False,foreground_parent_pid=None):
        if not frozenset(enabled) <= CAPABILITIES or not enabled:
            raise ValueError('Explicit capabilities required')
        if type(duration_minutes) is not int or not 1 <= duration_minutes <= 480:
            raise ValueError('Control duration must be 1..480 minutes')
        if browser_channel not in {'chromium', 'chrome', 'msedge'}:
            raise ValueError('Browser channel must be chromium, chrome or msedge')
        if type(foreground) is not bool:raise ValueError('Foreground option must be boolean')
        super().__init__(workspace)
        self.enabled = frozenset(enabled)
        self.allow_writes = 'files' in self.enabled
        self.expires = time.monotonic() + duration_minutes * 60
        self._disabled = False
        self._closed = False
        self._headless = headless
        self._browser_channel = browser_channel
        self._browser_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix='jan-browser')
        self._browser = None
        self._browser_pages = {}
        self._desktop_frame = None
        self._uia_inspection = None
        self._ui_lock = threading.RLock()
        self._foreground_parent=None
        self._audit('control_enabled', True, ','.join(sorted(self.enabled)))
        if foreground:
            from .foreground import ParentSession
            self._foreground_parent=ParentSession(foreground_parent_pid)
            self._foreground_parent.start(self._renew_foreground,self.close_control)

    def _renew_foreground(self):
        if self._disabled or self._closed:return False
        if self._foreground_parent is not None and self._foreground_parent.alive():
            self.expires=time.monotonic()+480*60
            return True
        return False

    def _require_capability(self, capability):
        if self._foreground_parent is not None and not self._renew_foreground():
            self.close_control()
        if self._disabled or time.monotonic() >= self.expires or capability not in self.enabled:
            raise PermissionDenied('Control capability disabled or expired; enable it locally')

    def _check(self, capability):
        # Capability, rate-limit and audit checks are preflight gates. If one
        # rejects an operation, the coordination ledger must record a clean
        # precondition failure, not an uncertain side effect requiring review.
        try:
            self._require_capability(capability)
            self._rate()
            # Never log command text, website content, form values or screenshots.
            self._audit('control_intent', True, capability)
        except PermissionDenied as exc:
            raise OperationNotApplied(str(exc)) from exc

    def skill_feedback(self, category, selected_skill, routing_method, outcome, correction=''):
        self._check('files')
        from .skills import Feedback
        return Feedback(self._store).record(category, selected_skill, routing_method, outcome, correction, reviewed=False)

    def diagnostic(self, name):
        self._check('commands')
        return super().diagnostic(name)

    def status(self):
        result = super().status()
        if self._foreground_parent is not None and not self._renew_foreground():self.close_control()
        active = not self._disabled and time.monotonic() < self.expires
        result.update(control_enabled=active, capabilities=sorted(self.enabled) if active else [],
                      control_seconds_remaining=max(0, int(self.expires-time.monotonic())) if active else 0,
                      arbitrary_shell=active and 'commands' in self.enabled, os_sandbox=False,
                      read_only=not (active and 'files' in self.enabled))
        if self._foreground_parent is not None:
            result.update(connection_lifetime='until terminal closes',foreground_active=active)
        return result

    @coordinated('files', 'path')
    def list_files(self, path='.'):
        """List workspace entries only when the files capability is enabled."""
        self._check('files')
        return super().list_files(path)

    @coordinated('files', 'path')
    def read_text(self, path):
        """Read workspace text only when the files capability is enabled."""
        self._check('files')
        return super().read_text(path)

    @coordinated('files', 'path')
    def file_info(self, path):
        """Inspect workspace file metadata only with the files capability."""
        self._check('files')
        return super().file_info(path)

    @coordinated('files', 'path')
    def find_files(self, term, max_results=50, path='.'):
        """Search filenames within the reserved path and enabled file capability."""
        self._check('files')
        return super().find_files(term, max_results, path)

    @coordinated('files', 'path')
    def create_directory(self, path):
        self._check('files')
        self._audit('create_directory', True, path)
        self._tree.mkdir(path)
        return {'path': path, 'created': True}

    @coordinated('files', 'path')
    def write_text(self, path, content, overwrite=False):
        self._check('files')
        return super().write_text(path, content, overwrite)

    @coordinated('files', 'path')
    def delete_text(self, path, expected_sha256):
        """Delete a reviewed workspace text file with a private recovery backup."""
        import hashlib
        from .safe_fs import unsupported_content
        self._check('files')
        if not isinstance(expected_sha256, str) or len(expected_sha256) != 64:
            raise PermissionDenied('Expected SHA256 required')
        self._audit('delete_intent', True, str(path))
        try:
            with self._lock, self._store.locked():
                data = self._tree.read(path)
                if unsupported_content(data):
                    raise PermissionDenied('Binary or private key data denied')
                if hashlib.sha256(data).hexdigest() != expected_sha256:
                    raise PermissionDenied('File changed; read it again before modifying')
                backup_id = self._store.backup(path, data)
                self._tree.unlink_file(path)
        except (OSError, ValueError) as exc:
            raise PermissionDenied('Delete denied') from exc
        self._audit('delete_text', True, f'{path};backup={backup_id}')
        return {'deleted': path, 'backup_id': backup_id}

    @coordinated('files', 'source', 'destination')
    def move_text(self, source, destination, expected_sha256):
        """Move or rename a reviewed workspace text file without overwriting."""
        import hashlib
        from .safe_fs import unsupported_content
        self._check('files')
        if not isinstance(source, str) or not isinstance(destination, str) or source.casefold() == destination.casefold():
            raise PermissionDenied('Choose distinct workspace paths')
        if not isinstance(expected_sha256, str) or len(expected_sha256) != 64:
            raise PermissionDenied('Expected SHA256 required')
        self._audit('move_intent', True, str(source))
        try:
            with self._lock, self._store.locked():
                data = self._tree.read(source)
                if unsupported_content(data):
                    raise PermissionDenied('Binary or private key data denied')
                if hashlib.sha256(data).hexdigest() != expected_sha256:
                    raise PermissionDenied('File changed; read it again before modifying')
                backup_id = self._store.backup(source, data)
                self._tree.write(destination, data, overwrite=False)
                try:
                    self._tree.unlink_file(source)
                except (OSError, ValueError):
                    self._tree.unlink_file(destination)
                    raise
        except (OSError, ValueError) as exc:
            raise PermissionDenied('Move denied') from exc
        self._audit('move_text', True, f'{source};backup={backup_id}')
        return {'moved_from': source, 'moved_to': destination, 'backup_id': backup_id}

    @coordinated('workspace')
    def restore_backup(self, backup_id):
        self._check('files')
        return super().restore_backup(backup_id)

    @coordinated('files', 'path')
    def edit_text(self, path, old_text, new_text, expected_sha256, dry_run=True):
        import hashlib
        import difflib
        self._check('files')
        if not isinstance(old_text, str) or not old_text or not isinstance(new_text, str) or type(dry_run) is not bool:
            raise PermissionDenied('Use non-empty literal old_text, new_text and a boolean dry_run')
        from .privacy import assert_public_text
        assert_public_text(old_text)
        assert_public_text(new_text)
        from .safe_fs import unsupported_content
        with self._lock, self._store.locked():
            data = self._tree.read(path)
            if unsupported_content(data):
                raise PermissionDenied('Binary or private key data denied')
            if hashlib.sha256(data).hexdigest() != expected_sha256:
                raise OperationNotApplied('File changed; read it again before editing')
            before = data.decode('utf-8')
            if before.count(old_text) != 1:
                raise PermissionDenied('old_text must match exactly once')
            after = before.replace(old_text, new_text, 1)
            assert_public_text(after)
            diff = ''.join(difflib.unified_diff(before.splitlines(True), after.splitlines(True), fromfile=path, tofile=path))[:16384]
            if dry_run:
                return {'dry_run': True, 'diff': diff, 'expected_sha256': expected_sha256}
            # _write re-acquires the store lock; leave this scope before invoking it.
        with self._lock:
            if self._tree.read(path) != data:
                raise OperationNotApplied('File changed before apply')
            result = self.write_text(path, after, overwrite=True)
            return {**result, 'sha256': hashlib.sha256(after.encode()).hexdigest()}

    @coordinated('workspace')
    def search_text(self, term, max_results=50):
        self._check('files')
        from .safe_fs import unsupported_content
        self._rate()
        if not isinstance(term, str) or not term or len(term) > 200 or type(max_results) is not int or not 1 <= max_results <= 100:
            raise PermissionDenied('Invalid literal search')
        from .privacy import assert_public_text
        assert_public_text(term)
        self._audit('search_text', True, 'literal search; contents omitted')
        pending, matches, scanned = ['.'], [], 0
        deadline = time.monotonic()+2
        while pending and scanned < 1000 and time.monotonic() < deadline and len(matches) < max_results:
            directory = pending.pop()
            try:
                entries = self._tree.entries(directory, limit=100, scan_limit=100)
            except (OSError, ValueError):
                continue
            for entry in entries:
                scanned += 1
                path = entry['name'] if directory == '.' else directory+'/'+entry['name']
                if entry['kind'] == 'directory':
                    if path.count('/') < 10: pending.append(path)
                    continue
                try:
                    data = self._tree.read(path)
                    if unsupported_content(data): continue
                    lines = data.decode('utf-8').splitlines()
                except (OSError, ValueError):
                    continue
                for number, line in enumerate(lines, 1):
                    if term in line:
                        matches.append({'path': path, 'line': number, 'text': line[:300]})
                        if len(matches) >= max_results: break
                if len(matches) >= max_results: break
        return {'matches': matches, 'bounded_search': True, 'scanned': scanned}

    @coordinated('workspace')
    def start_session(self, profile):
        self._check('commands')
        result = super().start_session(profile)
        current = assignment.get()
        if current:
            entry = self._sessions.get(result.get('session_id'))
            if entry is not None:
                entry['task_id'] = current[0]
        return result

    @coordinated('workspace')
    def start_process(self, command, shell='system', timeout_seconds=300):
        self._check('commands')
        from .privacy import assert_public_text
        assert_public_text(command)
        if type(timeout_seconds) is not int or not 1 <= timeout_seconds <= 3600:
            raise PermissionDenied('Process runtime must be 1..3600 seconds, within the local grant')
        if not isinstance(command, str) or not command.strip() or len(command.encode()) > 16384 or '\x00' in command:
            raise PermissionDenied('Command must contain 1..16384 bytes without NUL')
        if shell not in {'system', 'bash', 'powershell', 'cmd'}:
            raise PermissionDenied('Shell must be system, bash, powershell or cmd')
        if os.name == 'nt':
            shell = 'powershell' if shell == 'system' else shell
            if shell == 'powershell':
                executable = Path(os.environ.get('SystemRoot', r'C:\Windows')) / 'System32/WindowsPowerShell/v1.0/powershell.exe'
                argv = [str(executable), '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command]
            elif shell == 'cmd':
                executable = Path(os.environ.get('SystemRoot', r'C:\Windows')) / 'System32/cmd.exe'
                # cmd.exe requires raw /c quoting; list2cmdline backslash-escapes quotes incorrectly.
                argv = f'"{executable}" /d /s /c "{command}"'
            else:
                raise PermissionDenied('Use PowerShell or cmd on Windows')
        else:
            if shell not in {'system', 'bash'}:
                raise PermissionDenied('Use bash on Linux or macOS')
            executable = shutil.which('bash', path='/usr/bin:/bin')
            if not executable:
                raise PermissionDenied('Bash is unavailable')
            argv = [executable, '--noprofile', '--norc', '-c', command]
        return self._start_controlled_argv(argv, timeout_seconds)

    def list_applications(self, query='', limit=30):
        self._check('commands')
        self._rate()
        from .applications import installed_applications, validate_query
        query=validate_query(query, empty=True)
        if type(limit) is not int or not 1<=limit<=50:
            raise ValueError('Application limit must be 1..50')
        matches=[row for row in installed_applications() if not query or query in row['name'].casefold() or query==row['app_id'].casefold()]
        return {'applications':matches[:limit],'total_matches':len(matches),'truncated':len(matches)>limit,
                'scope':'Registered applications; portable programs may require an absolute path'}

    @coordinated('workspace')
    def open_application(self, application):
        self._check('commands')
        self._rate()
        from .applications import installed_applications, launch_application, select_application
        selected=select_application(installed_applications(), application)
        self._audit('open_application',True,'approved registered application')
        launch_application(selected['app_id'])
        return {**selected,'launch_requested':True,'visible_verified':False,
                'next_step':'Inspect a fresh approved desktop frame to verify the expected app opened. Launch acknowledgement does not prove the app is ready. Unrelated windows were not closed.'}

    @coordinated('workspace')
    def start_program(self, executable, arguments=None, timeout_seconds=300):
        self._check('commands')
        if type(timeout_seconds) is not int or not 1 <= timeout_seconds <= 3600:
            raise PermissionDenied('Process runtime must be 1..3600 seconds')
        if not isinstance(executable, str) or not Path(executable).is_absolute():
            raise PermissionDenied('Use an absolute executable path')
        path = Path(executable).resolve(strict=True)
        if not path.is_file(): raise PermissionDenied('Executable file required')
        arguments = [] if arguments is None else arguments
        if not isinstance(arguments, list) or len(arguments) > 64 or any(not isinstance(a,str) or '\x00' in a for a in arguments) or sum(len(a.encode()) for a in arguments) > 16384:
            raise PermissionDenied('Use at most 64 argv strings totaling 16 KiB without NUL')
        return self._start_controlled_argv([str(path), *arguments], timeout_seconds)

    def _start_controlled_argv(self, argv, timeout_seconds, environment=None):
        self._check('commands')
        child_environment = self._environment() if environment is None else environment
        lifetime = max(1, min(timeout_seconds, int(self.expires-time.monotonic())))

        def launch():
            from .session_guard import (
                create_windows_job_handle, close_windows_job_handle,
                terminate_windows_job_and_wait,
            )
            store = coordinator(self).store
            lock_resource = 'session:' + uuid.uuid4().hex
            owner_lock_resource = 'session-owner:' + uuid.uuid4().hex
            owner_ready = threading.Event()
            owner_release = threading.Event()
            owner_errors = []

            def hold_owner_lock():
                try:
                    with store.resource_locked(owner_lock_resource):
                        owner_ready.set()
                        owner_release.wait()
                except BaseException as exc:
                    owner_errors.append(exc)
                    owner_ready.set()

            threading.Thread(target=hold_owner_lock, daemon=True).start()
            if not owner_ready.wait(10) or owner_errors:
                owner_release.set()
                raise PermissionDenied('Could not establish the parent-owned session reservation')

            supervisor = None
            job_handle = None
            try:
                options = ({'creationflags': subprocess.CREATE_NEW_PROCESS_GROUP}
                           if os.name == 'nt' else {'start_new_session': True})
                supervisor_environment = dict(child_environment)
                supervisor_environment['PCRC_SUPERVISOR_PARENT_PID'] = str(os.getpid())
                startupinfo = None
                if os.name == 'nt':
                    job_handle = create_windows_job_handle()
                    supervisor_environment['PCRC_SUPERVISOR_JOB_HANDLE'] = str(job_handle)
                    startupinfo = subprocess.STARTUPINFO()
                    startupinfo.lpAttributeList = {'handle_list': [job_handle]}
                supervisor = subprocess.Popen(
                    [sys.executable, '-m', 'jan_mcp_commander.session_guard'],
                    cwd=self.workspace, env=supervisor_environment,
                    stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE, shell=False,
                    startupinfo=startupinfo, **options)
                config = {
                    'workspace': str(self.workspace),
                    'state_dir': str(store.path),
                    'lock_resource': lock_resource,
                    'argv': argv,
                }
                supervisor.stdin.write((json.dumps(config) + '\n').encode('utf-8'))
                supervisor.stdin.flush()

                def read_protocol_line():
                    ready = threading.Event()
                    result_box = []
                    def read():
                        result_box.append(supervisor.stdout.readline())
                        ready.set()
                    threading.Thread(target=read, daemon=True).start()
                    if not ready.wait(15):
                        raise PermissionDenied('Detached command supervisor did not acquire its reservation in time')
                    if not result_box[0]:
                        diagnostic = b''
                        if supervisor.poll() is not None and supervisor.stderr is not None:
                            diagnostic = supervisor.stderr.read(4096)
                        detail = diagnostic.decode('utf-8', 'replace').strip()
                        safe_detail = detail if detail.startswith('{"supervisor_error":') else ''
                        suffix = f' ({safe_detail})' if safe_detail else ''
                        raise PermissionDenied(
                            'Detached command supervisor exited before acquiring its reservation' + suffix)
                    try:
                        return json.loads(result_box[0].decode('utf-8'))
                    except (UnicodeError, ValueError) as exc:
                        raise PermissionDenied('Detached command supervisor returned an invalid handshake') from exc

                locked = read_protocol_line()
                if locked != {'locked': True}:
                    raise PermissionDenied('Detached command supervisor failed to acquire its reservation')
                operation_id = coordinator(self).register_detached_operation(
                    lock_resource, owner_lock_resource, supervisor_pid=supervisor.pid)
                supervisor.stdin.write((json.dumps({
                    'launch': True, 'operation_id': operation_id,
                }) + '\n').encode('utf-8'))
                supervisor.stdin.flush()
                ready = read_protocol_line()
                if ready.get('ready') is not True or type(ready.get('pid')) is not int:
                    raise PermissionDenied('Detached command process failed to start')

                coordinator(self).set_detached_child_identity(operation_id, ready['pid'])
                supervisor.pcrc_child_pid = ready['pid']
                supervisor.pcrc_supervisor_pid = supervisor.pid
                supervisor.pcrc_job_handle = job_handle
                supervisor.pcrc_lock_resource = lock_resource
                supervisor.pcrc_owner_lock_resource = owner_lock_resource

                def finalize_detached_operation():
                    try:
                        if os.name == 'nt' and job_handle:
                            supervisor.pcrc_terminated = terminate_windows_job_and_wait(job_handle)
                        # On POSIX the child inherits the supervisor's lock
                        # descriptor. On Windows the parent and supervisor
                        # retain a kill-on-close Job Object for the full tree.
                        while True:
                            with store.try_resource_locked(lock_resource) as acquired:
                                group_alive = False
                                if acquired and os.name == 'posix':
                                    try:
                                        os.killpg(supervisor.pcrc_child_pid, 0)
                                        group_alive = True
                                    except ProcessLookupError:
                                        group_alive = False
                                    except PermissionError:
                                        group_alive = True
                                if acquired and not group_alive:
                                    coordinator(self).finish_detached_operation(
                                        operation_id, success=(supervisor.returncode == 0 and not getattr(supervisor, 'pcrc_terminated', False)),
                                        exit_code=supervisor.returncode,
                                        terminated=getattr(supervisor, 'pcrc_terminated', False))
                                    supervisor.pcrc_finalized = True
                                    break
                            time.sleep(0.05)
                    finally:
                        if job_handle:
                            close_windows_job_handle(job_handle)
                        owner_release.set()

                supervisor.pcrc_on_exit = finalize_detached_operation
                return supervisor
            except BaseException:
                try:
                    if supervisor is not None:
                        self._terminate(supervisor)
                except Exception:
                    pass
                if job_handle:
                    terminate_windows_job_and_wait(job_handle)
                    close_windows_job_handle(job_handle)
                owner_release.set()
                raise

        result = self._start_owned_session('operator_command', launch,
                                            lifetime=lifetime, output_limit=1048576)
        identifier = result['session_id']
        entry = self._sessions[identifier]
        entry['child_pid'] = entry['process'].pcrc_child_pid
        entry['supervisor_pid'] = entry['process'].pcrc_supervisor_pid
        entry['input_queue'] = queue.Queue(maxsize=4)
        threading.Thread(target=self._write_input, args=(entry,), daemon=True).start()
        threading.Thread(target=self._expire_process, args=(identifier,), daemon=True).start()
        result['pid'] = entry['child_pid']
        result['supervisor_pid'] = entry['supervisor_pid']
        return result

    @staticmethod
    def _terminate(proc):
        if getattr(proc, 'pcrc_finalized', False):
            return
        if os.name == 'posix' and getattr(proc, 'pcrc_child_pid', None):
            # Ask a live supervisor to kill the child process group. If the
            # supervisor has already crashed, do not signal a bare PID: the
            # inherited lock remains held until that original child exits.
            if proc.poll() is None:
                proc.pcrc_terminated = True
                try:
                    proc.send_signal(signal.SIGTERM)
                except OSError:
                    pass
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    for process_group in (proc.pcrc_child_pid, proc.pid):
                        try:
                            os.killpg(process_group, signal.SIGKILL)
                        except ProcessLookupError:
                            pass
            else:
                # A surviving process group cannot have its numeric PGID
                # reused while any member remains, so verify it still exists.
                try:
                    os.killpg(proc.pcrc_child_pid, 0)
                except ProcessLookupError:
                    pass
                else:
                    proc.pcrc_terminated = True
                    os.killpg(proc.pcrc_child_pid, signal.SIGKILL)
            return
        PortableCommander._terminate(proc)

    @staticmethod
    def _check_session_task_access(entry):
        current = assignment.get()
        if current is not None and entry.get('task_id') != current[0]:
            raise PermissionDenied(
                'This command session belongs to another task or the unassigned operator. '
                'Use the matching task assignment or an unassigned operator session.'
            )

    @staticmethod
    def _write_input(entry):
        try:
            while not entry['done'].is_set():
                try:
                    packet = entry['input_queue'].get(timeout=0.1)
                except queue.Empty:
                    continue
                entry['process'].stdin.write(packet)
                entry['process'].stdin.flush()
        except (OSError, ValueError):
            entry['input_closed'] = True
        finally:
            entry['process'].stdin.close()

    @coordinated('workspace')
    def process_input(self, session_id, text, newline=True):
        self._check('commands')
        from .privacy import assert_public_text
        assert_public_text(text)
        if not isinstance(text, str) or len(text.encode()) > 4096 or '\x00' in text or type(newline) is not bool:
            raise PermissionDenied('Input must be at most 4096 UTF-8 bytes without NUL')
        with self._lock:
            entry = self._sessions.get(session_id)
            if not entry or entry['profile'] != 'operator_command' or entry['done'].is_set() or entry.get('input_closed'):
                raise PermissionDenied('Owned command is not accepting input')
            self._check_session_task_access(entry)
            try:
                entry['input_queue'].put_nowait((text+('\n' if newline else '')).encode())
            except queue.Full as exc:
                raise PermissionDenied('Process input queue is full') from exc
        return {'queued': True, 'delivery_verified': False}

    def process_output(self, session_id, offset=0, length=16384):
        self._check('commands')
        if type(offset) is not int or offset < 0 or type(length) is not int or not 1 <= length <= 16384:
            raise PermissionDenied('Use a nonnegative byte offset and 1..16384 byte length')
        with self._lock:
            entry = self._sessions.get(session_id)
            if not entry or entry['profile'] != 'operator_command':
                raise PermissionDenied('Unknown owned command')
            self._check_session_task_access(entry)
            data = bytes(entry['output'][offset:offset+length])
            from .privacy import assert_public_text
            assert_public_text(bytes(entry['output']).decode('utf-8','replace'))
            return {'session_id':session_id,'output':data.decode('utf-8','replace'),
                'next_offset':offset+len(data),'total_bytes':len(entry['output']),
                'running':not entry['done'].is_set(),'exit_code':entry['process'].poll(),
                'truncated':entry['truncated'],'timed_out':entry['timed_out']}

    def _expire_process(self, identifier):
        remaining = max(0, self.expires-time.monotonic())
        entry = self._sessions.get(identifier)
        if entry and not entry['done'].wait(remaining):
            self._terminate(entry['process'])

    @coordinated('workspace')
    def run_command(self, command, shell='system', timeout_seconds=10):
        if type(timeout_seconds) is not int or not 1 <= timeout_seconds <= 15:
            raise PermissionDenied('Synchronous timeout must be 1..15 seconds; use start_process for longer commands')
        result = self.start_process(command, shell)
        entry = self._sessions[result['session_id']]
        if not entry['done'].wait(timeout_seconds):
            entry['timed_out'] = True
            self._terminate(entry['process'])
            entry['done'].wait(5)
        try:
            return {**self.session_output(result['session_id']), 'session_retained': False,
                    'session_note': 'Synchronous command finished; use start_process or start_program for a retained interactive session.'}
        finally:
            self.stop_session(result['session_id'])

    def session_output(self, session_id):
        self._check('commands')
        entry = self._sessions.get(session_id)
        if entry is not None:
            self._check_session_task_access(entry)
        if entry and entry['profile'] == 'operator_command':
            return self.process_output(session_id)
        return super().session_output(session_id)

    def stop_session(self, session_id):
        entry = self._sessions.get(session_id)
        if entry is None:
            return super().stop_session(session_id)
        self._check_session_task_access(entry)
        result = super().stop_session(session_id)
        return {
            **result,
            'pid': entry.get('child_pid', result['pid']),
            'supervisor_pid': entry.get('supervisor_pid', result['pid']),
        }

    def list_sessions(self):
        self._check('commands')
        return super().list_sessions()

    def disable_control(self):
        self.close_control()
        return {'control_enabled': False, 'restart_locally_required': True}

    @coordinated('ui')
    def browser_action(self, action, target='', text=''):
        self._check('browser')
        if action not in {'open', 'new_tab', 'tabs', 'select_tab', 'close_tab', 'back', 'forward', 'reload', 'snapshot', 'click', 'fill', 'press', 'select', 'check', 'screenshot', 'close'}:
            raise PermissionDenied('Unknown browser action')
        if not isinstance(target, str) or not isinstance(text, str) or len(target) > 2048 or len(text) > 4096:
            raise PermissionDenied('Browser input exceeds limit')
        from .privacy import assert_public_text
        assert_public_text(target)
        assert_public_text(text)
        # Playwright sync objects must remain on their creating thread.
        return self._browser_executor.submit(self._browser_action, action, target, text).result(timeout=18)

    def _browser_action(self, action, target, text):
        self._check('browser')
        if action == 'new_tab' and not target:
            target = 'about:blank'
        if action == 'close':
            self._close_browser()
            return {'closed': True}
        if action in {'open', 'new_tab'} and not (action == 'new_tab' and target == 'about:blank'):
            url = urlsplit(target)
            if url.scheme not in {'http', 'https'} or not url.hostname or url.username or url.password:
                raise PermissionDenied('Open an http(s) URL without embedded credentials')
        if self._browser is None:
            try:
                from playwright.sync_api import sync_playwright
            except ImportError as exc:
                raise PermissionDenied('Install the browser extra and Chromium locally; see docs/computer-control.md') from exc
            driver = sync_playwright().start()
            browser = None
            try:
                browser = driver.chromium.launch(headless=self._headless, chromium_sandbox=True,
                    channel=None if self._browser_channel == 'chromium' else self._browser_channel)
                context = browser.new_context(accept_downloads=False, service_workers='block', viewport={'width':1280, 'height':800})
                context.set_default_timeout(5000)
                # No normal profile, exported cookies, extensions, storage API or arbitrary JS tool.
                page = context.new_page()
                page.on('dialog', lambda dialog: dialog.dismiss())
                self._browser = (driver, browser, context, page)
            except Exception:
                if browser:
                    browser.close()
                driver.stop()
                raise
        _, _, context, page = self._browser
        for candidate in context.pages:
            if candidate not in self._browser_pages.values():
                if len(self._browser_pages) >= 8:
                    candidate.close()
                else:
                    self._browser_pages[uuid.uuid4().hex] = candidate
        self._browser_pages = {key:p for key,p in self._browser_pages.items() if not p.is_closed()}
        if action == 'tabs':
            return {'tabs':[{'tab_id':key,'title':p.title()[:200],
                'url':urlsplit(p.url)._replace(query='',fragment='').geturl(),'active':p==page} for key,p in self._browser_pages.items()]}
        if action in {'select_tab', 'close_tab'}:
            selected = self._browser_pages.get(target)
            if selected is None: raise PermissionDenied('Unknown browser tab; list tabs first')
            if action == 'close_tab':
                selected.close()
                del self._browser_pages[target]
                if not self._browser_pages:
                    self._close_browser()
                    return {'closed': True}
                page = next(iter(self._browser_pages.values()))
            else:
                page = selected
                page.bring_to_front()
            self._browser = (*self._browser[:3], page)
        if action == 'new_tab':
            if len(self._browser_pages) >= 8: raise PermissionDenied('Browser tab limit reached')
            page = context.new_page()
            page.on('dialog', lambda dialog: dialog.dismiss())
            self._browser_pages[uuid.uuid4().hex] = page
            self._browser = (*self._browser[:3], page)
        if action in {'open', 'new_tab'}:
            page.goto(target, wait_until='domcontentloaded', timeout=10000)
        elif action in {'back', 'forward', 'reload'}:
            getattr(page, {'back':'go_back','forward':'go_forward','reload':'reload'}[action])(wait_until='domcontentloaded', timeout=10000)
        elif action in {'click', 'fill', 'press', 'select', 'check'}:
            locator = page.locator(target)
            if locator.count() != 1:
                raise PermissionDenied('Selector must identify exactly one element')
            # Credentials/OTP are entered manually in the visible browser.
            if locator.evaluate("e => e.matches('input[type=password i],[autocomplete*=one-time-code i],[autocomplete*=current-password i],[autocomplete*=new-password i],[autocomplete*=cc- i]')"):
                raise PermissionDenied('Enter credentials locally in the browser')
            if action == 'click':
                locator.click()
            elif action == 'fill':
                locator.fill(text)
            elif action == 'press':
                locator.press(text)
            elif action == 'select':
                locator.select_option(value=text)
            else:
                if text not in {'true','false'}: raise PermissionDenied('check text must be true or false')
                locator.set_checked(text=='true')
        elif action == 'screenshot':
            from .privacy import assert_public_text
            assert_public_text(page.locator('body').inner_text(timeout=5000))
            from PIL import Image
            return jpeg(Image.open(io.BytesIO(page.screenshot(type='jpeg', quality=60,
                mask=[page.locator('input,textarea')], timeout=5000))))
        # Fixed DOM extraction; input values, hidden fields, scripts and URL queries excluded.
        result = page.evaluate('''() => ({title:document.title.slice(0,200),
          text:(document.body?.innerText || '').slice(0,16000),
          elements:Array.from(document.querySelectorAll('a,button,input,textarea,select')).slice(0,100).map(e=>({
            tag:e.tagName.toLowerCase(),id:e.id,type:e.getAttribute('type'),
            label:(e.getAttribute('aria-label')||e.getAttribute('placeholder')||e.innerText||'').slice(0,120)
          }))})''')
        from .privacy import assert_public_text
        assert_public_text(json.dumps(result))
        url = urlsplit(page.url)
        result['url'] = url._replace(query='', fragment='').geturl()
        result['url_parameters_redacted'] = bool(url.query or url.fragment)
        result['tab_id'] = next((key for key,p in self._browser_pages.items() if p==page), None)
        return result

    def _close_browser(self):
        if self._browser:
            driver, browser, context, _ = self._browser
            self._browser = None
            self._teaching = None
            self._recorder_binding = False
            self._browser_pages.clear()
            try:
                context.close()
            finally:
                try:
                    browser.close()
                finally:
                    driver.stop()

    @coordinated('ui')
    def browser_workflow(self, action, options=None):
        self._check('browser')
        from .browser_teaching import workflow_action
        return self._browser_executor.submit(copy_context().run, workflow_action, self, action, options or {}).result(timeout=18)

    @staticmethod
    def _foreground_window():
        if sys.platform == 'darwin':
            try:
                from AppKit import NSWorkspace
                import Quartz
                if not Quartz.CGPreflightScreenCaptureAccess() or not Quartz.AXIsProcessTrusted():
                    raise PermissionDenied('Allow Screen Recording and Accessibility for PCRC in macOS System Settings')
                app = NSWorkspace.sharedWorkspace().frontmostApplication()
                if app is not None:
                    windows = Quartz.CGWindowListCopyWindowInfo(Quartz.kCGWindowListOptionOnScreenOnly, Quartz.kCGNullWindowID) or []
                    for window in windows:
                        if window.get(Quartz.kCGWindowOwnerPID) == app.processIdentifier() and window.get(Quartz.kCGWindowLayer) == 0:
                            return f"{app.processIdentifier()}:{window[Quartz.kCGWindowNumber]}"
            except ImportError as exc:
                raise PermissionDenied('Install the macOS desktop extra') from exc
            raise PermissionDenied('Desktop frame requires a visible foreground application window')
        if sys.platform.startswith('linux'):
            try:
                from Xlib.display import Display
                from Xlib import Xatom
                display = Display()
                try:
                    active = display.screen().root.get_full_property(display.intern_atom('_NET_ACTIVE_WINDOW', only_if_exists=True), Xatom.WINDOW)
                    if active is not None and len(active.value) == 1 and active.value[0]:
                        return str(active.value[0])
                finally:
                    display.close()
            except Exception as exc:
                raise PermissionDenied('Could not verify the active Linux X11 window') from exc
            raise PermissionDenied('Desktop frame requires an active Linux X11 window')
        if os.name != 'nt':
            raise PermissionDenied('Desktop input is unavailable on this platform')
        import ctypes
        from ctypes import wintypes
        user = ctypes.WinDLL('user32', use_last_error=True)
        user.GetForegroundWindow.restype = wintypes.HWND
        handle = user.GetForegroundWindow()
        if not handle:
            raise PermissionDenied('Desktop frame requires an interactive foreground window')
        return str(handle)

    @staticmethod
    def _uia_public(result):
        from .windows_uia import public_control
        from .privacy import sensitive_label, sensitive_text
        controls=[]
        for item in result.get('controls', []):
            public=public_control(item)
            if public is not None:
                controls.append(public)
        window=dict(result.get('window', {}))
        title=window.get('title','')
        if sensitive_label(title) or sensitive_text(title) or len(title)>160:
            window['title']='[protected or long title omitted]'
        return {'method':'windows_uia','window':window,'controls':controls,
                'status_text':[v for v in result.get('status_text',[]) if not sensitive_label(v) and not sensitive_text(v)],
                'bounded':True,'truncated':result.get('truncated',False),'visited':result.get('visited',0)}

    @coordinated('ui')
    def inspect_desktop_controls(self, fallback_to_screenshot=False):
        self._check('desktop')
        if type(fallback_to_screenshot) is not bool:
            raise ValueError('Screenshot fallback must be boolean')
        from .windows_uia import FILE_DIALOG_MESSAGE, query, public_control, UIAutomationError
        with self._ui_lock:
            self._uia_inspection=None
            self._desktop_frame=None
            public={}
            try:
                foreground=self._foreground_window()
                raw=query({'handle':foreground},lambda:self._require_capability('desktop'))
                self._require_capability('desktop')
                if foreground!=self._foreground_window():
                    raise UIAutomationError('UIA_TARGET_CHANGED','Foreground changed; inspect the intended window again.')
                public=self._uia_public(raw)
                if raw.get('file_dialog'):
                    raise UIAutomationError('UIA_FILE_DIALOG',FILE_DIALOG_MESSAGE)
                entries={}
                identities=set()
                for item in raw.get('controls',[]):
                    value=public_control(item)
                    if value is None:
                        continue
                    identity=item.get('runtime_id')
                    if not identity or identity in identities:
                        raise UIAutomationError('UIA_TARGET_CHANGED','Control identities are missing or ambiguous; inspect again.')
                    identities.add(identity)
                    identifier=uuid.uuid4().hex
                    entries[identifier]=item
                    value['control_id']=identifier
                    public['controls'][len(entries)-1]=value
                if not entries:
                    raise UIAutomationError('UIA_UNAVAILABLE','No usable accessible controls were found within the inspection bounds.')
                identifier=uuid.uuid4().hex
                self._uia_inspection=(identifier,time.monotonic(),foreground,raw['window_stamp'],entries)
                return {**public,'inspection_id':identifier,'expires_seconds':30,'single_use':True,
                        'fallback':'If the intended control is absent, capture_desktop and review a fresh frame; never guess coordinates.'}
            except UIAutomationError as exc:
                if exc.code not in {'UIA_UNAVAILABLE','UIA_FILE_DIALOG'}:
                    raise
                if fallback_to_screenshot:
                    return {**self.desktop_action('screenshot'),'method':'screenshot','uia_status':'unavailable','uia_reason':str(exc)}
                return {'method':'uia_unavailable','reason':str(exc),'window':public.get('window',{}),'visited':public.get('visited',0),'controls':[],'fallback_tool':'capture_desktop',
                        'next_step':'Review a fresh screenshot and use its frame_id once. No input was performed.'}

    @coordinated('ui')
    def interact_desktop_control(self, inspection_id, control_id, action, text=''):
        self._check('desktop')
        from .windows_uia import query, UIAutomationError
        from .privacy import assert_public_text
        if action not in {'invoke','set_value'} or not isinstance(text,str) or len(text)>1024 or any(ord(c)<32 for c in text):
            raise ValueError('Choose invoke or set_value with at most 1024 printable characters')
        assert_public_text(text)
        if action=='invoke' and text:
            raise ValueError('Invoke takes no text')
        with self._ui_lock:
            current=self._uia_inspection
            self._uia_inspection=None
            self._desktop_frame=None
            if (current is None or not isinstance(inspection_id,str) or inspection_id!=current[0] or
                time.monotonic()-current[1]>30 or current[2]!=self._foreground_window()):
                raise UIAutomationError('UIA_INSPECTION_REQUIRED','Inspection missing, expired, consumed, or foreground changed; inspect again.')
            target=current[4].get(control_id) if isinstance(control_id,str) else None
            if target is None or action not in target['actions'] or not target['enabled']:
                raise UIAutomationError('UIA_TARGET_CHANGED','Choose an enabled supported control_id from a fresh inspection; names are not selectors.')
            result=query({'handle':current[2],'window_stamp':current[3],'runtime_id':target['runtime_id'],
                          'stamp':target['stamp'],'action':action,'text':text},lambda:self._require_capability('desktop'))
            self._require_capability('desktop')
            public=self._uia_public(result)
            return {**public,'performed':result.get('performed',False),'action':action,
                    'verification':result.get('verification','readback_unavailable'),
                    **({'value_matches':result['value_matches']} if 'value_matches' in result else {}),
                    'next_step':'Readback describes the control only. Verify the actual outcome, such as the exact saved file and its contents. Inspect again before further input; never replay an uncertain action.'}

    @coordinated('ui')
    def desktop_action(self, action, x=0, y=0, text='', keys=None, amount=0, end_x=0, end_y=0, frame_id=''):
        self._check('desktop')
        from .privacy import assert_public_text
        assert_public_text(text)
        if sys.platform.startswith('linux') and (os.environ.get('XDG_SESSION_TYPE') != 'x11' or not os.environ.get('DISPLAY')):
            raise PermissionDenied('Linux desktop input requires an X11 session. Wayland input is unavailable.')
        if action not in {'screenshot', 'click', 'right_click', 'double_click', 'drag', 'move', 'scroll', 'type', 'hotkey'}:
            raise PermissionDenied('Unknown desktop action')
        if type(x) is not int or type(y) is not int or type(amount) is not int or not -20 <= amount <= 20:
            raise PermissionDenied('Invalid desktop coordinates or scroll amount')
        text_limit=1024 if os.name=='nt' else 4096
        if (not isinstance(text, str) or len(text) + (sum(ord(char) > 0xffff for char in text) if os.name == 'nt' else 0) > text_limit or
                (text and (not text.isprintable() or (os.name != 'nt' and not text.isascii())))):
            raise PermissionDenied(f'Desktop typing accepts printable text (ASCII on non-Windows), up to {text_limit} characters per step')
        if action == 'type' and not text:
            raise PermissionDenied('Desktop typing requires nonempty text')
        if keys is not None and (not isinstance(keys, list) or len(keys) > 4 or (action == 'hotkey' and not keys) or any(not isinstance(k, str) for k in keys)):
            raise PermissionDenied('Use one to four named keys')
        if keys is not None:
            keys=[key.lower() for key in keys]
        try:
            import pyautogui as ui
        except ImportError as exc:
            raise PermissionDenied('Install the desktop extra locally; see docs/computer-control.md') from exc
        with self._ui_lock:
            self._uia_inspection = None
            ui.FAILSAFE = True
            ui.PAUSE = 0.15
            width, height = ui.size()
            if action in {'click', 'right_click', 'double_click', 'drag', 'move', 'scroll'} and not (0 <= x < width and 0 <= y < height):
                raise PermissionDenied('Coordinates must be inside the primary screen')
            if action == 'drag' and (type(end_x) is not int or type(end_y) is not int or not (0 <= end_x < width and 0 <= end_y < height)):
                raise PermissionDenied('Drag endpoint must be inside the primary screen')
            if action == 'screenshot':
                foreground = self._foreground_window()
                focus = None
                if os.name == 'nt':
                    from .windows_input import focused_window
                    focus = focused_window()
                result = {**jpeg(ui.screenshot()),'method':'screenshot'}
                if foreground != self._foreground_window() or (os.name == 'nt' and focus != focused_window()):
                    raise PermissionDenied('Foreground changed during frame capture')
                identifier = uuid.uuid4().hex
                self._desktop_frame = (identifier, time.monotonic(), (width,height), foreground, focus)
                result.update(frame_id=identifier, frame_expires_seconds=30, foreground_window=foreground,
                              input_requires='Fresh one-use frame and unchanged foreground; verify the intended application visually')
                return result
            frame = self._desktop_frame
            if (not isinstance(frame_id,str) or frame is None or frame_id!=frame[0] or
                time.monotonic()-frame[1]>30 or frame[2]!=(width,height) or frame[3]!=self._foreground_window()):
                raise PermissionDenied('Desktop frame missing, stale, consumed or foreground changed')
            # Consume before input: a transport retry cannot silently repeat a mutation.
            self._desktop_frame = None
            if action == 'click': ui.click(x, y)
            elif action == 'right_click': ui.click(x, y, button='right')
            elif action == 'double_click': ui.doubleClick(x, y, interval=0.1)
            elif action == 'drag': ui.moveTo(x, y); ui.dragTo(end_x, end_y, duration=0.4)
            elif action == 'move': ui.moveTo(x, y, duration=0.1)
            elif action == 'scroll':
                ui.moveTo(x, y)
                # The pinned Windows adapter accepts raw WHEEL_DELTA units, not notches.
                ui.scroll(amount * 120 if os.name == 'nt' else amount)
            elif action == 'type':
                if os.name=='nt':
                    from .windows_input import focused_window, write_text
                    for offset in range(0,len(text),32):
                        ui.failSafeCheck()
                        self._check('desktop')
                        if frame[3]!=self._foreground_window() or not frame[4] or focused_window()!=frame[4]:
                            raise PermissionDenied('Desktop text input incomplete; keyboard focus changed. Inspect actual text; do not replay automatically.')
                        write_text(text[offset:offset+32])
                    if frame[3]!=self._foreground_window() or not frame[4] or focused_window()!=frame[4]:
                        raise PermissionDenied('Desktop text input incomplete; keyboard focus changed. Inspect actual text; do not replay automatically.')
                else:ui.write(text, interval=0.001)
            elif action == 'hotkey':
                if not keys or any(k not in ui.KEYBOARD_KEYS for k in keys):
                    raise PermissionDenied('Invalid key combination')
                if os.name=='nt':
                    from .windows_input import focused_window, press_hotkey
                    ui.failSafeCheck()
                    if frame[3]!=self._foreground_window() or not frame[4] or focused_window()!=frame[4]:
                        raise PermissionDenied('Desktop frame missing, stale, consumed or foreground changed')
                    press_hotkey([ui.platformModule.keyboardMapping.get(key) for key in keys])
                else:ui.hotkey(*keys)
            if action in {'type', 'hotkey'}:
                return {'dispatched': action, 'application_verified': False,
                        'next_step': 'Inspect the application before claiming success or sending more input.'}
            return {'performed': action, 'screen_width': width, 'screen_height': height}

    def close_control(self):
        if self._closed:
            return
        with self._lock:
            self._closed = True
            self._disabled = True
            self.allow_writes = False
        if self._foreground_parent is not None:self._foreground_parent.close()
        from .cli import Console
        Console(self).close()
        try:
            self._browser_executor.submit(self._close_browser).result(timeout=15)
        finally:
            self._browser_executor.shutdown(wait=False, cancel_futures=True)


CONTROL_METHODS = {'jan_inspect_development':'inspect_development','jan_preview_development_change':'preview_development_change','jan_apply_development_change':'apply_development_change','jan_get_development_change':'get_development_change','jan_inspect_desktop_controls':'inspect_desktop_controls','jan_interact_desktop_control':'interact_desktop_control','jan_inspect_document_pdf':'inspect_document_pdf','jan_browser_workflow':'browser_workflow', 'jan_run_command':'run_command', 'jan_start_process':'start_process',
    'jan_preview_document_workflow':'preview_document_workflow','jan_apply_document_workflow':'apply_document_workflow','jan_get_document_workflow':'get_document_workflow',
    'jan_inspect_office':'inspect_office','jan_edit_spreadsheet':'edit_spreadsheet','jan_preview_spreadsheet':'preview_spreadsheet',
    'jan_inspect_media':'inspect_media','jan_edit_media':'edit_media','jan_transcribe_audio':'transcribe_audio','jan_prepare_media':'prepare_media',
    'jan_read_pdf':'read_pdf', 'jan_rewrite_pdf':'rewrite_pdf', 'jan_create_pdf':'create_pdf',
    'jan_list_applications':'list_applications','jan_open_application':'open_application',
    'jan_process_input':'process_input','jan_process_output':'process_output','jan_start_program':'start_program',
    'jan_disable_control':'disable_control', 'jan_create_directory':'create_directory',
    'jan_browser':'browser_action', 'jan_desktop':'desktop_action', 'jan_write_text':'write_text',
    'jan_delete_text':'delete_text','jan_move_text':'move_text',
    'jan_restore_backup':'restore_backup', 'jan_edit_text':'edit_text', 'jan_search_text':'search_text', 'jan_session_output':'session_output',
    'jan_stop_session':'stop_session', 'jan_list_sessions':'list_sessions', 'jan_status':'status',
    'jan_list_files':'list_files', 'jan_read_text':'read_text', 'jan_find_files':'find_files',
    'jan_file_info':'file_info','jan_diagnostic':'diagnostic',
    'jan_run_profile':'run_profile','jan_start_session':'start_session',
    'jan_skills':'skill_catalog','jan_route_skill':'route_skill','jan_skill_guide':'skill_guide',
    'jan_feedback_status':'feedback_status','jan_skill_feedback':'skill_feedback'}


def register_control_tools(server, commander):
    from mcp.types import ToolAnnotations, ImageContent, TextContent, CallToolResult
    from .errors import tool_errors
    from .tool_metadata import directory_tool
    control = ToolAnnotations(readOnlyHint=False, destructiveHint=True, openWorldHint=True)
    read = ToolAnnotations(readOnlyHint=True, openWorldHint=False)

    @directory_tool(server, annotations=read)
    @tool_errors(commander)
    def jan_inspect_desktop_controls(fallback_to_screenshot: bool = False):
        """Inspect bounded actionable Windows controls. Password/protected controls omitted. Optional explicit fresh screenshot fallback; no guessed input."""
        result=commander.inspect_desktop_controls(fallback_to_screenshot)
        if result.get('mime_type'):
            return CallToolResult(content=[TextContent(type='text',text=json.dumps({k:v for k,v in result.items() if k!='data'})),ImageContent(type='image',data=result['data'],mimeType=result['mime_type'])])
        return result

    @directory_tool(server, annotations=control)
    @tool_errors(commander)
    def jan_interact_desktop_control(inspection_id: str, control_id: str, action: str, text: str = '') -> dict:
        """Invoke or set_value on one freshly inspected enabled control. Rechecks window/control identity, consumes inspection and returns bounded readback. Never retries input."""
        return commander.interact_desktop_control(inspection_id,control_id,action,text)

    @directory_tool(server, annotations=read)
    @tool_errors(commander)
    def jan_inspect_development(action: str, options: dict | None = None) -> dict:
        """Discover full project runtimes, environments, packages and dependency files; commands/files capability required."""
        return commander.inspect_development(action,options)

    @directory_tool(server, annotations=control)
    @tool_errors(commander)
    def jan_preview_development_change(action: str, options: dict) -> dict:
        """Prepare a one-shot development plan; package resolution uses original PyPI wheels. Poll receipt until previewed."""
        return commander.preview_development_change(action,options)

    @directory_tool(server, annotations=control)
    @tool_errors(commander)
    def jan_apply_development_change(plan_id: str, review_sha256: str) -> dict:
        """Apply one exact reviewed development plan once; never modify PCRC's embedded interpreter."""
        return commander.apply_development_change(plan_id,review_sha256)

    @directory_tool(server, annotations=read)
    @tool_errors(commander)
    def jan_get_development_change(plan_id: str) -> dict:
        """Get development review or durable receipt, including owned process IDs for logs/cancellation. Never replay uncertain writes."""
        return commander.get_development_change(plan_id)

    @directory_tool(server, annotations=read)
    @tool_errors(commander)
    def jan_preview_document_workflow(jobs: list[dict]) -> dict:
        """Start bounded read-only preparation of 1..5 document jobs. Poll jan_get_document_workflow until previewed; review exact edits/paths and hash before applying."""
        return commander.preview_document_workflow(jobs)

    @directory_tool(server, annotations=control)
    @tool_errors(commander)
    def jan_apply_document_workflow(plan_id: str, review_sha256: str, review: list[dict]) -> dict:
        """Start a reviewed document plan once; poll its receipt until finished. Rechecks hashes, keeps overwrite backups and reopens outputs. Never replay uncertain writes."""
        return commander.apply_document_workflow(plan_id, review_sha256, review)

    @directory_tool(server, annotations=read)
    @tool_errors(commander)
    def jan_get_document_workflow(plan_id: str) -> dict:
        """Read a durable document workflow receipt. This never executes or retries a write."""
        return commander.get_document_workflow(plan_id)

    @directory_tool(server, annotations=read)
    @tool_errors(commander)
    def jan_inspect_document_pdf(path: str, pages: list[int] | None = None):
        """Inspect text and render all bounded PDF pages; return visual previews of at most two selected pages. No JavaScript/forms/OCR."""
        result=commander.inspect_document_pdf(path,pages)
        images=result.pop('images')
        return CallToolResult(content=[TextContent(type='text',text=json.dumps(result)),*[ImageContent(**item) for item in images]])

    @directory_tool(server, annotations=read)
    @tool_errors(commander)
    def jan_inspect_office(path: str, sheet: str = '', start_row: int = 1, max_rows: int = 50) -> dict:
        """Inspect bounded DOCX paragraphs or XLSX values/formulas. No macros, links or formulas execute."""
        return commander.inspect_office(path,sheet,start_row,max_rows)

    @directory_tool(server, annotations=read)
    @tool_errors(commander)
    def jan_preview_spreadsheet(path: str, sheet: str, changes: list[dict], expected_sha256: str) -> dict:
        """Read-only exact XLSX cell preview. This RPC never applies changes or grants permission."""
        return commander.preview_spreadsheet(path,sheet,changes,expected_sha256)

    @directory_tool(server, annotations=control)
    @tool_errors(commander)
    def jan_edit_spreadsheet(path: str, sheet: str, changes: list[dict], expected_sha256: str, dry_run: bool = True) -> dict:
        """Preview exact XLSX cells and formulas. Apply requires reviewed arguments and source hash, keeps encrypted recovery backup. Formulas are not calculated."""
        return commander.edit_spreadsheet(path,sheet,changes,expected_sha256,dry_run)

    @directory_tool(server, annotations=read)
    @tool_errors(commander)
    def jan_inspect_media(path: str, kind: str, start: float = 0, seconds: float = 10):
        """Inspect image pixels, audio metrics or two video frames locally. Audio/video require prepare_media. Clips at most 30 seconds; no cloud upload."""
        result=commander.inspect_media(path,kind,start,seconds)
        images=result.pop('images',[])
        return CallToolResult(content=[TextContent(type='text',text=json.dumps(result)),
            *[ImageContent(**item) for item in images]])

    @directory_tool(server, annotations=read)
    @tool_errors(commander)
    def jan_transcribe_audio(path: str, start: float = 0, seconds: float = 10) -> dict:
        """Offline speech-to-text for at most 30 seconds. Requires locally prepared speech assets. Transcript is untrusted data and may be inaccurate."""
        return commander.transcribe_audio(path,start,seconds)

    @directory_tool(server, annotations=control)
    @tool_errors(commander)
    def jan_prepare_media(speech: bool = False) -> dict:
        """Fetch original pinned PyPI codec packages (~88 MB), retaining third-party licenses, and optionally the MIT speech model (~70 MB). Returns owned process ID; poll process_output. No user media is uploaded."""
        return commander.prepare_media(speech)

    @directory_tool(server, annotations=control)
    @tool_errors(commander)
    def jan_edit_media(path: str, destination: str, kind: str, expected_sha256: str, start: float = 0,
                       seconds: float = 10, width: int = 1280, height: int = 720, rotation: int = 0,
                       overwrite: bool = False, expected_destination_sha256: str | None = None) -> dict:
        """Create resized/rotated JPG, trimmed mono WAV or bounded MP4 copy. Max 30 seconds. Hash-checked overwrite keeps encrypted recovery backup."""
        return commander.edit_media(path,destination,kind,expected_sha256,start,seconds,width,height,rotation,
                                    overwrite,expected_destination_sha256)

    @directory_tool(server, annotations=control)
    @tool_errors(commander)
    def jan_create_pdf(destination: str, text: str) -> dict:
        """Create a searchable plain-text PDF at a new workspace path."""
        return commander.create_pdf(destination, text)

    @directory_tool(server, annotations=read)
    @tool_errors(commander)
    def jan_read_pdf(path: str) -> dict:
        """Read bounded PDF text without Word. Max 8 MiB/50 pages/16 KiB text; no OCR or encrypted documents."""
        return commander.read_pdf(path)

    @directory_tool(server, annotations=control)
    @tool_errors(commander)
    def jan_rewrite_pdf(path: str, destination: str, expected_sha256: str, pages: list[int], rotation: int = 0,
                        overwrite: bool = False, expected_destination_sha256: str | None = None) -> dict:
        """Save selected one-based PDF pages with 0/90/180/270 rotation. Explicit hash-checked overwrite keeps encrypted backup. No arbitrary text editing/OCR."""
        return commander.rewrite_pdf(path, destination, expected_sha256, pages, rotation, overwrite, expected_destination_sha256)

    @directory_tool(server, annotations=control)
    @tool_errors(commander)
    def jan_team(action: str, options: dict | None = None) -> dict:
        """Manage local shared assignments. A task label never grants OS permissions."""
        commander._check('files')
        return coordinator(commander).task(action, **(options or {}))

    @directory_tool(server, annotations=control)
    @tool_errors(commander)
    def jan_browser_workflow(action: str, options: dict | None = None) -> dict:
        """Record, review or replay one isolated-browser workflow step. Existing browser permission remains required."""
        return commander.browser_workflow(action, options)

    @directory_tool(server, annotations=control)
    @tool_errors(commander)
    def jan_coordinated_call(name: str, arguments: dict, task_id: str, lease_token: str):
        """Invoke an existing operation in a reserved assignment without granting extra capabilities."""
        if name not in CONTROL_METHODS or name == 'jan_disable_control':
            raise PermissionDenied('Unknown coordinated operation')
        marker = assignment.set((task_id, lease_token))
        try:
            result = getattr(commander, CONTROL_METHODS[name])(**arguments)
            if 'images' in result:
                images=result.pop('images')
                return CallToolResult(content=[TextContent(type='text',text=json.dumps(result)),
                    *[ImageContent(**item) for item in images]])
            if result.get('mime_type'):
                return CallToolResult(content=[TextContent(type='text', text=json.dumps({k:v for k,v in result.items() if k!='data'})),
                    ImageContent(type='image', data=result['data'], mimeType=result['mime_type'])])
            return result
        finally:
            assignment.reset(marker)

    @directory_tool(server, annotations=control)
    @tool_errors(commander)
    def jan_skill_feedback(category: str, selected_skill: str, routing_method: str, outcome: str, correction: str = '') -> dict:
        """Record catalog IDs and fixed outcome labels only, if local logging is enabled. Requires files capability. Local CLI handles configuration, review and clear."""
        return commander.skill_feedback(category, selected_skill, routing_method, outcome, correction)

    @directory_tool(server, annotations=control)
    @tool_errors(commander)
    def jan_create_directory(path: str) -> dict:
        """Create one directory under an existing approved workspace parent."""
        return commander.create_directory(path)

    @directory_tool(server, annotations=control)
    @tool_errors(commander)
    def jan_disable_control() -> dict:
        """Immediately disable this control instance, stop owned commands and close its browser. Local restart is required to enable control again."""
        return commander.disable_control()

    @directory_tool(server, annotations=control)
    @tool_errors(commander)
    def jan_run_command(command: str, shell: str = 'system', timeout_seconds: int = 10) -> dict:
        """Execute a command as the locally authorized OS account, NOT sandboxed to workspace. No interactive stdin. Never pass secrets. For >15s use jan_start_process."""
        return commander.run_command(command, shell, timeout_seconds)

    @directory_tool(server, annotations=control)
    @tool_errors(commander)
    def jan_start_process(command: str, shell: str = 'system', timeout_seconds: int = 300) -> dict:
        """Start an owned command with stdin, 1..3600s runtime within local grant, 1 MiB output cap. Read paginated output and stop it using JAN process tools. No PTY; some interactive apps require one."""
        return commander.start_process(command, shell, timeout_seconds)

    @directory_tool(server, annotations=read)
    @tool_errors(commander)
    def jan_list_applications(query: str = '', limit: int = 30) -> dict:
        """List bounded registered app names and IDs. Commands capability required; no private document contents are read."""
        return commander.list_applications(query, limit)

    @directory_tool(server, annotations=control)
    @tool_errors(commander)
    def jan_open_application(application: str) -> dict:
        """Request an approved installed app launch by exact app ID or unambiguous name. No install, elevation or automatic desktop interaction."""
        return commander.open_application(application)

    @directory_tool(server, annotations=control)
    @tool_errors(commander)
    def jan_start_program(executable: str, arguments: list[str] | None = None, timeout_seconds: int = 300) -> dict:
        """Run an absolute executable with exact argv and piped stdin/output, without a shell. Useful for Python REPLs, compilers and tools. OS-account access; max 3600s within local grant."""
        return commander.start_program(executable, arguments, timeout_seconds)

    @directory_tool(server, annotations=control)
    @tool_errors(commander)
    def jan_process_input(session_id: str, text: str, newline: bool = True) -> dict:
        """Queue up to 4096 bytes of stdin for an owned command. Never send credentials. Queue acknowledgement does not prove the application consumed it."""
        return commander.process_input(session_id, text, newline)

    @directory_tool(server, annotations=read)
    @tool_errors(commander)
    def jan_process_output(session_id: str, offset: int = 0, length: int = 16384) -> dict:
        """Read up to 16 KiB from an owned command at a byte offset; next_offset advances pagination. UTF-8 split at a byte boundary may display a replacement character."""
        return commander.process_output(session_id, offset, length)

    @directory_tool(server, annotations=control)
    @tool_errors(commander)
    def jan_edit_text(path: str, old_text: str, new_text: str, expected_sha256: str, dry_run: bool = True) -> dict:
        """Preview or apply exactly one literal replacement. Requires SHA256 of current UTF-8 bytes; saves encrypted backup before applying."""
        return commander.edit_text(path, old_text, new_text, expected_sha256, dry_run)

    @directory_tool(server, annotations=control)
    @tool_errors(commander)
    def jan_move_text(source: str, destination: str, expected_sha256: str) -> dict:
        """Move or rename one approved-workspace text file. Requires its current SHA256 and an unused destination. Saves a private recovery backup."""
        return commander.move_text(source, destination, expected_sha256)

    @directory_tool(server, annotations=control)
    @tool_errors(commander)
    def jan_delete_text(path: str, expected_sha256: str) -> dict:
        """Delete one approved-workspace text file after checking its current SHA256. Saves a private recovery backup."""
        return commander.delete_text(path, expected_sha256)

    @directory_tool(server, annotations=read)
    @tool_errors(commander)
    def jan_search_text(term: str, max_results: int = 50) -> dict:
        """Bounded literal content search in approved workspace text files; no regular expressions."""
        return commander.search_text(term, max_results)

    @directory_tool(server, annotations=control)
    @tool_errors(commander)
    def jan_browser(action: str, target: str = '', text: str = ''):
        """Control a separate Chromium session. Actions open/new_tab(URL), tabs, select_tab/close_tab(tab ID), back/forward/reload, snapshot, click(CSS), fill(CSS,text), press(CSS,key), select(CSS,value), check(CSS,true/false), screenshot, close. Enter passwords/OTP manually. Visible page contents may be shared with ChatGPT."""
        result = commander.browser_action(action, target, text)
        if result.get('mime_type'):
            return CallToolResult(content=[TextContent(type='text',text=json.dumps({k:v for k,v in result.items() if k!='data'})),
                ImageContent(type='image', data=result['data'], mimeType=result['mime_type'])])
        return result

    @directory_tool(server, annotations=control)
    @tool_errors(commander)
    def jan_desktop(action: str, x: int = 0, y: int = 0, text: str = '', keys: list[str] | None = None, amount: int = 0, end_x: int = 0, end_y: int = 0, frame_id: str = ''):
        """Control primary desktop: screenshot, click, right_click, double_click, drag(to end_x/end_y), move, scroll(amount), type(printable Unicode on Windows, ASCII on other systems). Keyboard dispatch requires app readback, hotkey(keys). Use native screen coordinates from screenshot metadata. Windows/Linux X11; Wayland unsupported. Whole screen is shared. Input requires frame_id from a fresh screenshot (one use, 30s, unchanged Windows foreground). Verify target visually. Move pointer to a corner for failsafe."""
        result = commander.desktop_action(action, x, y, text, keys, amount, end_x, end_y, frame_id)
        if result.get('mime_type'):
            return CallToolResult(content=[TextContent(type='text',text=json.dumps({k:v for k,v in result.items() if k!='data'})),
                ImageContent(type='image', data=result['data'], mimeType=result['mime_type'])])
        return result


def main(argv=None):
    parser = argparse.ArgumentParser(description='JAN operator control: commands can access your OS account; desktop sees the whole screen')
    parser.add_argument('--workspace', required=True)
    parser.add_argument('--capabilities', required=True, type=capabilities)
    parser.add_argument('--duration-minutes', type=int, default=60)
    parser.add_argument('--foreground',action='store_true',help='Keep local control active only while this launcher parent lives')
    parser.add_argument('--foreground-parent-pid',type=int,help=argparse.SUPPRESS)
    parser.add_argument('--headless', action='store_true')
    parser.add_argument('--browser-channel', choices=['chromium','chrome','msedge'], default='chromium')
    parser.add_argument('--transport', choices=['cli','stdio','http','cloudflare'], default='cli')
    parser.add_argument('--port', type=int, default=8866)
    parser.add_argument('--tool', choices=sorted(CONTROL_METHODS))
    parser.add_argument('--arguments', default='{}', help='JSON arguments for one-shot CLI call')
    args = parser.parse_args(argv)
    if args.transport != 'cli' and (args.tool or args.arguments != '{}'):
        parser.error('--tool and --arguments require CLI transport')
    from .cloudflare import require_standard_user
    commander = None
    try:
        require_standard_user()
        if args.transport == 'cloudflare':
            if args.foreground:raise ValueError('Foreground mode is for the local setup launcher, not legacy cloudflare transport')
            from .cloudflare import run
            return run(Path(args.workspace).expanduser().resolve(strict=True), args.port,
                       control_capabilities=args.capabilities, duration_minutes=args.duration_minutes, headless=args.headless,
                       browser_channel=args.browser_channel)
        commander = ControlCommander(Path(args.workspace), enabled=args.capabilities,
            duration_minutes=args.duration_minutes, headless=args.headless, browser_channel=args.browser_channel,foreground=args.foreground,foreground_parent_pid=args.foreground_parent_pid)
        if args.transport == 'stdio':
            from .server import build_server
            build_server(commander).run()
        elif args.transport == 'http':
            from .http_server import prepare_backend, create_app
            import uvicorn
            _, token, _ = prepare_backend(commander.workspace)
            config = uvicorn.Config(create_app(commander, token, args.port), host='127.0.0.1', port=args.port,
                        access_log=False, proxy_headers=False, log_level='warning', limit_concurrency=8,
                        timeout_keep_alive=5, h11_max_incomplete_event_size=16384)
            service = uvicorn.Server(config)
            if args.foreground:
                commander._foreground_parent.on_exit=lambda:(setattr(service,'should_exit',True),commander.close_control())
                commander._require_capability(next(iter(args.capabilities)))
            if os.name == 'nt':
                import signal
                signal.signal(signal.SIGBREAK, lambda *_: setattr(service, 'should_exit', True))
            service.run()
        else:
            def call(name, arguments):
                if name not in CONTROL_METHODS or not isinstance(arguments, dict):
                    raise ValueError('Use a supported tool name and JSON arguments object')
                return getattr(commander, CONTROL_METHODS[name])(**arguments)
            if args.tool:
                print(json.dumps(call(args.tool, json.loads(args.arguments))))
            else:
                print('JAN control: enter {"tool":"jan_status","arguments":{}}; exit stops owned processes. No passwords in this console.')
                while True:
                    try:
                        line = input('JAN control> ')
                        if line.strip() == 'exit': break
                        request = json.loads(line)
                        print(json.dumps(call(request['tool'], request.get('arguments', {}))))
                    except (ValueError, TypeError, KeyError, RuntimeError) as exc:
                        from .errors import public_error
                        print(json.dumps(public_error(exc)))
        return 0
    except (OSError, ValueError, RuntimeError, EOFError, KeyboardInterrupt) as exc:
        print('JAN control: '+str(exc), file=sys.stderr)
        return 1
    finally:
        if commander:
            commander.close_control()


if __name__ == '__main__':
    # Use the canonical module's class identities even when invoked with -m.
    # HTTP/server registration imports .control; constructing __main__'s copy
    # made isinstance checks fail and silently produced the restricted server.
    from .control import main as canonical_main
    raise SystemExit(canonical_main())
