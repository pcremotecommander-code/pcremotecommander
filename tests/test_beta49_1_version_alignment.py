import json
import re
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NPM_VERSION = "0.7.0-beta.49.1"
PYTHON_VERSION = "0.7.0b49.post1"


def test_current_release_docs_use_beta49_1_and_single_assistant_semantics():
    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    skills = (ROOT / "docs/skills.md").read_text(encoding="utf-8")
    assert "Current product release: PCRC Beta.49.1" in readme
    assert "one active task assignment" in readme
    assert "TASK_CONFLICT" in readme
    assert "0.7.0-beta.49.1" in skills
    assert "0.7.0-beta.48" not in skills


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

    worker_release = (ROOT / "deploy/cloudflare/worker/src/release.ts").read_text(encoding="utf-8")
    portal_ui = (ROOT / "deploy/cloudflare/worker/src/portal_ui.ts").read_text(encoding="utf-8")
    worker_index = (ROOT / "deploy/cloudflare/worker/src/index.ts").read_text(encoding="utf-8")
    assert "PCRC_RELEASE_VERSION = '0.7.0-beta.49.1'" in worker_release
    assert "PCRC_RELEASE_LABEL = 'Beta.49.1'" in worker_release
    assert "PCRC_RELEASE_LABEL" in portal_ui
    assert "version:PCRC_RELEASE_VERSION" in worker_index

    worker_package = json.loads((ROOT / "deploy/cloudflare/worker/package.json").read_text(encoding="utf-8"))
    worker_lock = json.loads((ROOT / "deploy/cloudflare/worker/package-lock.json").read_text(encoding="utf-8"))
    assert worker_package["version"] == NPM_VERSION
    assert worker_lock["version"] == NPM_VERSION
    assert worker_lock["packages"][""]["version"] == NPM_VERSION

    task_package = json.loads((ROOT / "deploy/mcp-task-server/package.json").read_text(encoding="utf-8"))
    task_lock = json.loads((ROOT / "deploy/mcp-task-server/package-lock.json").read_text(encoding="utf-8"))
    assert task_package["dependencies"]["hono"] == "4.13.22"
    assert task_package["dependencies"]["@hono/node-server"] == "2.1.11"
    assert task_lock["packages"]["node_modules/hono"]["version"] == "4.13.22"
    assert task_lock["packages"]["node_modules/@hono/node-server"]["version"] == "2.1.11"
