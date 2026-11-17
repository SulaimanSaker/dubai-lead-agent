import Anthropic from "@anthropic-ai/sdk";
import type {
  BetaContentBlockParam,
  BetaMessage,
  BetaMessageParam,
  BetaTool,
  MessageCreateParamsNonStreaming,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import {
  LlmError,
  type LlmErrorKind,
  type LlmMessage,
  type LlmProvider,
  type LlmRequest,
  type LlmResult,
  type LlmStop,
} from "@/agent/llm/types";

export type ClaudeEffort = "low" | "medium" | "high" | "xhigh" | "max";
export type ClaudeSend = (
  params: MessageCreateParamsNonStreaming,
  requestOptions: { signal?: AbortSignal },
) => Promise<BetaMessage>;

export interface ClaudeOptions {
  model: string;
  effort: ClaudeEffort;
  apiKey?: string;
  /** Replaces the real API call. Used by tests (recorded responses) and the fixture recorder. */
  send?: ClaudeSend;
  /** Called with every raw response (fixture recording; tracing later). */
  onRawResponse?: (response: BetaMessage) => void;
}

/** Chat replies are short; this is a safety cap, not a target. */
const MAX_TOKENS = 16_000;
/** On a policy refusal, the API retries on a server-chosen fallback model inside the same call. */
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

/**
 * Haiku models have no server-side fallback, and Anthropic says not to send `fallbacks` to them.
 * Their refusals come back as `stop: "refusal"` and the loop handles them.
 */
export function supportsServerFallback(model: string): boolean {
  return !model.startsWith("claude-haiku-");
}

/**
 * Claude through the official Anthropic SDK.
 *
 * - Thinking stays on; `effort` is the control. We set it explicitly: defaults differ per model
 *   (Haiku 5.5 and Opus 5.5: medium, Sonnet 5.5: high) and chat does well at `low`.
 * - No `temperature` (rejected by current models) and `tool_choice` stays `auto` (forced choice is a 400).
 * - Retries for 429 / 5xx / network errors are done by the SDK (`maxRetries`), with backoff.
 */
export function createClaudeProvider(options: ClaudeOptions): LlmProvider {
  let send = options.send;
  const getSend = (): ClaudeSend => {
    if (!send) {
      const client = new Anthropic({ apiKey: options.apiKey, maxRetries: 2, timeout: 60_000 });
      send = (params, requestOptions) => client.beta.messages.create(params, requestOptions);
    }
    return send;
  };

  return {
    name: "claude",
    model: options.model,
    async generate(request) {
      const params = buildClaudeRequest(request, options);
      let response: BetaMessage;
      try {
        response = await getSend()(params, { signal: request.signal });
      } catch (error) {
        throw toLlmError(error);
      }
      options.onRawResponse?.(response);
      return parseClaudeResponse(response);
    },
  };
}

export function buildClaudeRequest(
  request: LlmRequest,
  options: Pick<ClaudeOptions, "model" | "effort">,
): MessageCreateParamsNonStreaming {
  const system: MessageCreateParamsNonStreaming["system"] = [
    // Tools render before the system prompt, so this breakpoint caches tools + the frozen rules.
    { type: "text", text: request.system, cache_control: { type: "ephemeral" } },
  ];

  return {
    model: options.model,
    max_tokens: MAX_TOKENS,
    output_config: { effort: options.effort },
    ...(supportsServerFallback(options.model) && {
      betas: [FALLBACK_BETA],
      fallbacks: "default" as const,
    }),
    system,
    tools: request.tools.map((tool): BetaTool => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.jsonSchema,
    })),
    messages: toClaudeMessages(request.messages),
  };
}

/**
 * Our messages → Claude messages.
 * - Tool results become `tool_result` blocks; all results of one step share ONE user message.
 * - A Claude assistant turn is replayed from its raw content (thinking blocks included, unchanged).
 * - `context` becomes a mid-conversation `role: "system"` message (it always follows a user or tool-result
 *   message in our conversations). Two in a row are joined into one, the same way every time.
 */
