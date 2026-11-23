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
_JOB_HANDLE = None
_SUPERVISOR_DONE = threading.Event()
_PARENT_WATCHER = None


def _kernel32():
    return ctypes.WinDLL("kernel32", use_last_error=True)


def create_windows_job_handle():
    """Create an inheritable kill-on-close Job Object for one detached command."""
    if os.name != "nt":
        return None
    from ctypes import wintypes
    kernel32 = _kernel32()
    kernel32.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
    kernel32.CreateJobObjectW.restype = wintypes.HANDLE
    handle = kernel32.CreateJobObjectW(None, None)
    if not handle:
        raise OSError(ctypes.get_last_error(), "CreateJobObjectW failed")

    class BasicLimitInformation(ctypes.Structure):
        _fields_ = [
            ("PerProcessUserTimeLimit", ctypes.c_longlong),
            ("PerJobUserTimeLimit", ctypes.c_longlong),
            ("LimitFlags", wintypes.DWORD),
            ("MinimumWorkingSetSize", ctypes.c_size_t),
            ("MaximumWorkingSetSize", ctypes.c_size_t),
            ("ActiveProcessLimit", wintypes.DWORD),
            ("Affinity", ctypes.c_size_t),
            ("PriorityClass", wintypes.DWORD),
            ("SchedulingClass", wintypes.DWORD),
        ]

    class IoCounters(ctypes.Structure):
        _fields_ = [(name, ctypes.c_ulonglong) for name in
                    ("ReadOperationCount", "WriteOperationCount",
                     "OtherOperationCount", "ReadTransferCount",
                     "WriteTransferCount", "OtherTransferCount")]

    class ExtendedLimitInformation(ctypes.Structure):
        _fields_ = [
            ("BasicLimitInformation", BasicLimitInformation),
            ("IoInfo", IoCounters),
            ("ProcessMemoryLimit", ctypes.c_size_t),
            ("JobMemoryLimit", ctypes.c_size_t),
            ("PeakProcessMemoryUsed", ctypes.c_size_t),
            ("PeakJobMemoryUsed", ctypes.c_size_t),
        ]

    info = ExtendedLimitInformation()
    info.BasicLimitInformation.LimitFlags = 0x00002000  # KILL_ON_JOB_CLOSE
    kernel32.SetInformationJobObject.argtypes = [
        wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    kernel32.SetInformationJobObject.restype = wintypes.BOOL
    if not kernel32.SetInformationJobObject(
            handle, 9, ctypes.byref(info), ctypes.sizeof(info)):
        error = ctypes.get_last_error()
        kernel32.CloseHandle(handle)
        raise OSError(error, "SetInformationJobObject failed")
    kernel32.SetHandleInformation.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.DWORD]
    kernel32.SetHandleInformation.restype = wintypes.BOOL
    if not kernel32.SetHandleInformation(handle, 1, 1):  # HANDLE_FLAG_INHERIT
        error = ctypes.get_last_error()
        kernel32.CloseHandle(handle)
        raise OSError(error, "Could not make Job Object handle inheritable")
    return handle if isinstance(handle, int) else handle.value


def close_windows_job_handle(handle):
    if handle and os.name == "nt":
        from ctypes import wintypes
        kernel32 = _kernel32()
        kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel32.CloseHandle.restype = wintypes.BOOL
        kernel32.CloseHandle(wintypes.HANDLE(handle))


def terminate_windows_job(handle):
    if not handle or os.name != "nt":
        return False
    from ctypes import wintypes
    kernel32 = _kernel32()
    kernel32.TerminateJobObject.argtypes = [wintypes.HANDLE, wintypes.UINT]
    kernel32.TerminateJobObject.restype = wintypes.BOOL
    return bool(kernel32.TerminateJobObject(wintypes.HANDLE(handle), 125))


