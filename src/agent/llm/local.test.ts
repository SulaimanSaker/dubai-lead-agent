import OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";
import {
  buildLocalRequest,
  createLocalProvider,
  parseLocalResponse,
  type LocalSend,
} from "@/agent/llm/local";
import { LlmError, type LlmRequest } from "@/agent/llm/types";

const TOOL = {
  name: "search_listings",
  description: "Search listings.",
  jsonSchema: { type: "object" as const, properties: { area: { type: "string" } } },
};

const baseRequest: LlmRequest = {
  system: "Fixed rules.",
  messages: [{ role: "user", text: "hi" }],
  tools: [TOOL],
};

type Completion = Awaited<ReturnType<LocalSend>>;

function completion(
  message: Record<string, unknown>,
  finish_reason: string,
  extra: Record<string, unknown> = {},
): Completion {
  return {
    id: "c1",
    object: "chat.completion",
    created: 0,
    model: "google/gemma-3-4b",
    choices: [
      { index: 0, logprobs: null, finish_reason, message: { role: "assistant", ...message } },
    ],
    ...extra,
  } as unknown as Completion;
}

describe("buildLocalRequest", () => {
  it("appends context to the message before it (local templates allow one system message only)", () => {
    const params = buildLocalRequest(
      {
        ...baseRequest,
        messages: [
          { role: "user", text: "hi" },
          { role: "context", text: "Now: Mon 16 Nov 2026" },
        ],
      },
      "m",
    );
    expect(params.messages).toEqual([
      { role: "system", content: "Fixed rules." },
      { role: "user", content: "hi\n\n[Context for the assistant]\nNow: Mon 16 Nov 2026" },
    ]);
  });

  it("appends context after a tool result, and starts a user message after an assistant turn", () => {
    const params = buildLocalRequest(
      {
        ...baseRequest,
        messages: [
          { role: "user", text: "hi" },
          {
            role: "assistant",
            text: "",
            toolCalls: [{ id: "a", name: "search_listings", input: {}, inputError: null }],
          },
          { role: "tool", callId: "a", name: "search_listings", result: "{}", isError: false },
          { role: "context", text: "Correction" },
          { role: "assistant", text: "Hello", toolCalls: [] },
          { role: "context", text: "Now: Mon" },
        ],
      },
      "m",
    );
    expect(params.messages.slice(3)).toEqual([
      { role: "tool", tool_call_id: "a", content: "{}\n\n[Context for the assistant]\nCorrection" },
      { role: "assistant", content: "Hello" },
      { role: "user", content: "[Context for the assistant]\nNow: Mon" },
    ]);
  });

  it("uses temperature 0 and one system message (stable rules first)", () => {
    const params = buildLocalRequest(baseRequest, "google/gemma-3-4b");
    expect(params.temperature).toBe(0);
    expect(params.messages[0]).toEqual({
      role: "system",
      content: "Fixed rules.",
    });
    expect(params.tools).toEqual([
      {
        type: "function",
        function: { name: TOOL.name, description: TOOL.description, parameters: TOOL.jsonSchema },
      },
    ]);
  });

  it("maps assistant tool calls and tool results", () => {
    const params = buildLocalRequest(
      {
        ...baseRequest,
        messages: [
          { role: "user", text: "2 bed in JVC" },
          {
            role: "assistant",
            text: "",
            toolCalls: [
              { id: "a", name: "search_listings", input: { area: "JVC" }, inputError: null },
            ],
          },
          { role: "tool", callId: "a", name: "search_listings", result: "{}", isError: false },
        ],
      },
      "m",
    );
    expect(params.messages.slice(2)).toEqual([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "a",
            type: "function",
            function: { name: "search_listings", arguments: '{"area":"JVC"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "a", content: "{}" },
    ]);
  });
});

describe("parseLocalResponse", () => {
  it("treats tool calls reported with finish_reason 'stop' as a tool step", () => {
    const result = parseLocalResponse(
      completion(
        {
          content: "",
          tool_calls: [
            {
              type: "function",
              id: "",
              function: { name: "get_listing", arguments: '{"listingId":"L02"}' },
            },
          ],
        },
        "stop",
      ),
    );
    expect(result.stop).toBe("tool_use");
    // A missing id gets a stable fallback, so the tool result can still reference it.
    expect(result.toolCalls).toEqual([
      { id: "c1_0", name: "get_listing", input: { listingId: "L02" }, inputError: null },
    ]);
  });

  it("treats finish_reason 'tool_calls' with no calls as a normal end", () => {
    const result = parseLocalResponse(
      completion({ content: "Sure!", tool_calls: [] }, "tool_calls"),
    );
    expect(result).toMatchObject({ stop: "end", text: "Sure!", toolCalls: [] });
  });

  it("treats empty arguments as {} and reads usage", () => {
    const result = parseLocalResponse(
      completion(
        {
          content: null,
          tool_calls: [{ type: "function", id: "x", function: { name: "t", arguments: "" } }],
        },
        "tool_calls",
        { usage: { prompt_tokens: 50, completion_tokens: 7, total_tokens: 57 } },
      ),
    );
    expect(result.text).toBe("");
    expect(result.toolCalls[0]).toMatchObject({ input: {}, inputError: null });
    expect(result.usage).toEqual({
      inputTokens: 50,
      outputTokens: 7,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
    });
  });

  it("throws an LlmError when there is no choice at all", () => {
    const empty = { ...completion({}, "stop"), choices: [] } as Completion;
    expect(() => parseLocalResponse(empty)).toThrow(LlmError);
  });
});

describe("createLocalProvider", () => {
  it("returns the parsed result and reports the raw response", async () => {
    const raw = completion({ content: "Hello!" }, "stop");
    const onRawResponse = vi.fn();
    const provider = createLocalProvider({
      baseUrl: "http://localhost:1234/v1",
      model: "google/gemma-3-4b",
      send: async () => raw,
      onRawResponse,
    });
    await expect(provider.generate(baseRequest)).resolves.toMatchObject({
      text: "Hello!",
      stop: "end",
    });
    expect(onRawResponse).toHaveBeenCalledWith(raw);
  });

  const failWith = (error: unknown) =>
    createLocalProvider({
      baseUrl: "http://localhost:1234/v1",
      model: "m",
      send: async () => {
        throw error;
      },
    }).generate(baseRequest);

  it("says LM Studio may not be running when the connection fails", async () => {
    const thrown = await failWith(new OpenAI.APIConnectionError({ message: "ECONNREFUSED" })).catch(
      (e: unknown) => e,
    );
    expect(thrown).toMatchObject({ kind: "unavailable", provider: "local", retryable: true });
    expect((thrown as Error).message).toContain("is the LM Studio server running");
  });

  it.each([
    [429, "rate_limit"],
    [400, "bad_request"],
    [500, "unavailable"],
  ] as const)("maps HTTP %i to %s", async (status, kind) => {
    const error = OpenAI.APIError.generate(status, { error: {} }, "boom", new Headers());
    await expect(failWith(error)).rejects.toMatchObject({ kind });
  });

  it("maps timeouts and aborts, and re-throws bugs unchanged", async () => {
    await expect(failWith(new OpenAI.APIConnectionTimeoutError())).rejects.toMatchObject({
      kind: "timeout",
    });
    await expect(failWith(new OpenAI.APIUserAbortError())).rejects.toMatchObject({
      kind: "timeout",
    });
    const bug = new TypeError("x is undefined");
    await expect(failWith(bug)).rejects.toBe(bug);
  });
});
