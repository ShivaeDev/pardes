#!/usr/bin/env python3
"""Create, inspect, and reap stale Codex-managed Git worktrees."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Sequence


DEFAULT_MAX_AGE_DAYS = 7


def run_git(repo: Path, args: Sequence[str], check: bool = True) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        ["git", *args],
        cwd=repo,
        text=True,
        capture_output=True,
    )
    if check and result.returncode != 0:
        detail = (result.stderr or result.stdout).strip()
        raise RuntimeError(f"git {' '.join(args)} failed: {detail}")
    return result


def git_root(repo: Path) -> Path:
    result = run_git(repo, ["rev-parse", "--show-toplevel"])
    return Path(result.stdout.strip()).resolve()


def slug(value: str) -> str:
    normalized = re.sub(r"[^a-zA-Z0-9._-]+", "-", value).strip("-")
    if not normalized or normalized in {".", ".."}:
        raise ValueError(f"invalid slug: {value!r}")
    return normalized


def managed_root(repo: Path, explicit: str | None) -> Path:
    if explicit:
        return Path(explicit).expanduser().resolve()
    return git_root(repo) / ".worktrees"


def git_common_dir(repo: Path) -> Path:
    root = git_root(repo)
    raw = Path(run_git(root, ["rev-parse", "--git-common-dir"]).stdout.strip())
    return raw.resolve() if raw.is_absolute() else (root / raw).resolve()


def primary_checkout(repo: Path) -> Path:
    common_dir = git_common_dir(repo)
    if common_dir.name != ".git":
        raise RuntimeError(f"expected a non-bare repository with a .git common directory: {common_dir}")
    return common_dir.parent


def ensure_local_exclude(repo: Path) -> Path:
    exclude = git_common_dir(repo) / "info" / "exclude"
    pattern = "/.worktrees/"
    exclude.parent.mkdir(parents=True, exist_ok=True)
    content = exclude.read_text() if exclude.exists() else ""
    if pattern not in content.splitlines():
        separator = "" if not content or content.endswith("\n") else "\n"
        exclude.write_text(f"{content}{separator}{pattern}\n")
    return exclude


def ensure_under(path: Path, parent: Path) -> None:
    try:
        path.relative_to(parent)
    except ValueError as exc:
        raise RuntimeError(f"path is outside managed root {parent}: {path}") from exc


def worktree_status(path: Path) -> dict[str, Any]:
    root = git_root(path)
    status = run_git(root, ["status", "--porcelain=v1", "--untracked-files=all"]).stdout.splitlines()
    return {
        "path": str(path.resolve()),
        "git_root": str(root),
        "git_dir": run_git(root, ["rev-parse", "--git-dir"]).stdout.strip(),
        "git_common_dir": run_git(root, ["rev-parse", "--git-common-dir"]).stdout.strip(),
        "branch": run_git(root, ["branch", "--show-current"]).stdout.strip(),
        "head": run_git(root, ["rev-parse", "HEAD"]).stdout.strip(),
        "clean": not status,
        "status": status,
    }


def current_worktree() -> Path | None:
    try:
        return git_root(Path.cwd())
    except RuntimeError:
        return None


def reap_stale_worktrees(repo: Path, root: Path, max_age_days: int) -> dict[str, list[str]]:
    if max_age_days < 0:
        raise ValueError("max age days must be zero or greater")

    cutoff = int(time.time()) - max_age_days * 86400
    here = current_worktree()
    reaped: list[str] = []
    kept_dirty: list[str] = []
    output = run_git(repo, ["worktree", "list", "--porcelain"]).stdout
    for line in output.splitlines():
        if not line.startswith("worktree "):
            continue
        path = Path(line.removeprefix("worktree ")).resolve()
        try:
            path.relative_to(root)
        except ValueError:
            continue
        if path == here:
            continue
        if not path.exists():
            continue
        details = worktree_status(path)
        if not details["clean"]:
            kept_dirty.append(str(path))
            continue
        tip = int(run_git(path, ["log", "-1", "--format=%ct"]).stdout.strip())
        if tip < cutoff:
            run_git(repo, ["worktree", "remove", str(path)])
            reaped.append(str(path))

    run_git(repo, ["worktree", "prune"], check=False)
    return {"reaped_worktrees": reaped, "kept_dirty_worktrees": kept_dirty}


def create(args: argparse.Namespace) -> dict[str, Any]:
    repo = primary_checkout(Path(args.repo).expanduser())
    root = managed_root(repo, args.root)
    cleanup = reap_stale_worktrees(repo, root, args.max_age_days)
    path = root / slug(args.workstream) / slug(args.worker)
    path = path.resolve()
    ensure_under(path, root)
    if path.exists():
        raise RuntimeError(f"worktree path already exists: {path}")

    exclude = ensure_local_exclude(repo)
    path.parent.mkdir(parents=True, exist_ok=True)
    branch = args.branch
    branch_exists = (
        run_git(repo, ["show-ref", "--verify", "--quiet", f"refs/heads/{branch}"], check=False).returncode
        == 0
    )
    if branch_exists:
        run_git(repo, ["worktree", "add", str(path), branch])
        action = "attached"
    else:
        if not args.base or not re.fullmatch(r"[0-9a-fA-F]{40}", args.base):
            raise RuntimeError("new branches require --base with a full commit SHA")
        run_git(repo, ["rev-parse", "--verify", f"{args.base}^{{commit}}"])
        run_git(repo, ["worktree", "add", "-b", branch, str(path), args.base])
        action = "created"

    return {
        "action": action,
        "repo": str(repo),
        "managed_root": str(root),
        "local_exclude": str(exclude),
        **cleanup,
        **worktree_status(path),
    }


def status(args: argparse.Namespace) -> dict[str, Any]:
    path = Path(args.path).expanduser().resolve()
    return {"action": "status", **worktree_status(path)}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    create_parser = subparsers.add_parser("create", help="create a managed linked worktree")
    create_parser.add_argument("--repo", required=True, help="path inside the repository")
    create_parser.add_argument("--workstream", required=True, help="workstream slug")
    create_parser.add_argument("--worker", required=True, help="worker slug")
    create_parser.add_argument("--branch", required=True, help="branch for the linked worktree")
    create_parser.add_argument("--base", help="full branch-point SHA, required when creating a new branch")
    create_parser.add_argument("--root", help="override the managed worktree root")
    create_parser.add_argument(
        "--max-age-days",
        type=int,
        default=DEFAULT_MAX_AGE_DAYS,
        help=f"reap clean managed worktrees older than this many days before creation (default: {DEFAULT_MAX_AGE_DAYS})",
    )
    create_parser.set_defaults(handler=create)

    status_parser = subparsers.add_parser("status", help="inspect a linked worktree")
    status_parser.add_argument("--path", required=True, help="linked worktree path")
    status_parser.set_defaults(handler=status)

    return parser.parse_args()


def main() -> int:
    try:
        args = parse_args()
        print(json.dumps(args.handler(args), indent=2, sort_keys=True))
        return 0
    except (RuntimeError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
