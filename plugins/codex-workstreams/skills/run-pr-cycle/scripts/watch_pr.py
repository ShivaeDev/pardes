#!/usr/bin/env python3
"""Wait for batched actionable GitHub pull-request events."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Iterator, Sequence


FAILURE_VALUES = {
    "ACTION_REQUIRED",
    "CANCELLED",
    "ERROR",
    "FAILURE",
    "STARTUP_FAILURE",
    "TIMED_OUT",
}
PASS_VALUES = {"EXPECTED", "NEUTRAL", "SKIPPED", "SUCCESS"}
PR_URL_RE = re.compile(r"^https://github\.com/([^/]+)/([^/]+)/pull/(\d+)(?:/.*)?$")


def now() -> str:
    return datetime.now(UTC).isoformat()


def run_gh(args: Sequence[str]) -> str:
    result = subprocess.run(["gh", *args], text=True, capture_output=True)
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).strip()
        raise RuntimeError(f"gh {' '.join(args)} failed: {detail}")
    return result.stdout


def gh_json(args: Sequence[str]) -> Any:
    output = run_gh(args)
    try:
        return json.loads(output)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"invalid JSON from gh {' '.join(args)}: {exc}") from exc


def paginated_rest(endpoint: str) -> list[dict[str, Any]]:
    pages = gh_json(["api", "--paginate", "--slurp", endpoint])
    items: list[dict[str, Any]] = []
    for page in pages:
        items.extend(page)
    return items


def content_hash(value: Any) -> str:
    raw = json.dumps(value, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(raw.encode()).hexdigest()


def compact_author(item: dict[str, Any]) -> str | None:
    user = item.get("user") or item.get("author") or {}
    return user.get("login")


def normalized_comment(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": str(item["id"]),
        "author": compact_author(item),
        "body": item.get("body") or "",
        "created_at": item.get("created_at"),
        "updated_at": item.get("updated_at"),
        "url": item.get("html_url"),
    }


def normalized_review(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": str(item["id"]),
        "author": compact_author(item),
        "state": item.get("state"),
        "body": item.get("body") or "",
        "submitted_at": item.get("submitted_at"),
        "url": item.get("html_url"),
    }


def normalized_inline_comment(item: dict[str, Any]) -> dict[str, Any]:
    return {
        **normalized_comment(item),
        "review_id": str(item["pull_request_review_id"]) if item.get("pull_request_review_id") else None,
        "path": item.get("path"),
        "line": item.get("line"),
        "original_line": item.get("original_line"),
        "in_reply_to_id": str(item["in_reply_to_id"]) if item.get("in_reply_to_id") else None,
    }


def normalized_check(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "name": item.get("name") or item.get("context"),
        "status": item.get("status"),
        "conclusion": item.get("conclusion"),
        "state": item.get("state"),
        "details_url": item.get("detailsUrl") or item.get("targetUrl"),
        "workflow": item.get("workflowName"),
    }


def ci_state(checks: list[dict[str, Any]]) -> str:
    if not checks:
        return "none"
    values = {
        str(check.get("conclusion") or check.get("state") or check.get("status") or "").upper()
        for check in checks
    }
    if values & FAILURE_VALUES:
        return "failed"
    if values and values <= PASS_VALUES:
        return "passed"
    return "pending"


def snapshot(owner: str, repo: str, number: int, url: str) -> dict[str, Any]:
    meta = gh_json(
        [
            "pr",
            "view",
            url,
            "--json",
            "state,mergedAt,mergeCommit,headRefOid,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,url,number",
        ]
    )
    reviews_raw = paginated_rest(f"repos/{owner}/{repo}/pulls/{number}/reviews?per_page=100")
    reviews = [
        normalized_review(item)
        for item in reviews_raw
        if item.get("state") != "PENDING" and item.get("submitted_at")
    ]
    submitted_review_ids = {review["id"] for review in reviews}
    inline_raw = paginated_rest(f"repos/{owner}/{repo}/pulls/{number}/comments?per_page=100")
    inline_comments = [
        normalized_inline_comment(item)
        for item in inline_raw
        if not item.get("pull_request_review_id")
        or str(item["pull_request_review_id"]) in submitted_review_ids
    ]
    conversation = [
        normalized_comment(item)
        for item in paginated_rest(f"repos/{owner}/{repo}/issues/{number}/comments?per_page=100")
    ]
    checks = [normalized_check(item) for item in meta.get("statusCheckRollup") or []]
    return {
        "fetched_at": now(),
        "pull_request": {
            "owner": owner,
            "repo": repo,
            "number": number,
            "url": meta["url"],
            "state": meta.get("state"),
            "merged_at": meta.get("mergedAt"),
            "merge_commit": (meta.get("mergeCommit") or {}).get("oid"),
            "head_sha": meta.get("headRefOid"),
            "mergeable": meta.get("mergeable"),
            "merge_state_status": meta.get("mergeStateStatus"),
            "review_decision": meta.get("reviewDecision"),
        },
        "conversation_comments": conversation,
        "reviews": reviews,
        "inline_comments": inline_comments,
        "checks": checks,
        "ci_state": ci_state(checks),
    }


def by_id(items: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    return {str(item["id"]): item for item in items}


def changed_items(kind: str, previous: list[dict[str, Any]], current: list[dict[str, Any]]) -> list[dict[str, Any]]:
    old = by_id(previous)
    events: list[dict[str, Any]] = []
    for item_id, item in by_id(current).items():
        if item_id not in old:
            events.append({"type": f"new_{kind}", kind: item})
        elif content_hash(item) != content_hash(old[item_id]):
            events.append({"type": f"updated_{kind}", kind: item})
    return events


def actionable_review(item: dict[str, Any]) -> bool:
    return bool(item.get("body")) or item.get("state") == "CHANGES_REQUESTED"


def bot_authored(item: dict[str, Any]) -> bool:
    return str(item.get("author") or "").lower().endswith("[bot]")


def actionable_item_events(
    kind: str,
    previous: list[dict[str, Any]],
    current: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    events = changed_items(kind, previous, current)
    if kind == "conversation_comment":
        return [event for event in events if not bot_authored(event[kind])]
    if kind == "review":
        return [event for event in events if actionable_review(event[kind])]
    return events


def diff(previous: dict[str, Any], current: dict[str, Any]) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    old_pr = previous["pull_request"]
    new_pr = current["pull_request"]

    if new_pr.get("merged_at") and old_pr.get("merged_at") != new_pr.get("merged_at"):
        events.append({"type": "merged", "merge_commit": new_pr.get("merge_commit")})
    elif new_pr.get("state") == "CLOSED" and old_pr.get("state") != "CLOSED":
        events.append({"type": "closed_unmerged"})
    if new_pr.get("mergeable") == "CONFLICTING" and old_pr.get("mergeable") != "CONFLICTING":
        events.append({"type": "conflict"})
    if (
        old_pr.get("review_decision") != new_pr.get("review_decision")
        and new_pr.get("review_decision") == "CHANGES_REQUESTED"
    ):
        events.append(
            {
                "type": "review_decision_changed",
                "from": old_pr.get("review_decision"),
                "to": new_pr.get("review_decision"),
            }
        )

    events.extend(
        actionable_item_events("conversation_comment", previous["conversation_comments"], current["conversation_comments"])
    )
    events.extend(actionable_item_events("review", previous["reviews"], current["reviews"]))
    events.extend(actionable_item_events("inline_comment", previous["inline_comments"], current["inline_comments"]))

    if previous["ci_state"] != current["ci_state"] and current["ci_state"] == "failed":
        events.append({"type": "ci_failed", "checks": current["checks"]})
    return events


def baseline_events(current: dict[str, Any]) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    pr = current["pull_request"]
    if pr.get("merged_at"):
        events.append({"type": "merged", "merge_commit": pr.get("merge_commit")})
    elif pr.get("state") == "CLOSED":
        events.append({"type": "closed_unmerged"})
    if pr.get("mergeable") == "CONFLICTING":
        events.append({"type": "conflict"})
    if pr.get("review_decision") == "CHANGES_REQUESTED":
        events.append({"type": "review_decision", "value": pr["review_decision"]})
    if current["ci_state"] == "failed":
        events.append({"type": "ci_failed", "checks": current["checks"]})
    return events


def codex_home() -> Path:
    return Path(os.environ.get("CODEX_HOME", Path.home() / ".codex")).expanduser().resolve()


def state_path(args: argparse.Namespace, owner: str, repo: str, number: int) -> Path:
    root = Path(args.state_root).expanduser().resolve() if args.state_root else codex_home() / "state" / "pr-monitor"
    return root / "github.com" / owner / repo / str(number) / "state.json"


def load_state(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    return json.loads(path.read_text())


def write_state(path: Path, current: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {"version": 1, "updated_at": now(), "snapshot": current}
    with tempfile.NamedTemporaryFile("w", dir=path.parent, delete=False) as handle:
        json.dump(payload, handle, indent=2, sort_keys=True)
        handle.write("\n")
        temp_path = Path(handle.name)
    os.replace(temp_path, path)


@contextmanager
def lock(path: Path) -> Iterator[None]:
    lock_dir = path.parent / ".lock"
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        lock_dir.mkdir()
    except FileExistsError as exc:
        raise RuntimeError(f"another monitor already holds {lock_dir}") from exc
    try:
        yield
    finally:
        lock_dir.rmdir()


def attention_summary(events: list[dict[str, Any]]) -> str:
    event_types = {event["type"] for event in events}
    if "merged" in event_types:
        return "Pull request is merged. Continue the next approved workstream phase."
    if "closed_unmerged" in event_types:
        return "Pull request was closed without merging. Ask the user how to proceed."
    if "conflict" in event_types:
        return "Pull request has merge conflicts. Route conflict resolution to the owner worker."
    if "ci_failed" in event_types:
        return "CI failed. Route the failing checks to the owner worker."
    if event_types & {
        "review_decision",
        "review_decision_changed",
        "new_conversation_comment",
        "updated_conversation_comment",
        "new_review",
        "updated_review",
        "new_inline_comment",
        "updated_inline_comment",
    }:
        return "Review feedback arrived. Route the complete batch to the owner worker."
    return "GitHub activity needs attention. Inspect and handle the complete event batch."


def output(
    kind: str,
    url: str,
    events: list[dict[str, Any]],
    state_file: Path,
    observation: str,
) -> None:
    print(
        json.dumps(
            {
                "attention": attention_summary(events),
                "action_types": sorted({event["type"] for event in events}),
                "event": kind,
                "observation": observation,
                "pr_url": url,
                "state_file": str(state_file),
                "events": events,
            },
            indent=2,
            sort_keys=True,
        )
    )


def collect_batch(
    initial: dict[str, Any],
    owner: str,
    repo: str,
    number: int,
    url: str,
    debounce: float,
    debounce_cap: float,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    current = initial
    events: list[dict[str, Any]] = []
    seen: set[str] = set()
    started = time.monotonic()
    last_change = started
    while True:
        latest = snapshot(owner, repo, number, url)
        for event in diff(current, latest):
            fingerprint = content_hash(event)
            if fingerprint not in seen:
                seen.add(fingerprint)
                events.append(event)
                last_change = time.monotonic()
        current = latest
        elapsed = time.monotonic() - started
        quiet = time.monotonic() - last_change
        if events and (quiet >= debounce or elapsed >= debounce_cap):
            return current, events
        time.sleep(1)


def parse_pr_url(url: str) -> tuple[str, str, int]:
    match = PR_URL_RE.match(url)
    if not match:
        raise RuntimeError("expected a GitHub pull-request URL such as https://github.com/org/repo/pull/123")
    return match.group(1), match.group(2), int(match.group(3))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pr_url", help="GitHub pull-request URL")
    parser.add_argument("--interval", type=float, default=30, help="poll interval while waiting")
    parser.add_argument("--debounce", type=float, default=5, help="quiet period for batching review bursts")
    parser.add_argument("--debounce-cap", type=float, default=20, help="maximum batching delay")
    parser.add_argument("--max-errors", type=int, default=5, help="consecutive polling failures before returning")
    parser.add_argument("--state-root", help="override cursor-state root")
    return parser.parse_args()


def main() -> int:
    try:
        args = parse_args()
        owner, repo, number = parse_pr_url(args.pr_url)
        path = state_path(args, owner, repo, number)
        with lock(path):
            stored = load_state(path)
            previous = stored["snapshot"] if stored else None
            errors = 0
            while True:
                try:
                    current = snapshot(owner, repo, number, args.pr_url)
                    errors = 0
                except (RuntimeError, json.JSONDecodeError) as exc:
                    errors += 1
                    if errors >= args.max_errors:
                        output(
                            "monitor_error",
                            args.pr_url,
                            [{"type": "monitor_error", "detail": str(exc)}],
                            path,
                            "monitor_failure",
                        )
                        return 1
                    print(f"monitor warning ({errors}/{args.max_errors}): {exc}", file=sys.stderr)
                    time.sleep(args.interval)
                    continue

                if previous is None:
                    write_state(path, current)
                    events = baseline_events(current)
                    if events:
                        output("activity", args.pr_url, events, path, "initial_snapshot")
                        return 0
                    previous = current
                    time.sleep(args.interval)
                    continue

                events = diff(previous, current)
                if events:
                    current, events = collect_batch(
                        previous,
                        owner,
                        repo,
                        number,
                        args.pr_url,
                        args.debounce,
                        args.debounce_cap,
                    )
                    write_state(path, current)
                    output("activity", args.pr_url, events, path, "new_activity")
                    return 0

                write_state(path, current)
                previous = current
                time.sleep(args.interval)
    except (RuntimeError, OSError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
