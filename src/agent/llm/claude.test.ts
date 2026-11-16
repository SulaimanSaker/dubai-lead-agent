import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { buildClaudeRequest, createClaudeProvider, type ClaudeSend } from "@/agent/llm/claude";
import { LlmError, type LlmMessage, type LlmRequest } from "@/agent/llm/types";

const TOOL = {
  name: "search_listings",
  description: "Search listings.",
  jsonSchema: { type: "object" as const, properties: { area: { type: "string" } } },
};

function request(messages: LlmMessage[], dynamic = "Now: Sun 15 Nov 2026"): LlmRequest {
  return { system: { stable: "Fixed rules.", dynamic }, messages, tools: [TOOL] };
}

const options = { model: "claude-sonnet-5-5", effort: "low" as const };

describe("buildClaudeRequest", () => {
  it("sets effort, fallbacks and no sampling parameters", () => {
    const params = buildClaudeRequest(request([{ role: "user", text: "hi" }]), options);
    expect(params).toMatchObject({
      model: "claude-sonnet-5-5",
      output_config: { effort: "low" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
    expect(params).not.toHaveProperty("temperature");
    expect(params).not.toHaveProperty("tool_choice");
    expect(params).not.toHaveProperty("thinking");
  });

  it("sends no fallbacks to Haiku (it has no server-side fallback)", () => {
    const params = buildClaudeRequest(request([{ role: "user", text: "hi" }]), {
      ...options,
      model: "claude-haiku-5-5",
    });
    expect(params).toMatchObject({ model: "claude-haiku-5-5", output_config: { effort: "low" } });
    expect(params).not.toHaveProperty("fallbacks");
    expect(params).not.toHaveProperty("betas");
  });

  it("caches the stable system block and puts dynamic data after it", () => {
    const params = buildClaudeRequest(request([{ role: "user", text: "hi" }]), options);
    expect(params.system).toEqual([
      { type: "text", text: "Fixed rules.", cache_control: { type: "ephemeral" } },
      { type: "text", text: "Now: Sun 15 Nov 2026" },
    ]);
    const noDynamic = buildClaudeRequest(request([{ role: "user", text: "hi" }], ""), options);
    expect(noDynamic.system).toHaveLength(1);
  });

  it("maps tools to Claude's format", () => {
    const params = buildClaudeRequest(request([{ role: "user", text: "hi" }]), options);
    expect(params.tools).toEqual([
      { name: TOOL.name, description: TOOL.description, input_schema: TOOL.jsonSchema },
    ]);
  });

  it("puts all tool results of one step in ONE user message, before any new text", () => {
    const params = buildClaudeRequest(
      request([
        { role: "user", text: "2 bed in JVC" },
        {
          role: "assistant",
          text: "",
          toolCalls: [
            { id: "a", name: "search_listings", input: { area: "JVC" }, inputError: null },
            { id: "b", name: "update_lead", input: { beds: 2 }, inputError: null },
          ],
        },
        { role: "tool", callId: "a", name: "search_listings", result: "{}", isError: false },
        { role: "tool", callId: "b", name: "update_lead", result: "bad", isError: true },
        { role: "user", text: "and Marina?" },
      ]),
      options,
    );
    expect(params.messages).toHaveLength(3);
    expect(params.messages[2]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "a", content: "{}", is_error: false },
        { type: "tool_result", tool_use_id: "b", content: "bad", is_error: true },
        { type: "text", text: "and Marina?" },
      ],
    });
  });

  it("never merges two assistant turns (that would edit Claude's history)", () => {
    const turn = (text: string): LlmMessage => ({ role: "assistant", text, toolCalls: [] });
    const params = buildClaudeRequest(
      request([{ role: "user", text: "hi" }, turn("one"), turn("two")]),
      options,
    );
    expect(params.messages.map((m) => m.role)).toEqual(["user", "assistant", "assistant"]);
  });

  it("skips an assistant turn with no content (an empty message is a 400)", () => {
    const params = buildClaudeRequest(
      request([
        { role: "user", text: "hi" },
        { role: "assistant", text: "", toolCalls: [] },
        { role: "user", text: "hello?" },
      ]),
      options,
    );
    expect(params.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "hi" },
          { type: "text", text: "hello?" },
        ],
      },
    ]);
  });
});

describe("createClaudeProvider", () => {
  const message = {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5-5",
    content: [{ type: "text", text: "Hello!", citations: null }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 100,
      cache_creation_input_tokens: 20,
    },
  } as unknown as Awaited<ReturnType<ClaudeSend>>;

  it("returns the parsed result and reports the raw response", async () => {
    const onRawResponse = vi.fn();
    const provider = createClaudeProvider({
      ...options,
      send: async () => message,
      onRawResponse,
    });
    const result = await provider.generate(request([{ role: "user", text: "hi" }]));
    expect(result).toMatchObject({ text: "Hello!", stop: "end", toolCalls: [] });
    // Total input = uncached + cache reads + cache writes.
    expect(result.usage).toEqual({ inputTokens: 130, outputTokens: 5, cachedInputTokens: 100 });
    expect(onRawResponse).toHaveBeenCalledWith(message);
  });

  const failWith = (error: unknown) =>
    createClaudeProvider({
      ...options,
      send: async () => {
        throw error;
      },
    }).generate(request([{ role: "user", text: "hi" }]));

  it.each([
    [429, "rate_limit", true],
    [401, "auth", false],
    [403, "auth", false],
    [400, "bad_request", false],
    [529, "unavailable", true],
  ] as const)("maps HTTP %i to %s", async (status, kind, retryable) => {
    const error = Anthropic.APIError.generate(status, { error: {} }, "boom", new Headers());
    const thrown = await failWith(error).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(LlmError);
    expect(thrown).toMatchObject({ kind, provider: "claude", retryable });
  });

  it("maps network errors and timeouts", async () => {
    await expect(
      failWith(new Anthropic.APIConnectionError({ message: "offline" })),
    ).rejects.toMatchObject({ kind: "unavailable" });
    await expect(failWith(new Anthropic.APIConnectionTimeoutError())).rejects.toMatchObject({
      kind: "timeout",
    });
  });

  it("maps HTTP 408/504 and an aborted call to timeout", async () => {
    for (const status of [408, 504]) {
      const error = Anthropic.APIError.generate(status, { error: {} }, "slow", new Headers());
      await expect(failWith(error)).rejects.toMatchObject({ kind: "timeout", retryable: true });
    }
    await expect(failWith(new Anthropic.APIUserAbortError())).rejects.toMatchObject({
      kind: "timeout",
    });
  });

  it("passes the abort signal to the SDK", async () => {
    const send = vi.fn<ClaudeSend>(async () => message);
    const controller = new AbortController();
    await createClaudeProvider({ ...options, send }).generate({
      ...request([{ role: "user", text: "hi" }]),
      signal: controller.signal,
    });
    expect(send.mock.calls[0]?.[1]).toEqual({ signal: controller.signal });
  });

  it("re-throws bugs unchanged", async () => {
    const bug = new TypeError("x is undefined");
    await expect(failWith(bug)).rejects.toBe(bug);
  });
});
