"""Local foreground ownership, never a remote capability-renewal interface."""
import os
import sys
import threading


class ParentSession:
    def __init__(self, owner_pid=None):
        # Windows venv redirectors outlive their launcher; callers pass its real PID.
        if owner_pid is None and os.name=='nt' and sys.executable.casefold()!=getattr(sys,'_base_executable',sys.executable).casefold():
            raise ValueError('Foreground control requires the PCRC launcher to identify its owner process')
        self.pid=os.getppid() if owner_pid is None else owner_pid
        if type(self.pid) is not int or self.pid<=1 or self.pid==os.getpid():raise ValueError('Foreground control requires a live local launcher parent')
        self.stopped=threading.Event();self.thread=None;self.handle=None
        if os.name=='nt':
            import win32api,win32con,win32process
            self.handle=win32api.OpenProcess(win32con.SYNCHRONIZE|0x1000,False,self.pid)
            try:
                # Reject a recycled PID at attachment, then pin the checked process object.
                if win32process.GetProcessTimes(self.handle)['CreationTime']>win32process.GetProcessTimes(win32api.GetCurrentProcess())['CreationTime']:
                    raise ValueError('Foreground parent identity changed during startup')
            except Exception:
                self.handle.Close();self.handle=None;raise

    def alive(self):
        if self.stopped.is_set():return False
        if os.name=='nt':
            import win32event
            try:return win32event.WaitForSingleObject(self.handle,0)==win32event.WAIT_TIMEOUT
            except Exception:return False
        return os.getppid()==self.pid

    def start(self,renew,on_exit):
        self.on_exit=on_exit
        def monitor():
            while self.alive() and renew():
                if self.stopped.wait(15):return
            if not self.stopped.is_set():self.on_exit()
        self.thread=threading.Thread(target=monitor,name='pcrc-foreground',daemon=True)
        self.thread.start()

    def close(self):
        self.stopped.set()
        if self.thread and self.thread is not threading.current_thread():self.thread.join(timeout=1)
        if self.handle is not None:
            self.handle.Close();self.handle=None
