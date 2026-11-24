"""Control boundaries and real synthetic process/file/HTTP tests (no user desktop)."""
import hashlib
import json
import os
import sys
import time
from types import SimpleNamespace
from unittest.mock import Mock
import pytest
from starlette.testclient import TestClient
from jan_mcp_commander.control import ControlCommander, capabilities
from jan_mcp_commander.http_server import create_app, prepare_backend

@pytest.fixture
def control(tmp_path, monkeypatch):
    work = tmp_path/'work'; work.mkdir()
    monkeypatch.setenv('JAN_MCP_STATE_DIR',str(tmp_path/'private'))
    cmd = ControlCommander(work, enabled={'files','commands','browser','desktop'})
    yield cmd
    cmd.close_control()


def test_capabilities_and_expiry_deny_before_side_effects(control):
    with pytest.raises(ValueError): capabilities('all')
    control.expires = time.monotonic()-1
    for action in [lambda:control.run_command('echo blocked'), lambda:control.write_text('blocked.txt','bad'),
                   lambda:control.browser_action('open','https://example.com'),lambda:control.desktop_action('screenshot')]:
        with pytest.raises(ValueError,match='disabled or expired'): action()
    assert not list(control.workspace.iterdir())


def test_real_command_output_nonzero_timeout_and_no_ambient_secret(control, monkeypatch):
    monkeypatch.setenv('JAN_SYNTHETIC_SECRET','do-not-inherit')
    command = 'echo JAN_PROCESS_OK' if os.name=='nt' else "printf JAN_PROCESS_OK; exit 7"
    result=control.run_command(command)
    assert 'JAN_PROCESS_OK' in result['output']
    if os.name!='nt': assert result['exit_code']==7
    assert 'JAN_SYNTHETIC_SECRET' not in control._environment()
    # Python invocation is explicit; no subprocess consumes ambient PYTHONPATH.
    sleep = 'Start-Sleep -Seconds 10' if os.name=='nt' else 'sleep 10'
    result=control.run_command(sleep,timeout_seconds=1)
    assert result['timed_out'] and not control._sessions
    assert 'JAN_PROCESS_OK' not in control.audit_path.read_text()


def test_background_owned_process_stops(control):
    sleep = 'Start-Sleep -Seconds 10' if os.name=='nt' else 'sleep 10'
    info=control.start_process(sleep)
    assert info['max_runtime_seconds']==300
    assert control.list_sessions()['sessions'][0]['session_id']==info['session_id']
    proc=control._sessions[info['session_id']]['process']
    result=control.stop_session(info['session_id'])
    assert result['stopped']==info['session_id']
    # The public pid identifies the actual command child; the Popen handle
    # retained by PCRC supervises it and is reported separately.
    assert result['pid']==proc.pcrc_child_pid
    assert result['supervisor_pid']==proc.pid
    assert result['running'] is False
    assert result['exit_code']==proc.poll() and result['exit_code'] is not None
    assert result['session_retained'] is False
    with pytest.raises(ValueError): control.stop_session('not-owned')


def test_preview_hash_conflict_backup_and_search(control):
    control.write_text('example.txt','before\nsecond line\n')
    digest=hashlib.sha256((control.workspace/'example.txt').read_bytes()).hexdigest()
    preview=control.edit_text('example.txt','before','after',digest)
    assert preview['dry_run'] and (control.workspace/'example.txt').read_text().startswith('before')
    with pytest.raises(ValueError,match='File changed'):control.edit_text('example.txt','before','after','0'*64,False)
    result=control.edit_text('example.txt','before','after',digest,False)
    assert result['backup_id'] and control.search_text('after')['matches'][0]['line']==1
    control.restore_backup(result['backup_id'])
    assert (control.workspace/'example.txt').read_text().startswith('before')
    with pytest.raises(ValueError):control.write_text('../escape.txt','no')


def test_reviewed_move_and_delete_keep_recovery_backups(control):
    control.write_text('original.txt', 'synthetic file\n')
    digest=hashlib.sha256((control.workspace/'original.txt').read_bytes()).hexdigest()
    with pytest.raises(ValueError): control.move_text('original.txt', '../outside.txt', digest)
    with pytest.raises(ValueError): control.delete_text('original.txt', '0'*64)
    moved=control.move_text('original.txt', 'renamed.txt', digest)
    assert moved['backup_id'] and not (control.workspace/'original.txt').exists()
    assert (control.workspace/'renamed.txt').read_text()=='synthetic file\n'
    with pytest.raises(ValueError): control.move_text('renamed.txt', 'original.txt', '0'*64)
    deleted=control.delete_text('renamed.txt', digest)
    assert deleted['backup_id'] and not (control.workspace/'renamed.txt').exists()
    control.restore_backup(deleted['backup_id'])
    assert (control.workspace/'renamed.txt').read_text()=='synthetic file\n'


