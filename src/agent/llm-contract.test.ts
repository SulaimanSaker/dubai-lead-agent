/**
 * Adapter contract test: the same scenarios, run through BOTH adapters from saved provider responses,
 * must give the same result shape. No network. Fixtures: src/agent/llm/fixtures/ (local ones are real
 * recordings from `npm run llm:record -- local`; files with `"recorded": null` are synthetic).
 *
 * Lives in src/agent/ (not llm/) because it checks tool arguments against the real tool schemas,
 * and llm/ may not import tools.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildClaudeRequest, parseClaudeResponse } from "@/agent/llm/claude";
import { buildLocalRequest, parseLocalResponse } from "@/agent/llm/local";
import {
  toAssistantMessage,
  type LlmMessage,
  type LlmRequest,
  type LlmResult,
  type ProviderName,
} from "@/agent/llm";
import { TOOL_DEFS } from "@/agent/tool-defs";
import { TOOLS_BY_NAME } from "@/tools";

const PROVIDERS: ProviderName[] = ["claude", "local"];

function loadRaw(provider: ProviderName, scenario: string): unknown {
  const url = new URL(`./llm/fixtures/${provider}-${scenario}.json`, import.meta.url);
  return (JSON.parse(readFileSync(url, "utf8")) as { response: unknown }).response;
}

function parse(provider: ProviderName, scenario: string): LlmResult {
  const raw = loadRaw(provider, scenario);
  return provider === "claude"
    ? parseClaudeResponse(raw as Parameters<typeof parseClaudeResponse>[0])
    : parseLocalResponse(raw as Parameters<typeof parseLocalResponse>[0]);
}

function buildMessages(provider: ProviderName, messages: LlmMessage[]) {
  const request: LlmRequest = {
    system: { stable: "rules", dynamic: "now" },
    messages,
    tools: [...TOOL_DEFS],
  };
  return provider === "claude"
    ? buildClaudeRequest(request, { model: "claude-haiku-5-5", effort: "low" }).messages
    : buildLocalRequest(request, "google/gemma-3-4b").messages;
}

/**
 * Read the provider-format request back: which tool calls the assistant made, and which tool results
 * answer them, in order. For Claude, results must sit at the START of the next user message.
 */
function toolPairing(provider: ProviderName, messages: unknown[]) {
  const calls: string[] = [];
  const results: string[] = [];
  type Block = { type?: string; id?: string; tool_use_id?: string };
  type Message = {
    role: string;
    content?: unknown;
    tool_calls?: { id: string }[];
    tool_call_id?: string;
  };
  for (const message of messages as Message[]) {
    if (provider === "local") {
      if (message.role === "assistant") calls.push(...(message.tool_calls ?? []).map((c) => c.id));
      if (message.role === "tool" && message.tool_call_id) results.push(message.tool_call_id);
      continue;
    }
    const blocks = Array.isArray(message.content) ? (message.content as Block[]) : [];
    if (message.role === "assistant") {
      for (const block of blocks) if (block.type === "tool_use" && block.id) calls.push(block.id);
    } else {
      const firstOther = blocks.findIndex((block) => block.type !== "tool_result");
      blocks.forEach((block, index) => {
        if (block.type !== "tool_result" || !block.tool_use_id) return;
        expect(firstOther === -1 || index < firstOther, "tool_result after text").toBe(true);
        results.push(block.tool_use_id);
      });
    }
  }
  return { calls, results };
}

const count = z.number().int().nonnegative();
const resultShape = z.strictObject({
  text: z.string(),
  toolCalls: z.array(
    z.strictObject({
      id: z.string().min(1),
      name: z.string().min(1),
      input: z.unknown(),
      inputError: z.string().nullable(),
    }),
  ),
  stop: z.enum(["end", "tool_use", "max_tokens", "refusal", "other"]),
  usage: z.strictObject({ inputTokens: count, outputTokens: count, cachedInputTokens: count }),
  model: z.string().min(1),
  providerData: z.strictObject({
    provider: z.enum(["claude", "local"]),
    model: z.string().min(1),
    content: z.unknown(),
  }),
});

