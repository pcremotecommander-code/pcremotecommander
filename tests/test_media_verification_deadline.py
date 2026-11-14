"""Codec integrity verification stays complete but cannot exhaust the relay window."""
import hashlib
import json
from pathlib import Path
from types import SimpleNamespace
import threading

import pytest

from jan_mcp_commander import media_install,media_tools


def test_asset_verification_overlaps_slow_opens_with_at_most_four_workers(tmp_path,monkeypatch):
    files=[tmp_path/f'asset-{i}.bin' for i in range(8)]
    for path in files:path.write_bytes(b'synthetic codec bytes')
    raw=json.dumps({p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in files}).encode()
    (tmp_path/'FILES.json').write_bytes(raw)
    barrier=threading.Barrier(4);lock=threading.Lock();active=0;peak=0;opened=[];original=Path.open
    def slow_open(path,*args,**kwargs):
        nonlocal active,peak
        if path not in files:return original(path,*args,**kwargs)
        with lock:active+=1;peak=max(peak,active);opened.append(path.name)
        try:
            barrier.wait(timeout=2)
            return original(path,*args,**kwargs)
        finally:
            with lock:active-=1
    monkeypatch.setattr(Path,'open',slow_open)
    assert media_install.verify(tmp_path,{'manifest_sha256':hashlib.sha256(raw).hexdigest()})==tmp_path
    assert peak==4 and sorted(opened)==sorted(p.name for p in files)


def test_parallel_verification_still_rejects_a_changed_asset(tmp_path):
    files=[tmp_path/f'asset-{i}.bin' for i in range(8)]
    for path in files:path.write_bytes(b'synthetic codec bytes')
    raw=json.dumps({p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in files}).encode()
    (tmp_path/'FILES.json').write_bytes(raw);files[-1].write_bytes(b'tampered synthetic codec')
    with pytest.raises(ValueError,match='Media assets changed'):
        media_install.verify(tmp_path,{'manifest_sha256':hashlib.sha256(raw).hexdigest()})


def test_runtime_tree_rejects_reparse_directories_before_traversal(tmp_path,monkeypatch):
    import stat
    from contextlib import nullcontext
    payload=tmp_path/'module.py';payload.write_bytes(b'synthetic')
    raw=json.dumps({'module.py':hashlib.sha256(payload.read_bytes()).hexdigest()}).encode()
    (tmp_path/'FILES.json').write_bytes(raw)
    link=SimpleNamespace(stat=lambda **kwargs:SimpleNamespace(st_mode=stat.S_IFDIR,st_file_attributes=0x400))
    calls=[]
    def scan(path):calls.append(path);return nullcontext(iter([link]))
    monkeypatch.setattr(media_install.os,'scandir',scan)
    with pytest.raises(ValueError,match='Media assets changed'):
        media_install.verify(tmp_path,{'manifest_sha256':hashlib.sha256(raw).hexdigest()})
    assert calls==[tmp_path]


def test_slow_asset_hashing_stops_before_reading_entire_runtime(tmp_path,monkeypatch):
    payload=tmp_path/'synthetic-codec.bin';payload.write_bytes(b'x'*(8*1024*1024))
    raw=json.dumps({payload.name:hashlib.sha256(payload.read_bytes()).hexdigest()}).encode()
    (tmp_path/'FILES.json').write_bytes(raw);item={'manifest_sha256':hashlib.sha256(raw).hexdigest()}
    clock=[0.0];reads=[];original=Path.open
    monkeypatch.setattr(media_install,'time',SimpleNamespace(monotonic=lambda:clock[0]))
    class SlowRead:
        def __init__(self,stream):self.stream=stream
        def __enter__(self):return self
        def __exit__(self,*args):self.stream.close()
        def read(self,size):
            data=self.stream.read(size);clock[0]+=.02;reads.append(len(data));return data
    def opened(path,*args,**kwargs):
        stream=original(path,*args,**kwargs)
        return SlowRead(stream) if path==payload else stream
    monkeypatch.setattr(Path,'open',opened)
    with pytest.raises(ValueError,match='Media verification timed out') as caught:
        media_install.verify(tmp_path,item,deadline=.03)
    from jan_mcp_commander.errors import public_error
    assert public_error(caught.value)['error_code']=='MEDIA_VERIFICATION_TIMEOUT'
    assert sum(reads)<payload.stat().st_size
    assert max(reads)<=1024*1024


def test_processing_budget_reaches_verification_before_input_or_codec_execution(tmp_path,monkeypatch):
    def verify(path,item,*,deadline=None):
        assert deadline==123.0
        raise ValueError('Media verification timed out; no output saved')
    def forbidden(*args,**kwargs):pytest.fail('No input snapshot or codec must start after verification timed out')
    monkeypatch.setattr(media_tools,'verify',verify)
    monkeypatch.setattr(media_tools,'snapshot',forbidden)
    monkeypatch.setattr(media_tools.subprocess,'run',forbidden)
    with pytest.raises(ValueError,match='Media verification timed out'):
        media_tools.process_media(None,tmp_path,'synthetic.mp4','inspect','video',deadline=123.0)
