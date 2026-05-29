# onboarding

Get oriented in the **pardes** marketplace and tune your Claude Code setup in one place. The `onboarding` skill does two things: it explains what each plugin does and how they compose, then it runs an **advisory config doctor** that checks your settings against a set of recommended values — and applies them only if you say yes.

## Install

```bash
/plugin marketplace add ShivaeDev/pardes
/plugin install onboarding@pardes
```

## Use

Ask Claude to onboard you, or to check your config:

```
/onboarding what is this marketplace and how do I get set up?
```

Claude will give you a short tour of the plugins and how they fit together, then offer to run the config doctor.

## The config doctor

The doctor compares your `~/.claude/settings.json` against a manifest of **recommended** (never required) settings tuned for this marketplace's orchestration-heavy workflow — things like enabling tool search, a slightly smaller auto-compaction window, the 1M-context Opus model, an `auto` permission default, a higher effort level, and thinking summaries.

**Advisory report (read-only — changes nothing):**

```bash
bun "${CLAUDE_PLUGIN_ROOT}/scripts/doctor.ts"
```

Each recommended key is reported as **set** (already matches), **missing** (absent), or **differs** (present but holds your own value — the doctor never overwrites it).

**Opt-in apply (only the missing keys, after a backup):**

```bash
bun "${CLAUDE_PLUGIN_ROOT}/scripts/doctor.ts" --apply
```

`--apply` writes a timestamped backup of `settings.json` first, then merges in **only the keys you don't already have**. It never overwrites a value you already chose, never touches unrelated keys, and prints exactly what it changed. The skill always asks for your explicit confirmation before running this.

To point the doctor at a different file (e.g. to try it on a sample without touching your real config), pass `--settings <path>` or set `DOCTOR_SETTINGS_PATH`.

The doctor is dependency-free — `node:*` and Bun built-ins only — so it runs with no `bun install`.

The full operating manual the agent follows lives in `skills/onboarding/SKILL.md`.
