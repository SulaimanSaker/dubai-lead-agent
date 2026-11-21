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
src/app      UI + API routes                     ──►  may import: @/agent only (its public API, index.ts)
src/agent    prompts, tool loop, guards, chat    ──►  may import: tools, agent/llm, db (ADR 0004)
src/agent/llm  model provider adapters           ──►  may import: provider SDKs only
src/tools    one file per tool (Zod + impl)      ──►  may import: db
src/db       schema + seed                       ──►  imports no other layer
evals/       golden cases, checks, runner        ──►  may import: agent, tools, db (never app)
```

**Rule:** imports only point right. The UI never touches the database; tools never call the model.
Enforced by `no-restricted-imports` in `eslint.config.mjs` (also: always use the `@/` alias, never `../`).

`src/agent/index.ts` is the agent's public API for the app (`sendBuyerMessage`, `getLeads`, `getLead`,
`getModelInfo`, types). It starts with `import "server-only"`, so agent code can never be bundled into the
browser; client components import only types from it. Tests and scripts import agent modules directly.

## Request flow

```
Buyer message
  → POST /api/chat (src/app)
  → handleBuyerMessage({ leadId?, message })        (src/agent/chat.ts: Zod input, create lead, load chat)
  → runAgentTurn(...)                               (src/agent/loop.ts)
      → LlmProvider.generate(system, messages, tools, signal)   (src/agent/llm — Claude or local)
      → model asks for a tool → validate input with Zod → run tool (src/tools) → result back to model
      → repeat until the model replies (max 8 calls, 90 s timeout)
      → price guard checks the reply (src/agent/guards.ts)
  → save the turn's messages in one batch (src/agent/conversation.ts) → reply + lead view
  → one Langfuse trace per message (src/agent/tracing, when keys are set)
