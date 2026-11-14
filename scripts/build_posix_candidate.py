"""Build an allowlisted Linux/macOS source package and checksum-pinned launcher."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
from zipfile import ZIP_DEFLATED, ZipFile

ROOT = Path(__file__).resolve().parents[1]
FILES = (
    'pyproject.toml', 'requirements-linux.lock', 'setup-linux.sh', 'setup-macos.sh',
    'docs/document-workflow.md', 'docs/development-runtime.md',
    'pcrc-connect.sh', 'jan-cli.sh', 'scripts/verify_install.py',
    'deploy/npm/jan-commander/package.json', 'deploy/npm/jan-commander/package-lock.json',
    'deploy/mcp-task-server/package.json', 'deploy/mcp-task-server/package-lock.json',
    'deploy/mcp-task-server/tsconfig.json',
)
SOURCE = {
    'src/jan_mcp_commander': {'.py', '.json', '.md', '.yaml'},
    'deploy/npm/jan-commander/bin': {'.cjs'},
    'deploy/mcp-task-server/src': {'.ts'},
}


def build(output, version):
    subprocess.run(['node',str(ROOT/'scripts/generate_privacy_guard.cjs')],check=True)
    if not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?', version):
        raise ValueError('Use a release version such as 0.7.0-beta.28')
    output.mkdir(parents=True, exist_ok=True)
    archive = output / f'pcremotecommander-{version}-posix.zip'
    launcher = output / f'install-{version}-posix.sh'
    if archive.exists() or launcher.exists():
        raise FileExistsError('Use a new output directory or version')
    paths = [ROOT / name for name in FILES]
    for directory, suffixes in SOURCE.items():
        paths.extend(p for p in (ROOT / directory).rglob('*') if p.is_file()
                     and p.suffix in suffixes and not p.name.endswith('.test.ts')
                     and not any(part.startswith('.') or part in {'vendor', '__pycache__'}
                                 for part in p.relative_to(ROOT).parts))
    with ZipFile(archive, 'x', ZIP_DEFLATED) as bundle:
        for item in sorted(paths):
            if any(parent.is_symlink() for parent in (item, *item.parents) if parent != ROOT):
                raise ValueError(f'Symlink in package source: {item.relative_to(ROOT)}')
            relative = item.relative_to(ROOT).as_posix()
            content = item.read_bytes()
            if relative == 'src/jan_mcp_commander/__init__.py':
                content = re.sub(rb'__version__\s*=\s*"[^"]+"', ('__version__ = "' + version + '"').encode(), content)
            elif relative == 'pyproject.toml':
                content = re.sub(rb'(?m)^version\s*=\s*"[^"]+"', ('version = "' + version + '"').encode(), content, count=1)
            elif relative.endswith(('/package.json', '/package-lock.json')):
                value = json.loads(content)
                value['version'] = version
                if 'packages' in value and '' in value['packages']:
                    value['packages']['']['version'] = version
                content = json.dumps(value, indent=2).encode()
            bundle.writestr(relative, content)
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    template = (ROOT / 'scripts/install-posix.sh.in').read_text(encoding='utf-8')
    launcher.write_text(template.replace('@VERSION@', version).replace('@SHA256@', digest), encoding='utf-8', newline='\n')
    return archive, launcher, digest


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('output', type=Path)
    parser.add_argument('version')
    for value in build(**vars(parser.parse_args())):
        print(value)
