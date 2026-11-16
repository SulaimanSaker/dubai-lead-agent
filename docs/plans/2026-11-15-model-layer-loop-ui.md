# Model layer, agent loop and chat UI

**Goal:** a buyer can chat in the browser, get qualified, see matching listings and book a viewing, on both the local
model (Gemma 3 4B) and Claude (Haiku 5.5; was Opus 5.5, changed 2026-11-16 for cost, see ADR 0002), with the
provider picked by `LLM_PROVIDER`.

Built in three small steps. Each step ends with `npm run check` green and its own build-log entry.

## Step 2a: model layer (`src/agent/llm/`)

**Files**

- `types.ts`: our own provider-neutral types.
  - `LlmMessage` = `user { text }` | `assistant { text, toolCalls, providerData? }` | `tool { callId, name, result }`
  - `LlmToolDef` = `{ name, description, jsonSchema }` (built from Zod by the agent layer, because `llm/` may not
    import `tools/`)
  - `LlmResult` = `{ text, toolCalls: { id, name, input | inputError }[], stop: "end" | "tool_use" | "max_tokens" |
"refusal", usage: { inputTokens, outputTokens }, model, providerData }`
  - `LlmProvider.generate({ system, messages, tools }) → Promise<LlmResult>`
  - `LlmError` with `kind: "rate_limit" | "timeout" | "unavailable" | "bad_request" | "auth"` and `retryable`
- `config.ts`: Zod-validated env for providers (`LLM_PROVIDER`, `ANTHROPIC_API_KEY`, `CLAUDE_MODEL`, `CLAUDE_EFFORT`,
  `LMSTUDIO_BASE_URL`, `LMSTUDIO_MODEL`). Clear error if a required key is missing.
- `claude.ts`: official `@anthropic-ai/sdk`.
  - Model `claude-haiku-5-5` (set by `CLAUDE_MODEL`). Thinking stays on, so we only set `output_config.effort`
    (default `low` for chat; the model's own default is higher, so we set it explicitly). No `temperature` (rejected).
  - `tool_choice: auto` (forced tool choice returns a 400 on current models).
  - **Replay the assistant's raw content unchanged** (`providerData`), including thinking blocks. Claude checks that
    history is not edited; rebuilding the turn from text alone would drop its reasoning.
  - All tool results of one step go back in **one** user message (keeps parallel tool calls working).
  - Prompt caching: `cache_control` on the fixed system block; tools and fixed rules first, dynamic data last.
  - Refusal fallback: `fallbacks: "default"` (beta `server-side-fallback-2026-07-01`), only for models that have
    one (not Haiku 5.5); a final `refusal` maps to
    `stop: "refusal"`.
  - SDK errors mapped by class (`RateLimitError`, `AuthenticationError`, ...) to `LlmError`.
- `local.ts`: LM Studio's OpenAI-compatible API via the `openai` package, `temperature: 0`. Tool arguments arrive as a
  JSON string: `JSON.parse` in a try/catch; bad JSON becomes `inputError` (not a crash).
- `index.ts`: `getProvider()` picks the adapter from config.
- `fixtures/*.json`: recorded raw responses from both providers (real calls, saved once).

**Tests (no network):**

- **Contract test** (`src/agent/llm-contract.test.ts`): the same scenarios run through both adapters with recorded responses and must
  give the same shape: text only · one tool call · two tool calls in one step · bad JSON arguments · `max_tokens`.
- Request mapping: our messages and tools → each provider's request (tool results grouped; Claude raw content
  replayed; schemas passed through).
- Error mapping: 429 → `rate_limit`, 401 → `auth`, connection error → `unavailable`.

## Step 2b: agent loop, prompt v1, guards (`src/agent/`)

**Files**

- `tool-defs.ts`: `TOOLS` → `LlmToolDef[]` with `z.toJSONSchema(schema, { io: "input" })`.
- `prompts/v1.ts`: `{ version: "v1", fixed, dynamic(ctx) }`. Fixed part: role, qualification fields, "facts only from
  tools", when to hand off, reply in the buyer's language, WhatsApp-short replies. Dynamic part (last): current Dubai
  date and time, saved lead fields.
- `loop.ts`: `runAgentTurn({ provider, db, leadId, history, userMessage, now })`.
  - Steps: call model → run each requested tool with `tool.execute()` (Zod-validated) → send results back → repeat.
  - Limits: max 8 model calls per turn, 90 s timeout per turn (the local model is slow).
  - Unknown tool, bad JSON, invalid input, a tool that throws → an error result goes back to the model. The loop
    never crashes on model output.
  - Same tool failing 3 times in one turn → stop and reply with a safe handoff message.
  - Provider error: one retry if `retryable`, then a friendly "please try again" reply.
  - Returns `{ reply, newMessages, toolLog, usage, promptVersion, provider, model }` (Phase 3 tracing uses this).
