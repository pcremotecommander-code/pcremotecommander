"""Detached command supervisor with cross-process lifetime fencing."""
from __future__ import annotations

import ctypes
import json
import os
import signal
import subprocess
import sys
import threading
from pathlib import Path

from .security import PrivateStore

_CHILD_PGID = None
_CHILD_PID = None
_PARENT_DEAD = threading.Event()
_PARENT_HANDLE = None
_SUPERVISOR_DONE = threading.Event()
_PARENT_WATCHER = None


def _kernel32():
    return ctypes.WinDLL("kernel32", use_last_error=True)


def open_child_process_handle(pid):
    """Open a stable Windows process identity handle in the PCRC parent."""
    if os.name != "nt":
        return None
    from ctypes import wintypes
    kernel32 = _kernel32()
    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel32.OpenProcess.restype = wintypes.HANDLE
    handle = kernel32.OpenProcess(0x00100000 | 0x0001 | 0x1000, False, pid)
    if not handle:
        return None  # The command may already have exited.
    return handle if isinstance(handle, int) else handle.value


def close_child_process_handle(handle):
    if handle and os.name == "nt":
        from ctypes import wintypes
        kernel32 = _kernel32()
        kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel32.CloseHandle.restype = wintypes.BOOL
        kernel32.CloseHandle(wintypes.HANDLE(handle))


def terminate_child_process_tree(pid, handle):
    """Kill a still-live child tree using a handle bound to the original PID."""
    if os.name != "nt" or not handle:
        return False
    from ctypes import wintypes
    kernel32 = _kernel32()
    kernel32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    kernel32.WaitForSingleObject.restype = wintypes.DWORD
    kernel32.TerminateProcess.argtypes = [wintypes.HANDLE, wintypes.UINT]
    kernel32.TerminateProcess.restype = wintypes.BOOL
    h = wintypes.HANDLE(handle)
    if kernel32.WaitForSingleObject(h, 0) == 0:  # WAIT_OBJECT_0
        return False
    taskkill = os.path.join(os.environ.get("SystemRoot", r"C:\\Windows"),
                            "System32", "taskkill.exe")
    subprocess.run([taskkill, "/PID", str(pid), "/T", "/F"],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                   timeout=5, check=False)
    if kernel32.WaitForSingleObject(h, 5000) == 258:  # WAIT_TIMEOUT
        kernel32.TerminateProcess(h, 125)
        kernel32.WaitForSingleObject(h, 5000)
    return True


def _kill_windows_tree(pid):
    if pid is None:
        return
    handle = open_child_process_handle(pid)
    if not handle:
        return
    try:
        terminate_child_process_tree(pid, handle)
    finally:
        close_child_process_handle(handle)


def _parent_terminated(signum, frame):
    # POSIX child commands have their own process group. Killing that complete
    # group prevents descendants from outliving the supervisor reservation.
    if _CHILD_PGID is not None:
        try:
            os.killpg(_CHILD_PGID, signal.SIGKILL)
        except OSError:
            pass
    os._exit(125)


def _watch_windows_parent():
    from ctypes import wintypes
    kernel32 = _kernel32()
    kernel32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    kernel32.WaitForSingleObject.restype = wintypes.DWORD
    while not _SUPERVISOR_DONE.is_set():
        result = kernel32.WaitForSingleObject(wintypes.HANDLE(_PARENT_HANDLE), 250)
        if result == 0:  # PCRC parent process exited.
            _PARENT_DEAD.set()
            _kill_windows_tree(_CHILD_PID)
            os._exit(125)
        if result not in (258,):  # WAIT_TIMEOUT
            _PARENT_DEAD.set()
            _kill_windows_tree(_CHILD_PID)
            os._exit(125)


def _install_parent_death_guard():
    expected = os.environ.pop("PCRC_SUPERVISOR_PARENT_PID", "")
    if not expected.isdigit():
        raise RuntimeError("missing supervisor parent identity")
    expected_pid = int(expected)
    if os.name == "posix":
        if os.getppid() != expected_pid:
            os.kill(os.getpid(), signal.SIGTERM)
        signal.signal(signal.SIGTERM, _parent_terminated)
        libc = ctypes.CDLL(None, use_errno=True)
        if libc.prctl(1, signal.SIGTERM, 0, 0, 0) != 0:  # PR_SET_PDEATHSIG
            error = ctypes.get_errno()
            raise OSError(error, os.strerror(error))
        if os.getppid() != expected_pid:
            os.kill(os.getpid(), signal.SIGTERM)
    else:
        from ctypes import wintypes
        global _PARENT_HANDLE
        kernel32 = _kernel32()
        kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel32.OpenProcess.restype = wintypes.HANDLE
        opened = kernel32.OpenProcess(0x00100000, False, expected_pid)
        _PARENT_HANDLE = opened if isinstance(opened, int) else getattr(opened, "value", None)
        if not _PARENT_HANDLE:
            raise OSError(ctypes.get_last_error(), "Could not bind supervisor to PCRC parent process")
        watcher = threading.Thread(target=_watch_windows_parent, daemon=True)
        watcher.start()
        globals()["_PARENT_WATCHER"] = watcher


