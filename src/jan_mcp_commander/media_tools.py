"""Bounded media snapshots and worker invocation; paths never reach codecs."""
import base64
import hashlib
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import time

from .environment import runtime_environment
from .media_install import pins, verify
from .security_scan import scan_bytes
from .worker_limits import remaining

MAX_MEDIA = 64 * 1024 * 1024


def snapshot(tree, path, deadline=None):
    data = tree.read(path, MAX_MEDIA)
    if not data:
        raise ValueError('Media file is empty')
    return data, scan_bytes(data,deadline=deadline)


def options(root, action, kind, *, start=0, seconds=10, width=1280, height=720, rotation=0,deadline=None):
    if kind not in {'image','audio','video'} or action not in {'inspect','edit','transcribe'}:
        raise ValueError('Unsupported media operation')
    if (type(start) not in {int,float} or not math.isfinite(start) or not 0<=start<=86400 or
            type(seconds) not in {int,float} or not math.isfinite(seconds) or not 0<seconds<=30 or
            type(width) is not int or type(height) is not int or not 16<=width<=4096 or not 16<=height<=4096 or
            type(rotation) is not int or rotation not in {0,90,180,270} or action=='transcribe' and kind!='audio'):
        raise ValueError('Invalid media bounds; clips are at most 30 seconds')
    value={'action':action,'kind':kind,'start':start,'seconds':seconds,'width':width,'height':height,'rotation':rotation}
    if kind!='image' and rotation:raise ValueError('Rotation is supported for image files only')
    if kind!='image':
        manifest=pins();value['runtime']=str(verify(Path(root)/manifest['runtime']['manifest_sha256'][:16],manifest['runtime'],deadline=deadline))
        if action=='transcribe':
            value['model']=str(verify(Path(root)/manifest['speech']['manifest_sha256'][:16],manifest['speech'],deadline=deadline))
    return value


def worker_args(value):
    return [sys.executable,'-B','-I',str(Path(__file__).with_name('_media_worker.py')),json.dumps(value)]


def worker_environment():
    return {**runtime_environment(),'HF_HUB_OFFLINE':'1','HF_HUB_DISABLE_TELEMETRY':'1','TRANSFORMERS_OFFLINE':'1'}


def process_media(tree, root, path, action, kind, *, deadline=None, **kwargs):
    deadline=time.monotonic()+15 if deadline is None else deadline
    value=options(root,action,kind,deadline=deadline,**kwargs)
    data,scan=snapshot(tree,path,deadline)
    try:
        result=subprocess.run(worker_args(value),input=data,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,
            timeout=remaining(deadline,45),env=worker_environment(),**({'creationflags':subprocess.CREATE_NO_WINDOW} if os.name=='nt' else {}))
    except subprocess.TimeoutExpired as exc:
        raise ValueError('Media processing timed out; no output saved') from exc
    if result.returncode or len(result.stdout)>16*1024*1024:
        raise ValueError('Media processor unavailable or resource limit reached; no output saved')
    remaining(deadline,15)
    output=json.loads(result.stdout)
    if output.get('error'):raise ValueError(output['error'])
    from .privacy import assert_public_text
    if isinstance(output.get('text'),str):assert_public_text(output['text'])
    if 'data' in output:
        output['bytes']=base64.b64decode(output.pop('data'),validate=True)
        if len(output['bytes'])>8*1024*1024:raise ValueError('Media output exceeds 8 MiB')
    return {**output,'path':path,'sha256':hashlib.sha256(data).hexdigest(),'security_scan':scan}


def main(argv,workspace=None):
    import argparse
    from .control import ControlCommander
    from .cli import workspace_path
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action',choices=['prepare','inspect','edit','transcribe'])
    parser.add_argument('path',nargs='?');parser.add_argument('--kind',choices=['image','audio','video'],default='image')
    parser.add_argument('--speech',action='store_true');parser.add_argument('--start',type=float,default=0)
    parser.add_argument('--seconds',type=float,default=10);parser.add_argument('--width',type=int,default=1280)
    parser.add_argument('--height',type=int,default=720);parser.add_argument('--rotation',type=int,default=0)
    parser.add_argument('--destination');parser.add_argument('--sha256');parser.add_argument('--destination-sha256')
    parser.add_argument('--overwrite',action='store_true');parser.add_argument('--allow-writes',action='store_true')
    args=parser.parse_args(argv)
    commander=ControlCommander(workspace_path(workspace),enabled={'files'})
    commander.allow_writes=args.allow_writes
    try:
        if args.action=='prepare':
            from .media_install import prepare
            result=prepare(commander._store.path/'media',args.speech)
        elif args.action=='edit':
            if not args.allow_writes or not args.destination or not args.sha256:
                raise ValueError('Edit requires --allow-writes, --destination and fresh --sha256')
            result=commander.edit_media(args.path,args.destination,args.kind,args.sha256,args.start,args.seconds,
                args.width,args.height,args.rotation,args.overwrite,args.destination_sha256)
        elif args.action=='transcribe':result=commander.transcribe_audio(args.path,args.start,args.seconds)
        else:result=commander.inspect_media(args.path,args.kind,args.start,args.seconds)
        images=result.pop('images',[])
        if images:result['image_previews']=len(images)
        print(json.dumps(result));return 0
    except (ValueError,OSError) as exc:
        print(json.dumps({'error':str(exc)}));return 1
    finally:commander.close_control()
