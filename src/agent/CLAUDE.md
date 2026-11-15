# src/agent — rules for the agent layer

This folder is the "brain": system prompts, the tool-calling loop and the guardrails.

## Model providers

- Only `src/agent/llm/` may import a provider SDK (`@anthropic-ai/sdk`, LM Studio client). ESLint blocks it elsewhere.
- Everything outside `llm/` uses the `LlmProvider` interface, so the same agent runs on Claude or the local model (`LLM_PROVIDER=claude|local`).
- Adding a provider? Use the `add-llm-provider` skill.

## Prompts

- Prompts live in `prompts/` as versioned files: `v1.ts`, `v2.ts`, … Never edit a released version in place — copy it to a new version (use the `change-prompt` skill) so evals can compare old vs new.
- Keep fixed instructions first and dynamic data (lead, listings, time) last.

## Guardrails (non-negotiable)

- Facts (prices, availability, dates) come only from tool results — never from the model's memory.
- Any `AED` amount in a reply must exist in a tool result (`guards.ts` checks this).
- Hand off to a human on: negotiation, complaints, explicit request for a person, or repeated tool failure.
- The loop has a max step count and a timeout. Tool inputs are validated with Zod before running; bad inputs go back to the model as an error, not a crash.
