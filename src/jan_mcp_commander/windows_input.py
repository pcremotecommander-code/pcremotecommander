"""Bounded Windows keyboard input with correct Unicode and extended-key flags."""
import ctypes
import time
from ctypes import wintypes
from .core import PermissionDenied


def _input_api():
    class Keyboard(ctypes.Structure):
        _fields_=[('vk',wintypes.WORD),('scan',wintypes.WORD),('flags',wintypes.DWORD),('time',wintypes.DWORD),('extra',ctypes.c_size_t)]
    class Mouse(ctypes.Structure):
        _fields_=[('x',wintypes.LONG),('y',wintypes.LONG),('data',wintypes.DWORD),('flags',wintypes.DWORD),('time',wintypes.DWORD),('extra',ctypes.c_size_t)]
    class Hardware(ctypes.Structure):
        _fields_=[('message',wintypes.DWORD),('low',wintypes.WORD),('high',wintypes.WORD)]
    class Payload(ctypes.Union):
        _fields_=[('keyboard',Keyboard),('mouse',Mouse),('hardware',Hardware)]
    class Input(ctypes.Structure):
        _fields_=[('type',wintypes.DWORD),('payload',Payload)]
    send=ctypes.WinDLL('user32',use_last_error=True).SendInput
    send.argtypes=[wintypes.UINT,ctypes.POINTER(Input),ctypes.c_int]
    send.restype=wintypes.UINT
    return Input, Keyboard, send


def write_text(text):
    if not text:
        return
    Input,Keyboard,send=_input_api()
    for char in text:
        encoded = char.encode('utf-16-le')
        units = [int.from_bytes(encoded[i:i+2], 'little') for i in range(0, len(encoded), 2)]
        events = (Input * (2 * len(units)))()
        for index, event in enumerate(events):
            event.type=1
            event.payload.keyboard=Keyboard(0,units[index//2],0x0004|(0x0002 if index%2 else 0),0,0)
        count = send(len(events), events, ctypes.sizeof(Input))
        if count != len(events):
            if 0 < count < len(events) and count % 2:
                release = (Input * 1)(events[count])
                send(1, release, ctypes.sizeof(Input))
            raise PermissionDenied('Desktop text input incomplete; inspect actual text before continuing. Do not replay automatically.')
        # Modern Windows editors need each VK_PACKET consumed before the next character.
        time.sleep(0.01)


def press_hotkey(codes):
    if (not isinstance(codes,list) or not 1<=len(codes)<=4 or
            any(type(code) is not int or not 0<code<0x800 or not (code&0xff) for code in codes)):
        raise PermissionDenied('Invalid Windows key combination')
    keys=[]
    for code in codes:
        modifiers,key=divmod(code,256)
        for mask,modifier in ((4,0x12),(2,0x11),(1,0x10)):
            if modifiers&mask and modifier not in keys:keys.append(modifier)
        keys.append(key)
    Input,Keyboard,send=_input_api()
    mapping=ctypes.WinDLL('user32',use_last_error=True).MapVirtualKeyW
    mapping.argtypes=[wintypes.UINT,wintypes.UINT];mapping.restype=wintypes.UINT
    events=(Input*(len(keys)*2))()
    for index,(key,released) in enumerate([(key,False) for key in keys]+[(key,True) for key in reversed(keys)]):
        scan=mapping(key,4)
        # Navigation keys must identify their E0 prefix, not the NumLock keypad equivalents.
        extended=(scan&0xff00)==0xe000 or key in {0x21,0x22,0x23,0x24,0x25,0x26,0x27,0x28,0x2D,0x2E,0x5B,0x5C,0x5D,0x6F,0x90,0xA3,0xA5}
        use_scan = bool(scan & 0xff) and (scan & 0xff00) in {0, 0xe000}
        flags=(8 if use_scan else 0)|(1 if extended else 0)|(2 if released else 0)
        events[index].type=1
        events[index].payload.keyboard=Keyboard(0 if use_scan else key,scan&0xff,flags,0,0)
    if send(len(events),events,ctypes.sizeof(Input))!=len(events):
        releases=(Input*len(keys))(*events[len(keys):])
        try:send(len(releases),releases,ctypes.sizeof(Input))
        finally:
            raise PermissionDenied('Desktop text input incomplete; key release attempted. Inspect actual state before continuing. Do not replay automatically.')


def focused_window():
    class GuiThreadInfo(ctypes.Structure):
        _fields_ = [('size', wintypes.DWORD), ('flags', wintypes.DWORD)] + [
            (name, wintypes.HWND) for name in ('active', 'focus', 'capture', 'menu', 'move', 'caret')
        ] + [('caret_rect', wintypes.RECT)]

    info = GuiThreadInfo()
    info.size = ctypes.sizeof(info)
    query = ctypes.WinDLL('user32', use_last_error=True).GetGUIThreadInfo
    query.argtypes = [wintypes.DWORD, ctypes.POINTER(GuiThreadInfo)]
    query.restype = wintypes.BOOL
    return info.focus if query(0, ctypes.byref(info)) else None
