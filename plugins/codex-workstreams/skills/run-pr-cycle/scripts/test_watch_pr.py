#!/usr/bin/env python3
"""Regression tests for the pull-request monitor."""

from __future__ import annotations

import importlib.util
import io
import json
import unittest
from contextlib import redirect_stdout
from pathlib import Path


SCRIPT = Path(__file__).with_name("watch_pr.py")
SPEC = importlib.util.spec_from_file_location("watch_pr", SCRIPT)
assert SPEC and SPEC.loader
watch_pr = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(watch_pr)


def snapshot(**overrides: object) -> dict[str, object]:
    value: dict[str, object] = {
        "pull_request": {
            "merged_at": None,
            "merge_commit": None,
            "state": "OPEN",
            "mergeable": "MERGEABLE",
            "review_decision": "",
        },
        "conversation_comments": [],
        "reviews": [],
        "inline_comments": [],
        "checks": [],
        "ci_state": "pending",
    }
    value.update(overrides)
    return value


class WatchPrTest(unittest.TestCase):
    def test_baseline_records_existing_discussion_without_returning_activity(self) -> None:
        current = snapshot(
            conversation_comments=[{"id": "1", "author": "reviewer", "body": "old"}],
            reviews=[{"id": "2", "author": "reviewer", "body": "old", "state": "COMMENTED"}],
            inline_comments=[{"id": "3", "author": "reviewer", "body": "old"}],
        )

        self.assertEqual(watch_pr.baseline_events(current), [])

    def test_baseline_returns_current_merged_state(self) -> None:
        current = snapshot(
            pull_request={
                "merged_at": "2026-05-31T01:21:52Z",
                "merge_commit": "abc123",
                "state": "MERGED",
                "mergeable": "UNKNOWN",
                "review_decision": "",
            }
        )

        self.assertEqual(
            watch_pr.baseline_events(current),
            [{"type": "merged", "merge_commit": "abc123"}],
        )

    def test_new_bot_conversation_comment_is_not_actionable(self) -> None:
        previous = snapshot()
        current = snapshot(
            conversation_comments=[{"id": "1", "author": "vercel[bot]", "body": "deployed"}]
        )

        self.assertEqual(watch_pr.diff(previous, current), [])

    def test_new_human_conversation_comment_is_actionable(self) -> None:
        previous = snapshot()
        comment = {"id": "1", "author": "reviewer", "body": "please adjust this"}
        current = snapshot(conversation_comments=[comment])

        self.assertEqual(
            watch_pr.diff(previous, current),
            [{"type": "new_conversation_comment", "conversation_comment": comment}],
        )

    def test_output_explains_initial_merged_state(self) -> None:
        stream = io.StringIO()
        with redirect_stdout(stream):
            watch_pr.output(
                "activity",
                "https://github.com/org/repo/pull/1",
                [{"type": "merged", "merge_commit": "abc123"}],
                Path("/tmp/state.json"),
                "initial_snapshot",
            )

        payload = json.loads(stream.getvalue())
        self.assertEqual(payload["action_types"], ["merged"])
        self.assertEqual(payload["observation"], "initial_snapshot")
        self.assertIn("Continue the next approved workstream phase", payload["attention"])

if __name__ == "__main__":
    unittest.main()
