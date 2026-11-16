/**
 * Provider-neutral types for talking to a model. Everything outside src/agent/llm/ uses only these,
 * so the same agent runs on Claude or the local model. See docs/decisions/0002-model-layer.md.
 */

export type ProviderName = "claude" | "local";

/**
 * The provider's own copy of an assistant turn, stored with the conversation and replayed unchanged.
 * Claude needs this: its reasoning (thinking blocks) must be sent back exactly as received.
 * Must be JSON-serializable, because conversations are saved in the database.
 */
export interface ProviderData {
  provider: ProviderName;
  model: string;
  content: unknown;
}

export interface LlmToolCall {
  /** The provider's id for this call; the tool result must reference it. */
  id: string;
  name: string;
  /** Parsed arguments. Not validated yet: the tool's Zod schema does that. */
  input: unknown;
  /** Set when the model's arguments were not valid JSON. `input` is then `{}`. */
  inputError: string | null;
}

export type LlmMessage =
  | { role: "user"; text: string }
  | {
      role: "assistant";
      text: string;
      toolCalls: LlmToolCall[];
      providerData?: ProviderData;
    }
  | {
      role: "tool";
      callId: string;
      name: string;
      /** What the tool returned, as a string (usually JSON). */
      result: string;
      isError: boolean;
    };

/** A tool as the model sees it. Built from the Zod schemas in src/tools by the agent layer. */
export interface LlmToolDef {
  name: string;
  description: string;
  jsonSchema: { type: "object"; [key: string]: unknown };
}

export interface LlmRequest {
  /**
   * `stable` is the same on every call (cached by providers that support it).
   * `dynamic` changes per call (time, lead state) and always comes after it.
   */
  system: { stable: string; dynamic: string };
  messages: LlmMessage[];
  tools: LlmToolDef[];
  /** Aborts the call (the loop's turn timeout). An aborted call fails with a `timeout` LlmError. */
  signal?: AbortSignal;
}

/** Why the model stopped. `tool_use` is the only stop that carries tool calls. */
export type LlmStop = "end" | "tool_use" | "max_tokens" | "refusal" | "other";

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  /** Input tokens served from the prompt cache (0 if the provider has no cache). */
  cachedInputTokens: number;
}

export interface LlmResult {
  text: string;
  /** Empty unless `stop` is `tool_use`. Never run tools from a cut-off or refused response. */
  toolCalls: LlmToolCall[];
  stop: LlmStop;
  usage: LlmUsage;
  /** The model that actually answered (can differ from the requested one after a fallback). */
  model: string;
  providerData: ProviderData;
}

export interface LlmProvider {
  readonly name: ProviderName;
  readonly model: string;
  generate(request: LlmRequest): Promise<LlmResult>;
}

export type LlmErrorKind = "rate_limit" | "timeout" | "unavailable" | "bad_request" | "auth";

/** The only error type the agent loop needs to understand. Provider SDK errors are mapped to it. */
export class LlmError extends Error {
  readonly kind: LlmErrorKind;
  readonly provider: ProviderName;

  constructor(provider: ProviderName, kind: LlmErrorKind, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LlmError";
    this.provider = provider;
    this.kind = kind;
  }

  /** Worth one more try: the request was fine, the service was busy or slow. */
  get retryable(): boolean {
    return this.kind === "rate_limit" || this.kind === "timeout" || this.kind === "unavailable";
  }
}

/** Turn a model result into the assistant message that goes into the conversation. */
export function toAssistantMessage(result: LlmResult): LlmMessage {
  return {
    role: "assistant",
    text: result.text,
    toolCalls: result.toolCalls,
    providerData: result.providerData,
  };
}

/** Parse tool arguments sent as a JSON string. Bad JSON is reported, never thrown. */
export function parseToolArguments(raw: string): { input: unknown; inputError: string | null } {
  if (raw.trim() === "") return { input: {}, inputError: null };
  try {
    return { input: JSON.parse(raw), inputError: null };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { input: {}, inputError: `Arguments were not valid JSON (${reason}): ${raw}` };
  }
}