```

## Agent loop

`runAgentTurn` never crashes on model output. Every way a turn can end has an `outcome`, a test, and (except
`replied`) a fixed safe reply in the buyer's language:

| Outcome          | When                                                                              |
| ---------------- | --------------------------------------------------------------------------------- |
| `replied`        | the model answered with text that passed the guards                               |
| `price_guard`    | the reply had an AED amount no tool returned, twice (one retry with a correction) |
| `tool_failures`  | the same tool was misused 3 times in one message → automatic `handoff_to_human`   |
| `max_steps`      | 8 model calls without a reply                                                     |
| `timeout`        | 90 s used up (the running model call is aborted)                                  |
| `provider_error` | the provider failed after the SDK's retries, or returned an empty reply           |
| `refusal`        | the model declined                                                                |
| `cut_off`        | the reply hit `max_tokens`                                                        |
| `internal_error` | a bug or database error in our own code (logged; the messages so far are kept)    |

- Bad tool input, bad JSON, unknown tools and crashing tools become error results the model can read and fix.
- **Prices come only from tool results.** The buyer's own budget is allowed once `update_lead` has saved it
  (its result contains it); a number only the buyer said is not trusted.
- A saved conversation stays replayable: no two assistant turns in a row, no unanswered tool calls, and a draft
  that failed the price guard is never stored.
- Bugs in our own code are logged loudly and end as `internal_error` instead of throwing: a booking made by a tool
  must never be saved without the messages that explain it. The turn timer is cleared on every path.
- Messages for the same lead are handled one at a time (an in-process queue in `chat.ts`), so a double submit
  can't interleave two turns. One server process only; several would need a database lock.
- **The system prompt is frozen** ([ADR 0006](decisions/0006-frozen-system-prompt.md)). The turn's context (Dubai
  time, lead state) is added once, right after the buyer's message, as a `context` message; a price-guard correction
  is a `context` message too. Everything sent is saved and never edited: Claude rejects a replayed thinking block
  whose prefix changed.
- Prompts are versioned (`src/agent/prompts/v1.ts` … `v3.ts`; the app uses `CURRENT_PROMPT` = v3). A version is the
  system prompt, the turn context and the price-guard correction note. Each saved reply records provider, model,
  prompt version, tokens, latency and outcome.

## App (UI + API)

| Route            | What                                                                                         |
| ---------------- | -------------------------------------------------------------------------------------------- |
| `/`              | Short intro and links                                                                        |
| `/chat`          | Messenger-style buyer chat (client component) + live lead card. `?lead=<id>` restores a chat |
| `/leads`         | Agent view: all leads with status, score, summary, missing fields                            |
| `/leads/[id]`    | One lead: fields, handoff, viewings, transcript with tools used, model turns (tokens, time)  |
| `POST /api/chat` | `{ leadId?, message }` → reply + lead. 400 bad input · 503 database not set up · 500 logged  |

- `cacheComponents` is on: pages that read the database do it inside `<Suspense>` after `await connection()`,
  so the shell is static and the data is always fresh.
- Model replies are rendered as text with `**bold**` only, never as HTML.
- The chat blocks sending while a reply is pending; on an error the buyer's text is put back in the input.
  "New chat" resets the state in place (a link to `/chat` would keep the old state: same page, same component).
- The buyer page gets only chat bubbles and the lead summary (`getChat`); tool names and per-turn model data are
  for the agent view only.
- `POST /api/chat` refuses bodies over 16,000 characters (413) before parsing them.

## Model layer

`src/agent/llm/` hides which model runs:

- `types.ts` — `LlmProvider.generate({ system, messages, tools }) → { text, toolCalls, stop, usage, model,
providerData }`, plus `LlmError` (`rate_limit | timeout | unavailable | bad_request | auth`)
- `claude.ts` — Claude via the official Anthropic SDK (demo + final evals)
- `local.ts` — Gemma 3 4B in LM Studio via its OpenAI-compatible API (free development + comparison)
- `config.ts` — Zod-validated env (`LLM_PROVIDER`, `CLAUDE_MODEL`, `CLAUDE_EFFORT`, `LMSTUDIO_*`)
- `index.ts` — `getProvider()` picks one from `LLM_PROVIDER=claude|local`
- `structured.ts` — `claudeStructured()`: one Claude call that must answer JSON matching a schema. Claude-only,
  not part of `LlmProvider`; used by the eval judge ([ADR 0007](decisions/0007-evals-and-judge.md))

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
- **`context` messages:** Claude gets a mid-conversation `role: "system"` message (two in a row are joined; if
  one ever followed an assistant turn it would be sent as user text instead of causing a 400). The local adapter
  appends the context to the message before it, because local chat templates allow one leading system message.
- **Retries live in the SDKs** (`maxRetries`, with backoff for 429 / 5xx / network). Other errors become `LlmError`;
  anything else is a bug: the adapter re-throws it, and the loop ends the turn as `internal_error`.
- **Contract test** (`src/agent/llm-contract.test.ts`): the same scenarios through both adapters from saved
  responses (`src/agent/llm/fixtures/`, recorded with `npm run llm:record -- local|claude`) must give the same
  shape and valid tool arguments.

## Data

SQLite + Drizzle with the libSQL client (see [ADR 0001](decisions/0001-stack.md), [ADR 0003](decisions/0003-libsql-driver.md)).

- Tables: `listings` (30 fixed, fictional: 8 areas, rent and sale, ready and off-plan), `leads`, `viewings`,
  `messages` (the conversation, one row per message, ordered by id; see [ADR 0004](decisions/0004-agent-owns-conversation.md)).
- Migrations run only from scripts and tests (`src/db/migrate.ts`), never from the app: Next.js bundling changes
  `import.meta.url` paths.
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

- **Tracing** ([ADR 0005](decisions/0005-tracing.md)): one Langfuse trace per buyer message (`agent-turn`), all
  messages of a lead in one Langfuse **session**. Inside: a `generation` per model call (model, messages, output,
  usage incl. cache reads/writes, cost, stop reason), a `tool` per tool call (input, result; warning when
  `ok: false`), a `guardrail` when the price guard fires. Tags: provider, model, `prompt-vN`.
  - The agent reports to a `TurnObserver` (`src/agent/observer.ts`); `src/agent/tracing/` maps it to Langfuse and
    is the only place allowed to import `@langfuse/*` / `@opentelemetry/*` (ESLint). Observer errors never break
    a chat.
  - Started in `src/instrumentation.ts` (Next.js) and by scripts (which flush before exit). Off without
    `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY`.
  - Cost is computed in code (`src/agent/llm/pricing.ts`, dated price table) and is the same in Langfuse, the
    saved turn meta and the agent view. Each turn also stores its trace id.
- **Evals** ([ADR 0007](decisions/0007-evals-and-judge.md)): 31 golden conversations in `evals/cases/`, run through
  the real `handleBuyerMessage` in a fresh database. Code checks on the end state + a Claude Sonnet 5.5 judge;
  headline `pass` needs both. Run per model and compared (`evals/runs/COMPARISON.md`). See `evals/CLAUDE.md`.

## Out of scope (on purpose)

Real WhatsApp Business API, authentication, multi-tenancy, payments.
