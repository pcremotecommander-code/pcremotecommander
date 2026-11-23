"""Supervise detached command children while holding a cross-process reservation.

The supervisor outlives the PCRC request process. If it is killed unexpectedly,
the child is killed with it (PDEATHSIG on POSIX, a kill-on-close Job on Windows).
"""
from __future__ import annotations

import argparse
import base64
import ctypes
import json
import os
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path

from .security import PrivateStore


def _windows_job(process):
    """Assign a child to a kill-on-close Job Object."""
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    create_job = kernel32.CreateJobObjectW
    create_job.restype = ctypes.c_void_p
    job = create_job(None, None)
    if not job:
        raise OSError(ctypes.get_last_error(), "CreateJobObjectW failed")

    class IO_COUNTERS(ctypes.Structure):
        _fields_ = [(name, ctypes.c_ulonglong) for name in (
            "ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
            "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]

    class BASIC_LIMIT(ctypes.Structure):
        _fields_ = [
            ("PerProcessUserTimeLimit", ctypes.c_longlong),
            ("PerJobUserTimeLimit", ctypes.c_longlong),
            ("LimitFlags", ctypes.c_ulong),
            ("MinimumWorkingSetSize", ctypes.c_size_t),
            ("MaximumWorkingSetSize", ctypes.c_size_t),
            ("ActiveProcessLimit", ctypes.c_ulong),
            ("Affinity", ctypes.c_size_t),
            ("PriorityClass", ctypes.c_ulong),
            ("SchedulingClass", ctypes.c_ulong),
        ]

    class EXTENDED_LIMIT(ctypes.Structure):
        _fields_ = [("BasicLimitInformation", BASIC_LIMIT),
                    ("IoInfo", IO_COUNTERS),
                    ("ProcessMemoryLimit", ctypes.c_size_t),
                    ("JobMemoryLimit", ctypes.c_size_t),
                    ("PeakProcessMemoryUsed", ctypes.c_size_t),
                    ("PeakJobMemoryUsed", ctypes.c_size_t)]

    info = EXTENDED_LIMIT()
    info.BasicLimitInformation.LimitFlags = 0x00002000  # KILL_ON_JOB_CLOSE
    if not kernel32.SetInformationJobObject(ctypes.c_void_p(job), 9,
                                             ctypes.byref(info), ctypes.sizeof(info)):
        error = ctypes.get_last_error()
        kernel32.CloseHandle(ctypes.c_void_p(job))
        raise OSError(error, "SetInformationJobObject failed")
    if not kernel32.AssignProcessToJobObject(ctypes.c_void_p(job),
                                             ctypes.c_void_p(process._handle)):
        error = ctypes.get_last_error()
        kernel32.CloseHandle(ctypes.c_void_p(job))
        raise OSError(error, "AssignProcessToJobObject failed")
    return job


def _parent_death():
    """Make the direct child die if this supervisor unexpectedly disappears."""
    import ctypes.util
    libc_name = ctypes.util.find_library("c")
    libc = ctypes.CDLL(libc_name or None, use_errno=True)
    parent = os.getpid()

    def configure():
        libc.prctl(1, signal.SIGKILL, 0, 0, 0)  # PR_SET_PDEATHSIG
        if os.getppid() != parent:
            os.kill(os.getpid(), signal.SIGKILL)
    return configure


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


def _forward_output(source, destination):
    while True:
        packet = source.read1(4096)
        if not packet:
            break
        destination.write(packet)
        destination.flush()


def supervise(config):
    store = PrivateStore(Path(config["state_dir"]), Path(config["workspace"]))
    job = None
    child = None
    with store.resource_locked(config["lock_resource"]):
        options = ({"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP}
                   if os.name == "nt" else
                   {"start_new_session": True, "preexec_fn": _parent_death()})
        child = subprocess.Popen(
            config["argv"], cwd=config["workspace"], env=os.environ.copy(),
            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT, shell=False, **options,
        )
        try:
            if os.name == "nt":
                job = _windows_job(child)
            ready = {"ready": True, "pid": child.pid}
            sys.stdout.write(json.dumps(ready) + "\\n")
            sys.stdout.flush()
            input_thread = threading.Thread(
                target=_forward_input,
                args=(sys.stdin.buffer, child.stdin), daemon=True)
            input_thread.start()
            _forward_output(child.stdout, sys.stdout.buffer)
            exit_code = child.wait()
            sys.stderr.write(json.dumps({"completed": True, "exit_code": exit_code}) + "\\n")
            sys.stderr.flush()
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
            if job:
                ctypes.WinDLL("kernel32", use_last_error=True).CloseHandle(ctypes.c_void_p(job))


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    args = parser.parse_args(argv)
    try:
        config = json.loads(base64.urlsafe_b64decode(args.config.encode()).decode())
        return supervise(config)
    except BaseException as exc:
        try:
            sys.stderr.write(json.dumps({"completed": False, "error": type(exc).__name__}) + "\\n")
            sys.stderr.flush()
        except Exception:
            pass
        return 125


if __name__ == "__main__":
    raise SystemExit(main())
