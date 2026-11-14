from pathlib import Path
import pytest
from jan_mcp_commander.core import Commander, PermissionDenied


@pytest.fixture
def setup(tmp_path):
    root = tmp_path / "workspace"
    root.mkdir()
    (root / "hello.txt").write_text("hello JAN", encoding="utf-8")
    audit = tmp_path / "state" / "audit.jsonl"
    return Commander(root, audit), root, audit


def test_status(setup):
    cmd, _, audit = setup
    assert cmd.status()["remote_enabled"] is False
    assert audit.exists()


def test_list_and_read(setup):
    cmd, _, _ = setup
    assert "hello.txt" in [x["name"] for x in cmd.list_files()["entries"]]
    assert cmd.read_text("hello.txt")["content"] == "hello JAN"


def test_escape_parent_rejected(setup):
    cmd, _, _ = setup
    with pytest.raises(PermissionDenied):
        cmd.read_text("../outside.txt")


def test_absolute_path_rejected(setup):
    cmd, _, _ = setup
    with pytest.raises(PermissionDenied):
        cmd.read_text("/etc/passwd")


def test_symlink_escape_blocked(setup, tmp_path):
    cmd, root, _ = setup
    target = tmp_path / "secret.txt"
    target.write_text("secret")
    try:(root / "escape.txt").symlink_to(target)
    except OSError as exc:
        if getattr(exc,'winerror',None)==1314:pytest.skip('Windows user lacks symlink creation privilege')
        raise
    with pytest.raises(PermissionDenied):
        cmd.read_text("escape.txt")
    assert "escape.txt" not in [x["name"] for x in cmd.list_files()["entries"]]


def test_binary_rejected(setup):
    cmd, root, _ = setup
    (root / "binary.bin").write_bytes(b"a\x00b")
    with pytest.raises(PermissionDenied):
        cmd.read_text("binary.bin")


def test_large_rejected(setup):
    cmd, root, _ = setup
    (root / "large.txt").write_bytes(b"a" * 65537)
    with pytest.raises(PermissionDenied):
        cmd.read_text("large.txt")


def test_diagnostic_allowlist(setup):
    cmd, _, _ = setup
    assert "Python" in cmd.diagnostic("python_version")["output"]
    with pytest.raises(PermissionDenied):
        cmd.diagnostic("rm -rf /")


def test_audit_fail_closed(setup):
    cmd, _, _ = setup
    cmd.audit_path = Path("/dev/null/jan-audit")
    with pytest.raises(PermissionDenied):
        cmd.status()
