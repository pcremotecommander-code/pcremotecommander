"""Security-focused local core, intentionally independent of MCP transport."""
from __future__ import annotations
import json
import os
import platform
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
import hashlib
import threading
from .safe_fs import SafeTree, unsupported_content
from .security import PrivateStore

MAX_READ_BYTES = 65536
MAX_LIST_ITEMS = 100
DIAGNOSTICS = {
    "python_version": [sys.executable, "--version"],
    "git_version": ["git", "--version"],
    "uname": ["uname", "-srm"],
}


# Explicit, non-shell command profiles. No user-provided executable or arguments.
COMMAND_PROFILES = {
    "list_workspace": ["ls", "-la", "--"],
    "git_status": ["git", "status", "--short", "--untracked-files=no"],
    "disk_usage": ["du", "-sh", "--"],
}
MAX_TIMEOUT_SECONDS = 10
MAX_OUTPUT_BYTES = 16_384


class PermissionDenied(ValueError):
    pass


def state_directory(workspace: Path, audit_path: Path | None = None) -> Path:
    default = Path.home() / '.local/state/jan-mcp-commander' / hashlib.sha256(str(workspace).encode()).hexdigest()[:16]
    return Path(audit_path).parent if audit_path else Path(os.environ.get('JAN_MCP_STATE_DIR', str(default)))


