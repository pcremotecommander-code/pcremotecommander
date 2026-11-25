import subprocess
from pathlib import Path

import pytest

from jan_mcp_commander.workspace_identity import workspace_identity


def git(path: Path, *args: str) -> str:
    result = subprocess.run(["git", "-C", str(path), *args], capture_output=True, text=True, check=True)
    return result.stdout.strip()


def test_reports_local_github_repository_branch_and_relative_path(tmp_path):
    root = tmp_path / "workspace"
    root.mkdir()
    git(root, "init", "-b", "feature/workspace-policy")
    git(root, "config", "user.email", "test@example.invalid")
    git(root, "config", "user.name", "Test")
    git(root, "remote", "add", "origin", "https://github.com/example/project.git")
    (root / "src").mkdir()
    (root / "src" / "main.py").write_text("pass", encoding="utf-8")

    result = workspace_identity(root, "src/main.py")

    assert result == {
        "is_git": True,
        "repository": "example/project",
        "branch": "feature/workspace-policy",
        "path": "src/main.py",
        "identity_verified": True,
    }


def test_non_git_workspace_never_fabricates_repository_or_branch(tmp_path):
    root = tmp_path / "workspace"
    root.mkdir()
    (root / "file.txt").write_text("safe", encoding="utf-8")

    result = workspace_identity(root, "file.txt")

    assert result["is_git"] is False
    assert result["repository"] is None
    assert result["branch"] is None
    assert result["identity_verified"] is False


def test_non_github_remote_is_not_misreported_as_github_identity(tmp_path):
    root = tmp_path / "workspace"
    root.mkdir()
    git(root, "init", "-b", "main")
    git(root, "remote", "add", "origin", "https://gitlab.com/example/project.git")

    result = workspace_identity(root)

    assert result["is_git"] is True
    assert result["repository"] is None
    assert result["branch"] == "main"
    assert result["identity_verified"] is False


def test_rejects_workspace_path_escape(tmp_path):
    root = tmp_path / "workspace"
    root.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()

    with pytest.raises(ValueError, match="Unsafe path|escapes"):
        workspace_identity(root, "../outside")