def _forward_input(source, destination, child_done):
    try:
        while not child_done.is_set():
            if os.name == "posix":
                import select
                if not select.select([source], [], [], 0.1)[0]:
                    continue
            else:
                import msvcrt
                from ctypes import wintypes
                kernel32 = _kernel32()
                kernel32.PeekNamedPipe.argtypes = [
                    wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD,
                    ctypes.c_void_p, ctypes.POINTER(wintypes.DWORD), ctypes.c_void_p]
                kernel32.PeekNamedPipe.restype = wintypes.BOOL
                available = wintypes.DWORD()
                handle = msvcrt.get_osfhandle(source.fileno())
                if not kernel32.PeekNamedPipe(wintypes.HANDLE(handle), None, 0,
                                               None, ctypes.byref(available), None):
                    break
                if not available.value:
                    child_done.wait(0.1)
                    continue
            packet = source.read1(4096)
            if not packet:
                break
            destination.write(packet)
            destination.flush()
    except (BrokenPipeError, OSError, ValueError):
        pass
    finally:
        try:
            destination.close()
        except OSError:
            pass


def supervise(config):
    global _CHILD_PGID, _CHILD_PID
    store = PrivateStore(Path(config["state_dir"]), Path(config["workspace"]))
    lock_resource = config["lock_resource"]
    with store.resource_locked_handoff(lock_resource) as lock_fd:
        sys.stdout.write(json.dumps({"locked": True}) + "\n")
        sys.stdout.flush()
        launch = sys.stdin.buffer.readline(4096)
        if not launch:
            return 125
        launch_data = json.loads(launch.decode())
        if launch_data.get("launch") is not True or not isinstance(launch_data.get("operation_id"), str):
            return 125
        if _PARENT_DEAD.is_set():
            return 125

        options = ({"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP}
                   if os.name == "nt" else {"start_new_session": True})
        inherited_lock = {}
        if os.name == "posix":
            os.set_inheritable(lock_fd, True)
            inherited_lock["pass_fds"] = (lock_fd,)
        child = subprocess.Popen(
            config["argv"], cwd=config["workspace"], env=os.environ.copy(),
            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT, shell=False, **inherited_lock, **options,
        )
        _CHILD_PID = child.pid
        _CHILD_PGID = child.pid if os.name == "posix" else None
        if _PARENT_DEAD.is_set():
            if os.name == "nt":
                _kill_windows_tree(child.pid)
            else:
                os.killpg(child.pid, signal.SIGKILL)
            return 125
        sys.stdout.write(json.dumps({"ready": True, "pid": child.pid}) + "\n")
        sys.stdout.flush()
        child_done = threading.Event()
        input_thread = threading.Thread(
            target=_forward_input,
            args=(sys.stdin.buffer, child.stdin, child_done), daemon=False)
        input_thread.start()
        try:
            while True:
                packet = child.stdout.read1(4096)
                if not packet:
                    break
                sys.stdout.buffer.write(packet)
                sys.stdout.buffer.flush()
            return child.wait()
        finally:
            child_done.set()
            input_thread.join()
            if child.poll() is None:
                try:
                    if os.name == "nt":
                        _kill_windows_tree(child.pid)
                    else:
                        os.killpg(child.pid, signal.SIGKILL)
                except OSError:
                    child.kill()
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    pass


def main():
    try:
        _install_parent_death_guard()
        config_line = sys.stdin.buffer.readline(1024 * 1024)
        if not config_line:
            return 125
        config = json.loads(config_line.decode("utf-8"))
        return supervise(config)
    except BaseException as exc:
        try:
            sys.stderr.write(json.dumps({"supervisor_error": type(exc).__name__}) + "\n")
            sys.stderr.flush()
        except Exception:
            pass
        return 125
    finally:
        _SUPERVISOR_DONE.set()
        if _PARENT_WATCHER is not None:
            _PARENT_WATCHER.join(timeout=1)
        if _PARENT_HANDLE and os.name == "nt":
            from ctypes import wintypes
            kernel32 = _kernel32()
            kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
            kernel32.CloseHandle.restype = wintypes.BOOL
            kernel32.CloseHandle(wintypes.HANDLE(_PARENT_HANDLE))


if __name__ == "__main__":
    raise SystemExit(main())
