"""Confined filesystem primitives. POSIX operations traverse through directory FDs.

Windows holds directory handles without delete sharing and rejects reparse points.
The workspace owner/administrator remains trusted; this is not an OS sandbox.
"""
from __future__ import annotations
from contextlib import contextmanager, ExitStack
import os
from pathlib import Path
import re
import stat
import uuid

LIMIT = 65536
SENSITIVE = {'.git', '.ssh', '.aws', '.azure', '.gnupg', '.kube', '.docker',
             '.jan-mcp-backups', '.npmrc', '.pypirc', 'credentials', 'credentials.json',
             'id_rsa', 'id_ed25519', 'secrets.json', 'secrets.yaml', 'secrets.yml'}
RESERVED = re.compile(r'^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)', re.I)


def parts(name, internal=False):
    if not isinstance(name, str) or not name or len(name) > 512:
        raise ValueError('Invalid relative path')
    from .privacy import assert_public_text
    assert_public_text(name)
    if name == '.':
        return ()
    items = (name.replace('\\', '/') if os.name == 'nt' else name).split('/')
    # Reject DOS aliases instead of resolving them through potentially unsafe links.
    if os.name == 'nt' and any('~' in p for p in items):
        raise ValueError('Windows short-name paths denied; use the full filename without a tilde')
    if len(items) > 16 or any(not p or p in {'.', '..'} or len(p) > 128 or
        any(ord(c) < 32 or ord(c) == 127 or c in '\\:*?"<>|' for c in p) or
        p.endswith(('.', ' ')) or RESERVED.match(p) for p in items):
        raise ValueError('Unsafe path')
    if not internal and any(p.lower() in SENSITIVE or p.lower().startswith(('.env', '.jan-mcp-')) or
        p.lower().endswith(('.pem', '.key', '.p12', '.pfx', '.kdbx')) for p in items):
        raise ValueError('Sensitive path denied')
    return tuple(items)


def unsupported_content(data):
    from .privacy import sensitive_text
    return b'\x00' in data or sensitive_text(data)


def check(info, directory=False):
    if getattr(info, 'st_file_attributes', 0) & 0x400 or stat.S_ISLNK(info.st_mode):
        raise ValueError('Links and reparse points denied')
    if directory:
        if not stat.S_ISDIR(info.st_mode):
            raise ValueError('Directory required')
    elif not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise ValueError('Single-link regular file required')


@contextmanager
def windows_guard(path, directory=True, write=False):
    """Open without following the final reparse point; pin directory names."""
    import ctypes
    from ctypes import wintypes
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    create = kernel.CreateFileW
    create.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p,
                       wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
    create.restype = wintypes.HANDLE
    close = kernel.CloseHandle
    close.argtypes = [wintypes.HANDLE]
    # Directory handles exclude FILE_SHARE_DELETE, so parents cannot be renamed.
    handle = create(str(path), 0x80 if directory else 0x80000000,
                    3 if directory else 1, None, 3, 0x00200000 | (0x02000000 if directory else 0), None)
    if handle == wintypes.HANDLE(-1).value:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        class TagInfo(ctypes.Structure):
            _fields_ = [('attributes', wintypes.DWORD), ('tag', wintypes.DWORD)]
        tag = TagInfo()
        get = kernel.GetFileInformationByHandleEx
        get.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
        if not get(handle, 9, ctypes.byref(tag), ctypes.sizeof(tag)) or tag.attributes & 0x400:
            raise ValueError('Reparse point denied')
        if directory:
            if not tag.attributes & 0x10:
                raise ValueError('Directory required')
            yield None
        else:
            import msvcrt
            # Duplicate handle ownership is transferred to this file descriptor.
            fd = msvcrt.open_osfhandle(handle, os.O_RDONLY | os.O_BINARY)
            handle = None
            try:
                check(os.fstat(fd))
                yield fd
            finally:
                os.close(fd)
    finally:
        if handle is not None:
            close(handle)


