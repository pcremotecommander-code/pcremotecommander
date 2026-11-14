import ctypes
import os
from types import SimpleNamespace
import pytest
from jan_mcp_commander.windows_input import write_text
from jan_mcp_commander.core import PermissionDenied
from jan_mcp_commander.errors import public_error


@pytest.mark.skipif(os.name!='nt',reason='Windows INPUT ABI')
@pytest.mark.parametrize('partial',[False,True])
def test_literal_input_preserves_case_without_shift_and_never_retries_partial(monkeypatch,partial):
    calls=[]
    text=' PCRC_Ab9!'
    class Send:
        def __call__(self,count,events,size):
            calls.append(count)
            assert size==(40 if ctypes.sizeof(ctypes.c_void_p)==8 else 28)
            assert [e.type for e in events]==[1]*count
            assert [e.payload.keyboard.scan for e in events]==[ord(text[len(calls)-1])]*2
            assert [e.payload.keyboard.flags for e in events]==[4,6]
            assert all(e.payload.keyboard.vk==0 for e in events)
            return count-1 if partial else count
    monkeypatch.setattr(ctypes,'WinDLL',lambda *a,**kw:SimpleNamespace(SendInput=Send()))
    if partial:
        with pytest.raises(PermissionDenied) as error:write_text(text)
        assert public_error(error.value)['error_code']=='DESKTOP_INPUT_UNCERTAIN'
    else:write_text(text)
    assert calls==[2]*(1 if partial else len(text))


@pytest.mark.skipif(os.name!='nt',reason='Windows INPUT ABI')
def test_maximum_keyboard_step_has_bounded_dispatch_pacing(monkeypatch):
    import jan_mcp_commander.windows_input as module
    pauses=[]
    class Send:
        def __call__(self,count,*args):return count
    monkeypatch.setattr(ctypes,'WinDLL',lambda *a,**kw:SimpleNamespace(SendInput=Send()))
    monkeypatch.setattr(module.time,'sleep',pauses.append)
    write_text('A'*1024)
    assert len(pauses)==1024
    assert sum(pauses)==pytest.approx(10.24)
