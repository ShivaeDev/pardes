# Manager guidance maintainers

This folder owns deterministic model-facing orientation for coordinating managers. Lifecycle guidance is high-value software-authored signal: emit it intact. Do not silently truncate authored prompts. Bound only dynamic state/data interpolation where safety needs it.

## Surfaces

- `lifecycle.ts` is the obvious review surface: it keeps the complete activation, compaction, restoration, and reload prompts together. It also owns the few genuinely shared blocks reused by inbox/tool surfaces and the compaction coordinating suffix.
- `projection.ts` derives count-only lifecycle snapshots from durable state and attached runtimes. Its explicit count formatter bounds interpolated dynamic values without touching authored prompt text.
- `index.ts` appends the dynamic snapshot to the intact authored prompt and queues next-turn lifecycle reminders.

Adjacent model-facing surfaces must reuse or faithfully preserve the lifecycle inbox rule: inbox wake suffixes, inbox status/detail projections, and the descriptions/snippets/guidelines for `inbox_get`, `inbox_acknowledge`, `question`, and `await_user_feedback`.

## Lifecycle variants

Activation is comprehensive onboarding. Assume no prior Pardes knowledge: teach the manager role, software/mechanics boundary, compact projections, coherent delegated outcomes, advisory verification loop, exact-state publication, user-controlled merges, durable inbox handling, published-review commit safety, trust boundaries, and concise communication.

Post-compaction guidance substantially reteaches the important operating model and adds situational current-state orientation. Do not assume conversational context survived. The compaction suffix embeds the same core coordinating block so the reminder and summarized state agree.

Restoration is a concise reconnect/check pass: durable state returned while prior process-scoped child attachment is not assumed. Reload is deliberately narrower because the manager conversation retains context: say that the manager plugin version changed and retained workers disconnected from this runtime, then give only the retained-worker inspect → `agent_status` → `agent_revive` continuation sequence. Do not append general state orientation or reteach inbox, publication, verification, or manager SOP on reload.

## Wording invariants

Keep the two inbox paths explicit everywhere:

1. Autonomous rows may be acknowledged once handled.
2. When a report, external observation, blocker, or attention needs user judgment, do not acknowledge the active cursor first. Surface it, use `question` for structured options or `await_user_feedback` for free-form feedback, and leave the cursor open until response.

Do not encode semantic classification into software. The manager judges which path applies. Keep exact-cursor controller behavior unchanged: a delivered cursor covers only its inspectable batch and never a later queued suffix.

After publication, keep review-feedback routing explicit: tell the retained worker to make additive descendant commits only. Do not amend, rebase, or rewrite published branch history because exact-SHA publication intentionally never force-pushes.

## Dynamic boundedness

Dynamic lifecycle projection text stays aggregate-only: no repository paths, worker tasks, report bodies, external text, diagnostics, or unbounded identifiers. Interpolated counts use one explicit cap and render a visible `+` suffix above it. Adjacent wakes, projections, and tool outputs retain their own data bounds. Static authored lifecycle guidance remains complete.
