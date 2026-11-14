"""Scan exact bytes through Windows AMSI; no administrative elevation or exclusions."""
import ctypes
from ctypes import wintypes as w
import json
import sys

if __name__ == '__main__':
    api = ctypes.WinDLL('amsi.dll', winmode=0x00000800)
    context = ctypes.c_void_p()
    session = ctypes.c_void_p()
    verdict = w.DWORD(32768)
    api.AmsiInitialize.argtypes = [w.LPCWSTR, ctypes.POINTER(ctypes.c_void_p)]
    api.AmsiInitialize.restype = ctypes.c_long
    api.AmsiOpenSession.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p)]
    api.AmsiOpenSession.restype = ctypes.c_long
    api.AmsiScanBuffer.argtypes = [ctypes.c_void_p, ctypes.c_void_p, w.ULONG, w.LPCWSTR, ctypes.c_void_p, ctypes.POINTER(w.DWORD)]
    api.AmsiScanBuffer.restype = ctypes.c_long
    api.AmsiCloseSession.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    api.AmsiUninitialize.argtypes = [ctypes.c_void_p]
    hr = -1
    try:
        data = sys.stdin.buffer.read(160 * 1024 * 1024 + 1)
        if not data or len(data) > 160 * 1024 * 1024:
            raise ValueError('Invalid scan size')
        if api.AmsiInitialize('PC Remote Commander', ctypes.byref(context)) != 0:
            raise ValueError('AMSI initialization failed')
        if api.AmsiOpenSession(context, ctypes.byref(session)) != 0:
            raise ValueError('AMSI session failed')
        buffer = ctypes.create_string_buffer(data)
        hr = api.AmsiScanBuffer(context, buffer, len(data), 'pcrc-snapshot'+sys.argv[1], session, ctypes.byref(verdict))
    finally:
        if session:
            api.AmsiCloseSession(context, session)
        if context:
            api.AmsiUninitialize(context)
    print(json.dumps({'hresult': hr, 'result': verdict.value}))
