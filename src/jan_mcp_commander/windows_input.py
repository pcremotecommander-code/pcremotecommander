"""Literal Windows text input without keyboard-layout or Shift timing conversion."""
import ctypes
import time
from ctypes import wintypes
from .core import PermissionDenied


def write_text(text):
    if not text:
        return
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
    for char in text:
        events=(Input*2)()
        for released in (0,1):
            event=events[released]
            event.type=1
            event.payload.keyboard=Keyboard(0,ord(char),0x0004|(0x0002 if released else 0),0,0)
        if send(2,events,ctypes.sizeof(Input))!=2:
            raise PermissionDenied('Desktop text input incomplete; inspect actual text before continuing. Do not replay automatically.')
        # Modern Windows editors need each VK_PACKET consumed before the next character.
        time.sleep(0.01)
