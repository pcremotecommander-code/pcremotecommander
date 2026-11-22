"""Portable bounded command sessions; no arbitrary shell or public listener."""
from __future__ import annotations
import os
import signal
import subprocess
import sys
import threading
import time
import uuid
from .advanced import AdvancedCommander, MAX_OUTPUT, MAX_SESSIONS, SESSION_LIFETIME
from .core import PermissionDenied
from . import __version__


class PortableCommander(AdvancedCommander):
    def _within(self, path):
        if ":" in path or (os.name != "nt" and "\\" in path):
            raise PermissionDenied("Use relative paths with forward slashes")
        resolved = super()._within(path)
        if resolved == self._backup_root or self._backup_root in resolved.parents:
            raise PermissionDenied("Backup storage is protected")
        return resolved

    def _path(self, name, *, exists=True):
        if ":" in name or (os.name != "nt" and "\\" in name):
            raise PermissionDenied("Use relative paths with forward slashes")
        return super()._path(name, exists=exists)

    def _environment(self):
        from .environment import runtime_environment, command_path
        env = runtime_environment()
        env['PATH'] = command_path()
        env.update(HOME=str(self.workspace), LANG='C', PYTHONIOENCODING='utf-8',
                   GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=os.devnull,
                   GIT_OPTIONAL_LOCKS='0', GIT_NO_LAZY_FETCH='1', GIT_TERMINAL_PROMPT='0')
        return env

    @staticmethod
    def _terminate(proc):
        if proc.poll() is not None:
            return
        if os.name == 'nt':
            # Sessions expose fixed profiles only. taskkill limits termination to this PID tree.
            subprocess.run([os.path.join(os.environ.get('SystemRoot', r'C:\Windows'), 'System32', 'taskkill.exe'), '/PID', str(proc.pid), '/T', '/F'],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5)
        else:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()

    def _launch(self, profile):
        argv = self._argv(profile)
        # Check audit availability before executing, including session starts.
        self._audit('launch_profile', True, profile)
        options = {'creationflags': subprocess.CREATE_NEW_PROCESS_GROUP} if os.name == 'nt' else {'start_new_session': True}
        return subprocess.Popen(argv, cwd=self.workspace, env=self._environment(),
                                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, shell=False, **options)

    def start_session(self, profile):
        self._rate()
        self._argv(profile)
        return self._start_owned_session(profile, lambda: self._launch(profile))

    def _start_owned_session(self, profile, launch, *, lifetime=None, output_limit=None):
        """Collect and expire only processes created by this commander."""
        lifetime = SESSION_LIFETIME if lifetime is None else lifetime
        output_limit = MAX_OUTPUT if output_limit is None else output_limit
        with self._lock:
            self._refresh()
            if sum(e['process'].poll() is None for e in self._sessions.values()) >= MAX_SESSIONS:
                raise PermissionDenied('Running session limit reached; stop an active session first')
            completed = [k for k,e in self._sessions.items() if e['done'].is_set()]
            for k in completed[:-15]:
                self._sessions.pop(k, None)
            proc = launch()
            key = uuid.uuid4().hex
            entry = {'process': proc, 'profile': profile, 'started': time.monotonic(),
                     'output': bytearray(), 'truncated': False, 'done': threading.Event(), 'timed_out': False,
                     'lifetime': lifetime}
            self._sessions[key] = entry

        def collect():
            try:
                while True:
                    # read1 returns currently available bytes; read(n) can hide
                    # short prompts until EOF and deadlock interactive programs.
                    chunk = proc.stdout.read1(1024)
                    if not chunk:
                        break
                    with self._lock:
                        room = output_limit - len(entry['output'])
                        entry['output'].extend(chunk[:room])
                        if len(chunk) > room:
                            entry['truncated'] = True
                    if entry['truncated']:
                        self._terminate(proc)
                        break
                proc.wait()
            finally:
                proc.stdout.close()
                entry['done'].set()

        def deadline():
            if not entry['done'].wait(lifetime):
                entry['timed_out'] = True
                self._terminate(proc)

        threading.Thread(target=collect, daemon=True).start()
        threading.Thread(target=deadline, daemon=True).start()
        return {'session_id': key, 'profile': profile, 'pid': proc.pid, 'max_runtime_seconds': lifetime}

    def session_output(self, session_id):
        self._rate()
        with self._lock:
            entry = self._sessions.get(session_id)
            if entry is None:
                raise PermissionDenied('Unknown session')
            result = {'session_id': session_id, 'profile': entry['profile'],
                      'running': not entry['done'].is_set(), 'exit_code': entry['process'].poll(),
                      'output': bytes(entry['output']).decode('utf-8', 'replace'),
                      'truncated': entry['truncated'], 'timed_out': entry['timed_out']}
        self._audit('session_output', True, session_id)
        return result

    def stop_session(self, session_id):
        with self._lock:
            entry = self._sessions.get(session_id)
        if entry is None:
            raise PermissionDenied('Unknown session')
        # Termination remains available even when audit storage is full.
        self._terminate(entry['process'])
        entry['done'].wait(5)
        exit_code = entry['process'].wait(timeout=5)
        with self._lock:
            self._sessions.pop(session_id, None)
        self._audit('stop_session', True, session_id)
        return {'stopped': session_id, 'pid': entry['process'].pid, 'running': False,
                'exit_code': exit_code, 'session_retained': False}

    def run_profile(self, name, timeout_seconds=5):
        if type(timeout_seconds) is not int or not 1 <= timeout_seconds <= 10:
            raise PermissionDenied('Timeout must be an integer between 1 and 10')
        info = self.start_session(name)
        entry = self._sessions[info['session_id']]
        completed = entry['done'].wait(timeout_seconds)
        if not completed:
            entry['timed_out'] = True
            self._terminate(entry['process'])
            entry['done'].wait(5)
        result = self.session_output(info['session_id'])
        self.stop_session(info['session_id'])
        result['timeout_seconds'] = timeout_seconds
        return result

    def diagnostic(self, name):
        if name == 'uname' and os.name == 'nt':
            import platform
            self._audit('diagnostic', True, name)
            return {'name': name, 'exit_code': 0, 'output': platform.platform()}
        return super().diagnostic(name)

    def skill_catalog(self, skill=None):
        self._rate()
        from .skills import catalog
        return catalog(skill)

    def route_skill(self, request, skill=None):
        self._rate()
        from .skills import route
        return route(request,skill)

    def skill_guide(self):
        self._rate()
        from .skills import guide
        return guide()

    def feedback_status(self):
        self._rate()
        from .skills import Feedback
        return Feedback(self._store).status()

    def status(self):
        result = super().status()
        transport = getattr(self, '_transport', 'cli')
        result.update(version=__version__, stage='Portable CLI and MCP', mode=transport,
                      transport=transport, remote_enabled=transport=='http',
                      remote_transport='Authenticated loopback HTTP origin' if transport=='http' else transport,
                      live_remote_verified=None, connection_verification='Backend transport only; an external Secure WebSocket relay may use this stdio bridge. Verify the public gateway separately with an authenticated tool-call receipt',
                      last_mcp_tool_call_utc=getattr(self, '_last_mcp_tool_call_utc', None), arbitrary_shell=False)
        return result
