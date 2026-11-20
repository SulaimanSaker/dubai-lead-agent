import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import {
  claudeStructured,
  type StructuredRequest,
  type StructuredSend,
} from "@/agent/llm/structured";
import { LlmError } from "@/agent/llm/types";

type Params = Parameters<StructuredSend>[0];

function response(text: string, stop = "end_turn") {
  return {
    model: "claude-sonnet-5-5",
    stop_reason: stop,
    content: [{ type: "text", text }],
    usage: {
      input_tokens: 30,
      output_tokens: 12,
      cache_read_input_tokens: 1_000,
      cache_creation_input_tokens: 200,
    },
  } as unknown as Awaited<ReturnType<StructuredSend>>;
}

const base: Omit<StructuredRequest, "send"> = {
  model: "claude-sonnet-5-5",
  effort: "low",
  system: "You grade.",
  user: "<transcript>…</transcript>",
  schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
};

describe("claudeStructured", () => {
  it("asks for the schema, parses the JSON answer and reports total input incl. cache", async () => {
    const sent: Params[] = [];
    const result = await claudeStructured({
      ...base,
      send: async (params) => {
        sent.push(params);
        return response('{"ok":true}');
      },
    });
    expect(sent[0]).toMatchObject({
      model: "claude-sonnet-5-5",
      system: "You grade.",
      output_config: { effort: "low", format: { type: "json_schema", schema: base.schema } },
      messages: [{ role: "user", content: base.user }],
    });
    expect(result).toEqual({
      data: { ok: true },
      model: "claude-sonnet-5-5",
      // Total input = uncached + cache reads + cache writes (what pricing.ts expects).
      usage: {
        inputTokens: 1_230,
        outputTokens: 12,
        cachedInputTokens: 1_000,
        cacheWriteInputTokens: 200,
      },
    });
  });

  it("marks the system prompt for caching when asked", async () => {
    const sent: Params[] = [];
    await claudeStructured({
      ...base,
      cacheSystem: true,
      send: async (params) => {
        sent.push(params);
        return response('{"ok":true}');
      },
    });
    expect(sent[0]?.system).toEqual([
      { type: "text", text: "You grade.", cache_control: { type: "ephemeral" } },
    ]);
  });

  it.each(["refusal", "max_tokens"])(
    "fails on stop reason %s instead of guessing",
    async (stop) => {
      await expect(
        claudeStructured({ ...base, send: async () => response('{"ok":', stop) }),
      ).rejects.toMatchObject({ kind: "bad_request", message: expect.stringContaining(stop) });
    },
  );

  it("fails on an answer that isn't JSON", async () => {
    await expect(
      claudeStructured({ ...base, send: async () => response("not json") }),
    ).rejects.toThrow(/invalid JSON/);
  });

  it("maps SDK errors to LlmError like the chat adapter", async () => {
    const thrown = await claudeStructured({
      ...base,
      send: async () => {
        throw Anthropic.APIError.generate(429, { error: {} }, "slow down", new Headers());
      },
    }).catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(LlmError);
    expect(thrown).toMatchObject({ kind: "rate_limit" });
  });
});
