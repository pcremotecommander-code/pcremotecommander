"""Stage a private, self-contained npx preview candidate without publishing it."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import zipfile

from build_source_preview import ROOT, sources


EMBED_SHA256 = "a93abe456ab01bd96d7a085b3cdb6566b3063f4241360d114142fbdb07f0a310"


def add_runtime(destination: Path, embedded_zip: Path, manifest: dict) -> None:
    if hashlib.sha256(embedded_zip.read_bytes()).hexdigest() != EMBED_SHA256:
        raise ValueError("Embedded Python SHA-256 does not match the official 3.14.8 x64 release")
    runtime = destination / "runtime"
    runtime.mkdir()
    with zipfile.ZipFile(embedded_zip) as archive:
        for member in archive.infolist():
            target = (runtime / member.filename).resolve()
            if not target.is_relative_to(runtime.resolve()) or member.is_dir() and ".." in Path(member.filename).parts:
                raise ValueError("Unsafe embedded Python archive path")
        archive.extractall(runtime)
    site_packages = runtime / "Lib" / "site-packages"
    site_packages.mkdir(parents=True)
    subprocess.run(
        [sys.executable, "-m", "pip", "install", "--disable-pip-version-check", "--no-cache-dir", "--no-compile", "--target", str(site_packages),
         "mcp==2.3.0", "cryptography==50.0.2", "uvicorn==0.54.0", "pywin32==312", "playwright==1.64.0", "Pillow==12.3.0", "PyAutoGUI==0.9.54"],
        cwd=ROOT, check=True,
    )
    (runtime / "python314._pth").write_text(
        "python314.zip\n.\nLib\\site-packages\nLib\\site-packages\\win32\n"
        "Lib\\site-packages\\win32\\lib\nLib\\site-packages\\Pythonwin\n..\\..\\src\nimport site\n",
        encoding="utf-8",
    )
    for file in runtime.rglob("*"):
        if file.is_file():
            manifest[file.relative_to(destination).as_posix()] = hashlib.sha256(file.read_bytes()).hexdigest()


def build(destination: Path, embedded_zip: Path) -> dict:
    destination = destination.resolve()
    if destination.exists():
        raise FileExistsError(destination)
    destination.mkdir(parents=True)
    project = destination / "project"
    manifest = {}
    for source in sources():
        relative = source.relative_to(ROOT)
        if relative.name.startswith("2026.10.0-jan.1-cloudflared-linux-"):
            continue  # Windows preview does not use the Linux tunnel binaries.
        target = project / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
        manifest[relative.as_posix()] = hashlib.sha256(target.read_bytes()).hexdigest()
    launcher = ROOT / "deploy/npm/jan-commander/bin"
    for filename in ("npx-onboard.cjs", "pair-device.cjs", "relay-agent.cjs", "resolve-session.cjs"):
        source = launcher / filename
        target = destination / "bin" / filename
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
        manifest["bin/" + filename] = hashlib.sha256(target.read_bytes()).hexdigest()
    add_runtime(destination, embedded_zip, manifest)
    package = {
        "name": "pc-remote-commander-preview",
        "version": "0.7.0-rc.3",
        "private": True,
        "description": "Private Windows npx candidate for PC Remote Commander",
        "bin": {"pc-remote-commander": "bin/npx-onboard.cjs"},
        "os": ["win32"],
        "engines": {"node": ">=20"},
        "dependencies": {"ws": "8.22.0"},
        "files": ["bin", "project", "runtime", "SOURCE-MANIFEST.json"],
    }
    (destination / "package.json").write_text(json.dumps(package, indent=2) + "\n", encoding="utf-8")
    (destination / "README.md").write_text(
        "# PC Remote Commander private npx candidate\n\n"
        "This package is not published. It bundles the Windows source preview and a Python runtime. "
        "It requires Node.js 20+ and an internet connection for the first npx download. "
        "npx caches the package; the bundled Python runtime is copied to the user's LocalAppData. "
        "The agent opens the staging approval page and remains active only while its terminal is open.\n",
        encoding="utf-8",
    )
    (destination / "SOURCE-MANIFEST.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return {"path": str(destination), "files": len(manifest), "package": package["name"] + "@" + package["version"]}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("destination", type=Path)
    parser.add_argument("--embedded-python-zip", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(build(args.destination, args.embedded_python_zip), indent=2))
