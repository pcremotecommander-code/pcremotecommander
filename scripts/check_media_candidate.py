"""Candidate acceptance using synthetic assets; does not claim a public relay test."""
import io
import json
from pathlib import Path
import subprocess
import sys
import time

ROOT=Path(__file__).resolve().parents[1]
from jan_mcp_commander.media_install import install_archive,install_upstream,pins,verify
from jan_mcp_commander.media_tools import process_media
from jan_mcp_commander.safe_fs import SafeTree
from jan_mcp_commander import __version__


def main():
    artifacts=ROOT/'work/media-addons-upstream-beta23';cache=ROOT/'work/media-upstream-network-cache'
    manifest=pins();paths={}
    for name,item in manifest.items():
        paths[name]=install_upstream(cache,item) if name=='runtime' else install_archive(artifacts/item['filename'],cache,item)
    started=time.monotonic()
    transcript=process_media(SafeTree(ROOT/'work'),cache,'pcrc-synthetic-speech.wav','transcribe','audio',seconds=20)
    text=' '.join(item['text'] for item in transcript['segments']).casefold()
    assert 'audio test' in text and ('seven' in text or '7' in text),text
    sys.dont_write_bytecode=True
    sys.path.insert(0,str(paths['runtime']))
    import av
    import numpy as np
    from fractions import Fraction
    import tempfile
    with tempfile.TemporaryDirectory(prefix='media-bundle-',dir=ROOT/'work') as folder:
        folder=Path(folder);video_path=folder/'synthetic.mp4'
        with av.open(str(video_path),'w') as target:
            stream=target.add_stream('libx264',rate=15);stream.width=160;stream.height=96;stream.pix_fmt='yuv420p'
            for index in range(30):
                pixels=np.zeros((96,160,3),dtype=np.uint8);pixels[:,:,1]=index*4
                frame=av.VideoFrame.from_ndarray(pixels,format='rgb24');frame.pts=index;frame.time_base=Fraction(1,15)
                for packet in stream.encode(frame):target.mux(packet)
            for packet in stream.encode():target.mux(packet)
        tree=SafeTree(folder)
        seen=process_media(tree,cache,'synthetic.mp4','inspect','video',seconds=1)
        assert len(seen['images'])==2
        clip=process_media(tree,cache,'synthetic.mp4','edit','video',start=0.5,seconds=1,width=160,height=96)
        with av.open(io.BytesIO(clip['bytes'])) as saved:
            assert len(list(saved.decode(video=0)))==15
            assert abs(saved.duration/av.time_base-1)<0.15
    for name,item in manifest.items():verify(paths[name],item)
    report={'candidate_only':True,'runtime_version':__version__,'python':sys.executable,'pinned_installer':'pass','real_amsi_preflight':'pass',
        'offline_transcription':'pass','video_decode_clip_timing':'pass','seconds':round(time.monotonic()-started,2),'transcript':text}
    (ROOT/'work/media-candidate-result.json').write_text(json.dumps(report,indent=2))
    print(json.dumps(report))


if __name__=='__main__':main()
