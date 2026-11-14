import hashlib
import io
import json
import subprocess
import wave
from pathlib import Path

from PIL import Image
import pytest

from jan_mcp_commander import media_tools as media
from jan_mcp_commander.safe_fs import SafeTree


def test_edited_image_metadata_describes_the_saved_copy():
    import base64
    from jan_mcp_commander._media_worker import image_work
    data=io.BytesIO();Image.new('RGB',(100,60),'blue').save(data,format='PNG')
    result=image_work(data.getvalue(),{'action':'edit','rotation':90,'width':30,'height':50})
    with Image.open(io.BytesIO(base64.b64decode(result['data']))) as saved:
        assert (result['width'],result['height'],result['format'])==(*saved.size,saved.format)
        assert saved.size==(30,50)


def test_image_resize_enlarges_to_requested_bounds_and_preserves_aspect():
    import base64
    from jan_mcp_commander._media_worker import image_work
    data=io.BytesIO();Image.new('RGB',(64,48),'blue').save(data,format='PNG')
    result=image_work(data.getvalue(),{'action':'edit','rotation':0,'width':128,'height':96})
    with Image.open(io.BytesIO(base64.b64decode(result['data']))) as saved:
        assert saved.size==(128,96)
        assert (result['width'],result['height'])==saved.size


def test_two_complex_previews_fit_existing_relay_response_limit():
    import numpy as np
    from jan_mcp_commander._media_worker import preview
    image=Image.fromarray(np.random.default_rng(7).integers(0,256,size=(800,1280,3),dtype=np.uint8))
    images=[preview(image.copy()),preview(image.copy())]
    assert len(json.dumps({'result':{'content':images}}).encode())<1024*1024


def test_image_read_edit_bounded_original_preserved(tmp_path,monkeypatch):
    image=Image.new('RGB',(400,200),'green');out=io.BytesIO();image.save(out,format='PNG')
    data=out.getvalue();(tmp_path/'image.png').write_bytes(data)
    monkeypatch.setattr(media,'scan_bytes',lambda data, **kwargs: {'result':'synthetic_clean'})
    value=media.process_media(SafeTree(tmp_path),tmp_path,'image.png','inspect','image',width=100,height=100)
    assert (value['width'],value['height'])==(400,200)
    assert value['images'][0]['mimeType']=='image/jpeg'
    result=media.process_media(SafeTree(tmp_path),tmp_path,'image.png','edit','image',width=100,height=100)
    with Image.open(io.BytesIO(result['bytes'])) as saved:assert saved.size==(100,50)
    assert (tmp_path/'image.png').read_bytes()==data


def test_media_bounds_and_scanner_fail_closed(tmp_path,monkeypatch):
    for kwargs in [{'seconds':31},{'seconds':float('nan')},{'start':-1},{'width':True},{'rotation':45}]:
        with pytest.raises(ValueError):media.options(tmp_path,'inspect','image',**kwargs)
    (tmp_path/'sample.png').write_bytes(b'synthetic')
    def deny(data, **kwargs):raise ValueError('scan unavailable')
    monkeypatch.setattr(media,'scan_bytes',deny)
    with pytest.raises(ValueError,match='scan unavailable'):
        media.process_media(SafeTree(tmp_path),tmp_path,'sample.png','inspect','image')
    with pytest.raises(ValueError):media.snapshot(SafeTree(tmp_path),'../outside.wav')


def test_media_timeout_never_saves_partial_output(tmp_path,monkeypatch):
    (tmp_path/'image.png').write_bytes(b'synthetic')
    monkeypatch.setattr(media,'scan_bytes',lambda data, **kwargs:{'result':'synthetic_clean'})
    def timeout(*args,**kwargs):raise subprocess.TimeoutExpired(args[0],45)
    monkeypatch.setattr(media.subprocess,'run',timeout)
    with pytest.raises(ValueError,match='timed out'):
        media.process_media(SafeTree(tmp_path),tmp_path,'image.png','edit','image')


