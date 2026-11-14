import hashlib
import json
from pathlib import Path
import sys
import tarfile
import pytest

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
import build_security_runtime as patcher


def test_security_release_preserves_published_source_and_excludes_prototypes(tmp_path,monkeypatch):
    base=tmp_path/'base';destination=tmp_path/'patched';manifest={}
    files={'project/src/jan_mcp_commander/__init__.py':'__version__="0.7.0-beta.20"',
        'project/src/jan_mcp_commander/control.py':'PUBLISHED_BASE_ONLY=True',
        'project/pyproject.toml':'Pillow==12.3.0','project/requirements-control.lock':'Pillow==12.3.0',
        'package.json':'{"version":"0.7.0-beta.20"}',
        'project/deploy/npm/jan-commander/package.json':'{"version":"0.7.0-beta.20"}'}
    for name,content in files.items():
        path=base/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_text(content)
        if name.startswith('project/'):manifest[name[8:]]=hashlib.sha256(path.read_bytes()).hexdigest()
    (base/'SOURCE-MANIFEST.json').write_text(json.dumps(manifest))
    archive=tmp_path/'published.tgz'
    with tarfile.open(archive,'w:gz') as output:output.add(base,arcname='package')
    monkeypatch.setattr(patcher,'BASE_SHA256',hashlib.sha256(archive.read_bytes()).hexdigest())
    monkeypatch.setattr(patcher,'install_pillow',lambda destination,manifest:None)
    result=patcher.build(archive,destination)
    assert result['security_only'] and result['source_preserved']
    assert (destination/'project/src/jan_mcp_commander/control.py').read_text()=='PUBLISHED_BASE_ONLY=True'
    assert not (destination/'project/src/jan_mcp_commander/media_tools.py').exists()
    assert '13.0.0' in (destination/'project/pyproject.toml').read_text()
    assert json.loads((destination/'package.json').read_text())['version']=='0.7.0-beta.22'


@pytest.mark.parametrize('name',['package/project/connection.json','package/project/src/jan_mcp_commander/media_tools.py'])
def test_security_release_rejects_unlisted_private_or_prototype_files(tmp_path,monkeypatch,name):
    import io
    archive=tmp_path/'contaminated.tgz'
    with tarfile.open(archive,'w:gz') as output:
        item=tarfile.TarInfo(name);item.size=9;output.addfile(item,io.BytesIO(b'synthetic'))
    monkeypatch.setattr(patcher,'BASE_SHA256',hashlib.sha256(archive.read_bytes()).hexdigest())
    with pytest.raises(ValueError,match='Private state|Unpublished prototype'):patcher.build(archive,tmp_path/'release')
    assert not (tmp_path/'release').exists()


def test_security_release_rejects_changed_base_archive(tmp_path):
    archive=tmp_path/'tampered.tgz';archive.write_bytes(b'synthetic')
    with pytest.raises(ValueError,match='checksum mismatch'):patcher.build(archive,tmp_path/'release')
