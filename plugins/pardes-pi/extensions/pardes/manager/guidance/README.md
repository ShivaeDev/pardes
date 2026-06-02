# Manager guidance maintainers

This folder owns deterministic, bounded model-facing orientation for coordinating managers. It teaches the operating model at lifecycle boundaries; it does not implement workflow decisions, classify inbox rows semantically, or replace exact-cursor mechanics.

## Surfaces

- `index.ts` queues next-turn lifecycle reminders and exports shared wording invariants.
- `lifecycle.ts` renders activation, restoration, reload, and post-compaction variants.
- `projection.ts` derives bounded count-only lifecycle snapshots from durable state and attached runtimes.
- `bounds.ts` hard-bounds lifecycle lines and characters.
- `wording.ts` owns reusable operating rules, including the canonical two-path inbox wording and the compaction coordinating guidance embedded by `../compaction.ts`.

Adjacent model-facing surfaces must reuse or faithfully preserve the `wording.ts` inbox rule: inbox wake suffixes, inbox status/detail projections, and the descriptions/snippets/guidelines for `inbox_get`, `inbox_acknowledge`, `question`, and `await_user_feedback`.

## Lifecycle variants

Activation is the full onboarding surface. Assume no prior Pardes knowledge: explain the manager role, delegated worker outcome, advisory verification loop, exact-state publication, user-controlled merge, durable inbox inspection, two-path judgment rule, concise communication, and current counts.

Post-compaction guidance deliberately reteaches the operating model at roughly 50–80% fidelity instead of assuming the summary preserved it. The compaction suffix also embeds a bounded coordinating rule list so the reminder and summarized state agree.

Restoration and reload explain what happened before giving next actions. Restoration treats persisted state as authoritative and process-scoped runtime attachment as absent unless re-established. Reload explains intentional plugin-code adoption, pinned child-runtime snapshot refresh, detached RPC attachments, preserved managed artifacts, and selective revival.

## Wording invariants

Keep the two inbox paths explicit everywhere:

1. Autonomous rows may be acknowledged once handled.
2. When a report, external observation, blocker, or attention needs user judgment, do not acknowledge the active cursor first. Surface it, use `question` for structured options or `await_user_feedback` for free-form feedback, and leave the cursor open until response.

Do not encode semantic classification into software. The manager judges which path applies. Keep exact-cursor controller behavior unchanged: a delivered cursor covers only its inspectable batch and never a later queued suffix.

After publication, keep review-feedback routing explicit: tell the retained worker to make additive descendant commits only. Do not amend, rebase, or rewrite published branch history because exact-SHA publication intentionally never force-pushes.

## Boundedness

Every lifecycle variant has hard line, per-line, and total-character caps. Dynamic projection text stays aggregate-only: no repository paths, worker tasks, report bodies, external text, diagnostics, or unbounded identifiers. Adjacent wakes, projections, and tool outputs retain their own caps. Spend bounded lines to teach clearly; do not compress the operating model into ambiguous hints.