def test_read_scope_cannot_write_or_read_control_process_output(control):
    _, token, _ = prepare_backend(control.workspace, initialize=True)
    headers={'Authorization':'Bearer '+token,'Accept':'application/json, text/event-stream','Host':'localhost:8866'}
    with TestClient(create_app(control,token)) as client:
        for name,arguments in [('jan_write_text',{'path':'blocked.txt','content':'no'}),('jan_delete_text',{'path':'blocked.txt','expected_sha256':'0'*64}),('jan_move_text',{'source':'blocked.txt','destination':'other.txt','expected_sha256':'0'*64}),('jan_run_command',{'command':'echo no'}),('jan_session_output',{'session_id':'x'})]:
            msg={'jsonrpc':'2.0','id':1,'method':'tools/call','params':{'name':name,'arguments':arguments}}
            assert client.post('/mcp',json=msg,headers=headers).status_code==403
        for name in ['jan_inspect_desktop_controls','jan_interact_desktop_control']:
            msg={'jsonrpc':'2.0','id':1,'method':'tools/call','params':{'name':name,'arguments':{}}}
            assert client.post('/mcp',json=msg,headers=headers).status_code==403
        msg={'jsonrpc':'2.0','id':2,'method':'tools/call','params':{'name':'jan_write_text','arguments':{'path':'allowed.txt','content':'HTTP_CONTROL_OK'}}}
        response=client.post('/mcp',json=msg,headers={**headers,'X-JAN-Control':'1'})
        assert response.status_code==200 and not response.json()['result'].get('isError'),response.text
        assert (control.workspace/'allowed.txt').read_text()=='HTTP_CONTROL_OK'
        listing=client.post('/mcp',json={'jsonrpc':'2.0','id':3,'method':'tools/list'},headers=headers).json()
        assert {'jan_browser','jan_desktop','jan_edit_text','jan_move_text','jan_delete_text','jan_start_process'} <= {t['name'] for t in listing['result']['tools']}
        assert client.post('/mcp',json=[msg],headers=headers).status_code==400
    assert not (control.workspace/'blocked.txt').exists()


def test_browser_url_denied_before_import(control):
    for url in ['file:///etc/passwd','javascript:alert(1)','https://name:password@example.com','data:text/html,test']:
        with pytest.raises(ValueError,match='http'):control.browser_action('open',url)
    assert control._browser is None


def test_blank_new_tab_and_explicit_url_redaction(control):
    page = SimpleNamespace(on=Mock(), goto=Mock(), is_closed=lambda:False, url='about:blank', evaluate=Mock(return_value={'title':'test','text':'synthetic','elements':[]}))
    context = SimpleNamespace(new_page=Mock(return_value=page), close=Mock(), pages=[page])
    control._browser = (SimpleNamespace(stop=Mock()), SimpleNamespace(close=Mock()), context, page)
    control._browser_pages = {'original':page}
    result = control.browser_action('new_tab')
    page.goto.assert_called_once_with('about:blank',wait_until='domcontentloaded',timeout=10000)
    assert result['url'] == 'about:blank'
    assert result['url_parameters_redacted'] is False
    page.url = 'https://example.com/path?token=never-return-this#private'
    result = control.browser_action('snapshot')
    assert result['url'] == 'https://example.com/path'
    assert result['url_parameters_redacted'] is True
    assert 'never-return-this' not in json.dumps(result)


def test_desktop_wayland_denied_without_import(control,monkeypatch):
    monkeypatch.setattr(sys,'platform','linux')
    monkeypatch.setenv('XDG_SESSION_TYPE','wayland')
    monkeypatch.setenv('DISPLAY',':1')
    with pytest.raises(ValueError,match='Wayland'):control.desktop_action('click')