def windows_job_active_processes(handle):
    if not handle or os.name != "nt":
        return 0
    from ctypes import wintypes

    class BasicAccountingInformation(ctypes.Structure):
        _fields_ = [
            ("TotalUserTime", ctypes.c_longlong),
            ("TotalKernelTime", ctypes.c_longlong),
            ("ThisPeriodTotalUserTime", ctypes.c_longlong),
            ("ThisPeriodTotalKernelTime", ctypes.c_longlong),
            ("TotalPageFaults", wintypes.DWORD),
            ("TotalProcesses", wintypes.DWORD),
            ("ActiveProcesses", wintypes.DWORD),
            ("TotalTerminatedProcesses", wintypes.DWORD),
        ]

    kernel32 = _kernel32()
    kernel32.QueryInformationJobObject.argtypes = [
        wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD,
        ctypes.POINTER(wintypes.DWORD)]
    kernel32.QueryInformationJobObject.restype = wintypes.BOOL
    info = BasicAccountingInformation()
    if not kernel32.QueryInformationJobObject(
            wintypes.HANDLE(handle), 1, ctypes.byref(info), ctypes.sizeof(info), None):
        raise OSError(ctypes.get_last_error(), "QueryInformationJobObject failed")
    return info.ActiveProcesses


def _assign_and_resume_windows_child(child, job_handle):
    """Assign a suspended child to its non-breakaway job before it can execute."""
    from ctypes import wintypes
    kernel32 = _kernel32()
    kernel32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    kernel32.AssignProcessToJobObject.restype = wintypes.BOOL
    process_handle = child._handle
    if not kernel32.AssignProcessToJobObject(wintypes.HANDLE(job_handle), process_handle):
        error = ctypes.get_last_error()
        child.kill()
        child.wait()
        raise OSError(error, "AssignProcessToJobObject failed")

    class ThreadEntry32(ctypes.Structure):
        _fields_ = [
            ("dwSize", wintypes.DWORD), ("cntUsage", wintypes.DWORD),
            ("th32ThreadID", wintypes.DWORD), ("th32OwnerProcessID", wintypes.DWORD),
            ("tpBasePri", wintypes.LONG), ("tpDeltaPri", wintypes.LONG),
            ("dwFlags", wintypes.DWORD),
        ]

    kernel32.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
    kernel32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    kernel32.Thread32First.argtypes = [wintypes.HANDLE, ctypes.POINTER(ThreadEntry32)]
    kernel32.Thread32First.restype = wintypes.BOOL
    kernel32.Thread32Next.argtypes = [wintypes.HANDLE, ctypes.POINTER(ThreadEntry32)]
    kernel32.Thread32Next.restype = wintypes.BOOL
    kernel32.OpenThread.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel32.OpenThread.restype = wintypes.HANDLE
    kernel32.ResumeThread.argtypes = [wintypes.HANDLE]
    kernel32.ResumeThread.restype = wintypes.DWORD
    snapshot = kernel32.CreateToolhelp32Snapshot(0x00000004, 0)
    if snapshot == wintypes.HANDLE(-1).value:
        raise OSError(ctypes.get_last_error(), "CreateToolhelp32Snapshot failed")
    thread_handle = None
    try:
        entry = ThreadEntry32()
        entry.dwSize = ctypes.sizeof(entry)
        found = kernel32.Thread32First(snapshot, ctypes.byref(entry))
        while found:
            if entry.th32OwnerProcessID == child.pid:
                thread_handle = kernel32.OpenThread(0x0002, False, entry.th32ThreadID)
                if thread_handle:
                    break
            found = kernel32.Thread32Next(snapshot, ctypes.byref(entry))
    finally:
        kernel32.CloseHandle(snapshot)
    if not thread_handle:
        terminate_windows_job(job_handle)
        raise OSError(ctypes.get_last_error(), "Could not open suspended child thread")
    try:
        if kernel32.ResumeThread(thread_handle) == 0xFFFFFFFF:
            error = ctypes.get_last_error()
            terminate_windows_job(job_handle)
            raise OSError(error, "ResumeThread failed")
    finally:
        kernel32.CloseHandle(thread_handle)


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
    if _JOB_HANDLE:
        terminate_windows_job(_JOB_HANDLE)
        return
    if pid is None:
        return
    handle = open_child_process_handle(pid)
    if not handle:
        return
    try:
        terminate_child_process_tree(pid, handle)
    finally:
        close_child_process_handle(handle)


