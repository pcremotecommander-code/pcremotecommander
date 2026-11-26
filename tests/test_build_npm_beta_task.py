"""The public beta package must carry the task MCP used by its launcher."""
import hashlib
import json
from pathlib import Path
import sys
import os
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from build_npm_beta import build  # noqa: E402


@pytest.mark.skipif(os.name != 'nt', reason='Windows runtime packager uses npm.cmd and Windows wheel layout')
def test_beta_package_contains_task_server_and_runtime_dependencies(tmp_path,monkeypatch):
    from zipfile import ZipFile
    import build_npm_beta
    monkeypatch.setattr(build_npm_beta, "install_bundle_dependencies", lambda destination: None)
    wheel=tmp_path/'synthetic-pdf.whl'
    with ZipFile(wheel,'w') as archive:archive.writestr('pypdf/__init__.py','# synthetic dependency fixture')
    monkeypatch.setattr(build_npm_beta,'PDF_WHEEL',wheel)
    monkeypatch.setattr(build_npm_beta,'PDF_SHA256',hashlib.sha256(wheel.read_bytes()).hexdigest())
    pillow=tmp_path/'synthetic-pillow.whl'
    with ZipFile(pillow,'w') as archive:archive.writestr('PIL/__init__.py','__version__="13.0.0"')
    monkeypatch.setattr(build_npm_beta,'PILLOW_WHEEL',pillow)
    monkeypatch.setattr(build_npm_beta,'PILLOW_SHA256',hashlib.sha256(pillow.read_bytes()).hexdigest())
    pdfium=tmp_path/'synthetic-renderer.whl'
    with ZipFile(pdfium,'w') as archive:
        archive.writestr('pypdfium2/__init__.py','# synthetic renderer')
        archive.writestr('pypdfium2_cfg/__init__.py','# synthetic configuration')
        archive.writestr('pypdfium2-5.14.0.dist-info/licenses/LICENSES/BSD-3-Clause.txt','Synthetic license fixture')
    monkeypatch.setattr(build_npm_beta,'PDFIUM_WHEEL',pdfium)
    monkeypatch.setattr(build_npm_beta,'PDFIUM_SHA256',hashlib.sha256(pdfium.read_bytes()).hexdigest())
    base = tmp_path / "base"
    source = base / "project" / "pyproject.toml"
    source.parent.mkdir(parents=True)
    source.write_text("[project]\n", encoding="utf-8")
    (base / "SOURCE-MANIFEST.json").write_text(
        json.dumps({"pyproject.toml": hashlib.sha256(source.read_bytes()).hexdigest()}), encoding="utf-8"
    )
    (base / "bin").mkdir()
    (base / "project/deploy/npm/jan-commander/bin").mkdir(parents=True)
    obsolete=base/'runtime/Lib/site-packages/PIL/obsolete.py';obsolete.parent.mkdir(parents=True);obsolete.write_text('obsolete')
    old_metadata=base/'runtime/Lib/site-packages/pillow-12.3.0.dist-info/METADATA';old_metadata.parent.mkdir();old_metadata.write_text('old')
    manifest_path=base/'SOURCE-MANIFEST.json';original=json.loads(manifest_path.read_text())
    for file in [obsolete,old_metadata]:original[file.relative_to(base).as_posix()]=hashlib.sha256(file.read_bytes()).hexdigest()
    manifest_path.write_text(json.dumps(original))
    cache=base/"project/src/jan_mcp_commander/__pycache__";cache.mkdir(parents=True)
    (cache/"stale.pyc").write_bytes(b"unlisted stale bytecode")
    destination = tmp_path / "package"
    build(base, destination)
    package = json.loads((destination / "package.json").read_text(encoding="utf-8"))
    assert not list(destination.rglob("*.pyc"))
    assert package["version"] == build_npm_beta.VERSION
    assert package["overrides"] == {"hono": "4.13.22", "@hono/node-server": "2.1.11"}
    assert package["license"] == "SEE LICENSE IN LICENSE.txt"
    assert (destination / "LICENSE.txt").read_bytes() == (ROOT / "deploy/npm/launcher/LICENSE.txt").read_bytes()
    assert build_npm_beta.VERSION in (destination / "project/src/jan_mcp_commander/__init__.py").read_text()
    assert (destination/'runtime/Lib/site-packages/pypdfium2_cfg/__init__.py').is_file()
    assert (destination/'runtime/Lib/site-packages/pypdfium2-5.14.0.dist-info/licenses/LICENSES/BSD-3-Clause.txt').is_file()
    assert (destination/'project/docs/document-workflow.md').is_file()
    assert (destination/'runtime/Lib/site-packages/pypdf/__init__.py').is_file()
    assert '13.0.0' in (destination/'runtime/Lib/site-packages/PIL/__init__.py').read_text()
    assert not (destination/'runtime/Lib/site-packages/PIL/obsolete.py').exists()
    assert not (destination/'runtime/Lib/site-packages/pillow-12.3.0.dist-info').exists()
    assert (destination/'project/src/jan_mcp_commander/media-manifest.json').is_file()
    for filename in ['safe_fs.py', 'errors.py', 'control.py', 'windows_uia.py', 'office_documents.py','document_workflow.py','document_pdf.py','document_formats.py','_document_worker.py','foreground.py','environment.py','portable.py']:
        assert (destination / 'project/src/jan_mcp_commander' / filename).read_bytes() == (ROOT / 'src/jan_mcp_commander' / filename).read_bytes()
    assert (destination / "project/deploy/mcp-task-server/dist/main.js").is_file()
    assert package["dependencies"]["@modelcontextprotocol/server"] == "2.4.0"
    assert package["dependencies"]["@modelcontextprotocol/client"] == "2.4.0"
    assert package["dependencies"]["@modelcontextprotocol/node"] == "2.1.2"
    assert package["dependencies"]["zod"] == "4.6.7"
    assert (destination / "bin/relay-agent.cjs").read_bytes() == (
        ROOT / "deploy/npm/jan-commander/bin/relay-agent.cjs"
    ).read_bytes()

    metadata = json.loads((destination / "project/deploy/npm/jan-commander/package.json").read_text())
    assert metadata["version"] == package["version"]

    skill = 'src/jan_mcp_commander/skill_data/pcrc-computer-use/SKILL.md'
    assert (destination / 'project' / skill).read_bytes() == (ROOT / skill).read_bytes()
    manifest = json.loads((destination / 'SOURCE-MANIFEST.json').read_text())
    assert manifest[skill] == hashlib.sha256((ROOT / skill).read_bytes()).hexdigest()