def test_native_desktop_requires_verified_foreground(control, monkeypatch):
    monkeypatch.setattr(sys, 'platform', 'linux')
    root = SimpleNamespace(get_full_property=Mock(return_value=SimpleNamespace(value=[42])))
    display = SimpleNamespace(screen=lambda: SimpleNamespace(root=root), intern_atom=Mock(return_value=1), close=Mock())
    monkeypatch.setitem(sys.modules, 'Xlib', SimpleNamespace(Xatom=SimpleNamespace(WINDOW=33)))
    monkeypatch.setitem(sys.modules, 'Xlib.display', SimpleNamespace(Display=lambda: display))
    assert control._foreground_window() == '42'
    root.get_full_property.return_value = SimpleNamespace(value=[0])
    with pytest.raises(ValueError, match='active Linux X11 window'):
        control._foreground_window()
    assert display.close.call_count == 2

    monkeypatch.setattr(sys, 'platform', 'darwin')
    monkeypatch.setitem(sys.modules, 'AppKit', SimpleNamespace(NSWorkspace=None))
    monkeypatch.setitem(sys.modules, 'Quartz', SimpleNamespace(CGPreflightScreenCaptureAccess=lambda: False))
    with pytest.raises(ValueError, match='Screen Recording and Accessibility'):
        control._foreground_window()


def test_desktop_adapter_bounds_failsafe_and_typing(control,monkeypatch):
    monkeypatch.setenv('XDG_SESSION_TYPE','x11');monkeypatch.setenv('DISPLAY',':1')
    ui=SimpleNamespace(size=lambda:(1920,1080),click=Mock(),write=Mock(),hotkey=Mock(),failSafeCheck=Mock(),KEYBOARD_KEYS=['ctrl','a'],platformModule=SimpleNamespace(keyboardMapping={'ctrl':17,'a':65}))
    native=Mock()
    monkeypatch.setattr('jan_mcp_commander.windows_input.press_hotkey',native)
    monkeypatch.setattr('jan_mcp_commander.windows_input.focused_window',lambda: 1)
    monkeypatch.setitem(sys.modules,'pyautogui',ui)
    with pytest.raises(ValueError,match='inside'): control.desktop_action('click',x=1920)
    monkeypatch.setattr(control,'_foreground_window',lambda:None)
    control._desktop_frame=('fixture',time.monotonic(),(1920,1080),None)
    control.desktop_action('click',x=25,y=30,frame_id='fixture',keys=[])
    ui.click.assert_called_once_with(25,30)
    assert ui.FAILSAFE
    with pytest.raises(ValueError):control.desktop_action('hotkey',keys=['bad'])
    with pytest.raises(ValueError):control.desktop_action('hotkey',keys=[])
    control._desktop_frame=('upper',time.monotonic(),(1920,1080),None,1)
    receipt=control.desktop_action('hotkey',keys=['CTRL','A'],frame_id='upper')
    assert receipt['dispatched']=='hotkey' and receipt['application_verified'] is False
    assert 'performed' not in receipt
    if os.name=='nt':
        native.assert_called_once_with([17,65]);ui.failSafeCheck.assert_called_once()
        ui.hotkey.assert_not_called()
    else:ui.hotkey.assert_called_once_with('ctrl','a')
    assert control._desktop_frame is None
    from jan_mcp_commander.errors import public_error
    control._desktop_frame=('bad',time.monotonic(),(1920,1080),None)
    with pytest.raises(ValueError) as denied:
        control.desktop_action('hotkey',keys=['UNKNOWN_KEY'],frame_id='bad')
    assert public_error(denied.value)['error_code']=='DESKTOP_KEYS_INVALID'
    assert native.call_count+ui.hotkey.call_count==1
    with pytest.raises(ValueError):control.desktop_action('type',text='hello\ncommand')
    if os.name=='nt':
        with pytest.raises(ValueError,match='1024'):control.desktop_action('type',text='A'*1025)


def test_control_can_be_disabled_and_does_not_reenable(control):
    assert not control.disable_control()['control_enabled']
    assert not control.status()['control_enabled']
    with pytest.raises(ValueError,match='disabled'):control.write_text('blocked.txt','no')
    control.close_control()  # Idempotent shutdown, including lifespan + CLI finally.