def _enable_linux_subreaper():
    """Make orphaned command descendants children of this supervisor on Linux."""
    if sys.platform != "linux":
        return
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))


def _linux_descendants(root_pid):
    """Return live descendants by walking /proc parent identities."""
    if sys.platform != "linux":
        return []
    parents = {}
    try:
        entries = os.scandir("/proc")
    except OSError:
        return []
    with entries:
        for entry in entries:
            if not entry.name.isdigit():
                continue
            try:
                raw = Path(entry.path, "stat").read_text()
                fields = raw[raw.rfind(")") + 1:].split()
                parents[int(entry.name)] = int(fields[1])
            except (OSError, ValueError, IndexError):
                continue
    descendants = set()
    frontier = {root_pid}
    while frontier:
        children = {pid for pid, parent in parents.items()
                    if parent in frontier and pid not in descendants}
        if not children:
            break
        descendants.update(children)
        frontier = children
    return sorted(descendants, reverse=True)


def _terminate_linux_descendants():
    """Kill and reap command descendants adopted by the Linux subreaper."""
    if sys.platform != "linux":
        return False
    terminated = False
    # Repeat to catch a descendant that forks while an earlier snapshot is
    # being terminated. The command's direct child has already exited here.
    for _ in range(10):
        descendants = _linux_descendants(os.getpid())
        if not descendants:
            break
        for pid in descendants:
            try:
                os.kill(pid, signal.SIGKILL)
                terminated = True
            except ProcessLookupError:
                pass
            except PermissionError:
                terminated = True  # Fail closed: do not report clean completion.
        deadline = __import__("time").monotonic() + 0.2
        while __import__("time").monotonic() < deadline:
            try:
                pid, _ = os.waitpid(-1, os.WNOHANG)
                if pid == 0:
                    __import__("time").sleep(0.01)
            except ChildProcessError:
                break
    return terminated


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
        global _PARENT_HANDLE, _JOB_HANDLE
        job_text = os.environ.pop("PCRC_SUPERVISOR_JOB_HANDLE", "")
        if not job_text.isdigit():
            raise RuntimeError("missing Windows command Job Object handle")
        _JOB_HANDLE = int(job_text)
        kernel32 = _kernel32()
        kernel32.SetHandleInformation.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.DWORD]
        kernel32.SetHandleInformation.restype = wintypes.BOOL
        if not kernel32.SetHandleInformation(wintypes.HANDLE(_JOB_HANDLE), 1, 0):
            raise OSError(ctypes.get_last_error(), "Could not secure Job Object handle")
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
    _enable_linux_subreaper()
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

        options = ({"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP | 0x00000004}
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
        if os.name == "nt":
            if not _JOB_HANDLE:
                child.kill()
                child.wait()
                raise RuntimeError("Windows Job Object is unavailable")
            _assign_and_resume_windows_child(child, _JOB_HANDLE)
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
            exit_code = child.wait()
            if os.name == "posix" and _terminate_linux_descendants():
                # The requested command left background descendants behind.
                # They were terminated, so require review rather than treating
                # the operation as a clean completion.
                return 125
            if os.name == "nt":
                try:
                    if windows_job_active_processes(_JOB_HANDLE):
                        terminate_windows_job(_JOB_HANDLE)
                        return 125
                except OSError:
                    terminate_windows_job(_JOB_HANDLE)
                    return 125
            return exit_code
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
