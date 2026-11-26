import json
import re
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NPM_VERSION = "0.7.0-beta.49.1"
PYTHON_VERSION = "0.7.0b49.post1"


def test_beta49_1_release_metadata_is_aligned():
    project = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    assert project["project"]["version"] == PYTHON_VERSION

    init = (ROOT / "src/jan_mcp_commander/__init__.py").read_text(encoding="utf-8")
    assert re.search(r'^__version__\s*=\s*["\']' + PYTHON_VERSION + r'["\']$', init, re.M)

    preview = (ROOT / "scripts/build_source_preview.py").read_text(encoding="utf-8")
    assert f'"version": "{PYTHON_VERSION}"' in preview

    builder = (ROOT / "scripts/build_npm_beta.py").read_text(encoding="utf-8")
    assert f'VERSION = "{NPM_VERSION}"' in builder

    package = json.loads((ROOT / "deploy/npm/jan-commander/package.json").read_text(encoding="utf-8"))
    lock = json.loads((ROOT / "deploy/npm/jan-commander/package-lock.json").read_text(encoding="utf-8"))
    assert package["version"] == NPM_VERSION
    assert lock["version"] == NPM_VERSION
    assert lock["packages"][""]["version"] == NPM_VERSION
