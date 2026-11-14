"""Build-time installer for two checksum-pinned official release archives."""
import hashlib
from pathlib import Path
import sys
import urllib.request
import zipfile
import io

CHECKSUMS = {
    'amd64': 'd60cdba019bce451bcc3a15478cc5b9cb11270b049f5b56ea39a80b517f8b117',
    'arm64': '963d0384aaa7c798778479c45673f9051a4039dd891aef8f8978d2a1a628b74f',
}

def install(arch, directory):
    if arch not in CHECKSUMS:
        raise ValueError('Supported server architectures: amd64, arm64')
    name = f'tunnel-client-v0.0.16-linux-{arch}.zip'
    url = 'https://github.com/openai/tunnel-client/releases/download/v0.0.16/' + name
    with urllib.request.urlopen(url, timeout=120) as response:  # nosec B310 -- fixed official HTTPS origin, arch allowlist and pinned SHA256
        data = response.read(100 * 1024 * 1024 + 1)
    if len(data) > 100 * 1024 * 1024 or hashlib.sha256(data).hexdigest() != CHECKSUMS[arch]:
        raise ValueError('Official tunnel archive checksum mismatch')
    dest = Path(directory); dest.mkdir(parents=True, exist_ok=True)
    # Admit only expected flat files; never extract archive paths verbatim.
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        for item in archive.infolist():
            if item.filename in {'tunnel-client', 'cloudflared', 'cloudflared-manifest.json', 'LICENSE', 'NOTICE'} or (
                '/' not in item.filename and item.filename.endswith(('-licenses.txt', '.spdx.json'))):
                if item.file_size > 100 * 1024 * 1024:
                    raise ValueError('Unexpected archive member size')
                path = dest / item.filename
                path.write_bytes(archive.read(item))
                path.chmod(0o755 if item.filename in {'tunnel-client', 'cloudflared'} else 0o644)
    for executable in ('tunnel-client', 'cloudflared'):
        if not (dest / executable).is_file():
            raise ValueError('Required tunnel executable missing')

if __name__ == '__main__':
    install(sys.argv[1], sys.argv[2])