- `guards.ts`: `findInventedPrices(reply, toolResults)`: every AED amount in the reply (`AED 1,200,000`,
  `1.2M AED`, `120k`) must match a number in this conversation's tool results. If not: one retry with a correction
  note; if it still fails, send a safe reply without the amount.
- `conversation.ts`: load/save messages for a lead (needs a new table, below).
- `leads.ts`: read model for the agent view: lead fields, status, viewings, a **lead score** (code, not the model:
  points for each filled field, financing, timeline) and a short summary built from the fields and handoff summary.
- `config.ts`: Zod-validated `DATABASE_URL`; `db.ts` creates the app's database client once.

**Database:** new `messages` table (`id`, `lead_id`, `seq`, `role`, `content` JSON, `created_at`) + migration `0001`.
Saving the chat lets a page reload keep the conversation and gives the agent view a transcript.

**Layer change (ADR 0004):** today the docs say `agent` may import `tools` and `llm` only. The loop needs a database
(the tools' `ctx.db`, and the conversation itself). Proposal: allow `agent → db`; `app` still never touches `db`.
ESLint already allows it; update `docs/architecture.md` and record why.

**Tests:** a scripted `FakeProvider` (no model) drives the loop:

- tool call → result → final reply; two tool calls in one step
- bad JSON / invalid input → error back to the model → model fixes it
- unknown tool, tool throws, max steps reached, timeout, retryable provider error
- the cash buyer in Dubai Marina: `search_listings` + `update_lead` both run and the lead is saved
- guards: invented price caught; price from a tool result passes; the three number formats; retry then safe reply
- conversation saved and reloaded in order; lead score and summary

## Step 2c: API + UI (`src/app/`)

Read `node_modules/next/dist/docs/` first (route handlers, Cache Components, Server/Client Components): this project
has `cacheComponents: true`, so pages that read the database need `Suspense` / dynamic rendering.

- `src/app/api/chat/route.ts`: `POST { leadId?, message }` (Zod) → `{ leadId, reply, lead }`. New lead id is created
  on the server. Not streamed in v1 (simpler; streaming can come later).
- `src/app/chat/page.tsx`: WhatsApp-style chat (client component): bubbles, typing indicator, lead id kept in the URL
  (`/chat?lead=...`) so a reload keeps the chat. Shows which provider/model answered (small label).
- `src/app/leads/page.tsx` + `src/app/leads/[id]/page.tsx`: agent view: list of leads with status and score; detail
  with fields, missing fields, viewings, summary and transcript.
- `src/app/page.tsx`: replace the Next.js starter with links to Chat and Leads.
- `import "server-only"` in agent entry points so model code can never end up in the browser bundle.
- Migrations stay in scripts and tests (`npm run db:seed`). If the app finds no tables it shows "run npm run db:seed".

**Tests:** route input validation (empty message, too long, bad lead id). UI checked by hand.

## End-to-end check (done criteria)

Same script on both providers, run by hand in the browser and recorded with real results in this plan:

1. "Hi, I want to rent a 2 bed in Dubai Marina, budget around 120k a year, paying cash, moving next month."
2. Ask about the listing it shows → details from `get_listing`.
3. "Can I see it on Saturday?" → slots → book → lead status `viewing_booked` in the agent view.
4. New chat: "I want to speak to a real person" → `handoff_to_human`.

First on Gemma (free, all the UI work), then once on Claude. Expected: Gemma may miss `update_lead` (known from the
probe). That is a finding for Phase 4 evals, not something to hide.

## New packages

`@anthropic-ai/sdk`, `openai` (LM Studio client), `server-only`.

## Risks / open questions

- **Cost:** Claude is only used for recording fixtures and the final end-to-end run (a few short chats, well under
  US$1). Needs `ANTHROPIC_API_KEY` in `.env.local` (you add it; I never read that file).
- **Strict tool schemas** (`strict: true`) on Claude: not in v1. Our Zod validation + error-back-to-model covers bad
  input on both providers the same way, which keeps the comparison fair.
- **Gemma tool calling through LM Studio** can return tool calls inside the text instead of as tool calls. If that
  happens we record it as a finding; we don't add model-specific hacks in v1.
- **Summary on the agent view** is built by code in v1. An LLM summary (Claude Haiku 5.5) can come later.

**Status:** approved (2026-11-15): pause after each step; ADR 0004 allows agent → db; Claude effort `low`

## Progress

### Step 2a: model layer (done, 2026-11-15)

- `npm run check` green: **129 tests** (54 before + 75 new: contract, both adapters, config).
- Packages: `@anthropic-ai/sdk` 1.8.0, `openai` 7.57.0, `server-only` 0.0.1.
- Changes from the plan:
  - **Retries live in the SDKs** (`maxRetries`: Claude 2, local 1), not in the loop. Both SDKs already retry
    429 / 5xx / network errors with backoff; a loop retry on top would multiply them. The loop (2b) only turns a
    final `LlmError` into a friendly reply.
  - `src/agent/tool-defs.ts` moved forward from 2b (the fixture recorder needs the tool schemas).
  - New `npm run llm:record -- local|claude` (`scripts/record-llm-fixtures.ts`) saves raw responses as fixtures.
  - Adapters take an optional `send` (tests) and `onRawResponse` (recorder; tracing in Phase 3).
  - `LlmRequest.signal` (AbortSignal) added so the loop's turn timeout can really stop a model call.
- Fixtures: 4 scenarios × 2 providers are **real recordings** (Gemma 2026-11-15, Claude Haiku 5.5 2026-11-16, via an
  `ant auth login` profile, no API key file). Still **synthetic** (`"recorded": null`), because a real run can't
  produce them on demand: Claude cut-off and refusal, local bad JSON and cut-off.
- Claude Haiku 5.5 recording (effort `low`, 4 calls, all 130 tests pass on the real responses):

  | Scenario                         | Haiku 5.5                                                                                       | Latency |
  | -------------------------------- | ----------------------------------------------------------------------------------------------- | ------- |
  | "Hi! Who am I talking to?"       | introduces itself, no tool                                                                      | 1.4 s   |
  | "Thanks, that's all… Bye!"       | says goodbye, no tool                                                                           | 0.9 s   |
  | Cash buyer, 2 bed Marina, 120k   | `update_lead` (purpose, beds, areas, budget, **cash**) + `search_listings`, no invented filters | 1.7 s   |
  | After a search result (scripted) | `update_lead` with the same fields (the scripted history had no save yet)                       | 1.4 s   |

  **Prompt caching works:** the first call wrote 2,711 tokens (tools + stable rules) to the cache; the next 3 read
  them (`cache_read_input_tokens: 2711`). **Cost of the whole run: about US$0.0008** (690 input, 2,711 cache-write,
  8,133 cache-read, 664 output tokens at Haiku 5.5 prices).

- `npm run llm:record` now runs Prettier on the fixtures (raw JSON failed `format:check` the first time).
- First real findings (Gemma 3 4B, temperature 0, recording run), kept for Phase 4 evals:
  1. "Hi! Who am I talking to?" → calls `update_lead({})` (empty) instead of answering.
  2. "2 bed in Dubai Marina, budget around 120k a year, paying cash" → `search_listings` with **invented filters**
     `propertyType: "apartment"`, `status: "ready"`; again no `update_lead` (budget and cash lost).
  3. "Thanks, that's all for today. Bye!" → "Okay, let's start. What are you looking for today?"
  4. After a search result: text and a `get_listing` call in the same step.

**Architecture review (step 2a): needs changes → fixed.** 2 blocking issues, each now covered by a test that was
shown to fail with the bug put back:

1. A cut-off or refused Claude answer was saved with its unfinished `tool_use` block. Replaying it without a
   `tool_result` is a 400, so the whole conversation would be stuck. → Unpaired `tool_use` blocks are dropped
   from the saved content (thinking blocks come before them and stay unchanged).
2. The contract replay test only checked that the call id appeared somewhere, so it passed even if every tool
   result was dropped. → It now reads the provider request back and checks every call has exactly one result
   (Claude: at the start of the next user message), also for the cut-off, refused and bad-JSON fixtures.

Suggestions applied: HTTP 408/504 and aborted calls map to `timeout`; abort `signal` passed to both SDKs; local
fallback ids are unique per response (`<response id>_<n>`, not `call_0`); only user messages are merged for
Claude, never two assistant turns (the loop in 2b must keep a user turn between them); ESLint import rules now
also cover `scripts/`.

Not applied (noted for later): on local replay, a bad-JSON call is re-sent as `{}` (the error message the model
gets already contains its raw text); checking that prompt caching really hits waits for real Claude recordings.
