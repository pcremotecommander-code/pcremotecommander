"""Patch the published runtime dependency without including unpublished features."""
import argparse
import json
from pathlib import Path
import shutil
import tarfile
import tempfile
from pathlib import PurePosixPath
from build_npm_beta import digest,install_pillow

BASE_SHA256='b513b688b0c1c418fd5f6b56440f7f59b691f550637380c0985b01504ab4a27d'


def build(archive,destination):
    archive=archive.resolve();destination=destination.resolve()
    if destination.exists():raise FileExistsError(destination)
    if digest(archive)!=BASE_SHA256:raise ValueError('Published base archive checksum mismatch')
    with tempfile.TemporaryDirectory(prefix='pcrc-verified-base-',dir=destination.parent) as staging:
        with tarfile.open(archive,'r:gz') as bundle:
            total=0
            for item in bundle.getmembers():
                parts=PurePosixPath(item.name).parts;total+=item.size
                if (not parts or parts[0]!='package' or '..' in parts or '\\' in item.name or ':' in item.name or
                        not (item.isfile() or item.isdir()) or total>1024*1024*1024):
                    raise ValueError('Unsafe published base archive')
                if parts[-1] in {'connection.json','state.key','.npmrc','.dev.vars','.pypirc','wrangler.local.jsonc'}:
                    raise ValueError('Private state is forbidden in a release')
                if parts[:4]==('package','project','src','jan_mcp_commander') and parts[-1] in {
                    'media_tools.py','media_install.py','_media_worker.py','pdf_tools.py','_pdf_worker.py','security_scan.py','_security_scan_worker.py','worker_limits.py'}:
                    raise ValueError('Unpublished prototype in security-only release')
            bundle.extractall(staging,filter='data')
        return patch_verified_directory(Path(staging)/'package',destination)


def patch_verified_directory(base,destination):
    base=base.resolve();destination=destination.resolve()
    if destination.exists():raise FileExistsError(destination)
    manifest=json.loads((base/'SOURCE-MANIFEST.json').read_text())
    if json.loads((base/'package.json').read_text())['version']!='0.7.0-beta.20':
        raise ValueError('Expected the published beta20 runtime')
    for name,expected in manifest.items():
        source=base/(name if name.startswith(('bin/','runtime/')) else 'project/'+name)
        if digest(source)!=expected:raise ValueError('Published base manifest mismatch')
    shutil.copytree(base,destination,ignore=shutil.ignore_patterns('*.tgz'))
    install_pillow(destination,manifest)
    for name in ['package.json','project/deploy/npm/jan-commander/package.json']:
        target=destination/name;metadata=json.loads(target.read_text());metadata['version']='0.7.0-beta.22'
        target.write_text(json.dumps(metadata,indent=2)+'\n')
        if name.startswith('project/'):manifest[name.removeprefix('project/')]=digest(target)
    for name in ['pyproject.toml','requirements-control.lock']:
        target=destination/'project'/name
        target.write_text(target.read_text().replace('Pillow==12.3.0','Pillow==13.0.0'))
        manifest[name]=digest(target)
    version=destination/'project/src/jan_mcp_commander/__init__.py'
    version.write_text('__version__ = "0.7.0-beta.22"\n');manifest['src/jan_mcp_commander/__init__.py']=digest(version)
    for name in manifest:
        if name.startswith('src/') and name!='src/jan_mcp_commander/__init__.py':
            assert (destination/'project'/name).read_bytes()==(base/'project'/name).read_bytes()
    (destination/'SOURCE-MANIFEST.json').write_text(json.dumps(manifest,indent=2)+'\n')
    return {'version':'0.7.0-beta.22','security_only':True,'pillow':'13.0.0','files':len(manifest),'source_preserved':True}


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('base',type=Path);parser.add_argument('destination',type=Path)
    args=parser.parse_args();print(json.dumps(build(args.base,args.destination)))
