---
name: add-agent-tool
description: Add a new tool the agent can call (e.g. search_listings, book_viewing) — Zod schema, implementation, registration, unit tests and an eval case, following the project's layer rules. Use whenever a new agent capability is needed.
---

# Add an agent tool

A tool is a function the model can ask us to run. The model only sees its **name, description and input schema**,
so those are part of the prompt — write them carefully.

## Steps

1. **Plan.** Write `docs/plans/<date>-tool-<name>.md` (template in `docs/plans/README.md`) and get approval.
2. **Create `src/tools/<kebab-name>.ts`** with:
   - `inputSchema` — a Zod object. Every field has `.describe("...")` — the model reads these.
   - `description` — one or two sentences: what it does and **when to use it** (and when not to).
   - `run(input)` — the implementation. May import `@/db` only (never `@/agent` or `@/app`).
   - Expected "no result" situations (nothing found, slot taken) are **normal return values** with a clear message for the model, not exceptions.
3. **Register** the tool in the tool registry (`src/tools/index.ts`) so adapters can expose it.
4. **Unit tests** in `src/tools/<kebab-name>.test.ts` — no model calls:
   - happy path,
   - invalid input is rejected by the schema,
   - the "nothing found" / conflict case.
5. **Eval case.** Use the `add-eval-case` skill to add at least one conversation where the model should call this tool.
6. **Docs.** If the tool changes the agent's behaviour, mention it in `docs/architecture.md`. Note it in the feature's plan in `docs/plans/`.
7. **Check.** `npm run check` must pass (the Stop hook runs it anyway).

## Rules

- Tool names are `snake_case` for the model (`search_listings`), files are `kebab-case` (`search-listings.ts`).
- Prices, dates, availability: the tool returns them; the agent must never invent them.
- Keep inputs minimal — every extra optional field is another way for the model to go wrong.