class Commander:
    def __init__(self, workspace: Path, audit_path: Path | None = None):
        self.workspace = workspace.expanduser().resolve(strict=True)
        if not self.workspace.is_dir():
            raise ValueError("JAN_MCP_WORKSPACE must be a directory")
        self._tree = SafeTree(self.workspace)
        state_dir = state_directory(self.workspace, audit_path)
        try:
            self._store = PrivateStore(state_dir, self.workspace)
        except (OSError, ValueError) as exc:
            raise PermissionDenied('Private state initialization failed') from exc
        self.audit_path = self._store.path / 'audit.jsonl'
        self.allow_writes = os.environ.get('JAN_MCP_ALLOW_WRITES') == '1'
        self._rate_lock = threading.Lock()
        self._requests = []

    def _audit(self, action: str, ok: bool, detail: str) -> None:
        from .privacy import sensitive_text
        detail='[sensitive detail withheld]' if sensitive_text(str(detail)) else str(detail)
        record = {"timestamp": datetime.now(timezone.utc).isoformat(),
                  "action": action, "ok": ok, "detail": str(detail)[:250]}
        try:
            with self._store.locked():
                self._store.audit(self.audit_path, record)
        except (OSError, ValueError) as exc:
            raise PermissionDenied("Audit logging unavailable") from exc

    def _rate(self):
        with self._rate_lock:
            now = time.monotonic()
            self._requests = [t for t in self._requests if now - t < 60]
            if len(self._requests) >= 120:
                raise PermissionDenied('Request limit reached; retry after one minute')
            self._requests.append(now)

    def _within(self, path: str) -> Path:
        try:
            self._tree.info(path)
            return self.workspace / path
        except (OSError, ValueError) as exc:
            raise PermissionDenied('Workspace access denied') from exc

    def status(self) -> dict[str, Any]:
        self._rate()
        result = {"name": "PC Remote Commander", "stage": "2.1", "mode": "local-stdio",
                  "workspace": str(self.workspace), "platform": platform.system(),
                  "computer_name": platform.node(), "os_release": platform.release(), "os_version": platform.version(),
                  "python": platform.python_version(), "remote_enabled": False,
                  "commands": sorted(DIAGNOSTICS), "terminal_profiles": ["disk_usage", "list_workspace"], "read_only": not self.allow_writes, "live_remote_verified": False}
        self._audit("status", True, "local status")
        return result

    def list_files(self, path: str = ".") -> dict[str, Any]:
        self._rate()
        self._audit('list_files', True, path)
        try:
            return {'path': path, 'entries': self._tree.entries(path), 'limit': MAX_LIST_ITEMS}
        except (OSError, ValueError) as exc:
            raise PermissionDenied('Directory access denied') from exc

    def read_text(self, path: str) -> dict[str, Any]:
        self._rate()
        self._audit('read_text', True, path)
        try:
            data = self._tree.read(path)
            if unsupported_content(data):
                raise ValueError('Binary or private key content denied')
            return {'path': path, 'content': data.decode('utf-8'), 'sha256': hashlib.sha256(data).hexdigest()}
        except (OSError, ValueError) as exc:
            raise PermissionDenied('File read denied') from exc

    def diagnostic(self, name: str) -> dict[str, Any]:
        self._rate()
        self._audit('diagnostic', True, str(name))
        if name == 'python_version':
            output = 'Python ' + platform.python_version()
        elif name == 'uname':
            output = platform.platform()
        else:
            raise PermissionDenied('Diagnostic unavailable; git execution is disabled in the hardened release')
        return {'name': name, 'exit_code': 0, 'output': output}

    def _argv(self, profile):
        if profile == 'list_workspace':
            # Serialize a filtered snapshot as a Python string literal. No path or
            # file content is interpreted as code or passed as a shell command.
            output = '\n'.join(x['name'] for x in self._tree.entries())
            return [sys.executable, '-I', '-c', 'import sys; sys.stdout.write(' + repr(output) + ')']
        if profile == 'disk_usage':
            return [sys.executable, '-I', '-c', 'import shutil,json; print(json.dumps(dict(zip(("total","used","free"),shutil.disk_usage(".")))))']
        raise PermissionDenied('Only list_workspace and disk_usage are enabled; Git is disabled')

    def run_profile(self, name: str, timeout_seconds: int = 5) -> dict[str, Any]:
        """Run one immutable, vetted argv profile; never invoke a shell."""
        if name not in COMMAND_PROFILES or type(timeout_seconds) is not int or not (1 <= timeout_seconds <= MAX_TIMEOUT_SECONDS):
            self._audit("run_profile", False, str(name))
            raise PermissionDenied("Command profile or timeout not permitted")
        self._rate()
        self._audit('profile_intent', True, name)
        argv = self._argv(name)
        try:
            proc = subprocess.Popen(
                argv, cwd=self.workspace, shell=False, stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                start_new_session=True, env={"PATH": "/usr/bin:/bin", "LANG": "C", "HOME": str(self.workspace), "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_OPTIONAL_LOCKS": "0", "GIT_NO_LAZY_FETCH": "1"},
            )
            try:
                import selectors
                import signal
                chunks = []
                total = 0
                timed_out = False
                truncated = False
                selector = selectors.DefaultSelector()
                if proc.stdout is None:
                    raise PermissionDenied("Process output unavailable")
                os.set_blocking(proc.stdout.fileno(), False)
                selector.register(proc.stdout, selectors.EVENT_READ)
                deadline = time.monotonic() + timeout_seconds
                while selector.get_map():
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        timed_out = True
                        break
                    ready = selector.select(timeout=remaining)
                    if not ready:
                        timed_out = True
                        break
                    for key, _ in ready:
                        data = os.read(key.fd, min(4096, MAX_OUTPUT_BYTES + 1 - total))
                        if not data:
                            selector.unregister(key.fileobj)
                            continue
                        if total + len(data) > MAX_OUTPUT_BYTES:
                            chunks.append(data[:MAX_OUTPUT_BYTES-total])
                            total = MAX_OUTPUT_BYTES
                            truncated = True
                            break
                        chunks.append(data)
                        total += len(data)
                        if total >= MAX_OUTPUT_BYTES:
                            truncated = True
                            break
                    if truncated:
                        break
                selector.close()
            finally:
                if proc.poll() is None:
                    import signal
                    try:
                        os.killpg(proc.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                proc.wait()
            output = b"".join(chunks).decode("utf-8", errors="replace")
            result = {"profile": name, "exit_code": proc.returncode,
                      "output": output, "timed_out": timed_out, "truncated": truncated,
                      "timeout_seconds": timeout_seconds}
            self._audit("run_profile", not timed_out, f"{name}: exit={proc.returncode}; timeout={timed_out}; truncated={truncated}")
            return result
        except (OSError, ValueError) as exc:
            self._audit("run_profile", False, name)
            raise PermissionDenied("Command execution failed") from exc
