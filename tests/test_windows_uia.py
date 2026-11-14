import copy
import time
import pytest
from jan_mcp_commander.control import ControlCommander
from jan_mcp_commander.core import PermissionDenied
from jan_mcp_commander.windows_uia import UIAutomationError


@pytest.fixture
def uia(tmp_path, monkeypatch):
    monkeypatch.setenv('JAN_MCP_STATE_DIR',str(tmp_path/'state'))
    work=tmp_path/'files';work.mkdir()
    commander=ControlCommander(work,enabled={'desktop','files'})
    foreground=['10'];calls=[]
    raw={'window':{'title':'Synthetic app','handle':'10','process_id':123},'window_stamp':'root:1','visited':6,
         'controls':[{'name':'Save','role':'Button','enabled':True,'automation_id':'save','label':'','actions':['invoke'],'runtime_id':'1','stamp':'save:1'},
                     {'name':'Message','role':'Edit','enabled':True,'automation_id':'message','label':'','actions':['set_value'],'runtime_id':'2','stamp':'edit:1'}],
         'status_text':['Ready']}
    def query(request,check):
        check();calls.append(request)
        if request.get('action'):
            return {**copy.deepcopy(raw),'performed':True,'verification':'read_back','value_matches':True,'status_text':['Saved']}
        return copy.deepcopy(raw)
    monkeypatch.setattr(commander,'_foreground_window',lambda:foreground[0])
    monkeypatch.setattr('jan_mcp_commander.windows_uia.query',query)
    yield commander,raw,foreground,calls
    commander.close_control()


def test_fresh_identity_action_and_readback_never_return_private_fingerprints(uia):
    c,raw,_,calls=uia
    inspected=c.inspect_desktop_controls()
    assert inspected['method']=='windows_uia' and inspected['single_use']
    assert 'stamp' not in str(inspected) and 'runtime_id' not in str(inspected)
    target=inspected['controls'][1]
    result=c.interact_desktop_control(inspected['inspection_id'],target['control_id'],'set_value','PCRC_Ab9!')
    assert result['performed'] and result['value_matches'] and result['status_text']==['Saved']
    assert calls[-1]['runtime_id']=='2' and calls[-1]['stamp']=='edit:1'
    with pytest.raises(UIAutomationError,match='consumed'):c.interact_desktop_control(inspected['inspection_id'],target['control_id'],'set_value','again')
    assert len(calls)==2


@pytest.mark.parametrize('case',['foreground','expiry','missing','disabled','unsupported'])
def test_rejects_before_dispatch(uia,case):
    c,raw,foreground,calls=uia
    if case=='disabled':raw['controls'][0]['enabled']=False
    inspected=c.inspect_desktop_controls();identifier=inspected['controls'][0]['control_id'];action='invoke'
    if case=='foreground':foreground[0]='11'
    if case=='expiry':c._uia_inspection=(c._uia_inspection[0],time.monotonic()-31,*c._uia_inspection[2:])
    if case=='missing':identifier='Save'
    if case=='unsupported':action='set_value'
    with pytest.raises(UIAutomationError):c.interact_desktop_control(inspected['inspection_id'],identifier,action)
    assert len(calls)==1 and c._uia_inspection is None


def test_duplicate_names_require_distinct_ids_and_duplicate_runtime_is_rejected(uia):
    c,raw,_,calls=uia
    raw['controls'][1]['name']='Save'
    inspected=c.inspect_desktop_controls()
    assert len(set(v['control_id'] for v in inspected['controls']))==2
    with pytest.raises(UIAutomationError):c.interact_desktop_control(inspected['inspection_id'],'Save','invoke')
    raw['controls'][1]['runtime_id']='1'
    with pytest.raises(UIAutomationError,match='ambiguous'):c.inspect_desktop_controls()
    assert len(calls)==2


def test_protected_fields_labels_and_values_omitted_and_protected_input_rejected(uia):
    c,raw,_,calls=uia
    raw['controls'] += [{**raw['controls'][1],'name':'Password','runtime_id':'secret'},
                        {**raw['controls'][1],'label':'PIN','runtime_id':'pin'},
                        {**raw['controls'][1],'protected':True,'runtime_id':'hidden'}]
    raw['status_text']=['Ready','Password=hunter2']
    inspected=c.inspect_desktop_controls()
    assert len(inspected['controls'])==2 and inspected['status_text']==['Ready']
    with pytest.raises(ValueError):c.interact_desktop_control(inspected['inspection_id'],inspected['controls'][1]['control_id'],'set_value','password=hunter2')
    assert len(calls)==1


def test_unavailable_is_explicit_and_screenshot_fallback_never_inputs(uia,monkeypatch):
    c,_,_,_=uia
    def missing(*args):raise UIAutomationError('UIA_UNAVAILABLE','test')
    monkeypatch.setattr('jan_mcp_commander.windows_uia.query',missing)
    calls=[]
    monkeypatch.setattr(c,'desktop_action',lambda action: calls.append(action) or {'frame_id':'fresh','mime_type':'image/jpeg','data':'test'})
    assert c.inspect_desktop_controls()['fallback_tool']=='capture_desktop' and not calls
    result=c.inspect_desktop_controls(True)
    assert result['method']=='screenshot' and result['frame_id']=='fresh' and calls==['screenshot']
    assert c._uia_inspection is None


