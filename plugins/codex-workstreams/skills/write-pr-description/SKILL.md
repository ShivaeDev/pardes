---
name: write-pr-description
description: Use when opening or rewriting a pull request and the reviewer needs a concise, truthful explanation of why the change exists, how it works, which decisions matter, and where to look carefully.
---

# Write PR Description

A reviewer should understand the change in under a minute. Pull intent from the
approved PR goal, accepted commits, owner-worker report, and verifier summary.
Inspect specific diff details only when needed for an accurate callout. Never
fabricate motivation.

## Title

Describe impact or behavior. Do not use a branch name, file path, or vague
placeholder.

## Body

```md
### Why?

<1-3 sentences describing the real problem or motivation>

### How?

<1-2 sentences describing the high-level technical approach>

### Decisions

- <meaningful tradeoff, rejected alternative, or scope choice with its reason>

### Callouts

- <surface where reviewer attention is valuable>
```

Use `N/A` when `Decisions` or `Callouts` has no meaningful content. Add issue
links on their own lines when relevant.

## Exclude

- file lists
- diff narration
- test-plan narration
- invented intent
- speculative risk padding

Follow a stronger repository-specific PR template when one exists.
