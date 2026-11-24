import os,sys,time,json
from types import SimpleNamespace
from unittest.mock import Mock
import pytest
from jan_mcp_commander.control import ControlCommander
from jan_mcp_commander.cloudflare import clean_environment
from jan_mcp_commander.errors import public_error

@pytest.fixture
def cmd(tmp_path,monkeypatch):
    work=tmp_path/'work';work.mkdir();monkeypatch.setenv('JAN_MCP_STATE_DIR',str(tmp_path/'private'))
    control=ControlCommander(work,enabled={'files','commands','browser','desktop'})
    yield control
    control.close_control()

def test_runtime_environment_without_secrets(cmd,monkeypatch):
    for name in ['USERPROFILE','TEMP','TMP','ProgramFiles','ProgramFiles(x86)']:monkeypatch.setenv(name,'synthetic-os-path')
    for name in ['API_TOKEN','GITHUB_CLIENT_SECRET','PYTHONPATH','HTTPS_PROXY']:monkeypatch.setenv(name,'do-not-inherit')
    for env in [cmd._environment(),clean_environment()]:
        assert all(name.upper() in {key.upper() for key in env} for name in ['USERPROFILE','TEMP','TMP','ProgramFiles','ProgramFiles(x86)'])
        assert not any(name in env for name in ['API_TOKEN','GITHUB_CLIENT_SECRET','PYTHONPATH','HTTPS_PROXY'])

def test_completed_jobs_not_counted_as_running_and_history_bounded(cmd):
    for i in range(20):
        info=cmd.start_program(sys.executable,['-I','-c','print(1)'],timeout_seconds=5)
        assert cmd._sessions[info['session_id']]['done'].wait(5)
    assert len(cmd._sessions)<=16

    # Arbitrary shell commands reserve the whole workspace. A second command
    # must wait until the first is stopped; allowing four concurrent commands
    # would reintroduce uncoordinated workspace writes.
    active=cmd.start_program(sys.executable,['-I','-c','import time;time.sleep(20)'],timeout_seconds=20)
    with pytest.raises(ValueError,match='owned command is still running'):
        cmd.start_program(sys.executable,['-V'])
    assert not cmd._sessions[active['session_id']]['done'].is_set()
    cmd.stop_session(active['session_id'])

    # Once the owned command has fully stopped, the workspace reservation is
    # released and another command can start normally.
    next_job=cmd.start_program(sys.executable,['-I','-c','print(2)'],timeout_seconds=5)
    assert cmd._sessions[next_job['session_id']]['done'].wait(5)

def test_safe_public_errors_never_reflect_payloads():
    secret='synthetic token and command'
    result=public_error(OSError(secret));assert secret not in json.dumps(result)
    assert result['error_code']=='RESOURCE_UNAVAILABLE'

def test_desktop_frames_consumed_expired_and_focus_changed(cmd,monkeypatch):
    from PIL import Image
    monkeypatch.setenv('XDG_SESSION_TYPE','x11');monkeypatch.setenv('DISPLAY',':1')
    ui=SimpleNamespace(size=lambda:(1920,1080),screenshot=lambda:Image.new('RGB',(1920,1080)),click=Mock(),write=Mock(),hotkey=Mock(),KEYBOARD_KEYS=['ctrl','a'])
    monkeypatch.setitem(sys.modules,'pyautogui',ui)
    monkeypatch.setattr(cmd,'_foreground_window',lambda:'owned-window')
    with pytest.raises(ValueError,match='frame'):cmd.desktop_action('click',x=10,y=20)
    frame=cmd.desktop_action('screenshot');assert frame['screen_width']==1920
    cmd.desktop_action('click',x=10,y=20,frame_id=frame['frame_id']);ui.click.assert_called_once_with(10,20)
    with pytest.raises(ValueError):cmd.desktop_action('click',x=10,y=20,frame_id=frame['frame_id'])
    frame=cmd.desktop_action('screenshot');monkeypatch.setattr(cmd,'_foreground_window',lambda:'different-window')
    with pytest.raises(ValueError,match='foreground'):cmd.desktop_action('click',x=10,y=20,frame_id=frame['frame_id'])
    monkeypatch.setattr(cmd,'_foreground_window',lambda:'owned-window')
    frame=cmd.desktop_action('screenshot')
    identifier,_,*target=cmd._desktop_frame
    cmd._desktop_frame=(identifier,time.monotonic()-31,*target)
    with pytest.raises(ValueError):cmd.desktop_action('click',x=10,y=20,frame_id=frame['frame_id'])
    assert ui.click.call_count==1 and ui.FAILSAFE
