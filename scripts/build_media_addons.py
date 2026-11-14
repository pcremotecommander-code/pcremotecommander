"""Build reviewable optional Windows codecs/speech assets from pinned local inputs."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import urllib.request
import time
from zipfile import ZipFile, ZIP_DEFLATED
from packaging.utils import parse_wheel_filename


def digest(data):
    return hashlib.sha256(data).hexdigest()


def build(wheels, model, destination, lock=None):
    artifacts = {}
    def verified(path):
        name, version, _, _ = parse_wheel_filename(path.name)
        if lock is not None:
            item=next(x for x in json.loads(lock.read_text()) if x['filename']==path.name)
            if str(name)!=item['name'] or str(version)!=item['version'] or digest(path.read_bytes())!=item['sha256']:
                raise ValueError('Pinned wheel mismatch: '+path.name)
            return item
        for attempt in range(3):
            try:
                request=urllib.request.Request(f'https://pypi.org/pypi/{name}/{version}/json',headers={'User-Agent':'PCRC-release-verifier'})
                with urllib.request.urlopen(request, timeout=30) as response: package=json.load(response)
                break
            except OSError:
                if attempt==2:raise
                time.sleep(1)
        item = next(x for x in package['urls'] if x['filename'] == path.name)
        assert digest(path.read_bytes()) == item['digests']['sha256'], path.name
        return {'name':str(name),'version':str(version),'filename':path.name,'sha256':item['digests']['sha256'],'url':item['url']}
    with ThreadPoolExecutor(max_workers=4) as pool:
        pins = list(pool.map(verified, sorted(wheels.glob('*.whl'))))
    assert {'av','faster-whisper','ctranslate2','onnxruntime'} <= {x['name'] for x in pins}
    destination.mkdir(parents=True, exist_ok=False)
    entries = {}
    for pin in pins:
        pin['bytes']=(wheels/pin['filename']).stat().st_size
        with ZipFile(wheels/pin['filename']) as wheel:
            for item in wheel.infolist():
                if item.is_dir(): continue
                name=item.filename
                if name in entries: raise ValueError('Overlapping wheel file: '+name)
                if name.startswith('/') or '\\' in name or ':' in name or '..' in Path(name).parts or item.external_attr >> 16 & 0o170000 == 0o120000:
                    raise ValueError('Unsafe wheel entry')
                entries[name]=digest(wheel.read(item))
    raw=json.dumps(entries,sort_keys=True).encode()
    artifacts['runtime']={'source':'pypi-original-wheels','upstream_wheels':pins,
        'manifest_sha256':digest(raw),'bytes':sum(p['bytes'] for p in pins)}
    expected={'config.json':'a73a28cdfe1c43ccc7202fa333d1f89c202477271407ae9a7f19afa52039cac8','model.bin':'dcb76c6586fc06cbdac6dd21f14cfd129cc4cdd9dce19bf4ffa62e59cbe6e6d1','tokenizer.json':'fb7b63191e9bb045082c79fd742a3106a12c99513ab30df4a0d47fa6cb6fd0ab','vocabulary.txt':'34ce3fe1c5041027b3f8d42912270993f986dbc4bb34cf27f951e34a1e453913'}
    archive=destination/'pcremotecommander-speech-tiny-v1.zip'
    license_data=(model/'LICENSE').read_bytes()
    if b'Copyright (c) 2022 OpenAI' not in license_data or b'MIT License' not in license_data:
        raise ValueError('Whisper redistribution license required')
    expected['LICENSE']=digest(license_data)
    with ZipFile(archive,'x',ZIP_DEFLATED,compresslevel=6) as output:
        for name,expected_hash in expected.items():
            data=(model/name).read_bytes();assert digest(data)==expected_hash;output.writestr(name,data)
        raw=json.dumps(expected,sort_keys=True).encode();output.writestr('FILES.json',raw)
        output.writestr('MODEL-ORIGIN.txt','Systran/faster-whisper-tiny revision d90ca5fe260221311c53c58e660288d3deb8d356; converted OpenAI Whisper Tiny multilingual weights. See https://huggingface.co/Systran/faster-whisper-tiny and https://github.com/openai/whisper/blob/main/LICENSE\n')
    artifacts['speech']={'filename':archive.name,'sha256':digest(archive.read_bytes()),'manifest_sha256':digest(raw),'bytes':archive.stat().st_size}
    (destination/'media-manifest.json').write_text(json.dumps(artifacts,indent=2)+'\n')
    (destination/'dependencies.lock.json').write_text(json.dumps(pins,indent=2)+'\n')
    return artifacts


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('wheels',type=Path);parser.add_argument('model',type=Path);parser.add_argument('destination',type=Path)
    parser.add_argument('--lock',type=Path,help='Previously reviewed dependency SHA-256 lock for offline reproducible builds')
    args=parser.parse_args();print(json.dumps(build(args.wheels,args.model,args.destination,args.lock),indent=2))
