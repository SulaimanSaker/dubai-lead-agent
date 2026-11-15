---
name: write-adr
description: Record an architecture decision as a short ADR in docs/decisions/ (context, decision, alternatives, consequences). Use when choosing a library, pattern, model, data store, or changing a layer rule.
---

# Write an ADR

ADRs save context between sessions: the next person (or agent) can see **why** something is the way it is,
and won't re-argue it.

## Steps

1. Next number: look at `docs/decisions/` (e.g. `0003`).
2. Create `docs/decisions/NNNN-<kebab-title>.md`:

   ```md
   # NNNN — <Title>

   - **Status:** proposed | accepted | superseded by NNNN
   - **Date:** YYYY-MM-DD

   ## Context

   What problem, what constraints. Facts, not opinions.

   ## Decision

   What we chose, in a few bullets.

   ## Alternatives considered

   Each option and why it lost.

   ## Consequences

   What gets easier, what gets harder, what we must now do.
   ```

3. Add a row to the table in `docs/decisions/README.md`.
4. Status is `proposed` until the human accepts it.
5. Never rewrite an accepted decision. Write a new ADR and mark the old one `superseded by NNNN`.
