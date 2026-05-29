# pr-description

A tiny skill for writing pull-request descriptions a reviewer can actually use.

It gives one opinionated structure — **Why / How / Decisions / Callouts** — plus an honest title and a short list of things to never include (files-changed dumps, test-plan narration, diff restatement). The goal: a reviewer understands the change in under a minute.

## Install

```bash
/plugin marketplace add ShivaeDev/pardes
/plugin install pr-description@pardes
```

## Use

Invoke `/pr-description`, or just lean on it whenever you open or rewrite a PR. See `skills/pr-description/SKILL.md` for the full structure.
