import hashlib
import json
from zipfile import ZipFile

import pytest
from jan_mcp_commander.media_install import install_archive,verify


def fixture(tmp_path,extra=None):
    archive=tmp_path/'assets.zip';data=b'benign synthetic module'
    raw=json.dumps({'module.py':hashlib.sha256(data).hexdigest()}).encode()
    with ZipFile(archive,'w') as bundle:
        bundle.writestr('module.py',data);bundle.writestr('FILES.json',raw)
        if extra:bundle.writestr(extra,b'synthetic')
    return archive,{'sha256':hashlib.sha256(archive.read_bytes()).hexdigest(),
        'manifest_sha256':hashlib.sha256(raw).hexdigest(),'bytes':archive.stat().st_size}


def test_verified_install_reuse_tamper_and_unlisted_file(tmp_path,monkeypatch):
    monkeypatch.setattr('jan_mcp_commander.security_scan.scan_bytes',lambda *args:{'result':'synthetic_clean'})
    archive,item=fixture(tmp_path)
    installed=install_archive(archive,tmp_path/'private',item)
    assert verify(installed,item)==installed
    assert install_archive(archive,tmp_path/'private',item)==installed
    (installed/'extra.py').write_text('synthetic')
    with pytest.raises(ValueError,match='Unexpected'):verify(installed,item)
    (installed/'extra.py').unlink();(installed/'module.py').write_text('tampered')
    with pytest.raises(ValueError,match='changed'):verify(installed,item)


@pytest.mark.parametrize('extra',['../escape.py','/absolute.py','MODULE.PY','extra.py'])
def test_archive_path_duplicates_and_unlisted_files_fail_closed(tmp_path,monkeypatch,extra):
    monkeypatch.setattr('jan_mcp_commander.security_scan.scan_bytes',lambda *args:{'result':'synthetic_clean'})
    archive,item=fixture(tmp_path,extra)
    with pytest.raises(ValueError):install_archive(archive,tmp_path/'private',item)
    assert not (tmp_path/'escape.py').exists()


def test_scanner_rejection_never_extracts(tmp_path,monkeypatch):
    archive,item=fixture(tmp_path)
    def deny(*args):raise ValueError('scanner unavailable')
    monkeypatch.setattr('jan_mcp_commander.security_scan.scan_bytes',deny)
    with pytest.raises(ValueError,match='scanner unavailable'):install_archive(archive,tmp_path/'private',item)
    assert not (tmp_path/'private'/item['manifest_sha256'][:16]).exists()


def upstream_fixture(tmp_path):
    import io
    from jan_mcp_commander.media_install import install_upstream
    data=b'original synthetic module'
    out=io.BytesIO()
    with ZipFile(out,'w') as archive:archive.writestr('module.py',data)
    raw=out.getvalue()
    return raw,{'manifest_sha256':hashlib.sha256(json.dumps({'module.py':hashlib.sha256(data).hexdigest()},sort_keys=True).encode()).hexdigest(),
        'upstream_wheels':[{'filename':'synthetic.whl','url':'https://files.pythonhosted.org/packages/synthetic.whl',
            'sha256':hashlib.sha256(raw).hexdigest(),'bytes':len(raw)}]}


def test_original_wheels_install_reuse_and_tamper(tmp_path,monkeypatch):
    from jan_mcp_commander.media_install import install_upstream
    raw,item=upstream_fixture(tmp_path);scanned=[]
    monkeypatch.setattr('jan_mcp_commander.media_install.download_wheel',lambda wheel:raw)
    monkeypatch.setattr('jan_mcp_commander.security_scan.scan_bytes',lambda data,suffix:scanned.append((data,suffix)))
    root=tmp_path/'private';installed=install_upstream(root,item)
    assert scanned==[(raw,'.whl')]
    assert install_upstream(root,item)==installed and len(scanned)==1
    (installed/'module.py').write_text('tampered')
    with pytest.raises(ValueError,match='changed'):install_upstream(root,item)


@pytest.mark.parametrize('failure',['scan','manifest','duplicate'])
def test_original_wheels_fail_atomically(tmp_path,monkeypatch,failure):
    from jan_mcp_commander.media_install import install_upstream
    raw,item=upstream_fixture(tmp_path)
    monkeypatch.setattr('jan_mcp_commander.media_install.download_wheel',lambda wheel:raw)
    def scan(*args):
        if failure=='scan':raise ValueError('scan denied')
    monkeypatch.setattr('jan_mcp_commander.security_scan.scan_bytes',scan)
    if failure=='manifest':item['manifest_sha256']='0'*64
    if failure=='duplicate':item['upstream_wheels']*=2
    root=tmp_path/'private'
    with pytest.raises(ValueError):install_upstream(root,item)
    assert not list(root.iterdir())


def test_original_wheel_network_validation(tmp_path,monkeypatch):
    import io
    from jan_mcp_commander.media_install import download_wheel
    raw,item=upstream_fixture(tmp_path);wheel=item['upstream_wheels'][0]
    class Response(io.BytesIO):
        status=200
        headers={'Content-Length':str(len(raw))}
        def geturl(self):return wheel['url']
    monkeypatch.setattr('urllib.request.urlopen',lambda *a,**k:Response(raw))
    assert download_wheel(wheel)==raw
    with pytest.raises(ValueError,match='checksum'):download_wheel({**wheel,'sha256':'0'*64})
    Response.headers={'Content-Length':str(len(raw)+1)}
    with pytest.raises(ValueError,match='size'):download_wheel(wheel)
    Response.headers={'Content-Length':str(len(raw))}
    Response.geturl=lambda self:'https://evil.example/synthetic.whl'
    with pytest.raises(ValueError,match='source'):download_wheel(wheel)
    for url in ['http://files.pythonhosted.org/packages/synthetic.whl','https://evil.example/synthetic.whl',
                'https://files.pythonhosted.org:444/packages/synthetic.whl']:
        with pytest.raises(ValueError,match='PyPI'):download_wheel({**wheel,'url':url})



def test_speech_download_identifies_installer_and_verifies_archive(tmp_path,monkeypatch):
    import io
    import os
    from types import SimpleNamespace
    from jan_mcp_commander import media_install
    archive,item=fixture(tmp_path);item['filename']='synthetic-model.zip';raw=archive.read_bytes();requests=[]
    monkeypatch.setattr(media_install,'os',SimpleNamespace(name='nt',rename=os.rename,scandir=os.scandir))
    monkeypatch.setattr(media_install.sys,'version_info',(3,14))
    monkeypatch.setattr(media_install,'pins',lambda:{'runtime':{'manifest_sha256':'f'*64},'speech':item})
    monkeypatch.setattr(media_install,'install_upstream',lambda *args:None)
    monkeypatch.setattr('jan_mcp_commander.security_scan.scan_bytes',lambda *args:None)
    class Response(io.BytesIO):
        status=200
        headers={'Content-Length':str(len(raw))}
    def fetch(request,**kwargs):
        requests.append(request)
        assert request.get_header('User-agent')=='PCRC-media-installer'
        return Response(raw)
    monkeypatch.setattr('urllib.request.urlopen',fetch)
    root=tmp_path/'private'
    assert media_install.prepare(root,speech=True)['speech_ready']
    assert len(requests)==1
    assert media_install.verify(root/item['manifest_sha256'][:16],item).is_dir()