@pytest.mark.skipif(os.name!='nt',reason='Windows literal typing adapter')
def test_windows_typing_keeps_failsafe_consumes_frame_and_stops_on_focus_change(control,monkeypatch):
    import jan_mcp_commander.windows_input as windows_input
    ui=SimpleNamespace(size=lambda:(1920,1080),failSafeCheck=Mock(),write=Mock())
    monkeypatch.setitem(sys.modules,'pyautogui',ui)
    focus=[1];sent=[]
    monkeypatch.setattr(control,'_foreground_window',lambda:'test-window')
    def send(text):sent.append(text);focus[0]=2
    monkeypatch.setattr(windows_input,'focused_window',lambda:focus[0])
    monkeypatch.setattr(windows_input,'write_text',send)
    control._desktop_frame=('fixture',time.monotonic(),(1920,1080),'test-window',1)
    with pytest.raises(ValueError,match='input incomplete'):
        control.desktop_action('type',text='Abc '*16,frame_id='fixture')
    assert sent==['Abc '*8]
    assert ui.failSafeCheck.call_count==2
    assert control._desktop_frame is None
    ui.write.assert_not_called()


def test_http_screenshot_is_mcp_image_content(control,monkeypatch):
    from PIL import Image
    from jan_mcp_commander.control import jpeg
    monkeypatch.setattr(control,'desktop_action',lambda *args:jpeg(Image.new('RGB',(1920,1080),'white')))
    _,token,_=prepare_backend(control.workspace,initialize=True)
    h={'Authorization':'Bearer '+token,'X-JAN-Control':'1','Accept':'application/json, text/event-stream','Host':'localhost:8866'}
    with TestClient(create_app(control,token)) as client:
        response=client.post('/mcp',json={'jsonrpc':'2.0','id':1,'method':'tools/call','params':{'name':'jan_desktop','arguments':{'action':'screenshot'}}},headers=h)
        content=response.json()['result']['content']
        assert content[1]['type']=='image' and content[1]['mimeType']=='image/jpeg'
        assert json.loads(content[0]['text'])['screen_width']==1920


def test_process_stdin_and_output_pagination(control):
    import shlex
    code="import sys;print('READY',flush=True);line=input();print('GOT:'+line,flush=True)"
    if os.name=='nt':
        command='& "'+sys.executable+'" -I -u -c "'+code+'"'
    else:
        command=shlex.quote(sys.executable)+' -I -u -c '+shlex.quote(code)
    info=control.start_program(sys.executable,['-I','-u','-c',code],timeout_seconds=10)
    identifier=info['session_id']
    try:
        deadline=time.monotonic()+5
        while 'READY' not in control.process_output(identifier)['output'] and time.monotonic()<deadline:time.sleep(0.02)
        assert 'READY' in control.process_output(identifier)['output']
        assert control.process_input(identifier,'JAN_STDIN')['queued']
        control._sessions[identifier]['done'].wait(5)
        output=control.process_output(identifier,length=3)
        assert len(output['output'])==3 and output['next_offset']==3
        assert 'GOT:JAN_STDIN' in control.process_output(identifier)['output']
    finally:control.stop_session(identifier)


def test_module_entrypoint_keeps_control_class_identity(control,monkeypatch):
    """Exercise the launcher path rather than constructing the class directly."""
    import runpy
    import uvicorn
    from jan_mcp_commander import cloudflare
    monkeypatch.setattr(cloudflare,'require_standard_user',lambda:None)
    _,token,_=prepare_backend(control.workspace,initialize=True)
    observed=[]
    def inspect(service):
        h={'Authorization':'Bearer '+token,'X-JAN-Control':'1','Host':'localhost:8866','Accept':'application/json, text/event-stream'}
        with TestClient(service.config.app) as client:
            response=client.post('/mcp',headers=h,json={'jsonrpc':'2.0','id':1,'method':'tools/list'})
            tools=response.json()['result']['tools'];observed.extend(t['name'] for t in tools)
            result=client.post('/mcp',headers=h,json={'jsonrpc':'2.0','id':2,'method':'tools/call','params':{'name':'jan_write_text','arguments':{'path':'module-entry.txt','content':'MODULE_CONTROL_OK'}}})
            assert not result.json()['result'].get('isError'),result.text
    monkeypatch.setattr(uvicorn.Server,'run',inspect)
    monkeypatch.setattr(sys,'argv',['jan-mcp-control','--workspace',str(control.workspace),'--capabilities','files,commands','--transport','http'])
    with pytest.warns(RuntimeWarning,match='found in sys.modules'):
        with pytest.raises(SystemExit) as stopped:
            runpy.run_module('jan_mcp_commander.control',run_name='__main__')
    assert stopped.value.code==0
    assert len(observed)==58 and {'jan_inspect_development','jan_preview_development_change','jan_apply_development_change','jan_get_development_change','jan_inspect_desktop_controls','jan_interact_desktop_control','jan_inspect_document_pdf','jan_preview_document_workflow','jan_apply_document_workflow','jan_get_document_workflow','jan_inspect_office','jan_preview_spreadsheet','jan_edit_spreadsheet','jan_create_directory','jan_create_pdf','jan_run_command','jan_move_text','jan_delete_text','jan_coordinated_call','jan_browser_workflow','jan_list_applications','jan_open_application','jan_read_pdf','jan_rewrite_pdf','jan_inspect_media','jan_edit_media','jan_transcribe_audio','jan_prepare_media'} <= set(observed)
    assert (control.workspace/'module-entry.txt').read_text()=='MODULE_CONTROL_OK'


