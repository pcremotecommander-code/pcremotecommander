"""Only synthetic child processes; no user files, desktop or network."""
import os
import subprocess
import sys

import pytest


def test_document_worker_has_its_own_wall_deadline():
    result=subprocess.run([sys.executable,'-c',
        'from jan_mcp_commander._document_worker import watch_parent; import time,sys; watch_parent(.3,parent_pid=int(sys.argv[1])); print("ready",flush=True); time.sleep(30)',str(os.getpid())],
        timeout=8,capture_output=True)
    assert result.stdout.strip()==b'ready',result.stderr.decode(errors='replace')
    if os.name=='nt':assert result.returncode==124
    else:
        import signal
        assert result.returncode in (124,-signal.SIGALRM)


@pytest.mark.skipif(os.name!='nt',reason='Native pinned Windows parent handle')
def test_document_worker_stops_after_its_parent_is_killed():
    import win32api,win32con,win32event
    child='from jan_mcp_commander._document_worker import watch_parent; import time,sys; watch_parent(parent_pid=int(sys.argv[1])); print("ready",flush=True); time.sleep(30)'
    script='import subprocess,sys,time,os; p=subprocess.Popen([sys.executable,"-c",'+repr(child)+',str(os.getpid())],stdout=subprocess.PIPE); print(p.pid,flush=True); print(p.stdout.readline().decode().strip(),flush=True); time.sleep(30)'
    parent=subprocess.Popen([sys.executable,'-c',script],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    handle=None
    try:
        pid=int(parent.stdout.readline());assert parent.stdout.readline().strip()=='ready'
        handle=win32api.OpenProcess(win32con.SYNCHRONIZE|win32con.PROCESS_TERMINATE,False,pid)
        parent.terminate();parent.wait(timeout=5)
        assert win32event.WaitForSingleObject(handle,4000)==win32event.WAIT_OBJECT_0
    finally:
        if parent.poll() is None:parent.terminate();parent.wait(timeout=5)
        if handle is not None:
            if win32event.WaitForSingleObject(handle,0)==win32event.WAIT_TIMEOUT:win32api.TerminateProcess(handle,1)
            handle.Close()


@pytest.mark.skipif(os.name!='nt',reason='Native Windows kernel parser limits')
def test_document_worker_configures_memory_and_cpu_limits():
    import win32job
    script='from jan_mcp_commander.worker_limits import apply_limits; import win32job; j=apply_limits(512,cpu_seconds=12); v=win32job.QueryInformationJobObject(j,win32job.JobObjectExtendedLimitInformation); b=v["BasicLimitInformation"]; assert b["LimitFlags"] & win32job.JOB_OBJECT_LIMIT_PROCESS_TIME; assert b["PerProcessUserTimeLimit"]==120000000; assert v["ProcessMemoryLimit"]==512*1024*1024'
    result=subprocess.run([sys.executable,'-c',script],timeout=8,capture_output=True)
    assert result.returncode==0,result.stderr.decode(errors='replace')