export function toClaudeMessages(messages: LlmMessage[]): BetaMessageParam[] {
  const out: BetaMessageParam[] = [];
  const add = (role: "user" | "assistant", blocks: BetaContentBlockParam[]) => {
    if (blocks.length === 0) return;
    const last = out.at(-1);
    // Only user content is merged (tool results + text). Two assistant turns are never merged:
    // that would edit Claude's history, which current Claude models check. The loop keeps a user turn between them.
    if (role === "user" && last?.role === "user" && Array.isArray(last.content)) {
      last.content.push(...blocks);
    } else {
      out.push({ role, content: [...blocks] });
    }
  };

  for (const message of messages) {
    if (message.role === "user") {
      add("user", [{ type: "text", text: message.text }]);
    } else if (message.role === "context") {
      const last = out.at(-1);
      if (last?.role === "system" && typeof last.content === "string") {
        last.content = `${last.content}\n\n${message.text}`;
      } else if (last?.role === "user") {
        out.push({ role: "system", content: message.text });
      } else {
        // A system message must follow a user message. Our loop never produces anything else, but if a
        // future change did, a 400 here would block the lead forever; send it as user text instead.
        add("user", [{ type: "text", text: `[Context for the assistant]\n${message.text}` }]);
      }
    } else if (message.role === "tool") {
      add("user", [
        {
          type: "tool_result",
          tool_use_id: message.callId,
          content: message.result,
          is_error: message.isError,
        },
      ]);
    } else {
      const raw = message.providerData;
      if (raw?.provider === "claude" && Array.isArray(raw.content)) {
        add("assistant", raw.content as BetaContentBlockParam[]);
      } else {
        // Written by another provider: rebuild from the neutral fields.
        const blocks: BetaContentBlockParam[] = [];
        if (message.text) blocks.push({ type: "text", text: message.text });
        for (const call of message.toolCalls) {
          blocks.push({ type: "tool_use", id: call.id, name: call.name, input: call.input ?? {} });
        }
        add("assistant", blocks);
      }
    }
  }
  return out;
}

export function parseClaudeResponse(response: BetaMessage): LlmResult {
  const stop = mapStop(response.stop_reason);
  const text = response.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("");
  const toolCalls =
    stop === "tool_use"
      ? response.content.flatMap((block) =>
          block.type === "tool_use"
            ? [{ id: block.id, name: block.name, input: block.input, inputError: null }]
            : [],
        )
      : [];
  const usage = response.usage;
  const cached = usage.cache_read_input_tokens ?? 0;

  return {
    text,
    toolCalls,
    stop,
    usage: {
      inputTokens: usage.input_tokens + cached + (usage.cache_creation_input_tokens ?? 0),
      outputTokens: usage.output_tokens,
      cachedInputTokens: cached,
      cacheWriteInputTokens: usage.cache_creation_input_tokens ?? 0,
    },
    model: response.model,
    providerData: {
      provider: "claude",
      model: response.model,
      content: replayableContent(response),
    },
  };
}

/**
 * What to send back next time. A cut-off or refused answer can end with a `tool_use` we will never run;
 * replaying it without a `tool_result` is a 400 on every later request. So we drop those unpaired
 * `tool_use` blocks (they come after the thinking blocks, which stay valid and unchanged).
 */
function replayableContent(response: BetaMessage): BetaMessage["content"] {
  if (response.stop_reason === "tool_use") return response.content;
  return response.content.filter((block) => block.type !== "tool_use");
}

function mapStop(reason: BetaMessage["stop_reason"]): LlmStop {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "end";
    case "tool_use":
      return "tool_use";
    case "max_tokens":
    case "model_context_window_exceeded":
      return "max_tokens";
    case "refusal":
      return "refusal";
    default:
      return "other";
  }
}

/** Map SDK errors by class (most specific first). Anything else is a bug and is re-thrown as is. */
export function toLlmError(error: unknown): unknown {
  const make = (kind: LlmErrorKind) =>
    new LlmError("claude", kind, `Claude: ${(error as Error).message}`, { cause: error });

  // Our loop aborts a call when its turn timeout is reached, so an abort counts as a timeout.
  if (error instanceof Anthropic.APIUserAbortError) return make("timeout");
  if (error instanceof Anthropic.APIConnectionTimeoutError) return make("timeout");
  if (error instanceof Anthropic.APIConnectionError) return make("unavailable");
  if (error instanceof Anthropic.RequestTimeoutError) return make("timeout");
  if (error instanceof Anthropic.GatewayTimeoutError) return make("timeout");
  if (error instanceof Anthropic.RateLimitError) return make("rate_limit");
  if (error instanceof Anthropic.AuthenticationError) return make("auth");
  if (error instanceof Anthropic.PermissionDeniedError) return make("auth");
  if (error instanceof Anthropic.InternalServerError) return make("unavailable");
  if (error instanceof Anthropic.APIError) {
    return make(
      typeof error.status === "number" && error.status >= 500 ? "unavailable" : "bad_request",
    );
  }
  return error;
}
