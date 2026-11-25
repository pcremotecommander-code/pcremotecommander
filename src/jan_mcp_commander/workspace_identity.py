"""Read-only, local discovery of the Git workspace containing a PCRC path.

This reports hints for a later authorization check; it does not grant access.
"""
from __future__ import annotations

import os
from pathlib import Path
import re
import subprocess
from urllib.parse import urlsplit

from .safe_fs import parts

_GITHUB_REPOSITORY = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")


def _git(root: Path, *args: str) -> str | None:
    env = {
        "PATH": os.environ.get("PATH", ""),
        "HOME": str(root),
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": os.devnull,
        "GIT_OPTIONAL_LOCKS": "0",
        "GIT_TERMINAL_PROMPT": "0",
        "GIT_NO_LAZY_FETCH": "1",
    }
    try:
        result = subprocess.run(
            ["git", "-C", str(root), *args],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=2,
            check=False,
            env=env,
            shell=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    return result.stdout.strip() if result.returncode == 0 else None


def workspace_identity(workspace: Path, relative_path: str = ".") -> dict:
    """Resolve Git root/branch locally without accepting caller-supplied identity."""
    root = Path(workspace).resolve(strict=True)
    names = parts(relative_path)
    target = root.joinpath(*names).resolve(strict=False)
    if target != root and root not in target.parents:
        raise ValueError("Workspace path escapes the configured root")

    git_root_text = _git(target if target.is_dir() else target.parent, "rev-parse", "--show-toplevel")
    if not git_root_text:
        return {
            "is_git": False,
            "repository": None,
            "branch": None,
            "path": relative_path,
            "identity_verified": False,
        }

    git_root = Path(git_root_text).resolve(strict=True)
    if target != git_root and git_root not in target.parents:
        raise ValueError("Git root does not contain the requested workspace path")

    branch = _git(git_root, "symbolic-ref", "--quiet", "--short", "HEAD")
    branch = branch if branch and branch not in {".", ".."} and not branch.startswith("-") else None

    remote = _git(git_root, "config", "--local", "--get", "remote.origin.url")
    repository = None
    if remote:
        if remote.startswith("https://") or remote.startswith("http://"):
            parsed = urlsplit(remote)
            if parsed.hostname and parsed.hostname.casefold() == "github.com":
                candidate = parsed.path.strip("/").removesuffix(".git")
                if _GITHUB_REPOSITORY.fullmatch(candidate):
                    repository = candidate
        elif remote.startswith("git@github.com:"):
            candidate = remote[len("git@github.com:"):].removesuffix(".git")
            if _GITHUB_REPOSITORY.fullmatch(candidate):
                repository = candidate

    relative = "." if target == git_root else target.relative_to(git_root).as_posix()
    return {
        "is_git": True,
        "repository": repository,
        "branch": branch,
        "path": relative,
        "identity_verified": bool(repository and branch),
    }
