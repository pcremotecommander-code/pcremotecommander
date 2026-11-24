"""Detached command supervisor with cross-process lifetime fencing."""
from __future__ import annotations

import ctypes
import errno
import json
import os
import signal
import subprocess
import sys
import threading
import time
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


def terminate_windows_job_and_wait(handle):
    """Terminate every Job Object member and retain the caller's lock until exit."""
    if not handle or os.name != "nt":
        return False
    terminated = False
    while True:
        try:
            active = windows_job_active_processes(handle)
        except OSError:
            terminate_windows_job(handle)
            time.sleep(0.05)
            continue
        if not active:
            return terminated
        terminated = terminate_windows_job(handle) or terminated
        # TerminateJobObject initiates termination; do not release reservations
        # until the kernel reports that every member has actually exited.
        time.sleep(0.01)


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
    process_handle = int(child._handle)
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
        terminate_windows_job_and_wait(_JOB_HANDLE)
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


def _linux_process_table():
    """Snapshot PID parentage and start times from procfs, or fail closed."""
    processes = {}
    try:
        entries = os.scandir("/proc")
    except OSError:
        return None
    with entries:
        for entry in entries:
            if not entry.name.isdigit():
                continue
            try:
                raw = Path(entry.path, "stat").read_text()
                fields = raw[raw.rfind(")") + 1:].split()
                processes[int(entry.name)] = (int(fields[1]), int(fields[19]))
            except FileNotFoundError:
                # The process exited while procfs was being scanned.
                continue
            except (OSError, ValueError, IndexError):
                return None
    return processes


def _linux_descendants(root_pid):
    """Return (pid, start_time) identities below a process in the procfs tree."""
    processes = _linux_process_table()
    if processes is None:
        return None
    descendants = {}
    frontier = {root_pid}
    while frontier:
        children = {
            pid: start_time
            for pid, (parent, start_time) in processes.items()
            if parent in frontier and pid not in descendants
        }
        if not children:
            break
        descendants.update(children)
        frontier = set(children)
    return sorted(descendants.items(), reverse=True)


def _linux_kill_process_identity(pid, expected_start_time):
    """Signal a PID only after binding and validating its process identity."""
    pidfd = None
    try:
        if hasattr(os, "pidfd_open") and hasattr(signal, "pidfd_send_signal"):
            try:
                pidfd = os.pidfd_open(pid, 0)
            except OSError as exc:
                if exc.errno not in (errno.ENOSYS, errno.EINVAL, errno.EPERM):
                    raise
            if pidfd is not None:
                current_table = _linux_process_table()
                current = None if current_table is None else current_table.get(pid)
                if current is None or current[1] != expected_start_time:
                    return False
                signal.pidfd_send_signal(pidfd, signal.SIGKILL)
                return True
        current_table = _linux_process_table()
        current = None if current_table is None else current_table.get(pid)
        if current is None or current[1] != expected_start_time:
            return False
        os.kill(pid, signal.SIGKILL)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        # The caller must retain the reservation if a descendant cannot be
        # terminated; report it as still present and keep retrying.
        return False
    finally:
        if pidfd is not None:
            os.close(pidfd)


def _reap_linux_children():
    while True:
        try:
            pid, _ = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            return
        if pid == 0:
            return


def _terminate_linux_descendants():
    """Kill and reap all descendants, retaining the lock until none remain."""
    if sys.platform != "linux":
        return False
    terminated = False
    while True:
        descendants = _linux_descendants(os.getpid())
        if descendants is None:
            # Procfs is required to prove that no descendants remain.
            time.sleep(0.05)
            continue
        if not descendants:
            _reap_linux_children()
            remaining = _linux_descendants(os.getpid())
            if remaining == []:
                return terminated
        for pid, start_time in descendants:
            if _linux_kill_process_identity(pid, start_time):
                terminated = True
        _reap_linux_children()
        # No timeout: if a process cannot be killed (for example, stuck in
        # uninterruptible kernel sleep), keeping the reservation is safer than
        # falsely declaring the workspace available.
        time.sleep(0.01)


