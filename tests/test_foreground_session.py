"""Foreground lifetime is local parent-bound; explicit timed grants remain bounded."""
import inspect
import os
import time

import pytest

from jan_mcp_commander.control import ControlCommander


def test_foreground_mode_is_explicitly_available():
    assert 'foreground' in inspect.signature(ControlCommander).parameters


def test_foreground_renews_only_while_parent_alive(tmp_path,monkeypatch):
    from jan_mcp_commander import foreground as module
    class Parent:
        running=True
        def alive(self):return self.running
        def start(self,renew,callback):self.callback=callback
        def close(self):pass
    parent=Parent();monkeypatch.setattr(module,'ParentSession',lambda owner=None:parent)
    monkeypatch.setenv('JAN_MCP_STATE_DIR',str(tmp_path/'state'));root=tmp_path/'files';root.mkdir()
    cmd=ControlCommander(root,enabled={'files'},foreground=True)
    try:
        cmd.expires=time.monotonic()-1
        assert cmd.status()['control_enabled']
        assert cmd.status()['connection_lifetime']=='until terminal closes'
        parent.running=False
        with pytest.raises(ValueError):cmd._check('files')
        assert not cmd.status()['control_enabled']
        parent.running=True
        with pytest.raises(ValueError):cmd._check('files')
    finally:cmd.close_control()


def test_explicit_time_limit_does_not_renew(tmp_path,monkeypatch):
    monkeypatch.setenv('JAN_MCP_STATE_DIR',str(tmp_path/'state'));root=tmp_path/'files';root.mkdir()
    cmd=ControlCommander(root,enabled={'files'},duration_minutes=1)
    try:
        cmd.expires=time.monotonic()-1
        assert not cmd.status()['control_enabled']
        with pytest.raises(ValueError):cmd._check('files')
    finally:cmd.close_control()


@pytest.mark.skipif(os.name!='nt',reason='Windows process identity attachment')
def test_recycled_parent_pid_is_rejected_at_attachment(monkeypatch):
    import win32api,win32process
    from jan_mcp_commander.foreground import ParentSession
    class Handle:
        closed=False
        def Close(self):self.closed=True
    handle=Handle();current=object()
    monkeypatch.setattr(win32api,'OpenProcess',lambda *args:handle)
    monkeypatch.setattr(win32api,'GetCurrentProcess',lambda:current)
    monkeypatch.setattr(win32process,'GetProcessTimes',lambda h:{'CreationTime':2 if h is handle else 1})
    with pytest.raises(ValueError,match='identity changed'):ParentSession(123)
    assert handle.closed


@pytest.mark.skipif(os.name!='nt',reason='Windows venv redirector protection')
def test_ambiguous_venv_parent_is_rejected(monkeypatch):
    import sys
    from jan_mcp_commander.foreground import ParentSession
    monkeypatch.setattr(sys,'executable','C:/venv/Scripts/python.exe')
    monkeypatch.setattr(sys,'_base_executable','C:/Python/python.exe')
    with pytest.raises(ValueError,match='owner process'):ParentSession()
