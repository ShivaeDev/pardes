---
name: pr-description
description: Write a clear, useful PR description — a tight Why / How / Decisions / Callouts structure that tells a reviewer what changed and why, with no filler. Use whenever you open or rewrite a pull request.
user-invocable: true
---

# pr-description

A good PR description answers three things fast: *why does this exist, what did it do, and what should I look at?* Use this exact structure, and keep every section short — a reviewer should grasp the change in under a minute.

## Title

Meaningful, and about impact — what the change does for the product or system, not how it's implemented. Never a branch name, a file path, or "fix stuff".

## Body

### Why?

1–3 sentences: the actual problem or motivation. Pull it from the real context; don't invent one. If you genuinely don't know why, find out before opening the PR.

### How?

1–2 sentences: a short technical summary for a technical reader — the approach, not a file-by-file walkthrough.

### Decisions

One bullet per meaningful tradeoff, abandoned alternative, or scope choice — each with the reason. `N/A` if there were none.

### Callouts

One bullet per spot a reviewer should look harder at — risky surfaces, things that look innocuous but have knock-on effects, one-way doors. `Callouts — N/A` if everything is straightforward.

## Never include

- **Files-changed lists** — the diff already shows them.
- **Test plans** or "how I tested" narration.
- **Risk speculation** and hedging.
- **Diff narration** — restating the code change in prose.

That's it: an honest title, four short sections, and nothing the diff already says.
