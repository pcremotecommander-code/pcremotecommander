"""Build a private Windows source preview without runtime state or credentials."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo


ROOT = Path(__file__).resolve().parents[1]
FILES = (
    "pyproject.toml",
    "requirements-control.lock",
    "README.md",
    "SECURITY.md",
    "Setup-Windows.cmd",
    "Setup-Windows.ps1",
    "PC-Remote-Commander.cmd",
    "JAN-CLI.cmd",
    "Connect-ChatGPT.cmd",
    "Connect-ChatGPT.ps1",
    "scripts/setup_windows.py",
    "scripts/verify_install.py",
    "deploy/npm/jan-commander/package.json",
    "deploy/npm/jan-commander/package-lock.json",
    "docs/development.md",
    "docs/security-model.md",
    "docs/document-workflow.md",
    "docs/device-pairing.md",
)
FOLDERS = ("src/jan_mcp_commander", "deploy/npm/jan-commander/bin")
OMIT_SUFFIXES = {".pyc", ".pyo", ".bak"}


def sources() -> list[Path]:
    items = [ROOT / name for name in FILES]
    for folder in FOLDERS:
        items.extend(path for path in (ROOT / folder).rglob("*") if path.is_file())
    items = sorted((path for path in set(items) if path.suffix.lower() not in OMIT_SUFFIXES and "__pycache__" not in path.parts), key=lambda path: path.as_posix())
    for path in items:
        relative = path.relative_to(ROOT)
        if (not path.is_file() or path.is_symlink() or
                any(part.startswith(".") or part == "__pycache__" for part in relative.parts) or
                any(part.lower() in {"state", "node_modules"} for part in relative.parts)):
            raise ValueError(f"Unsafe or missing source path: {relative}")
    return items


def build(destination: Path) -> dict:
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        raise FileExistsError(destination)
    paths = sources()
    contents = [(path.relative_to(ROOT).as_posix(), path.read_bytes()) for path in paths]
    manifest = {
        "kind": "private-source-preview",
        "version": "0.7.0rc1",
        "standalone": False,
        "files": {name: hashlib.sha256(data).hexdigest() for name, data in contents},
    }
    with ZipFile(destination, "x", ZIP_DEFLATED, compresslevel=6) as archive:
        for name, data in contents + [("SOURCE-MANIFEST.json", json.dumps(manifest, indent=2).encode())]:
            item = ZipInfo(name, (2026, 10, 17, 0, 0, 0))
            item.compress_type = ZIP_DEFLATED
            archive.writestr(item, data)
    return {"path": str(destination), "sha256": hashlib.sha256(destination.read_bytes()).hexdigest(), "files": len(contents)}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("destination", type=Path)
    print(json.dumps(build(parser.parse_args().destination), indent=2))
