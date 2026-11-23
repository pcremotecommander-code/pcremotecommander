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
        if not launch or json.loads(launch.decode()).get("launch") is not True:
            return 125

        options = ({"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP}
                   if os.name == "nt" else
                   {"start_new_session": True, "preexec_fn": _parent_death()})
        child = subprocess.Popen(
            config["argv"], cwd=config["workspace"], env=config["environment"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT, shell=False, **options,
        )
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
