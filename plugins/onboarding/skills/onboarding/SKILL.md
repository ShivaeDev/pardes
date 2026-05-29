---
name: onboarding
description: Get oriented in the pardes marketplace and tune the user's Claude Code setup. Explains what each plugin does and how they compose, then runs an advisory config doctor that reports recommended settings and applies them only on explicit confirmation. Use when a user is new to the marketplace, asks what these plugins do or how to get set up, or wants their config checked.
user-invocable: true
---

# onboarding

You are helping a user get oriented in the **pardes** marketplace and tune their Claude Code setup. This skill has two halves: **orient** (explain what's here and how it fits together) and **doctor** (check their config and, only if they say yes, apply recommended settings). Do the orientation first, then offer the doctor — don't run the doctor unprompted unless the user clearly asked for a config check.

## Half 1 — Orient the user

Pardes is a small marketplace of focused Claude Code plugins. Each plugin ships exactly one skill (the deliberate exception is `base`, which carries shared infrastructure). Explain the pieces in plain terms and, importantly, **how they compose** — the value is in the combination:

- **base** — foundational plugin with shared hooks and core skills. The other plugins assume it's present; install it first.
- **orchestrate** — plans one large multi-chunk PR through a short interview, then ships it by dispatching focused sub-agents one chunk at a time. Reach for it when a single PR is too big for one context but is sequenceable into discrete commits.
- **shift-leader** — the standing autonomous orchestrator *above* a single PR: it runs a multi-PR / multi-agent effort, dispatches file-disjoint work to parallel worktrees, gates dependent work on merges (never merging itself), opens and monitors each PR, and survives compaction via a durable state file. It uses `orchestrate` (if present) to plan+ship each individual large PR.
- **shell-helpers** — dependency-free shell helpers that the orchestration skills lean on: freshen a checkout to a clean baseline, prune merged branches, reap stale worktrees. Available both as PATH commands and as sourceable shell functions.
- **pr-description** — writes a tight PR description (Why / How / Decisions / Callouts, no filler). Pairs naturally with `orchestrate` and `shift-leader` when a PR is ready to open.
- **statusline** — a rich multi-line status line: model, context-pressure bar, cost, git, PR, and rate limits on the main line, plus per-subagent gauges in the agent panel. Most useful precisely when `shift-leader` has several sub-agents running — you can watch each one's context pressure.

The composition story to convey: **shift-leader** is the conductor, **orchestrate** plans+ships each big PR under it, **shell-helpers** keeps the worktrees and branches clean, **pr-description** writes the PRs, and **statusline** lets the user see it all happening. A user new to the marketplace usually wants `base` + whichever of those match their workflow.

If a user simply wants the whole set, mention **pardes-all** — a meta plugin with no skill of its own that just depends on every other plugin, so a single install pulls in the entire marketplace at once. It's the "give me everything" option for someone who doesn't want to pick à la carte. (The human-facing README has the exact install command; point them there rather than reciting it.)

When you mention any sibling skill, treat it as **optional and possibly-installed**: if the skill is available in this session, suggest invoking it directly; if it isn't, describe what it does and point the user at installing that plugin from the marketplace (the human-facing README has the exact install commands — don't paste install commands into your own reasoning here).

Tailor the orientation to what the user actually asked. If they just said "what is this / help me get started," give the short tour above and then move to the doctor. If they asked about a specific plugin, lead with that one and how it composes with the rest.

## Half 2 — Run the config doctor

The doctor is a dependency-free script that compares the user's `~/.claude/settings.json` against a manifest of **recommended** (never required) settings tuned for this marketplace's orchestration-heavy style. It is **advisory by default** and only writes anything on an explicit `--apply` run, after a backup, and only for keys that are currently missing.

### Step 1 — Advisory report (always safe; read-only)

Run the report. It only reads settings; it changes nothing.

```bash
bun "${CLAUDE_PLUGIN_ROOT}/scripts/doctor.ts"
```

The report marks each recommended key as **set** (already matches), **missing** (absent — an apply would add it), or **differs** (present but holds a different value — the doctor will never overwrite it). It also lists a couple of intents (workflows-enabled-by-default, agent view) that have no stable settings key, so the doctor describes them but cannot apply them.

Read the report back to the user in plain language: what's already good, what's missing, and for anything that differs, note that the doctor leaves their choice alone.

### Step 2 — Offer to apply, and get explicit confirmation

If anything is **missing**, offer to apply *only* the missing recommendations. This is a genuine choice — use the question tool / ask the user directly. **Never apply without an explicit yes.** Make clear that:

- it adds **only the missing keys** — it never overwrites a value they already set (the "differs" entries stay theirs),
- it writes a **timestamped backup** of `settings.json` first,
- it touches **no unrelated keys**, and
- it prints exactly what it changed.

Only after the user explicitly confirms, run:

```bash
bun "${CLAUDE_PLUGIN_ROOT}/scripts/doctor.ts" --apply
```

Then report back exactly what the doctor said it changed, and where the backup was written. If the user wants to undo it, the change is reversible by restoring that backup or removing the added keys.

If nothing is missing, tell the user their config already matches the recommendations and skip the apply.

### Notes

- The settings path can be overridden with `--settings <path>` or the `DOCTOR_SETTINGS_PATH` env var. That's mainly for testing against a sample file — for a real user, leave it at the default (`~/.claude/settings.json`).
- If the doctor reports the settings file is unparseable, do **not** try to apply. Tell the user to fix or remove the file first; never let an apply run against a file the doctor couldn't parse.
- Recommended values are intentionally generic. If a user has a deliberately different value (e.g. a different model or effort level), that's fine — respect it; the "differs" status exists exactly so the doctor reports without nagging or overwriting.