@pytest.mark.parametrize('kind',['pdf','image'])
@pytest.mark.parametrize('revoke',['disabled','expired'])
def test_long_parser_cannot_commit_after_control_revocation(tmp_path,monkeypatch,kind,revoke):
    import time
    from jan_mcp_commander.control import ControlCommander
    monkeypatch.setenv('JAN_MCP_STATE_DIR',str(tmp_path/'private'))
    work=tmp_path/'work';work.mkdir();cmd=ControlCommander(work,enabled={'files'})
    def parsed(*args,**kwargs):
        if revoke=='disabled':cmd._disabled=True
        else:cmd.expires=time.monotonic()-1
        return {'bytes':b'synthetic','sha256':'a'*64,'page_count':1}
    monkeypatch.setattr(media,'process_media',parsed)
    monkeypatch.setattr('jan_mcp_commander.pdf_tools.process_pdf',parsed)
    try:
        with pytest.raises(ValueError,match='disabled or expired'):
            if kind=='pdf':cmd.rewrite_pdf('source.pdf','new.pdf','a'*64,[1])
            else:cmd.edit_media('source.png','new.jpg','image','a'*64)
        assert not list(work.iterdir())
    finally:cmd.close_control()


def test_binary_commit_rechecks_after_backup_and_operation_deadline(tmp_path,monkeypatch):
    import time
    from jan_mcp_commander.control import ControlCommander
    monkeypatch.setenv('JAN_MCP_STATE_DIR',str(tmp_path/'private'))
    work=tmp_path/'work';work.mkdir();(work/'existing.jpg').write_bytes(b'original')
    cmd=ControlCommander(work,enabled={'files'})
    try:
        with pytest.raises(ValueError,match='deadline'):
            cmd._write_binary('new.jpg',b'new',deadline=time.monotonic()-1)
        assert not (work/'new.jpg').exists()
        def revoke(*args,**kwargs):cmd._disabled=True;return 'synthetic-backup'
        monkeypatch.setattr(cmd._store,'backup',revoke)
        with pytest.raises(ValueError,match='disabled or expired'):
            cmd._write_binary('existing.jpg',b'new',overwrite=True)
        assert (work/'existing.jpg').read_bytes()==b'original'
    finally:cmd.close_control()


@pytest.mark.parametrize(('format','codec'),[('flac','flac'),('mp3','libmp3lame')])
def test_compressed_audio_formats_decode_locally(format,codec):
    import av
    import numpy as np
    output=io.BytesIO()
    with av.open(output,'w',format=format) as container:
        stream=container.add_stream(codec,rate=16000);stream.layout='mono'
        frame=av.AudioFrame.from_ndarray((np.sin(np.arange(16000)*2*np.pi*440/16000)*8000).astype('<i2').reshape(1,-1),format='s16',layout='mono')
        frame.sample_rate=16000
        for packet in stream.encode(frame):container.mux(packet)
        for packet in stream.encode():container.mux(packet)
    opts={'kind':'audio','action':'inspect','runtime':str(Path(media.__file__).parents[2]/'.venv/Lib/site-packages'),
        'start':0,'seconds':0.5,'width':100,'height':100,'rotation':0}
    done=subprocess.run(media.worker_args(opts),input=output.getvalue(),capture_output=True,timeout=45,env=media.worker_environment())
    result=json.loads(done.stdout);assert 'error' not in result,result
    assert 0.4<=result['seconds']<=0.5 and result['peak']>0.1


def test_audio_codec_read_and_trim_without_network(tmp_path):
    # Tests the worker with installed codecs; separate installer tests verify the pinned asset bundle.
    import numpy as np
    out=io.BytesIO()
    with wave.open(out,'wb') as wav:
        wav.setnchannels(1);wav.setsampwidth(2);wav.setframerate(16000)
        wav.writeframes((np.sin(np.arange(32000)*2*np.pi*440/16000)*8000).astype('<i2').tobytes())
    opts={'kind':'audio','action':'edit','runtime':str(Path(media.__file__).parents[2]/'.venv/Lib/site-packages'),
        'start':0.5,'seconds':0.5,'width':100,'height':100,'rotation':0}
    done=subprocess.run(media.worker_args(opts),input=out.getvalue(),capture_output=True,timeout=45,env=media.worker_environment())
    assert done.returncode==0,done.stderr.decode()
    result=json.loads(done.stdout);assert 'error' not in result,result
    import base64
    with wave.open(io.BytesIO(base64.b64decode(result['data'])),'rb') as wav:assert wav.getnframes()==8000
    assert result['seconds']==0.5


