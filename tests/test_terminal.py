import json
import sys
import pytest
from jan_mcp_commander.core import Commander, PermissionDenied


@pytest.fixture
def cmd(tmp_path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "hello.txt").write_text("hi")
    return Commander(workspace, tmp_path / "logs" / "audit.jsonl")


def test_profiles_exposed(cmd):
    assert "list_workspace" in cmd.status()["terminal_profiles"]
    assert cmd.status()["remote_enabled"] is False


@pytest.mark.skipif(sys.platform == 'win32', reason='Legacy Commander profile runner uses POSIX pipes; PortableCommander is Windows-supported')
def test_list_profile(cmd):
    result = cmd.run_profile("list_workspace")
    assert result["exit_code"] == 0
    assert "hello.txt" in result["output"]
    assert not result["timed_out"]


@pytest.mark.skipif(sys.platform == 'win32', reason='Legacy Commander profile runner uses POSIX pipes; PortableCommander is Windows-supported')
def test_disk_profile(cmd):
    assert cmd.run_profile("disk_usage")["exit_code"] == 0


@pytest.mark.parametrize("name", ["bash", "echo", "sudo", "rm -rf /", "list_workspace; id", "../bin/ls", ""])
def test_reject_unknown_profiles(cmd, name):
    with pytest.raises(PermissionDenied):
        cmd.run_profile(name)


@pytest.mark.parametrize("timeout", [-1, 0, 11, 1.3, "5", True])
def test_reject_invalid_timeouts(cmd, timeout):
    with pytest.raises(PermissionDenied):
        cmd.run_profile("list_workspace", timeout)


@pytest.mark.skipif(sys.platform == 'win32', reason='Legacy Commander profile runner uses POSIX pipes; PortableCommander is Windows-supported')
def test_audit_records_profile(cmd):
    cmd.run_profile("list_workspace")
    records = [json.loads(line) for line in cmd.audit_path.read_text().splitlines()]
    assert records[-1]["action"] == "run_profile"
    assert records[-1]["ok"]


def test_fail_closed_audit(cmd):
    from pathlib import Path
    cmd.audit_path = Path("/dev/null/denied")
    with pytest.raises(PermissionDenied):
        cmd.run_profile("list_workspace")
