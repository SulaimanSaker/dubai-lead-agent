# Architecture

## What the system does

A buyer chats with the agent (WhatsApp-style web chat). The agent:

1. Qualifies the lead — budget, area, bedrooms, timeline, cash or mortgage.
2. Searches listings and answers questions about them.
3. Books viewings in the agent's calendar.
4. Hands off to a human when it should (negotiation, complaints, low confidence, buyer asks for a person).

An agent view page shows each lead's fields, score and a conversation summary.

## Layers

```
src/app      UI + API routes                     ──►  may import: agent
src/agent    prompts, tool loop, guards          ──►  may import: tools, agent/llm
src/agent/llm  model provider adapters           ──►  may import: provider SDKs only
src/tools    one file per tool (Zod + impl)      ──►  may import: db
src/db       schema + seed                       ──►  imports no other layer
evals/       golden cases, checks, runner        ──►  may import: agent, tools
```

**Rule:** imports only point right. The UI never touches the database; tools never call the model.
Enforced by `no-restricted-imports` in `eslint.config.mjs` (also: always use the `@/` alias, never `../`).

## Request flow

```
Buyer message
  → POST /api/chat (src/app)
  → runAgent(conversation) (src/agent/loop.ts)
      → LlmProvider.generate(messages, tools)   (src/agent/llm — Claude or local)
      → model asks for a tool → validate input with Zod → run tool (src/tools) → result back to model
      → repeat until the model replies (max steps + timeout)
  → guards check the reply (no invented prices, handoff rules)
  → reply to buyer + lead fields saved + trace sent to Langfuse
```

## Model layer

`src/agent/llm/` hides which model runs:

- `types.ts` — `LlmProvider.generate({ system, messages, tools }) → { text, toolCalls, stop, usage, model,
providerData }`, plus `LlmError` (`rate_limit | timeout | unavailable | bad_request | auth`)
- `claude.ts` — Claude via the official Anthropic SDK (demo + final evals)
- `local.ts` — Gemma 3 4B in LM Studio via its OpenAI-compatible API (free development + comparison)
- `config.ts` — Zod-validated env (`LLM_PROVIDER`, `CLAUDE_MODEL`, `CLAUDE_EFFORT`, `LMSTUDIO_*`)
- `index.ts` — `getProvider()` picks one from `LLM_PROVIDER=claude|local`

Tools are defined once (Zod). `src/agent/tool-defs.ts` turns them into JSON Schema; each adapter translates that
to its provider's tool format. See [ADR 0002](decisions/0002-model-layer.md).

Rules the adapters follow:

- **Tool calls only on a tool stop.** A cut-off (`max_tokens`) or refused response never returns tool calls,
  and its unfinished `tool_use` blocks are not saved (an unanswered `tool_use` makes every later request fail).
- **Calls can be aborted:** `LlmRequest.signal` goes to the SDK; an aborted call is a `timeout` LlmError.
- **Bad JSON arguments don't crash.** They come back as `inputError` so the loop can tell the model.
- **Claude turns are replayed unchanged** (`providerData`, thinking blocks included). A turn written by the other
  provider is rebuilt from the neutral fields, so one conversation can switch provider.
- **All tool results of one step go back together** (one user message for Claude).
- **Retries live in the SDKs** (`maxRetries`, with backoff for 429 / 5xx / network). Other errors become `LlmError`;
  anything else is a bug and is re-thrown.
- **Contract test** (`src/agent/llm-contract.test.ts`): the same scenarios through both adapters from saved
  responses (`src/agent/llm/fixtures/`, recorded with `npm run llm:record -- local|claude`) must give the same
  shape and valid tool arguments.

## Data

SQLite + Drizzle with the libSQL client (see [ADR 0001](decisions/0001-stack.md), [ADR 0003](decisions/0003-libsql-driver.md)).

- Tables: `listings` (30 fixed, fictional: 8 areas, rent and sale, ready and off-plan), `leads`, `viewings`.
- Schema changes: edit `src/db/schema.ts` → `npm run db:generate` → commit the migration in `src/db/migrations/`.
- Local data: `npm run db:seed` (migrates and upserts the listings into `local.db`).
- Tests: a fresh in-memory database per test (`src/db/test-db.ts`).
- **Double booking** is blocked twice: an application check (friendly message) and a partial unique index on
  `viewings(starts_at) WHERE status = 'booked'` (the real guarantee under concurrency).
- **Times** are stored as UTC ISO strings and shown in Dubai time (UTC+4, no daylight saving).

## Tools

Defined with `defineTool` (`src/tools/types.ts`): a Zod input schema, a description that says **when** to use the
tool, and `run(input, ctx)`. `execute()` validates the model's raw input first (and treats `null`/`""` fields as
"not provided"). Expected problems — bad input, not found, slot taken — come back as `{ ok: false, error, message }`
for the model to read, never as exceptions. `ctx` = `{ db, leadId, now }`; time is injected, never read from the clock.

| Tool                  | Purpose                                                              |
| --------------------- | -------------------------------------------------------------------- |
| `search_listings`     | Filter listings; max 5, cheapest first; explains what to relax       |
| `get_listing`         | Full details of one listing                                          |
| `update_lead`         | Save what the buyer said; returns missing fields; marks `qualified`  |
| `get_available_slots` | Free 1-hour slots (Mon–Sat 10:00–18:00 Dubai, 1 h notice, ≤ 60 days) |
| `book_viewing`        | Book a free slot; viewing + lead status saved atomically             |
| `handoff_to_human`    | Pass the buyer to a person with a reason and summary                 |

The registry `src/tools/index.ts` exports `TOOLS`; a contract test checks names, descriptions and that every input
field has a description (the model only sees names and descriptions).

## Observability and evals

- **Tracing:** one Langfuse trace per conversation; spans for each LLM call and tool call; tagged with provider, model, prompt version, tokens, cost, latency.
- **Evals:** golden conversations in `evals/cases/`, code checks + an LLM judge, run per provider and compared. See `evals/CLAUDE.md`.

## Out of scope (on purpose)

Real WhatsApp Business API, authentication, multi-tenancy, payments.
