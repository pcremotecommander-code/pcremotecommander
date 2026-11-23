"""Private state, authenticated encrypted recovery, and bounded durable audit."""
from contextlib import contextmanager
import hashlib
import errno
import base64
import hmac
import json
import os
from pathlib import Path
import threading
import time
import uuid
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from .safe_fs import SafeTree, check

STATE_LIMIT = 64 * 1024 * 1024
AUDIT_LIMIT = 2 * 1024 * 1024


def private_directory(path):
    path = Path(path).expanduser().absolute()
    # Reject linked ancestors before mkdir or ACL updates.
    for ancestor in reversed((path, *path.parents)):
        if ancestor.exists() or ancestor.is_symlink():
            check(ancestor.lstat(), directory=True)
    path.mkdir(parents=True, mode=0o700, exist_ok=True)
    if os.name == 'posix':
        info = path.stat()
        if info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ValueError('State directory must be owned by this user with mode 0700')
    elif os.name == 'nt':
        import win32api
        import win32con
        import win32security
        import ntsecuritycon
        token = win32security.OpenProcessToken(win32api.GetCurrentProcess(), win32con.TOKEN_QUERY)
        try:
            sid = win32security.GetTokenInformation(token, win32security.TokenUser)[0]
        finally:
            token.Close()
        acl = win32security.ACL()
        flags = win32con.OBJECT_INHERIT_ACE | win32con.CONTAINER_INHERIT_ACE
        acl.AddAccessAllowedAceEx(win32security.ACL_REVISION, flags, ntsecuritycon.FILE_ALL_ACCESS, sid)
        system = win32security.CreateWellKnownSid(win32security.WinLocalSystemSid, None)
        acl.AddAccessAllowedAceEx(win32security.ACL_REVISION, flags, ntsecuritycon.FILE_ALL_ACCESS, system)
        win32security.SetNamedSecurityInfo(str(path), win32security.SE_FILE_OBJECT,
            win32security.DACL_SECURITY_INFORMATION | win32security.PROTECTED_DACL_SECURITY_INFORMATION,
            None, None, acl, None)
    return path


