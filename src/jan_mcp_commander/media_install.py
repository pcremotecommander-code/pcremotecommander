"""Optional, pinned media assets. Installation never uploads user media."""
import hashlib
from concurrent.futures import ThreadPoolExecutor
from itertools import islice
import io
import json
import os
import stat
from pathlib import Path, PurePosixPath
import sys
import tempfile
import time
import urllib.request
from urllib.parse import urlsplit
from zipfile import ZipFile

from .security import private_directory

BASE = 'https://pc-remote-commander.pcremotecommander.workers.dev/downloads/windows/'


def pins():
    return json.loads(Path(__file__).with_name('media-manifest.json').read_text())


def verify(directory, item, *, deadline=None):
    def check_deadline():
        if deadline is not None and time.monotonic()>=deadline:
            raise ValueError('Media verification timed out; no output saved')
    check_deadline()
    directory = Path(directory)
    manifest = directory/'FILES.json'
    if directory.is_symlink() or not manifest.is_file() or manifest.is_symlink():
        raise ValueError('Media assets missing; use prepare_media first')
    if manifest.stat().st_size>2*1024*1024:raise ValueError('Media manifest exceeds limit')
    raw = manifest.read_bytes()
    if hashlib.sha256(raw).hexdigest() != item['manifest_sha256']:
        raise ValueError('Media asset manifest failed verification')
    entries=json.loads(raw)
    actual={}
    pending=[directory]
    while pending:
        check_deadline()
        with os.scandir(pending.pop()) as children:
            for child in children:
                check_deadline()
                info=child.stat(follow_symlinks=False)
                if stat.S_ISLNK(info.st_mode) or getattr(info,'st_file_attributes',0)&0x400:
                    raise ValueError('Media assets changed; stop and reinstall the verified assets')
                path=Path(child.path)
                if stat.S_ISDIR(info.st_mode):pending.append(path)
                elif stat.S_ISREG(info.st_mode):actual[path.relative_to(directory).as_posix()]=(path,info.st_size)
                else:raise ValueError('Media assets changed; stop and reinstall the verified assets')
    if set(actual)-set(entries)-{'FILES.json','DEPENDENCIES.json','MODEL-ORIGIN.txt'}:
        raise ValueError('Unexpected media asset files; stop and reinstall')
    def verify_file(entry):
        name,expected=entry
        check_deadline()
        if not name or PurePosixPath(name).is_absolute() or '..' in PurePosixPath(name).parts or '\\' in name or ':' in name:
            raise ValueError('Unsafe media manifest path')
        asset=actual.get(name)
        if asset is None or asset[1]>160*1024*1024:
            raise ValueError('Media assets changed; stop and reinstall the verified assets')
        path=asset[0]
        hasher=hashlib.sha256()
        with path.open('rb') as source:
            while chunk:=source.read(1024*1024):
                check_deadline();hasher.update(chunk)
        check_deadline()
        if hasher.hexdigest()!=expected:raise ValueError('Media assets changed; stop and reinstall the verified assets')
    if len(entries)<2:
        for entry in entries.items():verify_file(entry)
    else:
        with ThreadPoolExecutor(max_workers=4,thread_name_prefix='pcrc-media-verify') as executor:
            pending=iter(entries.items())
            while batch:=list(islice(pending,4)):
                check_deadline()
                for future in [executor.submit(verify_file,entry) for entry in batch]:future.result()
    return directory


def unpack(data, folder, names, total):
    with ZipFile(io.BytesIO(data)) as bundle:
        for entry in bundle.infolist():
            parts = PurePosixPath(entry.filename).parts
            total += entry.file_size
            if (not parts or entry.filename.startswith('/') or any(p in {'.','..'} for p in parts) or
                    entry.filename.casefold() in names or
                    '\\' in entry.filename or ':' in entry.filename or '\x00' in entry.filename or
                    entry.external_attr >> 16 & 0o170000 == 0o120000 or total > 512 * 1024 * 1024):
                raise ValueError('Unsafe media archive')
            names.add(entry.filename.casefold())
        bundle.extractall(folder)
    return total