def test_external_playlist_is_rejected():
    opts={'kind':'audio','action':'inspect','runtime':str(Path(media.__file__).parents[2]/'.venv/Lib/site-packages'),
        'start':0,'seconds':1,'width':100,'height':100,'rotation':0}
    done=subprocess.run(media.worker_args(opts),input=b'#EXTM3U\nhttps://127.0.0.1/private.mp3\n',capture_output=True,timeout=15,env=media.worker_environment())
    assert done.returncode==0
    assert 'error' in json.loads(done.stdout)


@pytest.mark.parametrize('fps',[15,24])
def test_video_clip_preserves_audio_and_returns_actual_frames(tmp_path,fps):
    import av
    import numpy as np
    from fractions import Fraction
    source=tmp_path/'source.mp4'
    with av.open(str(source),'w') as output:
        video=output.add_stream('libx264',rate=fps);video.width=160;video.height=96;video.pix_fmt='yuv420p'
        audio=output.add_stream('aac',rate=16000);audio.layout='mono'
        for index in range(fps*2):
            pixels=np.zeros((96,160,3),dtype=np.uint8);pixels[:,:,1]=index*4
            frame=av.VideoFrame.from_ndarray(pixels,format='rgb24');frame.pts=index;frame.time_base=Fraction(1,fps)
            for packet in video.encode(frame):output.mux(packet)
        for packet in video.encode():output.mux(packet)
        for offset in range(0,32000,1024):
            values=(np.sin(np.arange(offset,min(offset+1024,32000))*2*np.pi*440/16000)*0.2).astype(np.float32).reshape(1,-1)
            frame=av.AudioFrame.from_ndarray(values,format='fltp',layout='mono');frame.sample_rate=16000;frame.pts=offset;frame.time_base=Fraction(1,16000)
            for packet in audio.encode(frame):output.mux(packet)
        for packet in audio.encode():output.mux(packet)
    opts={'kind':'video','action':'edit','runtime':str(Path(media.__file__).parents[2]/'.venv/Lib/site-packages'),
        'start':0.5,'seconds':1,'width':160,'height':96,'rotation':0}
    done=subprocess.run(media.worker_args(opts),input=source.read_bytes(),capture_output=True,timeout=45,env=media.worker_environment())
    result=json.loads(done.stdout);assert 'error' not in result,result
    import base64
    clipped=base64.b64decode(result['data'])
    with av.open(io.BytesIO(clipped)) as saved:
        assert saved.streams.audio and saved.streams.video
        assert len(list(saved.decode(video=0)))==fps
        assert abs(float(saved.duration/av.time_base)-1)<0.15
    with av.open(io.BytesIO(clipped)) as saved:assert sum(f.samples for f in saved.decode(audio=0))>=15000
    opts['action']='inspect'
    checked=subprocess.run(media.worker_args(opts),input=source.read_bytes(),capture_output=True,timeout=45,env=media.worker_environment())
    assert len(json.loads(checked.stdout)['images'])==2


def test_media_hash_overwrite_recovery_and_cli(tmp_path,monkeypatch,capsys):
    from jan_mcp_commander.control import ControlCommander
    from jan_mcp_commander.cli import main
    monkeypatch.setenv('JAN_MCP_STATE_DIR',str(tmp_path/'private'))
    monkeypatch.setattr(media,'scan_bytes',lambda data, **kwargs:{'result':'synthetic_clean'})
    work=tmp_path/'work';work.mkdir();source=work/'source.png'
    Image.new('RGB',(200,100),'blue').save(source)
    cmd=ControlCommander(work,enabled={'files'})
    try:
        digest=hashlib.sha256(source.read_bytes()).hexdigest()
        with pytest.raises(ValueError):cmd.edit_media('source.png','wrong.jpg','image','0'*64)
        assert not (work/'wrong.jpg').exists()
        first=cmd.edit_media('source.png','copy.jpg','image',digest,width=100,height=100)
        original=(work/'copy.jpg').read_bytes()
        with pytest.raises(ValueError):cmd.edit_media('source.png','copy.jpg','image',digest,overwrite=True)
        second=cmd.edit_media('source.png','copy.jpg','image',digest,width=50,height=50,overwrite=True,expected_destination_sha256=first['sha256'])
        cmd.restore_backup(second['backup_id']);assert (work/'copy.jpg').read_bytes()==original
    finally:cmd.close_control()
    assert main(['--workspace',str(work),'media','inspect','source.png','--kind','image'])==0
    assert json.loads(capsys.readouterr().out)['width']==200
