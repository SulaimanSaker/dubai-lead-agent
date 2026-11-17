# 0006 — Frozen system prompt; changing context as messages

- **Status:** accepted
- **Date:** 2026-11-17

## Context

Until now the system prompt had two parts: fixed rules, and a dynamic part (Dubai time, the lead's saved
fields) rebuilt before **every** model call. After `update_lead` saved something, the next call in the same turn
had a different system prompt.

On 2026-11-17 Claude Haiku 5.5 started rejecting the second call of such a turn with a 400:

> Invalid `signature` in `thinking` block. The block is bound to a different conversation. … The `system` prompt
> differs from the one this block was created with.

Current Claude models tie each thinking block to the exact conversation prefix it was produced with (system
prompt included) and check it when the block is replayed. The check was not enforced for this account the day
before, so the runs on 2026-11-16 passed. The rule is also how prompt caching works: any change early in the
prefix invalidates everything after it.

## Decision

- **The system prompt is frozen:** `LlmRequest.system` is one string, identical on every call of a conversation.
- **Changing information is appended as a `context` message**, never edited afterwards:
  - once per buyer message, right after it: Dubai time + lead status + saved and missing fields;
  - when the price guard retries: the correction note.
  - Context messages are saved with the conversation, so a later turn replays exactly what the model saw.
- **Claude:** `context` → a mid-conversation `{ role: "system" }` message (supported on Haiku 5.5, Sonnet 5.5,
  Opus 5.5); two in a row are joined the same way every time.
- **Local model:** `context` is appended to the message before it, because local chat templates (Gemma's) accept
  one system message at the start and strict user/assistant turns.
- Within a turn the model sees new facts through tool results (e.g. `update_lead` returns the saved lead), so the
  context does not need updating mid-turn.

## Alternatives considered

- **Strip thinking blocks before replay:** breaks the turn ("dropping or editing them breaks the turn") and loses
  the model's reasoning; the API guidance is to never strip them.
- **`prefix_mismatch_behavior: "drop_block"` (beta header):** hides the problem; the model silently loses its
  earlier reasoning on every call, and the prompt cache still breaks.
- **Put the context into the user's message text:** works, but mixes buyer words with operator data, and a
  `role: "system"` message is the operator channel that buyer text cannot forge.

## Consequences

- A regression test checks that, within a turn, the system prompt is identical on every call and each request
  only extends the previous one.
- The prompt version still identifies the rules; prompt v1's text did not change, only where its dynamic part is
  delivered.
- Prompt caching gets better: the cached prefix (tools + system) never changes. Because history is now
  append-only it could be cached too (a later breakpoint on the messages); not done yet.
- **Claude conversations saved before this change cannot continue.** Their assistant turns carry thinking blocks
  made under the old system prompt, so replaying them hits the same 400 (`provider_error` on every new message).
  Start a new chat, or reseed the local database. (A migration could send
  `thinking.block_binding.prefix_mismatch_behavior: "drop_block"` for old leads; not worth it for demo data.)
  Local-model conversations are not affected.
- Prompt v1's text is unchanged, but its dynamic part now arrives once per turn instead of before every call, so
  runs before and after 2026-11-17 are not strictly comparable. No evals existed yet, so nothing is lost.
- With `fallbacks: "default"`, Claude Sonnet 5.5 falls back to Claude Sonnet 5, which does **not** accept
  mid-conversation system messages; a refusal fallback on Sonnet could fail. Haiku 5.5 (the default) sends no
  fallbacks, and Opus 5.5's fallbacks support them. Check this before switching to Sonnet.
- Each generation in Langfuse carries the whole conversation so far, so trace data grows with conversation length
  squared. Fine for demo chats; long conversations would need trimming or a summary.
