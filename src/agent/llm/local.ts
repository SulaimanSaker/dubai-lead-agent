import OpenAI from "openai";
import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions/completions";
import {
  LlmError,
  parseToolArguments,
  type LlmErrorKind,
  type LlmMessage,
  type LlmProvider,
  type LlmRequest,
  type LlmResult,
  type LlmStop,
} from "@/agent/llm/types";

export type LocalSend = (
  params: ChatCompletionCreateParamsNonStreaming,
  requestOptions: { signal?: AbortSignal },
) => Promise<ChatCompletion>;

export interface LocalOptions {
  baseUrl: string;
  model: string;
  /** Replaces the real API call. Used by tests (recorded responses) and the fixture recorder. */
  send?: LocalSend;
  /** Called with every raw response (fixture recording; tracing later). */
  onRawResponse?: (response: ChatCompletion) => void;
}

/**
 * A local model in LM Studio through its OpenAI-compatible API.
 * `temperature: 0` so development runs are as repeatable as a local model allows.
 */
export function createLocalProvider(options: LocalOptions): LlmProvider {
  let send = options.send;
  const getSend = (): LocalSend => {
    if (!send) {
      // LM Studio ignores the key, but the SDK requires one. A 4 GB GPU is slow: allow 2 minutes.
      const client = new OpenAI({
        baseURL: options.baseUrl,
        apiKey: "lm-studio",
        maxRetries: 1,
        timeout: 120_000,
      });
      send = (params, requestOptions) => client.chat.completions.create(params, requestOptions);
    }
    return send;
  };

  return {
    name: "local",
    model: options.model,
    async generate(request) {
      const params = buildLocalRequest(request, options.model);
      let response: ChatCompletion;
      try {
        response = await getSend()(params, { signal: request.signal });
      } catch (error) {
        throw toLlmError(error, options.baseUrl);
      }
      options.onRawResponse?.(response);
      return parseLocalResponse(response);
    },
  };
}

export function buildLocalRequest(
  request: LlmRequest,
  model: string,
): ChatCompletionCreateParamsNonStreaming {
  const system = [request.system.stable, request.system.dynamic].filter(Boolean).join("\n\n");
  return {
    model,
    temperature: 0,
    messages: [{ role: "system", content: system }, ...toLocalMessages(request.messages)],
    tools: request.tools.map((tool) => ({
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: tool.jsonSchema },
    })),
  };
}

/** Our messages → OpenAI chat messages. Always rebuilt from the neutral fields (no hidden state). */
export function toLocalMessages(messages: LlmMessage[]): ChatCompletionMessageParam[] {
  return messages.map((message): ChatCompletionMessageParam => {
    if (message.role === "user") return { role: "user", content: message.text };
    if (message.role === "tool") {
      return { role: "tool", tool_call_id: message.callId, content: message.result };
    }
    if (message.toolCalls.length === 0) return { role: "assistant", content: message.text };
    return {
      role: "assistant",
      content: message.text || null,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.input ?? {}) },
      })),
    };
  });
}

export function parseLocalResponse(response: ChatCompletion): LlmResult {
  const choice = response.choices[0];
  if (!choice) {
    throw new LlmError("local", "unavailable", "Local model returned no choices.");
  }
  const message = choice.message;
  const functionCalls = (message.tool_calls ?? []).flatMap((call) =>
    call.type === "function" ? [call] : [],
  );

  // Some local servers report "stop" even when the message contains tool calls.
  let stop = mapStop(choice.finish_reason);
  if (functionCalls.length > 0 && stop === "end") stop = "tool_use";

  const toolCalls =
    stop === "tool_use"
      ? functionCalls.map((call, index) => ({
          // Ids must be unique across the whole conversation (Claude rejects duplicates after a switch).
          id: call.id || `${response.id}_${index}`,
          name: call.function.name,
          ...parseToolArguments(call.function.arguments),
        }))
      : [];

  return {
    text: message.content ?? "",
    toolCalls,
    stop,
    usage: {
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: response.usage?.completion_tokens ?? 0,
      cachedInputTokens: response.usage?.prompt_tokens_details?.cached_tokens ?? 0,
    },
    model: response.model,
    providerData: { provider: "local", model: response.model, content: message },
  };
}

function mapStop(reason: ChatCompletion.Choice["finish_reason"]): LlmStop {
  switch (reason) {
    case "stop":
      return "end";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "content_filter":
      return "refusal";
    default:
      return "other";
  }
}

/** Map SDK errors by class (most specific first). Anything else is a bug and is re-thrown as is. */
export function toLlmError(error: unknown, baseUrl: string): unknown {
  const make = (kind: LlmErrorKind, hint = "") =>
    new LlmError("local", kind, `Local model: ${(error as Error).message}${hint}`, {
      cause: error,
    });

  // Our loop aborts a call when its turn timeout is reached, so an abort counts as a timeout.
  if (error instanceof OpenAI.APIUserAbortError) return make("timeout");
  if (error instanceof OpenAI.APIConnectionTimeoutError) return make("timeout");
  if (error instanceof OpenAI.APIConnectionError) {
    return make("unavailable", ` (is the LM Studio server running at ${baseUrl}?)`);
  }
  if (error instanceof OpenAI.RateLimitError) return make("rate_limit");
  if (error instanceof OpenAI.AuthenticationError) return make("auth");
  if (error instanceof OpenAI.InternalServerError) return make("unavailable");
  if (error instanceof OpenAI.APIError) {
    return make(
      typeof error.status === "number" && error.status >= 500 ? "unavailable" : "bad_request",
    );
  }
  return error;
}
