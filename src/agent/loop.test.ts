import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LlmError, type LlmMessage } from "@/agent/llm";
import { runAgentTurn, type AgentTurnInput } from "@/agent/loop";
import { PROMPT_V1 } from "@/agent/prompts/v1";
import { FakeProvider, textStep, toolStep, type FakeStep } from "@/agent/testing/fake-provider";
import type { Db } from "@/db/client";
import { leads } from "@/db/schema";
import { createTestDb } from "@/db/test-db";
import { searchListings } from "@/tools/search-listings";

const NOW = new Date("2026-11-16T10:05:00Z"); // Mon 16 Nov 2026, 14:05 in Dubai
const CASH_BUYER = "2 bed in Dubai Marina, budget around 120k a year, paying cash";

let db: Db;

beforeEach(async () => {
  db = await createTestDb();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function turn(script: FakeStep[], overrides: Partial<AgentTurnInput> = {}) {
  const provider = new FakeProvider(script);
  const input: AgentTurnInput = {
    provider,
    db,
    leadId: "lead-1",
    history: [],
    userMessage: CASH_BUYER,
    now: NOW,
    ...overrides,
  };
  return { provider, run: () => runAgentTurn(input) };
}

/** A saved conversation must never have two assistant turns in a row (Claude rejects edited history). */
function expectAlternation(messages: LlmMessage[]) {
  messages.forEach((message, index) => {
    if (index > 0 && message.role === "assistant") {
      expect(messages[index - 1]?.role, `message ${index}`).not.toBe("assistant");
    }
  });
}

describe("runAgentTurn: normal turns", () => {
  it("replies with text and records the turn", async () => {
    const { provider, run } = turn([textStep("Hi! Are you looking to rent or buy?")]);
    const result = await run();

    expect(result).toMatchObject({
      reply: "Hi! Are you looking to rent or buy?",
      outcome: "replied",
      steps: 1,
      promptVersion: "v1",
      provider: "local",
      model: "fake-model",
      usage: {
        inputTokens: 100,
        outputTokens: 10,
        cachedInputTokens: 50,
        cacheWriteInputTokens: 0,
      },
    });
    expect(result.newMessages.map((m) => m.role)).toEqual(["user", "context", "assistant"]);

    const request = provider.requests[0];
    expect(request?.system).toBe(PROMPT_V1.stable);
    // Time and lead state arrive as a context message right after the buyer's message.
    const context = request?.messages[1];
    expect(context).toMatchObject({ role: "context" });
    expect(context && "text" in context && context.text).toContain(
      "Current time in Dubai: Mon 16 Nov 2026, 14:05",
    );
    expect(context && "text" in context && context.text).toContain("Saved so far: nothing yet");
    expect(request?.tools.map((t) => t.name)).toContain("search_listings");
  });

  it("runs tools, sends results back, and saves the lead (the cash buyer case)", async () => {
    const { provider, run } = turn([
      toolStep(
        [
          "update_lead",
          {
            purpose: "rent",
            areas: ["Dubai Marina"],
            beds: 2,
            budgetAed: 120000,
            financing: "cash",
          },
        ],
        [
          "search_listings",
          { purpose: "rent", area: "Dubai Marina", beds: 2, maxPriceAed: 120000 },
        ],
      ),
      textStep(
        "I found Spacious 2BR in Al Sahab Tower for AED 115,000 a year. When do you want to move?",
      ),
    ]);
    const result = await run();

    expect(result.outcome).toBe("replied");
    expect(result.toolLog.map((t) => [t.name, t.ok])).toEqual([
      ["update_lead", true],
      ["search_listings", true],
    ]);
    expect(result.newMessages.map((m) => m.role)).toEqual([
      "user",
      "context",
      "assistant",
      "tool",
      "tool",
      "assistant",
    ]);

    const lead = await db.query.leads.findFirst({ where: eq(leads.id, "lead-1") });
    expect(lead).toMatchObject({ budgetAed: 120000, financing: "cash", beds: 2 });

    // The second call sees the tool results (the saved lead is in update_lead's result).
    const second = provider.requests[1];
    expect(second?.messages.at(-1)).toMatchObject({ role: "tool", name: "search_listings" });
    expect(second?.messages.at(-1)).toHaveProperty("result", expect.stringContaining("L02"));
    expect(second?.messages.at(-2)).toHaveProperty("result", expect.stringContaining("120000"));
  });

  it("never edits what was already sent: same system prompt, and each call extends the last one", async () => {
    // Claude ties its thinking to the exact prefix it saw; a changed system prompt or edited history is a 400.
    const { provider, run } = turn([
      toolStep(["update_lead", { budgetAed: 120000 }]),
      toolStep(["search_listings", { purpose: "rent" }]),
      textStep("Here you go."),
    ]);
    await run();
    const [first, second, third] = provider.requests;
    expect(new Set(provider.requests.map((r) => r.system)).size).toBe(1);
    expect(second?.messages.slice(0, first?.messages.length)).toEqual(first?.messages);
    expect(third?.messages.slice(0, second?.messages.length)).toEqual(second?.messages);
  });

  it("continues an existing conversation", async () => {
    const history: LlmMessage[] = [
      { role: "user", text: "Hi" },
      { role: "assistant", text: "Hello! Rent or buy?", toolCalls: [] },
    ];
    const { provider, run } = turn([textStep("Great, which area?")], {
      history,
      userMessage: "Rent",
    });
    await run();
    expect(provider.requests[0]?.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "context",
    ]);
  });
});

describe("runAgentTurn: bad model output never crashes the turn", () => {
  it("sends invalid input back as an error, and the model can fix it", async () => {
    const { run } = turn([
      toolStep(["search_listings", { beds: "many" }]),
      toolStep(["search_listings", { purpose: "rent", beds: 2 }]),
      textStep("Here are some options."),
    ]);
    const result = await run();
    expect(result.outcome).toBe("replied");
    expect(result.toolLog.map((t) => [t.ok, t.error])).toEqual([
      [false, "invalid_input"],
      [true, undefined],
    ]);
    const firstResult = result.newMessages[3];
    expect(firstResult).toMatchObject({ role: "tool", isError: true });
  });

  it("reports bad JSON arguments and unknown tools to the model", async () => {
    const { provider, run } = turn([
      {
        stop: "tool_use",
        toolCalls: [
          {
            id: "a",
            name: "search_listings",
            input: {},
            inputError: "Arguments were not valid JSON",
          },
          { id: "b", name: "find_cheap_villas", input: {}, inputError: null },
        ],
      },
      textStep("Let me try again."),
    ]);
    const result = await run();
    const results = provider.requests[1]?.messages.filter((m) => m.role === "tool") ?? [];
    expect(results.map((m) => JSON.parse((m as { result: string }).result).error)).toEqual([
      "invalid_input",
      "unknown_tool",
    ]);
    expect(result.outcome).toBe("replied");
  });

  it("turns a crashing tool into an error result and logs it", async () => {
    vi.spyOn(searchListings, "execute").mockRejectedValue(new Error("database is locked"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { run } = turn([
      toolStep(["search_listings", { purpose: "rent" }]),
      textStep("Sorry, let me try that again."),
    ]);
    const result = await run();
    expect(result.toolLog[0]).toMatchObject({
      name: "search_listings",
      ok: false,
      error: "tool_crashed",
    });
    expect(log).toHaveBeenCalled();
    expect(result.outcome).toBe("replied");
  });

  it("hands off to a human after the same tool fails 3 times", async () => {
    const bad = toolStep(["search_listings", { beds: "many" }]);
    const { run } = turn([
      bad,
      toolStep(["search_listings", { beds: -1 }]),
      toolStep(["search_listings", { beds: "x" }]),
    ]);
    const result = await run();

    expect(result.outcome).toBe("tool_failures");
    expect(result.reply).toMatch(/human agent/);
    expect(result.toolLog.at(-1)).toMatchObject({ name: "handoff_to_human", ok: true });
    const lead = await db.query.leads.findFirst({ where: eq(leads.id, "lead-1") });
    expect(lead?.status).toBe("handed_off");
    expectAlternation(result.newMessages);
  });
});

describe("runAgentTurn: limits and provider problems end in a safe reply", () => {
  it("stops after maxSteps", async () => {
    const provider = new FakeProvider([toolStep(["get_listing", { listingId: "L02" }])], {
      repeatLast: true,
    });
    const result = await runAgentTurn({
      provider,
      db,
      leadId: "lead-1",
      history: [],
      userMessage: "Tell me about L02",
      now: NOW,
      limits: { maxSteps: 3 },
    });
    expect(result).toMatchObject({ outcome: "max_steps", steps: 3 });
    expect(result.reply).toMatch(/^Sorry/);
    expect(result.newMessages.at(-1)).toMatchObject({ role: "assistant", toolCalls: [] });
    expectAlternation(result.newMessages);
  });

  it("aborts a slow model call when the turn times out", async () => {
    const slow: FakeStep = (request) =>
      new Promise((_, reject) => {
        request.signal?.addEventListener("abort", () =>
          reject(new LlmError("local", "timeout", "aborted")),
        );
      });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { run } = turn([slow], { limits: { timeoutMs: 20 } });
    const result = await run();
    expect(result).toMatchObject({ outcome: "timeout", error: "aborted" });
  });

  it("gives a safe reply when the provider is down", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { run } = turn([new LlmError("claude", "unavailable", "overloaded")]);
    const result = await run();
    expect(result).toMatchObject({ outcome: "provider_error", error: "overloaded" });
    expect(result.newMessages.map((m) => m.role)).toEqual(["user", "context", "assistant"]);
  });

  it("logs a bug in our own code and ends with internal_error, keeping the messages so far", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { run } = turn([
      toolStep(["update_lead", { budgetAed: 120000 }]),
      new TypeError("x is undefined"),
    ]);
    const result = await run();
    expect(result).toMatchObject({ outcome: "internal_error", error: "x is undefined" });
    expect(log).toHaveBeenCalled();
    // The saved update_lead call and its result stay, followed by the safe reply.
    expect(result.newMessages.map((m) => m.role)).toEqual([
      "user",
      "context",
      "assistant",
      "tool",
      "assistant",
    ]);
    expectAlternation(result.newMessages);
  });

  it.each([
    [{ stop: "refusal" as const }, "refusal", /can't help/],
    [{ stop: "max_tokens" as const, text: "Here are the det" }, "cut_off", /^Sorry/],
    [{ stop: "end" as const, text: "  " }, "provider_error", /^Sorry/],
  ])("handles %j", async (step, outcome, reply) => {
    const { run } = turn([step]);
    const result = await run();
    expect(result.outcome).toBe(outcome);
    expect(result.reply).toMatch(reply);
  });

  it("answers in Arabic when the buyer wrote Arabic", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { run } = turn([new LlmError("local", "unavailable", "down")], {
      userMessage: "أبحث عن شقة في دبي مارينا",
    });
    const result = await run();
    expect(result.reply).toMatch(/[؀-ۿ]/);
  });
});

describe("runAgentTurn: price guard", () => {
  it("retries once with a correction when the reply has a made-up price", async () => {
    const { provider, run } = turn([
      textStep("We have a 2 bed in Marina for AED 99,000."),
      toolStep(["search_listings", { purpose: "rent", area: "Dubai Marina", beds: 2 }]),
      textStep("I found one for AED 115,000 a year."),
    ]);
    const result = await run();

    expect(result.outcome).toBe("replied");
    expect(result.guardEvents).toEqual([
      { type: "invented_price", amounts: ["AED 99,000"], action: "retried" },
    ]);
    // The correction goes in as a context message (the system prompt never changes).
    expect(provider.requests[1]?.messages.at(-1)).toMatchObject({
      role: "context",
      text: expect.stringContaining("Correction: your draft reply mentioned AED 99,000"),
    });
    // The bad draft itself is never saved: no assistant message has the made-up price.
    const assistantText = result.newMessages.filter((m) => m.role === "assistant");
    expect(JSON.stringify(assistantText)).not.toContain("99,000");
  });

  it("replaces the reply if the retry still has a made-up price", async () => {
    const { run } = turn([
      textStep("It costs AED 99,000."),
      textStep("Sorry, it costs AED 98,000."),
    ]);
    const result = await run();
    expect(result.outcome).toBe("price_guard");
    expect(result.guardEvents.map((e) => e.action)).toEqual(["retried", "replaced"]);
    expect(result.reply).toMatch(/double-check the exact price/);
    const assistantText = result.newMessages.filter((m) => m.role === "assistant");
    expect(JSON.stringify(assistantText)).not.toMatch(/9[89],000/);
  });

  it("lets the buyer's budget through once update_lead has saved it", async () => {
    const { run } = turn([
      toolStep(["update_lead", { budgetAed: 120000, financing: "cash" }]),
      textStep("Noted: up to 120k a year, paid in cash. Which area?"),
    ]);
    const result = await run();
    expect(result.outcome).toBe("replied");
    expect(result.guardEvents).toEqual([]);
  });

  it("does not trust a number only the buyer said", async () => {
    const { run } = turn(
      [textStep("Yes, L02 is AED 80,000 a year."), textStep("Let me check that for you.")],
      { userMessage: "Is L02 really 80k a year?" },
    );
    const result = await run();
    expect(result.guardEvents).toEqual([
      { type: "invented_price", amounts: ["AED 80,000"], action: "retried" },
    ]);
    expect(result.reply).toBe("Let me check that for you.");
  });
});

describe("runAgentTurn: edge cases from review", () => {
  it("treats a tool stop with no calls as a text answer, never saving an empty tool turn", async () => {
    const { run } = turn([{ stop: "tool_use", toolCalls: [], text: "Which area do you prefer?" }]);
    const result = await run();
    expect(result).toMatchObject({ outcome: "replied", reply: "Which area do you prefer?" });
    expect(result.newMessages.map((m) => m.role)).toEqual(["user", "context", "assistant"]);

    const empty = await turn([{ stop: "tool_use", toolCalls: [], text: "" }]).run();
    expect(empty.outcome).toBe("provider_error");
    expectAlternation(empty.newMessages);
  });

  it("accepts a text answer with stop 'other'", async () => {
    const { run } = turn([{ stop: "other", text: "Hello!" }]);
    expect(await run()).toMatchObject({ outcome: "replied", reply: "Hello!" });
  });

  it("ends with a timeout reply when the time runs out during tools", async () => {
    vi.spyOn(searchListings, "execute").mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return { ok: true, count: 0, listings: [], message: "none" } as never;
    });
    const { provider, run } = turn([toolStep(["search_listings", { purpose: "rent" }])], {
      limits: { timeoutMs: 10 },
    });
    const result = await run();
    expect(result).toMatchObject({ outcome: "timeout", error: "turn timeout after tools" });
    expect(provider.requests).toHaveLength(1);
    expectAlternation(result.newMessages);
  });

  it("does not hand off when different tools fail twice each", async () => {
    const { run } = turn([
      toolStep(["search_listings", { beds: "x" }], ["get_listing", {}]),
      toolStep(["search_listings", { beds: "y" }], ["get_listing", {}]),
      textStep("Could you tell me the area you like?"),
    ]);
    const result = await run();
    expect(result.outcome).toBe("replied");
    expect(result.toolLog.some((t) => t.name === "handoff_to_human")).toBe(false);
  });

  it("clears the turn timer even when our own code throws", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { run } = turn([new TypeError("bug in our code")]);
      expect((await run()).outcome).toBe("internal_error");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
