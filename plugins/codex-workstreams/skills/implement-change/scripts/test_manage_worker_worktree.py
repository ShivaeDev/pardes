#!/usr/bin/env python3
"""Regression tests for managed worker worktrees."""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("manage_worker_worktree.py")


def run(
    command: list[str],
    cwd: Path,
    env: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, cwd=cwd, env=env, text=True, capture_output=True)


class ManageWorkerWorktreeTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.repo = Path(self.temp.name) / "repo"
        self.repo.mkdir()
        run(["git", "init", "-b", "main"], self.repo).check_returncode()
        run(["git", "config", "user.email", "codex@example.com"], self.repo).check_returncode()
        run(["git", "config", "user.name", "Codex"], self.repo).check_returncode()
        (self.repo / "README.md").write_text("fixture\n")
        run(["git", "add", "README.md"], self.repo).check_returncode()
        run(["git", "commit", "-m", "fixture"], self.repo).check_returncode()
        self.head = run(["git", "rev-parse", "HEAD"], self.repo).stdout.strip()

    def tearDown(self) -> None:
        self.temp.cleanup()

    def helper(self, *args: str) -> subprocess.CompletedProcess[str]:
        return run(["python3", str(SCRIPT), *args], self.repo)

    def add_stale_worktree(self, worker: str, branch: str, dirty: bool = False) -> Path:
        path = self.repo / ".worktrees" / "stale" / worker
        run(["git", "worktree", "add", "-b", branch, str(path), self.head], self.repo).check_returncode()
        env = {
            **os.environ,
            "GIT_AUTHOR_DATE": "2000-01-01T00:00:00Z",
            "GIT_COMMITTER_DATE": "2000-01-01T00:00:00Z",
        }
        run(["git", "commit", "--allow-empty", "-m", "stale"], path, env=env).check_returncode()
        if dirty:
            (path / "DIRTY").write_text("keep\n")
        return path.resolve()

    def test_new_branch_requires_full_sha(self) -> None:
        result = self.helper(
            "create",
            "--repo",
            str(self.repo),
            "--workstream",
            "demo",
            "--worker",
            "one",
            "--branch",
            "feature",
        )

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("new branches require --base with a full commit SHA", result.stderr)

    def test_new_branch_is_created_and_existing_branch_is_attached(self) -> None:
        created = self.helper(
            "create",
            "--repo",
            str(self.repo),
            "--workstream",
            "demo",
            "--worker",
            "one",
            "--branch",
            "feature",
            "--base",
            self.head,
        )
        created.check_returncode()
        self.assertEqual(json.loads(created.stdout)["action"], "created")

        run(["git", "branch", "existing", self.head], self.repo).check_returncode()
        attached = self.helper(
            "create",
            "--repo",
            str(self.repo),
            "--workstream",
            "demo",
            "--worker",
            "two",
            "--branch",
            "existing",
        )
        attached.check_returncode()
        self.assertEqual(json.loads(attached.stdout)["action"], "attached")

    def test_linked_repo_argument_still_uses_primary_managed_root(self) -> None:
        first = self.helper(
            "create",
            "--repo",
            str(self.repo),
            "--workstream",
            "demo",
            "--worker",
            "one",
            "--branch",
            "first",
            "--base",
            self.head,
        )
        first.check_returncode()
        first_path = Path(json.loads(first.stdout)["path"])

        second = self.helper(
            "create",
            "--repo",
            str(first_path),
            "--workstream",
            "demo",
            "--worker",
            "two",
            "--branch",
            "second",
            "--base",
            self.head,
        )
        second.check_returncode()
        self.assertEqual(
            Path(json.loads(second.stdout)["path"]),
            self.repo.resolve() / ".worktrees" / "demo" / "two",
        )

    def test_create_reaps_clean_managed_worktree_older_than_seven_days(self) -> None:
        stale_path = self.add_stale_worktree("old", "stale-clean")

        result = self.helper(
            "create",
            "--repo",
            str(self.repo),
            "--workstream",
            "demo",
            "--worker",
            "new",
            "--branch",
            "fresh",
            "--base",
            self.head,
        )
        result.check_returncode()

        self.assertIn(str(stale_path), json.loads(result.stdout)["reaped_worktrees"])
        self.assertFalse(stale_path.exists())
        self.assertEqual(
            run(["git", "show-ref", "--verify", "--quiet", "refs/heads/stale-clean"], self.repo).returncode,
            0,
        )

    def test_create_keeps_dirty_managed_worktree_older_than_seven_days(self) -> None:
        stale_path = self.add_stale_worktree("dirty", "stale-dirty", dirty=True)

        result = self.helper(
            "create",
            "--repo",
            str(self.repo),
            "--workstream",
            "demo",
            "--worker",
            "new",
            "--branch",
            "fresh",
            "--base",
            self.head,
        )
        result.check_returncode()

        self.assertIn(str(stale_path), json.loads(result.stdout)["kept_dirty_worktrees"])
        self.assertTrue(stale_path.exists())


if __name__ == "__main__":
    unittest.main()