class SafeTree:
    def __init__(self, root, internal=False):
        root = Path(root).expanduser().absolute()
        check(root.lstat(), directory=True)
        self.root = root.resolve(strict=True)
        self.internal = internal

    @contextmanager
    def parent(self, name, root_ok=False):
        names = parts(name, self.internal)
        if not names and not root_ok:
            raise ValueError('File path required')
        with ExitStack() as stack:
            if os.name == 'posix':
                flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
                fd = os.open(self.root, flags)
                stack.callback(os.close, fd)
                for part in names[:-1]:
                    fd = os.open(part, flags, dir_fd=fd)
                    stack.callback(os.close, fd)
                yield fd, names[-1] if names else '.'
            elif os.name == 'nt':
                current = self.root
                stack.enter_context(windows_guard(current))
                for part in names[:-1]:
                    current = current / part
                    stack.enter_context(windows_guard(current))
                yield current, names[-1] if names else '.'
            else:
                raise ValueError('Unsupported operating system')

    def info(self, name):
        with self.parent(name, root_ok=True) as (parent, leaf):
            info = os.stat(leaf, dir_fd=parent, follow_symlinks=False) if os.name == 'posix' else (parent / leaf).lstat()
            check(info, directory=stat.S_ISDIR(info.st_mode))
            return info

    def read(self, name, limit=LIMIT):
        with self.parent(name) as (parent, leaf), ExitStack() as stack:
            if os.name == 'posix':
                fd = os.open(leaf, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
                stack.callback(os.close, fd)
                check(os.fstat(fd))
            else:
                fd = stack.enter_context(windows_guard(parent / leaf, directory=False))
            if os.fstat(fd).st_size > limit:
                raise ValueError('File size limit exceeded')
            chunks = bytearray()
            while len(chunks) <= limit:
                chunk = os.read(fd, min(16384, limit + 1 - len(chunks)))
                if not chunk:
                    break
                chunks.extend(chunk)
            if len(chunks) > limit:
                raise ValueError('File size limit exceeded')
            return bytes(chunks)

    def mkdir(self, name):
        with self.parent(name) as (parent, leaf):
            if os.name == 'posix':
                os.mkdir(leaf, mode=0o700, dir_fd=parent)
            else:
                (parent / leaf).mkdir()

    def write(self, name, data, overwrite=False):
        """Atomic replacement, or exclusive creation without a check/replace race."""
        with self.parent(name) as (parent, leaf):
            tmp = '.jan-mcp-' + uuid.uuid4().hex + '.tmp'
            posix = os.name == 'posix'
            kw = {'dir_fd': parent} if posix else {}
            target = leaf if posix else parent / leaf
            temporary = tmp if posix else parent / tmp
            fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600, **kw)
            try:
                with os.fdopen(fd, 'wb') as out:
                    out.write(data)
                    out.flush()
                    os.fsync(out.fileno())
                if overwrite:
                    try:
                        check(os.stat(target, follow_symlinks=False, **kw))
                    except FileNotFoundError:
                        pass
                    if posix:
                        os.replace(tmp, leaf, src_dir_fd=parent, dst_dir_fd=parent)
                    else:
                        os.replace(temporary, target)
                elif posix:
                    os.link(tmp, leaf, src_dir_fd=parent, dst_dir_fd=parent, follow_symlinks=False)
                else:
                    # Windows rename is exclusive when destination exists.
                    os.rename(temporary, target)
                if posix:
                    os.fsync(parent)
            finally:
                try:
                    os.unlink(temporary, **kw)
                except FileNotFoundError:
                    pass

    def unlink_file(self, name):
        """Remove one verified regular file inside pinned workspace parents."""
        with self.parent(name) as (parent, leaf):
            kw = {'dir_fd': parent} if os.name == 'posix' else {}
            target = leaf if os.name == 'posix' else parent / leaf
            check(os.stat(target, follow_symlinks=False, **kw))
            os.unlink(target, **kw)
            if os.name == 'posix':
                os.fsync(parent)

    def entries(self, name='.', limit=100, scan_limit=10000):
        if isinstance(name, str):
            # Accept ordinary directory separators without resolving traversal or links.
            name = (name.replace('\\', '/') if os.name == 'nt' else name).rstrip('/')
        result = []
        with self.parent(name, root_ok=True) as (parent, leaf), ExitStack() as stack:
            if os.name == 'posix':
                fd = os.open(leaf, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
                stack.callback(os.close, fd)
                iterator = os.scandir(fd)
            else:
                directory = parent / leaf
                stack.enter_context(windows_guard(directory))
                iterator = os.scandir(directory)
            with iterator:
                for i, entry in enumerate(iterator):
                    if i >= scan_limit:
                        break
                    try:
                        parts(entry.name, self.internal)
                        info = os.stat(entry.path, follow_symlinks=False) if os.name == 'nt' else entry.stat(follow_symlinks=False)
                        directory = stat.S_ISDIR(info.st_mode)
                        check(info, directory)
                    except (ValueError, OSError):
                        continue
                    result.append({'name': entry.name, 'kind': 'directory' if directory else 'file'})
                    if len(result) >= limit:
                        break
        return sorted(result, key=lambda x: x['name'])