def _parent_terminated(signum, frame):
    # First kill the ordinary process group, then on Linux remain alive as a
    # subreaper until even daemonized descendants have exited and been reaped.
    if _CHILD_PGID is not None:
        try:
            os.killpg(_CHILD_PGID, signal.SIGKILL)
        except OSError:
            pass
    if sys.platform == "linux":
        _terminate_linux_descendants()
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


def supervise_linux_guardian(config, lock_fd):
    """Run a Linux command behind a second subreaper that survives supervisor crashes."""
    global _CHILD_PGID, _CHILD_PID

    guardian_environment = os.environ.copy()
    guardian_environment["PCRC_SUPERVISOR_PARENT_PID"] = str(os.getpid())
    os.set_inheritable(lock_fd, True)
    guardian = subprocess.Popen(
        [sys.executable, "-m", "jan_mcp_commander.session_guard"],
        cwd=config["workspace"],
        env=guardian_environment,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        shell=False,
        start_new_session=True,
        pass_fds=(lock_fd,),
    )
    _CHILD_PID = guardian.pid
    _CHILD_PGID = guardian.pid
    input_thread = None
    guardian_done = threading.Event()
    try:
        guardian_config = {
            "role": "guardian",
            "workspace": config["workspace"],
            "argv": config["argv"],
            "lock_fd": lock_fd,
        }
        guardian.stdin.write((json.dumps(guardian_config) + "\n").encode("utf-8"))
        guardian.stdin.flush()

        import select
        output_fd = guardian.stdout.fileno()
        ready_deadline = time.monotonic() + 15
        ready_line = bytearray()
        while not ready_line.endswith(b"\n") and len(ready_line) < 4096:
            remaining = ready_deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("Linux command guardian did not become ready")
            readable, _, _ = select.select([output_fd], [], [], remaining)
            if not readable:
                raise TimeoutError("Linux command guardian did not become ready")
            packet = os.read(output_fd, 1)
            if not packet:
                break
            ready_line.extend(packet)
        if not ready_line.endswith(b"\n"):
            diagnostic = guardian.stderr.read(4096) if guardian.poll() is not None else b""
            raise RuntimeError(
                "Linux command guardian exited before starting the command: "
                + diagnostic.decode("utf-8", "replace")[:240]
            )
        ready = json.loads(bytes(ready_line).decode("utf-8"))
        if ready.get("ready") is not True or type(ready.get("pid")) is not int:
            raise RuntimeError("Linux command guardian returned an invalid handshake")
        sys.stdout.write(json.dumps(ready) + "\n")
        sys.stdout.flush()

        input_thread = threading.Thread(
            target=_forward_input,
            args=(sys.stdin.buffer, guardian.stdin, guardian_done),
            daemon=False,
        )
        input_thread.start()

        pipe_closed = False
        while guardian.poll() is None:
            if pipe_closed:
                time.sleep(0.02)
                continue
            readable, _, _ = select.select([output_fd], [], [], 0.05)
            if not readable:
                continue
            packet = os.read(output_fd, 4096)
            if packet:
                sys.stdout.buffer.write(packet)
                sys.stdout.buffer.flush()
            else:
                pipe_closed = True

        exit_code = guardian.wait()
        # If the guardian itself was killed, its orphaned descendants are now
        # adopted by this supervisor (also a subreaper) and must be reaped here.
        descendants_terminated = _terminate_linux_descendants()
        while True:
            readable, _, _ = select.select([output_fd], [], [], 0)
            if not readable:
                break
            packet = os.read(output_fd, 4096)
            if not packet:
                break
            sys.stdout.buffer.write(packet)
            sys.stdout.buffer.flush()
        if descendants_terminated or exit_code < 0:
            return 125
        return exit_code
    finally:
        guardian_done.set()
        if input_thread is not None:
            input_thread.join()
        if guardian.poll() is None:
            try:
                os.killpg(guardian.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            guardian.wait()
        for stream in (guardian.stdin, guardian.stdout, guardian.stderr):
            try:
                stream.close()
            except OSError:
                pass


def supervise_guardian(config):
    """Linux per-command subreaper; keep the workspace lock if its parent dies."""
    global _CHILD_PGID, _CHILD_PID

    lock_fd = config.get("lock_fd")
    if type(lock_fd) is not int or lock_fd < 0:
        raise ValueError("Invalid inherited resource-lock descriptor")
    # The guardian holds the lock independently. The user command never needs
    # the descriptor, so closing its unrelated descriptors cannot release it.
    os.set_inheritable(lock_fd, False)
    if _PARENT_DEAD.is_set():
        return 125

    child = subprocess.Popen(
        config["argv"],
        cwd=config["workspace"],
        env=os.environ.copy(),
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        shell=False,
        start_new_session=True,
        close_fds=True,
    )
    _CHILD_PID = child.pid
    _CHILD_PGID = child.pid
    if _PARENT_DEAD.is_set():
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        child.wait()
        return 125

    sys.stdout.write(json.dumps({"ready": True, "pid": child.pid}) + "\n")
    sys.stdout.flush()
    child_done = threading.Event()
    input_thread = threading.Thread(
        target=_forward_input,
        args=(sys.stdin.buffer, child.stdin, child_done),
        daemon=False,
    )
    input_thread.start()
    try:
        import select
        pipe_closed = False
        while child.poll() is None:
            if pipe_closed:
                time.sleep(0.02)
                continue
            readable, _, _ = select.select([child.stdout], [], [], 0.05)
            if not readable:
                continue
            packet = child.stdout.read1(4096)
            if packet:
                sys.stdout.buffer.write(packet)
                sys.stdout.buffer.flush()
            else:
                pipe_closed = True

        exit_code = child.wait()
        descendants_terminated = _terminate_linux_descendants()
        while True:
            packet = child.stdout.read1(4096)
            if not packet:
                break
            sys.stdout.buffer.write(packet)
            sys.stdout.buffer.flush()
        if descendants_terminated or exit_code < 0:
            return 125
        return exit_code
    finally:
        child_done.set()
        input_thread.join()
        if child.poll() is None:
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            child.wait()
        # Fail closed on every unexpected guardian exit, not just normal exit.
        _terminate_linux_descendants()


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
        if sys.platform == "linux":
            return supervise_linux_guardian(config, lock_fd)

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
            # Do not wait for pipe EOF before observing the direct command's
            # exit: a background descendant may have inherited stdout/stderr.
            pipe_closed = False
            while child.poll() is None:
                if pipe_closed:
                    time.sleep(0.02)
                    continue
                if os.name == "posix":
                    import select
                    readable, _, _ = select.select([child.stdout], [], [], 0.05)
                    if not readable:
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
                    pipe_handle = msvcrt.get_osfhandle(child.stdout.fileno())
                    if not kernel32.PeekNamedPipe(
                            wintypes.HANDLE(pipe_handle), None, 0, None,
                            ctypes.byref(available), None):
                        pipe_closed = True
                        continue
                    if not available.value:
                        time.sleep(0.02)
                        continue
                packet = child.stdout.read1(4096)
                if packet:
                    sys.stdout.buffer.write(packet)
                    sys.stdout.buffer.flush()
                else:
                    pipe_closed = True

            exit_code = child.wait()
            descendants_terminated = False
            if os.name == "posix":
                descendants_terminated = _terminate_linux_descendants()
            else:
                descendants_terminated = terminate_windows_job_and_wait(_JOB_HANDLE)
            # Once descendants are gone, the output pipe must reach EOF. Drain
            # buffered output without allowing a detached writer to hold the
            # workspace reservation open.
            while True:
                packet = child.stdout.read1(4096)
                if not packet:
                    break
                sys.stdout.buffer.write(packet)
                sys.stdout.buffer.flush()
            if descendants_terminated or exit_code < 0:
                # Exit 125 is the private review-required sentinel for a
                # terminated descendant tree or a command killed by signal.
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
        # Enable subreaper mode before installing the parent-death signal so
        # there is no startup window in which escaped orphans reparent to init.
        _enable_linux_subreaper()
        _install_parent_death_guard()
        config_line = sys.stdin.buffer.readline(1024 * 1024)
        if not config_line:
            return 125
        config = json.loads(config_line.decode("utf-8"))
        if config.get("role") == "guardian":
            return supervise_guardian(config)
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
