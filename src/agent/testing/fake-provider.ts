import type { LlmProvider, LlmRequest, LlmResult, LlmStop, LlmToolCall } from "@/agent/llm";

/** One scripted model answer: a result, an error to throw, or a function of the request. */
export type FakeStep =
  | Partial<LlmResult>
  | Error
  | ((request: LlmRequest) => Partial<LlmResult> | Promise<Partial<LlmResult>>);

/**
 * A model that answers from a script, for tests. Records every request it receives (a copy, because
 * the loop keeps appending to the same conversation array).
 */
export class FakeProvider implements LlmProvider {
  readonly name = "local" as const;
  readonly model = "fake-model";
  readonly requests: LlmRequest[] = [];
  private readonly script: FakeStep[];
  private readonly repeatLast: boolean;

  constructor(script: FakeStep[], options: { repeatLast?: boolean } = {}) {
    this.script = [...script];
    this.repeatLast = options.repeatLast ?? false;
  }

  async generate(request: LlmRequest): Promise<LlmResult> {
    this.requests.push({ ...request, messages: structuredClone(request.messages) });
    const step = this.script.length > 1 || !this.repeatLast ? this.script.shift() : this.script[0];
    if (step === undefined) throw new Error("FakeProvider: script is empty");
    if (step instanceof Error) throw step;
    const partial = typeof step === "function" ? await step(request) : step;
    const toolCalls = partial.toolCalls ?? [];
    const stop: LlmStop = partial.stop ?? (toolCalls.length > 0 ? "tool_use" : "end");
    return {
      text: "",
      toolCalls,
      stop,
      usage: {
        inputTokens: 100,
        outputTokens: 10,
        cachedInputTokens: 50,
        cacheWriteInputTokens: 0,
      },
      model: this.model,
      providerData: { provider: "local", model: this.model, content: null },
      ...partial,
    };
  }
}

let callCounter = 0;

/** A model step that asks for tools: `toolStep(["search_listings", {...}], ["update_lead", {...}])`. */
export function toolStep(...calls: [name: string, input: unknown][]): Partial<LlmResult> {
  return {
    stop: "tool_use",
    toolCalls: calls.map(([name, input]): LlmToolCall => ({
      id: `call_${++callCounter}`,
      name,
      input,
      inputError: null,
    })),
  };
}

/** A model step that replies with text. */
export function textStep(text: string): Partial<LlmResult> {
  return { stop: "end", text };
}
