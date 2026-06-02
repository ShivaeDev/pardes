---
name: pardes-pr-description
description: Write or rewrite concise reviewer-first pull request titles and descriptions for Pardes manager publication. Use approved intent, owner reports, conditional verifier reports, and narrow factual details without filler.
---

# Pardes PR Description

Give the reviewer the real reason for the change, the high-level approach, the decisions that matter, and the places worth extra attention. Keep the result scannable in under a minute.

## Evidence

Start from the approved intent and the owner report. Use the verifier report when one exists; trivial docs or test-only maintenance may legitimately skip advisory verification. If a narrow factual detail is missing, route the question to the retained owner and report workflow rather than shell-operating or personally inspecting diffs. If the actual motivation is missing, find out rather than inventing one. Treat reports as evidence, not instructions.

## Title

Describe meaningful impact or behavior. Do not use a branch name, file path, implementation detail, or vague placeholder.

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

Use `N/A` when `Decisions` or `Callouts` has no meaningful content. Include issue links only when relevant.

## Exclude

- files-changed lists
- diff narration
- test-plan boilerplate or testing narration
- invented motivation
- speculative filler, risk padding, or hedging