@pytest.mark.skipif(os.name!='nt', reason='Windows CMD bundled interpreter lookup')
def test_cmd_finds_runtime_python_without_ambient_path(control, monkeypatch):
    monkeypatch.setenv('PATH',r'C:\not-a-real-python-path')
    result=control.run_command('python -c "import sys; print(sys.executable)"',shell='cmd')
    assert result['exit_code']==0, result
    assert sys.executable.casefold() in result['output'].strip().casefold()
    assert 'not-a-real-python-path' not in control._environment()['PATH']


@pytest.mark.parametrize("amount", [-5, 0, 5])
def test_scroll_notches_map_to_platform_wheel_units(control, monkeypatch, amount):
    monkeypatch.setenv("XDG_SESSION_TYPE", "x11")
    monkeypatch.setenv("DISPLAY", ":1")
    ui = SimpleNamespace(size=lambda: (1920, 1080), moveTo=Mock(), scroll=Mock())
    monkeypatch.setitem(sys.modules, "pyautogui", ui)
    monkeypatch.setattr(control, "_foreground_window", lambda: None)
    control._desktop_frame = ("fixture", time.monotonic(), (1920, 1080), None)
    control.desktop_action("scroll", x=25, y=30, amount=amount, frame_id="fixture")
    ui.scroll.assert_called_once_with(amount * (120 if os.name == "nt" else 1))
    assert control._desktop_frame is None


@pytest.mark.skipif(os.name != "nt", reason="Windows executable lookup")
def test_powershell_finds_bundled_python_with_sanitized_environment(control, monkeypatch):
    monkeypatch.setenv("PATH", r"C:\untrusted-tools")
    monkeypatch.setenv("PATHEXT", ".CPL")
    monkeypatch.setenv("ComSpec", r"C:\untrusted-tools\cmd.exe")
    result = control.run_command('python -c "import sys; print(sys.executable)"', shell="powershell")
    assert result["exit_code"] == 0, result
    assert sys.executable.casefold() in result["output"].strip().casefold()
    env = control._environment()
    assert env["PATHEXT"] == ".COM;.EXE;.BAT;.CMD"
    assert "untrusted-tools" not in env["PATH"]
    assert "untrusted-tools" not in env["ComSpec"]


def test_create_directory_respects_workspace_and_existing_paths(control):
    assert control.create_directory('new') == {'path': 'new', 'created': True}
    assert (control.workspace / 'new').is_dir()
    with pytest.raises(FileExistsError):
        control.create_directory('new')
    with pytest.raises(FileNotFoundError):
        control.create_directory('missing/nested')
    with pytest.raises(ValueError):
        control.create_directory('../outside')
    assert not (control.workspace.parent / 'outside').exists()


@pytest.mark.skipif(os.name != 'nt', reason='PDF release preflight requires Windows AMSI/Defender')
def test_create_pdf_is_searchable_exclusive_and_workspace_confined(control):
    import io
    from pypdf import PdfReader
    marker = 'PCRC (review) 42 – café'
    result = control.create_pdf('new.pdf', marker)
    original = (control.workspace / 'new.pdf').read_bytes()
    assert result['page_count'] == 1
    assert marker in PdfReader(io.BytesIO(original)).pages[0].extract_text()
    with pytest.raises(FileExistsError):
        control.create_pdf('new.pdf', 'replacement')
    with pytest.raises(ValueError):
        control.create_pdf('../outside.pdf', marker)
    with pytest.raises(ValueError, match='Windows-1252'):
        control.create_pdf('unicode.pdf', '日本語')
    assert (control.workspace / 'new.pdf').read_bytes() == original
    assert not (control.workspace / 'unicode.pdf').exists()
