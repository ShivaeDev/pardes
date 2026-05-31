---
name: investigate-codebase
description: Use when a coding task is not understood well enough to choose an implementation direction, including broad feature requests, unfamiliar code paths, bugs with multiple plausible causes, and work that benefits from parallel read-only exploration before architecture or planning.
---

# Investigate Codebase

Gather evidence before choosing a change. Keep the manager on synthesis and
delegate codebase reading to focused explorers.

## Workflow

1. State the question, known symptoms, and important unknowns.
2. Split the investigation into distinct evidence-gathering angles.
3. Spawn focused read-only `explorer` agents for the distinct questions. Use
   multiple explorers when the questions are independent.
4. When explorer output becomes the blocker, call `wait_agent` with all
   unresolved explorer IDs and a `900000` ms timeout. Treat an ordinary timeout
   as "still working": wait again with a long timeout instead of short-polling
   or narrating routine status.
5. Synthesize findings, separating observed facts from hypotheses.
6. Return the synthesis to `drive-workstream` for user discussion and scope
   approval. Record discovered fixes as candidate follow-ups; do not implement
   them during investigation.

## Explorer Briefs

Give each explorer one bounded question. Ask for file references, relevant
commands or logs, verified observations, uncertainties, and a concise report.
Do not send multiple explorers over the same surface.

## Output

Report:

- problem statement
- verified observations
- likely causes or relevant architecture
- contradictions and unknowns
- candidate fixes or slices
- recommended scope and PR sequence
