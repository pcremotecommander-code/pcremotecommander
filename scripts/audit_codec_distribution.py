"""Check distribution evidence, not legal certification. Never publishes assets."""
import hashlib
import json
from email.parser import BytesParser
from pathlib import Path
from zipfile import ZipFile

ROOT=Path(__file__).resolve().parents[1]


def main():
    assets=ROOT/'work/media-addons-upstream-beta23'
    pins=json.loads((assets/'dependencies.lock.json').read_text())
    packages=[]
    for item in pins:
        wheel=ROOT/'work/media-wheels'/item['filename']
        assert hashlib.sha256(wheel.read_bytes()).hexdigest()==item['sha256']
        with ZipFile(wheel) as bundle:
            metadata=BytesParser().parsebytes(bundle.read(next(n for n in bundle.namelist() if n.endswith('.dist-info/METADATA'))))
            notices=[n for n in bundle.namelist() if not n.endswith('/') and Path(n).name.casefold().startswith(('license','copying','notice'))]
            packages.append({'name':item['name'],'version':item['version'],'license':str(metadata.get('License-Expression') or metadata.get('License') or 'not declared')[:120],
                'notice_files':len(notices)})
    manifest=json.loads((assets/'media-manifest.json').read_text())
    from urllib.parse import urlsplit
    runtime=manifest['runtime']
    assert runtime['source']=='pypi-original-wheels' and runtime['upstream_wheels']==pins
    assert all(urlsplit(p['url']).hostname=='files.pythonhosted.org' and urlsplit(p['url']).scheme=='https' for p in pins)
    assert not list(assets.glob('pcremotecommander-media-*.zip'))
    native_license=[]
    with ZipFile(assets/manifest['speech']['filename']) as bundle:
        model_mit=b'Copyright (c) 2022 OpenAI' in bundle.read('LICENSE')
    upstream_patch=(ROOT/'work/upstream-ffmpeg.patch').read_text()
    conflict=all(s in upstream_patch for s in ['-    libx264','-    libx265','+    libx264','+    libx265'])
    report={'codec_distribution_cleared':False,'pcrc_codec_rehosting':'not_applicable_direct_upstream_download',
        'direct_upstream_manifest_verified':True,'pcrc_codec_archive_produced':False,'model_mit_notice_present':model_mit,'python_packages':packages,
        'native_copying_files':native_license,'upstream_license_classification_patch_found':conflict,
        'source_references':['https://github.com/FFmpeg/FFmpeg/blob/master/LICENSE.md',
            'https://github.com/PyAV-Org/pyav-ffmpeg/blob/master/patches/ffmpeg.patch'],
        'blockers':['The build enables libx264/libx265 while reporting LGPL; upstream patch changes their license classification.',
            'Complete applicable native-library notices and corresponding-source/build provenance have not been supplied.',
            'PCRC must not host the old codec archive; direct installation is not certification of the upstream license classification.'],
        'security_only_release_includes_codecs':False,'published':False}
    (ROOT/'work/codec-distribution-audit.json').write_text(json.dumps(report,indent=2))
    print(json.dumps({'direct_upstream_manifest_verified':True,'pcrc_codec_archive_produced':False,'codec_distribution_cleared':False,'model_notice':model_mit,'wheels_inspected':len(packages),
        'native_copying_files':len(native_license),'classification_conflict':conflict}))
    return 0  # Passing architecture check, not legal clearance of upstream binaries.


if __name__=='__main__':raise SystemExit(main())
