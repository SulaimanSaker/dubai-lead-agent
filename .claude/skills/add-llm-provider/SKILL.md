---
name: add-llm-provider
description: Add or change a model provider adapter in src/agent/llm/ (e.g. Claude via the Anthropic SDK, a local model via LM Studio) behind the LlmProvider interface, with a contract test. Use when connecting a new model or changing how a provider is called.
---

# Add an LLM provider adapter

All model access goes through the `LlmProvider` interface in `src/agent/llm/types.ts`.
The rest of the app must not know which model is running.

## Steps

1. **Plan + ADR.** A new provider is an architecture decision → `write-adr` skill.
2. **Create `src/agent/llm/<provider>.ts`** implementing `LlmProvider`:
   - Map our messages → the provider's message format.
   - Map our tool definitions (built from the Zod schemas in `src/tools/`) → the provider's tool format.
   - Map the provider's response → our `{ text, toolCalls }` shape. Parse tool arguments with `JSON.parse`
     and validate them with the tool's Zod schema — never trust raw model output.
   - Read config from env (validated with Zod). Never hard-code keys.
3. **For Claude:** use the official Anthropic SDK (`@anthropic-ai/sdk`) — not an OpenAI-compatible shim.
   Load the `claude-api` skill first for current API details (model IDs, thinking/effort settings, tool use, refusals).
4. **For LM Studio:** use its OpenAI-compatible endpoint (`LMSTUDIO_BASE_URL`, default `http://localhost:1234/v1`).
5. **Register** it in `src/agent/llm/index.ts` under a new `LLM_PROVIDER` value; add the variable to `.env.example`.
6. **Contract test** `src/agent/llm/<provider>.test.ts`: feed a recorded provider response (no network) through the
   adapter and assert the output shape matches the other adapters (text and/or tool calls with valid arguments).
7. **Run evals** with `--provider <name>` and add the row to the model comparison table in `README.md`.

## Rules

- Provider SDK imports are allowed **only** in `src/agent/llm/` (ESLint enforces it).
- Errors from the provider (rate limits, timeouts, refusals) are mapped to one error type the loop understands.
