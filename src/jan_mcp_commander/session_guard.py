"""Detached command supervisor with a durable cross-process resource lock."""
from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import threading
from pathlib import Path

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from .security import PrivateStore


def _parent_death():
    """Return a pre-exec hook that kills this child if its parent disappears."""
    import ctypes
    import ctypes.util
    libc = ctypes.CDLL(ctypes.util.find_library("c") or None, use_errno=True)
    parent_pid = os.getpid()

    def configure():
        libc.prctl(1, signal.SIGKILL, 0, 0, 0)  # Linux PR_SET_PDEATHSIG
        if os.getppid() != parent_pid:
            os.kill(os.getpid(), signal.SIGKILL)
    return configure





def parent_death_preexec():
    return _parent_death()


def assign_supervisor_job(process):
    """Assign the waiting supervisor to a kill-on-close Windows Job Object."""
    import ctypes
    from ctypes import wintypes
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
    kernel32.CreateJobObjectW.restype = wintypes.HANDLE
    kernel32.SetInformationJobObject.argtypes = [wintypes.HANDLE, wintypes.INT,
                                                  ctypes.c_void_p, wintypes.DWORD]
    kernel32.SetInformationJobObject.restype = wintypes.BOOL
    kernel32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    kernel32.AssignProcessToJobObject.restype = wintypes.BOOL
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel32.CloseHandle.restype = wintypes.BOOL

    class IO_COUNTERS(ctypes.Structure):
        _fields_ = [(name, ctypes.c_ulonglong) for name in (
            "ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
            "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]

    class BASIC_LIMIT(ctypes.Structure):
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

    class EXTENDED_LIMIT(ctypes.Structure):
        _fields_ = [("BasicLimitInformation", BASIC_LIMIT),
                    ("IoInfo", IO_COUNTERS),
                    ("ProcessMemoryLimit", ctypes.c_size_t),
                    ("JobMemoryLimit", ctypes.c_size_t),
                    ("PeakProcessMemoryUsed", ctypes.c_size_t),
                    ("PeakJobMemoryUsed", ctypes.c_size_t)]

    job = kernel32.CreateJobObjectW(None, None)
    if not job:
        raise ctypes.WinError(ctypes.get_last_error())
    info = EXTENDED_LIMIT()
    info.BasicLimitInformation.LimitFlags = 0x00002000  # KILL_ON_JOB_CLOSE
    if not kernel32.SetInformationJobObject(job, 9, ctypes.byref(info),
                                             ctypes.sizeof(info)):
        error = ctypes.get_last_error()
        kernel32.CloseHandle(job)
        raise ctypes.WinError(error)
    if not kernel32.AssignProcessToJobObject(job, wintypes.HANDLE(process._handle)):
        error = ctypes.get_last_error()
        kernel32.CloseHandle(job)
        raise ctypes.WinError(error)
    return int(job)


def close_supervisor_job(handle):
    if handle and os.name == "nt":
        import ctypes
        from ctypes import wintypes
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel32.CloseHandle.restype = wintypes.BOOL
        kernel32.CloseHandle(wintypes.HANDLE(handle))


def _mark_completed(store, operation_id):
    with store.locked():
        try:
            blob = store.tree.read("tasks.enc", 2 * 1024 * 1024)
        except FileNotFoundError:
            return
        data = json.loads(AESGCM(store.key).decrypt(
            blob[:12], blob[12:], store.context))
        record = data.get("operations", {}).get(operation_id)
        if not isinstance(record, dict) or record.get("state") != "active":
            return
        record.update(state="completed", finished_at=__import__("time").time(),
                      note="Detached command process exited under its supervisor.")
        raw = json.dumps(data, ensure_ascii=True).encode()
        nonce = os.urandom(12)
        store.tree.write("tasks.enc", nonce + AESGCM(store.key).encrypt(
            nonce, raw, store.context), overwrite=True)


def _forward_input(source, destination):
    try:
        while True:
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
    store = PrivateStore(Path(config["state_dir"]), Path(config["workspace"]))
    with store.resource_locked(config["lock_resource"]):
        # Parent has not authorized the command to start yet. EOF means the
        # caller died or abandoned startup, so no user process is launched.
        sys.stdout.write(json.dumps({"locked": True}) + "\\n")
        sys.stdout.flush()
        launch = sys.stdin.buffer.readline(4096)
        if not launch:
            return 125
        launch_data = json.loads(launch.decode())
        if launch_data.get("launch") is not True or not isinstance(launch_data.get("operation_id"), str):
            return 125
        operation_id = launch_data["operation_id"]

        options = ({"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP}
                   if os.name == "nt" else
                   {"start_new_session": True, "preexec_fn": _parent_death()})
        try:
            child = subprocess.Popen(
                config["argv"], cwd=config["workspace"], env=os.environ.copy(),
                stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT, shell=False, **options,
            )
        except BaseException:
            with store.locked():
                blob = store.tree.read("tasks.enc", 2 * 1024 * 1024)
                data = json.loads(AESGCM(store.key).decrypt(blob[:12], blob[12:], store.context))
                record = data.get("operations", {}).get(operation_id)
                if isinstance(record, dict) and record.get("state") == "active":
                    record.update(state="failed", finished_at=__import__("time").time(),
                                  note="Supervisor could not create the child process; no command process started.")
                    raw = json.dumps(data, ensure_ascii=True).encode()
                    nonce = os.urandom(12)
                    store.tree.write("tasks.enc", nonce + AESGCM(store.key).encrypt(
                        nonce, raw, store.context), overwrite=True)
            raise
        config["operation_id"] = operation_id
        sys.stdout.write(json.dumps({"ready": True, "pid": child.pid}) + "\\n")
        sys.stdout.flush()
        input_thread = threading.Thread(
            target=_forward_input,
            args=(sys.stdin.buffer, child.stdin), daemon=True)
        input_thread.start()
        try:
            while True:
                packet = child.stdout.read1(4096)
                if not packet:
                    break
                sys.stdout.buffer.write(packet)
                sys.stdout.buffer.flush()
            exit_code = child.wait()
            _mark_completed(store, config["operation_id"])
            return exit_code
        finally:
            if child.poll() is None:
                try:
                    if os.name == "nt":
                        subprocess.run(
                            [os.path.join(os.environ.get("SystemRoot", r"C:\\Windows"),
                                           "System32", "taskkill.exe"),
                             "/PID", str(child.pid), "/T", "/F"],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                            timeout=5, check=False)
                    else:
                        os.killpg(child.pid, signal.SIGKILL)
                except (OSError, subprocess.TimeoutExpired):
                    child.kill()
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    pass


def main():
    try:
        config_line = sys.stdin.buffer.readline(1024 * 1024)
        if not config_line:
            return 125
        config = json.loads(config_line.decode("utf-8"))
        return supervise(config)
    except BaseException as exc:
        try:
            sys.stderr.write(json.dumps({"supervisor_error": type(exc).__name__}) + "\\n")
            sys.stderr.flush()
        except Exception:
            pass
        return 125


if __name__ == "__main__":
    raise SystemExit(main())