class PrivateStore:
    def __init__(self, path, workspace):
        candidate = Path(path).expanduser().absolute()
        if candidate.is_relative_to(workspace):
            raise ValueError('Private state must be outside workspace')
        self.path = private_directory(candidate)
        self.context = hashlib.sha256(str(workspace).encode()).digest()
        self.tree = SafeTree(self.path, internal=True)
        self.mutex = threading.RLock()
        self.resource_mutexes = {}
        try:
            self.tree.write('state.lock', b'0')
        except FileExistsError:
            pass
        with self.locked():
            try:
                self.key = self.tree.read('state.key', 32)
            except FileNotFoundError:
                self.key = AESGCM.generate_key(bit_length=256)
                self.tree.write('state.key', self.key)
            self.audit_key = hmac.new(self.key, b'jan-audit-key-v1', hashlib.sha256).digest()
            if len(self.key) != 32:
                raise ValueError('Invalid state encryption key')
            if os.name == 'posix' and (self.path / 'state.key').stat().st_mode & 0o077:
                raise ValueError('Encryption key permissions must be 0600')

    @contextmanager
    def locked(self):
        with self.mutex:
            fd = os.open(self.path / 'state.lock', os.O_RDWR | getattr(os, 'O_NOFOLLOW', 0))
            try:
                check(os.fstat(fd))
                if os.name == 'posix':
                    import fcntl
                    fcntl.flock(fd, fcntl.LOCK_EX)
                else:
                    import msvcrt
                    msvcrt.locking(fd, msvcrt.LK_LOCK, 1)
                try:
                    yield
                finally:
                    if os.name == 'posix':
                        fcntl.flock(fd, fcntl.LOCK_UN)
                    else:
                        os.lseek(fd, 0, os.SEEK_SET)
                        msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
            finally:
                os.close(fd)

    @contextmanager
    def resource_locked(self, resource_id):
        """Lock one canonical resource across threads and processes.

        Callers that need multiple resources must acquire them in sorted order.
        The metadata lock is deliberately not held while the protected work runs.
        """
        if not isinstance(resource_id, str) or not resource_id:
            raise ValueError('A non-empty resource identifier is required')
        lock_name = 'resource-' + hashlib.sha256(resource_id.encode('utf-8')).hexdigest() + '.lock'
        with self.mutex:
            local_lock = self.resource_mutexes.setdefault(lock_name, threading.RLock())
        with local_lock:
            try:
                self.tree.write(lock_name, b'0')
            except FileExistsError:
                pass
            fd = os.open(self.path / lock_name, os.O_RDWR | getattr(os, 'O_NOFOLLOW', 0))
            try:
                check(os.fstat(fd))
                if os.name == 'posix':
                    import fcntl
                    fcntl.flock(fd, fcntl.LOCK_EX)
                else:
                    import msvcrt
                    # LK_LOCK gives up after a bounded retry period on Windows.
                    # Poll LK_NBLCK instead so long-running user work is not
                    # spuriously failed merely because it holds a lock longer.
                    while True:
                        os.lseek(fd, 0, os.SEEK_SET)
                        try:
                            msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
                            break
                        except OSError as exc:
                            if exc.errno not in (errno.EACCES, errno.EDEADLK):
                                raise
                            time.sleep(0.05)
                try:
                    yield
                finally:
                    if os.name == 'posix':
                        fcntl.flock(fd, fcntl.LOCK_UN)
                    else:
                        os.lseek(fd, 0, os.SEEK_SET)
                        msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
            finally:
                os.close(fd)

    def backup(self, path, data, *, binary=False):
        if binary and len(data) > 8 * 1024 * 1024:
            raise ValueError('Binary backup size limit exceeded')
        items = self.tree.entries(limit=1002, scan_limit=1002)
        if len(items) >= 1000 or sum(self.tree.info(x['name']).st_size for x in items) + len(data) * 6 + 1024 > STATE_LIMIT:
            raise ValueError('Backup quota reached; operator maintenance required')
        identifier = uuid.uuid4().hex
        value = {'path': path, 'content': base64.b64encode(data).decode('ascii'), 'encoding': 'base64'} if binary else {'path': path, 'content': data.decode('utf-8')}
        payload = json.dumps(value, ensure_ascii=True).encode()
        nonce = os.urandom(12)
        blob = nonce + AESGCM(self.key).encrypt(nonce, payload, identifier.encode() + self.context)
        self.tree.write(identifier + '.enc', blob)
        return identifier

    def restore(self, identifier):
        if not isinstance(identifier, str) or len(identifier) != 32 or any(c not in '0123456789abcdef' for c in identifier):
            raise ValueError('Invalid backup identifier')
        blob = self.tree.read(identifier + '.enc', 12 * 1024 * 1024)
        raw = AESGCM(self.key).decrypt(blob[:12], blob[12:], identifier.encode() + self.context)
        return json.loads(raw)

    def audit(self, path, record):
        if Path(path).absolute() != self.path / 'audit.jsonl':
            raise ValueError('Audit location changed; restart with a valid private state directory')
        try:
            data = self.tree.read('audit.jsonl', AUDIT_LIMIT)
        except FileNotFoundError:
            data = b''
        # Each record is authenticated. This does not provide external anchoring
        # against removal of records by an attacker with the operator's key.
        body = json.dumps(record, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode()
        line = json.dumps(dict(record, hmac_sha256=hmac.new(self.audit_key, body, hashlib.sha256).hexdigest())).encode() + b'\n'
        if len(data) + len(line) > AUDIT_LIMIT:
            raise ValueError('Audit quota reached; archive private state before restarting')
        self.tree.write('audit.jsonl', data + line, overwrite=True)
