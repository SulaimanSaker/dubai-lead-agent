import Anthropic from "@anthropic-ai/sdk";
import type {
  Message,
  MessageCreateParamsNonStreaming,
} from "@anthropic-ai/sdk/resources/messages/messages";
import { toLlmError, type ClaudeEffort } from "@/agent/llm/claude";
import { LlmError, type LlmUsage } from "@/agent/llm/types";

export type StructuredSend = (params: MessageCreateParamsNonStreaming) => Promise<Message>;

export interface StructuredRequest {
  model: string;
  effort: ClaudeEffort;
  system: string;
  /** Mark the system prompt for prompt caching (worth it when many calls share it, e.g. the eval judge). */
  cacheSystem?: boolean;
  user: string;
  /** JSON Schema the answer must follow (structured outputs: the reply is guaranteed to parse). */
  schema: Record<string, unknown>;
  apiKey?: string;
  /** Replaces the real API call (tests). */
  send?: StructuredSend;
}

export interface StructuredResult {
  /** The parsed JSON answer. Not validated against the caller's types: validate it (Zod). */
  data: unknown;
  model: string;
  usage: LlmUsage;
}

let defaultClient: Anthropic | null = null;

/**
 * One Claude call that must answer with JSON matching a schema (used by the eval judge). Lives in the model
 * layer because only src/agent/llm/ may use provider SDKs. Errors map to LlmError like the chat adapter.
 */
export async function claudeStructured(request: StructuredRequest): Promise<StructuredResult> {
  const send: StructuredSend =
    request.send ??
    ((params) => {
      defaultClient ??= new Anthropic({ apiKey: request.apiKey, maxRetries: 3, timeout: 120_000 });
      return defaultClient.messages.create(params);
    });

  let response: Message;
  try {
    response = await send({
      model: request.model,
      max_tokens: 4_000,
      output_config: {
        effort: request.effort,
        format: { type: "json_schema", schema: request.schema },
      },
      system: request.cacheSystem
        ? [{ type: "text", text: request.system, cache_control: { type: "ephemeral" } }]
        : request.system,
      messages: [{ role: "user", content: request.user }],
    });
  } catch (error) {
    throw toLlmError(error);
  }

  if (response.stop_reason === "refusal" || response.stop_reason === "max_tokens") {
    throw new LlmError("claude", "bad_request", `Structured call stopped: ${response.stop_reason}`);
  }
  const text = response.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("");
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new LlmError(
      "claude",
      "bad_request",
      `Structured call returned invalid JSON: ${text.slice(0, 200)}`,
    );
  }
  const usage = response.usage;
  const cached = usage.cache_read_input_tokens ?? 0;
  const written = usage.cache_creation_input_tokens ?? 0;
  return {
    data,
    model: response.model,
    usage: {
      inputTokens: usage.input_tokens + cached + written,
      outputTokens: usage.output_tokens,
      cachedInputTokens: cached,
      cacheWriteInputTokens: written,
    },
  };
}