describe.each(PROVIDERS)("%s adapter contract", (provider) => {
  describe.each(["text-reply", "tool-call", "after-tool-result"])("%s", (scenario) => {
    const result = parse(provider, scenario);

    it("has the shared result shape", () => {
      expect(resultShape.safeParse(result).success).toBe(true);
      expect(result.providerData.provider).toBe(provider);
    });

    it("carries tool calls only when it stopped for tools", () => {
      expect(result.stop === "tool_use").toBe(result.toolCalls.length > 0);
    });

    it("gives valid arguments for known tools", () => {
      for (const call of result.toolCalls) {
        const tool = TOOLS_BY_NAME.get(call.name);
        expect(tool, `unknown tool ${call.name}`).toBeDefined();
        expect(call.inputError).toBeNull();
        expect(tool?.inputSchema.safeParse(call.input).success).toBe(true);
      }
    });

    it("survives saving to the database (JSON round trip)", () => {
      expect(JSON.parse(JSON.stringify(result.providerData))).toEqual(result.providerData);
    });
  });

  // Replay = what the next request sends. Every tool call in it must have exactly one result,
  // and no call may be left without one (the API rejects that, and the conversation is stuck).
  const replayScenarios =
    provider === "claude"
      ? ["text-reply", "tool-call", "after-tool-result", "max-tokens", "refusal"]
      : ["text-reply", "tool-call", "after-tool-result", "max-tokens", "bad-json"];

  it.each(replayScenarios)("%s: replays with every tool call answered exactly once", (scenario) => {
    const result = parse(provider, scenario);
    const history: LlmMessage[] = [
      { role: "user", text: "hi" },
      toAssistantMessage(result),
      ...result.toolCalls.map((call): LlmMessage => ({
        role: "tool",
        callId: call.id,
        name: call.name,
        result: '{"ok":true}',
        isError: false,
      })),
      { role: "user", text: "thanks" },
    ];
    const { calls, results } = toolPairing(provider, buildMessages(provider, history));
    expect(calls).toEqual(result.toolCalls.map((call) => call.id));
    expect(results).toEqual(calls);
  });

  it("text-reply: plain text, no tools", () => {
    const result = parse(provider, "text-reply");
    expect(result.stop).toBe("end");
    expect(result.text.length).toBeGreaterThan(0);
    expect(result.toolCalls).toEqual([]);
  });

  it("tool-call: searches Dubai Marina", () => {
    const result = parse(provider, "tool-call");
    expect(result.stop).toBe("tool_use");
    const search = result.toolCalls.find((call) => call.name === "search_listings");
    expect(search?.input).toMatchObject({ area: expect.stringMatching(/marina/i), beds: 2 });
  });

  it("max_tokens: never returns tool calls from a cut-off response", () => {
    const result = parse(provider, "max-tokens");
    expect(result.stop).toBe("max_tokens");
    expect(result.toolCalls).toEqual([]);
  });
});

describe("provider-specific contract cases", () => {
  it("local: bad JSON arguments become inputError, other calls still parse", () => {
    const result = parse("local", "bad-json");
    expect(result.stop).toBe("tool_use");
    const [broken, fine] = result.toolCalls;
    expect(broken).toMatchObject({ name: "search_listings", input: {} });
    expect(broken?.inputError).toMatch(/not valid JSON/);
    expect(fine).toMatchObject({ name: "update_lead", inputError: null, input: { beds: 2 } });
  });

  it("claude: a refusal has no text and no tool calls", () => {
    const result = parse("claude", "refusal");
    expect(result).toMatchObject({ stop: "refusal", text: "", toolCalls: [] });
  });

  it("claude: replays its own turn unchanged, thinking blocks included", () => {
    const raw = loadRaw("claude", "tool-call") as { content: unknown[] };
    const result = parse("claude", "tool-call");
    const messages = buildMessages("claude", [
      { role: "user", text: "hi" },
      toAssistantMessage(result),
    ]);
    expect(messages[1]).toEqual({ role: "assistant", content: raw.content });
  });

  it("a conversation can switch provider: local tool calls replay on Claude and back", () => {
    const local = parse("local", "tool-call");
    const claudeMessages = buildMessages("claude", [
      { role: "user", text: "hi" },
      toAssistantMessage(local),
    ]);
    expect(claudeMessages[1]).toEqual({
      role: "assistant",
      content: local.toolCalls.map((call) => ({
        type: "tool_use",
        id: call.id,
        name: call.name,
        input: call.input,
      })),
    });

    const claude = parse("claude", "tool-call");
    const localMessages = buildMessages("local", [
      { role: "user", text: "hi" },
      toAssistantMessage(claude),
    ]);
    // [system, user, assistant]
    expect(localMessages[2]).toMatchObject({
      role: "assistant",
      tool_calls: claude.toolCalls.map((call) => ({
        id: call.id,
        function: { name: call.name, arguments: JSON.stringify(call.input) },
      })),
    });
  });
});