def test_file_dialog_never_issues_an_action_token_or_captures_implicitly(uia,monkeypatch):
    c,raw,_,calls=uia
    old=c.inspect_desktop_controls()
    raw['file_dialog']=True
    captures=[]
    monkeypatch.setattr(c,'desktop_action',lambda action: captures.append(action) or {'frame_id':'fresh'})
    dialog=c.inspect_desktop_controls()
    assert dialog['method']=='uia_unavailable' and dialog['fallback_tool']=='capture_desktop'
    assert 'file dialog' in dialog['reason'] and not dialog['controls']
    assert 'inspection_id' not in dialog and not captures
    with pytest.raises(UIAutomationError) as error:
        c.interact_desktop_control(old['inspection_id'],old['controls'][0]['control_id'],'invoke')
    assert error.value.code=='UIA_INSPECTION_REQUIRED' and not any(call.get('action') for call in calls)
    fallback=c.inspect_desktop_controls(True)
    assert fallback['method']=='screenshot' and fallback['uia_reason']==dialog['reason'] and captures==['screenshot']


def test_changed_worker_target_and_uncertain_action_consume_without_retry(uia,monkeypatch):
    c,_,_,calls=uia
    inspected=c.inspect_desktop_controls()
    def stale(*args):calls.append('worker');raise UIAutomationError('UIA_TARGET_CHANGED','test')
    monkeypatch.setattr('jan_mcp_commander.windows_uia.query',stale)
    with pytest.raises(UIAutomationError):c.interact_desktop_control(inspected['inspection_id'],inspected['controls'][0]['control_id'],'invoke')
    with pytest.raises(UIAutomationError):c.interact_desktop_control(inspected['inspection_id'],inspected['controls'][0]['control_id'],'invoke')
    assert calls.count('worker')==1


def test_local_capability_and_ui_reservation_apply(uia):
    from jan_mcp_commander.coordination import coordinator
    c,_,_,calls=uia
    task=coordinator(c).task('create',title='Synthetic owner')
    coordinator(c).task('claim',task_id=task['id'],agent='Owner',resources=['ui'])
    with pytest.raises(ValueError,match='reserved'):c.inspect_desktop_controls()
    c.enabled=frozenset({'files'})
    with pytest.raises(PermissionDenied):c.interact_desktop_control('0'*32,'0'*32,'invoke')
    assert not calls


def test_worker_permission_heartbeat_does_not_charge_tool_rate_quota(uia,monkeypatch):
    c,raw,_,_=uia
    def heartbeat(request,check):
        for _ in range(150):check()
        return copy.deepcopy(raw)
    monkeypatch.setattr('jan_mcp_commander.windows_uia.query',heartbeat)
    assert c.inspect_desktop_controls()['method']=='windows_uia'
    assert len(c._requests)==1
    c._disabled=True
    with pytest.raises(PermissionDenied):c._require_capability('desktop')


def test_screenshot_invalidates_uia_and_requires_its_own_one_use_frame(uia,monkeypatch):
    import sys
    from types import SimpleNamespace
    from unittest.mock import Mock
    from PIL import Image
    c,_,_,_=uia
    ui=SimpleNamespace(size=lambda:(100,100),screenshot=lambda:Image.new('RGB',(100,100)),click=Mock())
    monkeypatch.setitem(sys.modules,'pyautogui',ui)
    state=c.inspect_desktop_controls()
    frame=c.desktop_action('screenshot')
    assert frame['method']=='screenshot'
    with pytest.raises(UIAutomationError):c.interact_desktop_control(state['inspection_id'],state['controls'][0]['control_id'],'invoke')
    assert not ui.click.called
    # A rejected cross-method action invalidates the screenshot too: inspect again.
    with pytest.raises(PermissionDenied):c.desktop_action('click',10,10,frame_id=frame['frame_id'])


@pytest.mark.parametrize('acting',[False,True])
def test_worker_deadline_kills_once_without_input_replay(monkeypatch,acting):
    import subprocess
    from types import SimpleNamespace
    import jan_mcp_commander.windows_uia as module
    inputs=[];killed=[]
    class Process:
        returncode=None
        def poll(self):return 0 if killed else None
        def kill(self):killed.append(True)
        def communicate(self,payload=None,timeout=None):
            inputs.append(payload)
            if killed:return b'',b''
            raise subprocess.TimeoutExpired('synthetic',timeout)
    monkeypatch.setattr(module.subprocess,'Popen',lambda *args,**kwargs:Process())
    ticks=iter([0,1,9])
    monkeypatch.setattr(module,'time',SimpleNamespace(monotonic=lambda:next(ticks)))
    with pytest.raises(UIAutomationError) as error:module.query({'handle':'1',**({'action':'invoke'} if acting else {})},lambda:None)
    assert error.value.code==('UIA_ACTION_UNCERTAIN' if acting else 'UIA_UNAVAILABLE')
    assert killed==[True] and inputs[0] is not None and inputs[1] is None
