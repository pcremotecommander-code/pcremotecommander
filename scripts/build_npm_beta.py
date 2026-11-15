"""Turn a verified private Windows bundle into a reviewable npm beta candidate."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import io
from zipfile import ZipFile

from build_source_preview import ROOT


NAME = "pcremotecommander"
VERSION = "0.7.0-beta.44"
PDFIUM_WHEEL = ROOT/'work/dependency-wheels/pypdfium2-5.14.0-py3-none-win_amd64.whl'
PDFIUM_SHA256 = '149fd5c6397b8df8bf7911a93506eff0be874f877afe7ac936cf5d37d21a6a06'
PDF_WHEEL = ROOT/'work/dependency-wheels/pypdf-6.21.4-py3-none-any.whl'
PDF_SHA256 = '33e4fb41ca352810eb4e9838aa0d82d6888a5f8bf682f43e99cce5faa666255c'
PILLOW_WHEEL=ROOT/'work/dependency-wheels/pillow-13.0.0-cp314-cp314-win_amd64.whl'
PILLOW_SHA256='f7cbb7a64e7ec664775195e4f81923bc8a93d9451b963f844e59118f63147a7a'


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def install_pillow(destination,manifest):
    pillow=PILLOW_WHEEL.read_bytes()
    if hashlib.sha256(pillow).hexdigest()!=PILLOW_SHA256:raise ValueError('Pillow dependency checksum mismatch')
    library=destination/'runtime/Lib/site-packages'
    for old in library.iterdir() if library.exists() else []:
        if old.name=='PIL' or old.name.casefold().startswith('pillow-') and old.name.endswith('.dist-info'):
            if not old.resolve().is_relative_to(destination):raise ValueError('Linked dependency directory denied')
            prefix=old.relative_to(destination).as_posix()+'/'
            for key in list(manifest):
                if key.startswith(prefix):del manifest[key]
            shutil.rmtree(old)
    with ZipFile(io.BytesIO(pillow)) as wheel:
        for item in wheel.infolist():
            if item.is_dir():continue
            if not item.filename.startswith(('PIL/','pillow-13.0.0.dist-info/')) or '..' in Path(item.filename).parts:
                raise ValueError('Unexpected Pillow dependency contents')
            relative='runtime/Lib/site-packages/'+item.filename;target=destination/relative
            target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(wheel.read(item));manifest[relative]=digest(target)


def build(base: Path, destination: Path) -> dict:
    subprocess.run(['node',str(ROOT/'scripts/generate_privacy_guard.cjs')],check=True)
    base = base.resolve()
    destination = destination.resolve()
    if destination.exists():
        raise FileExistsError(destination)
    manifest = json.loads((base / "SOURCE-MANIFEST.json").read_text(encoding="utf-8"))
    if not isinstance(manifest, dict) or not manifest:
        raise ValueError("Missing source manifest")
    for relative, expected in manifest.items():
        # The project entries were recorded relative to the copied source tree.
        source = base / (relative if relative.startswith(("bin/", "runtime/")) else "project/" + relative)
        if not source.is_file() or digest(source) != expected:
            raise ValueError(f"Base bundle hash mismatch: {relative}")
    shutil.copytree(base, destination, ignore=shutil.ignore_patterns("*.tgz", "__pycache__", "*.pyc", "*.pyo"))
    install_pillow(destination,manifest)
    pdfium=PDFIUM_WHEEL.read_bytes()
    if hashlib.sha256(pdfium).hexdigest()!=PDFIUM_SHA256:raise ValueError('PDF renderer checksum mismatch')
    with ZipFile(io.BytesIO(pdfium)) as wheel:
        for item in wheel.infolist():
            if item.is_dir():continue
            if not item.filename.startswith(('pypdfium2/','pypdfium2_raw/','pypdfium2_cfg/','pypdfium2_cli/','pypdfium2-5.14.0.dist-info/')) or '..' in Path(item.filename).parts:
                raise ValueError('Unexpected PDF renderer contents')
            relative='runtime/Lib/site-packages/'+item.filename
            target=destination/relative;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(wheel.read(item));manifest[relative]=digest(target)
    for name in ['pyproject.toml','requirements-control.lock']:
        shutil.copy2(ROOT/name,destination/'project'/name);manifest[name]=digest(ROOT/name)
    guide='docs/document-workflow.md'
    (destination/'project'/guide).parent.mkdir(parents=True,exist_ok=True)
    shutil.copy2(ROOT/guide,destination/'project'/guide);manifest[guide]=digest(ROOT/guide)
    pdf=PDF_WHEEL.read_bytes()
    if hashlib.sha256(pdf).hexdigest()!=PDF_SHA256:raise ValueError('PDF dependency checksum mismatch')
    with ZipFile(io.BytesIO(pdf)) as wheel:
        for item in wheel.infolist():
            if item.is_dir():continue
            if not item.filename.startswith(('pypdf/','pypdf-6.21.4.dist-info/')) or '..' in Path(item.filename).parts:
                raise ValueError('Unexpected PDF dependency contents')
            relative='runtime/Lib/site-packages/'+item.filename
            target=destination/relative;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(wheel.read(item))
            manifest[relative]=digest(target)
    for source in sorted((ROOT / 'src/jan_mcp_commander').glob('*.py')):
        relative = source.relative_to(ROOT).as_posix()
        target = destination / 'project' / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
        manifest[relative] = digest(source)
    version_file = destination / 'project/src/jan_mcp_commander/__init__.py'
    media_manifest=ROOT/'src/jan_mcp_commander/media-manifest.json'
    media_relative='src/jan_mcp_commander/media-manifest.json'
    shutil.copy2(media_manifest,destination/'project'/media_relative)
    manifest[media_relative]=digest(media_manifest)
    privacy_relative='src/jan_mcp_commander/privacy-rules.json'
    shutil.copy2(ROOT/privacy_relative,destination/'project'/privacy_relative)
    manifest[privacy_relative]=digest(ROOT/privacy_relative)
    version_file.write_text('__version__ = '+json.dumps(VERSION)+'\n', encoding='utf-8')
    manifest['src/jan_mcp_commander/__init__.py'] = digest(version_file)
    for source in sorted((ROOT / 'src/jan_mcp_commander/skill_data').rglob('*')):
        if source.is_file() and source.suffix in {'.md', '.yaml'}:
            relative = source.relative_to(ROOT).as_posix()
            target = destination / 'project' / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
            manifest[relative] = digest(source)
    for filename in sorted(source.name for source in (ROOT / 'deploy/npm/jan-commander/bin').glob('*.cjs')):
        source = ROOT / "deploy/npm/jan-commander/bin" / filename
        for relative in ("bin/" + filename, "project/deploy/npm/jan-commander/bin/" + filename):
            target = destination / relative
            shutil.copy2(source, target)
        manifest["bin/" + filename] = digest(source)
        manifest["deploy/npm/jan-commander/bin/" + filename] = digest(source)
    agent_metadata = destination / "project/deploy/npm/jan-commander/package.json"
    agent_package = json.loads((ROOT / "deploy/npm/jan-commander/package.json").read_text(encoding="utf-8"))
    agent_package["version"] = VERSION
    agent_metadata.write_text(json.dumps(agent_package, indent=2) + "\n", encoding="utf-8")
    manifest["deploy/npm/jan-commander/package.json"] = digest(agent_metadata)
    task_source = ROOT / "deploy/mcp-task-server"
    subprocess.run(["npm.cmd", "run", "build"], cwd=task_source, check=True)
    task_target = destination / "project/deploy/mcp-task-server"
    (task_target / "dist").mkdir(parents=True, exist_ok=True)
    for source in sorted((task_source / "dist").glob("*.js")):
        if source.name.endswith(".test.js"):
            continue
        target = task_target / "dist" / source.name
        shutil.copy2(source, target)
        manifest[target.relative_to(destination / "project").as_posix()] = digest(source)
    if not (task_target / "dist/main.js").is_file():
        raise ValueError("Task MCP server build did not produce main.js")
    (task_target / "package.json").write_text('{"type":"module"}\n', encoding="utf-8")
    manifest["deploy/mcp-task-server/package.json"] = digest(task_target / "package.json")
    package = {
        "name": NAME,
        "version": VERSION,
        "description": "PC Remote Commander Windows beta with bundled Python runtime",
        "license": "SEE LICENSE IN LICENSE.txt",
        "bin": {NAME: "bin/npx-onboard.cjs"},
        "os": ["win32"],
        "engines": {"node": ">=20"},
        "dependencies": {"ws": "8.22.0", **json.loads((task_source / "package.json").read_text(encoding="utf-8"))["dependencies"]},
        "bundleDependencies": ["ws", "@modelcontextprotocol/server", "@modelcontextprotocol/client", "@modelcontextprotocol/node", "zod"],
        "publishConfig": {"access": "public", "tag": "beta"},
        "files": ["bin", "project", "runtime", "SOURCE-MANIFEST.json"],
    }
    (destination / "package.json").write_text(json.dumps(package, indent=2) + "\n", encoding="utf-8")
    shutil.copy2(ROOT / "deploy/npm/launcher/LICENSE.txt", destination / "LICENSE.txt")
    (destination / "README.md").write_text(
        "# PC Remote Commander Windows beta\n\n"
        "Windows 10/11 and Node.js 20+ are required. This beta connects to the public PCRC service "
        "with GitHub or verified email sign-in. It is not production certification.\n\n"
        "Run `npx pcremotecommander@beta setup` in PowerShell or Command Prompt. "
        "The small npm launcher verifies this versioned archive and installs its bundled Python runtime "
        "under LocalAppData and opens a browser to review full computer control "
        "for device approval. Keep the terminal open while using the computer remotely.\n\n"
        "The npm package contains executable desktop-control code. Review permissions on the "
        "approval page before pairing. Full control also requires pcrc:control OAuth consent. "
        "Release acceptance applies only to the versions and operations documented in the test report.\n",
        encoding="utf-8",
    )
    (destination / "SOURCE-MANIFEST.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return {"destination": str(destination), "name": NAME, "version": VERSION, "verified_files": len(manifest)}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("base", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    print(json.dumps(build(args.base, args.destination), indent=2))