def download_wheel(item):
    url = urlsplit(item['url'])
    if (url.scheme != 'https' or url.hostname != 'files.pythonhosted.org' or
            url.username or url.password or url.port not in {None,443} or url.query or url.fragment or
            not url.path.endswith('/'+item['filename']) or
            not item['filename'].endswith('.whl') or not 0 < item['bytes'] <= 160*1024*1024):
        raise ValueError('Only pinned original PyPI wheels are supported')
    request=urllib.request.Request(item['url'],headers={'User-Agent':'PCRC-media-installer'})
    with urllib.request.urlopen(request,timeout=60) as response:
        if response.geturl()!=item['url'] or response.status!=200:
            raise ValueError('Unexpected wheel download source')
        if int(response.headers.get('Content-Length','0'))!=item['bytes']:
            raise ValueError('Unexpected wheel download size')
        data=response.read(item['bytes']+1)
    if len(data)!=item['bytes'] or hashlib.sha256(data).hexdigest()!=item['sha256']:
        raise ValueError('Wheel download incomplete or checksum mismatch')
    return data


def install_upstream(root, item):
    root=private_directory(root)
    destination=root/item['manifest_sha256'][:16]
    if destination.exists():return verify(destination,item)
    from .security_scan import scan_bytes
    with tempfile.TemporaryDirectory(prefix='upstream-',dir=root) as staging:
        folder=Path(staging);names=set();total=0
        for index,wheel in enumerate(item['upstream_wheels'],1):
            data=download_wheel(wheel)
            scan_bytes(data,'.whl')
            total=unpack(data,folder,names,total)
            print(f'Original PyPI packages verified: {index}/{len(item["upstream_wheels"])}',flush=True)
        entries={p.relative_to(folder).as_posix():hashlib.sha256(p.read_bytes()).hexdigest()
                 for p in folder.rglob('*') if p.is_file()}
        (folder/'FILES.json').write_bytes(json.dumps(entries,sort_keys=True).encode())
        verify(folder,item)
        os.rename(folder,destination)
    return destination


def install_archive(archive, root, item):
    root = private_directory(root)
    if Path(archive).stat().st_size!=item['bytes']:raise ValueError('Unexpected media archive size')
    data=Path(archive).read_bytes()
    if hashlib.sha256(data).hexdigest() != item['sha256']:
        raise ValueError('Media archive checksum mismatch; nothing loaded')
    from .security_scan import scan_bytes
    scan_bytes(data, '.zip')
    destination = root/item['manifest_sha256'][:16]
    if destination.exists():
        return verify(destination, item)
    with tempfile.TemporaryDirectory(prefix='unpack-', dir=root) as staging:
        folder = Path(staging)
        unpack(data, folder, set(), 0)
        verify(folder, item)
        os.rename(folder, destination)
    return destination


def prepare(root, speech=False):
    if os.name != 'nt' or sys.version_info[:2] != (3,14):
        raise ValueError('This optional media build requires the bundled Windows x64 Python 3.14 runtime')
    root = private_directory(root)
    manifest = pins()
    for kind in (['runtime','speech'] if speech else ['runtime']):
        item = manifest[kind];destination = root/item['manifest_sha256'][:16]
        if destination.exists():
            verify(destination, item);print(kind+' assets verified',flush=True);continue
        if kind=='runtime':
            install_upstream(root,item)
            print('runtime assets installed directly from PyPI and verified',flush=True)
            continue
        with tempfile.NamedTemporaryFile(prefix='download-', suffix='.zip', dir=root, delete=False) as out:
            temporary = Path(out.name)
            try:
                request=urllib.request.Request(BASE+item['filename'],headers={'User-Agent':'PCRC-media-installer'})
                with urllib.request.urlopen(request, timeout=60) as response:
                    if response.status != 200 or int(response.headers.get('Content-Length','0')) != item['bytes']:
                        raise ValueError('Unexpected media download size')
                    received=0;last=time.monotonic();digest=hashlib.sha256()
                    while chunk:=response.read(1024*1024):
                        received+=len(chunk)
                        if received>item['bytes']:raise ValueError('Oversized media download')
                        out.write(chunk);digest.update(chunk)
                        if time.monotonic()-last>=5:
                            print(f'{kind} download: {received*100//item["bytes"]}%',flush=True);last=time.monotonic()
                    if received!=item['bytes'] or digest.hexdigest()!=item['sha256']:
                        raise ValueError('Media download incomplete or checksum mismatch')
                out.close()
                install_archive(temporary,root,item)
            finally:
                out.close();temporary.unlink(missing_ok=True)
        print(kind+' assets installed and verified',flush=True)
    return {'ready':True,'speech_ready':speech,'processing':'offline','user_media_uploaded':False}


if __name__=='__main__':
    import argparse
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--root',type=Path,required=True);parser.add_argument('--speech',action='store_true')
    args=parser.parse_args()
    try:print(json.dumps(prepare(args.root,args.speech)))
    except Exception:
        print('Media preparation failed. No unverified assets were loaded; check network, protection and disk space.',file=sys.stderr);sys.exit(1)
