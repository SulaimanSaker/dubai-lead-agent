# 0004 — The agent layer may use the database (it owns the conversation)

- **Status:** accepted
- **Date:** 2026-11-16

## Context

`docs/architecture.md` said `src/agent` may import only `src/tools` and `src/agent/llm`. Phase 2 needs:

- a database client to build the tools' `ToolContext` (`ctx.db`),
- a place to **save the conversation** (every user, assistant and tool message), so a page reload keeps the chat,
  the agent view can show a transcript, and Claude's earlier turns can be replayed unchanged,
- a read model of leads for the agent view (fields, score, summary, viewings).

The UI (`src/app`) must still never touch the database.

## Decision

- Allow **`agent → db`**. The agent layer owns the conversation, so it stores it.
- New table `messages` (`lead_id`, `role`, `content` JSON = the provider-neutral `LlmMessage`, `meta` JSON,
  `created_at`). Order = auto-increment id. Stored content is validated with Zod when read back.
- The app talks only to `@/agent` (`handleBuyerMessage`, lead read functions). `app → db` stays forbidden by ESLint.
- The agent creates the app's database client once (`src/agent/db.ts`, `DATABASE_URL` validated with Zod).
  Migrations still run only from scripts and tests (`npm run db:seed`), never from the app.

## Alternatives considered

- **Keep db behind `src/tools`** (put the client and message storage in `src/tools/lib`). Keeps the old rule, but
  `tools/` would hold things that are not tools, and every agent feature would need a "fake tool" wrapper.
- **Let the app store messages.** Breaks "UI never touches the database" and splits the conversation logic
  between two layers.
- **Keep messages in memory / the browser.** No reload, no transcript for the human agent, and the browser would
  hold Claude's raw turns.

## Consequences

- The layer table in `docs/architecture.md` changes: `src/agent` may import `tools`, `agent/llm` and `db`.
  ESLint already allowed it, so no rule change is needed; `app → db` and `tools → agent` stay blocked.
- Saved conversations must stay replayable: the loop must never store a turn the provider would reject (see the
  orphan `tool_use` fix in step 2a) and never put two assistant turns in a row.
- Schema change → migration `0001` (`npm run db:generate`).
