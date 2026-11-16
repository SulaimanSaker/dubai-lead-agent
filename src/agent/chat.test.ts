import { beforeEach, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { handleBuyerMessage, type ChatDeps } from "@/agent/chat";
import { appendMessages, loadConversation, loadTurnMeta } from "@/agent/conversation";
import { getChatView, getLeadDetail } from "@/agent/leads";
import { FakeProvider, textStep, toolStep, type FakeStep } from "@/agent/testing/fake-provider";
import type { Db } from "@/db/client";
import { messages } from "@/db/schema";
import { createTestDb } from "@/db/test-db";

const NOW = new Date("2026-11-16T10:05:00Z");
const LEAD_ID = "5f0c6a7e-8a1b-4c2d-9e3f-0a1b2c3d4e5f";

let db: Db;

beforeEach(async () => {
  db = await createTestDb();
});

function deps(script: FakeStep[]): ChatDeps & { provider: FakeProvider } {
  return { db, provider: new FakeProvider(script), now: () => NOW, newId: () => LEAD_ID };
}

describe("handleBuyerMessage", () => {
  it("starts a new lead, saves the conversation and returns the lead view", async () => {
    const response = await handleBuyerMessage(
      { message: "2 bed in Dubai Marina, budget 120k, cash" },
      deps([
        toolStep([
          "update_lead",
          {
            purpose: "rent",
            areas: ["Dubai Marina"],
            beds: 2,
            budgetAed: 120000,
            financing: "cash",
          },
        ]),
        textStep("Noted! When are you planning to move?"),
      ]),
    );

    expect(response).toMatchObject({
      leadId: LEAD_ID,
      reply: "Noted! When are you planning to move?",
      outcome: "replied",
      lead: { status: "new", missing: ["timeline"], fields: { budgetAed: 120000 } },
    });
    const saved = await loadConversation(db, LEAD_ID);
    expect(saved.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
  });

  it("continues the saved conversation on the next message", async () => {
    await handleBuyerMessage({ message: "Hi" }, deps([textStep("Hello! Rent or buy?")]));
    const second = deps([textStep("Great. Which area?")]);
    await handleBuyerMessage({ leadId: LEAD_ID, message: "Rent" }, second);

    expect(second.provider.requests[0]?.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
    ]);
    expect(await loadConversation(db, LEAD_ID)).toHaveLength(4);
  });

  it("handles two messages for the same lead one after another, not at the same time", async () => {
    await handleBuyerMessage({ message: "Hi" }, deps([textStep("Hello!")]));
    const first = deps([textStep("Rent noted.")]);
    const second = deps([textStep("Marina noted.")]);
    await Promise.all([
      handleBuyerMessage({ leadId: LEAD_ID, message: "Rent" }, first),
      handleBuyerMessage({ leadId: LEAD_ID, message: "Marina" }, second),
    ]);
    // The second call saw the first call's question and answer.
    expect(second.provider.requests[0]?.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
    ]);
    const saved = await loadConversation(db, LEAD_ID);
    expect(saved.flatMap((m) => (m.role === "user" ? [m.text] : []))).toEqual([
      "Hi",
      "Rent",
      "Marina",
    ]);
  });

  it("does not let a failing message block the next one for the same lead", async () => {
    await handleBuyerMessage({ message: "Hi" }, deps([textStep("Hello!")]));
    const broken: ChatDeps = {
      ...deps([textStep("never")]),
      // Same database, but saving the turn fails.
      db: Object.assign(Object.create(db) as Db, {
        batch: () => Promise.reject(new Error("disk full")),
      }),
    };
    const results = await Promise.allSettled([
      handleBuyerMessage({ leadId: LEAD_ID, message: "Rent" }, broken),
      handleBuyerMessage({ leadId: LEAD_ID, message: "Marina" }, deps([textStep("Marina noted.")])),
    ]);
    expect(results.map((r) => r.status)).toEqual(["rejected", "fulfilled"]);
  });

  it("stores per-turn facts on the reply (provider, model, prompt version, tokens)", async () => {
    await handleBuyerMessage({ message: "Hi" }, deps([textStep("Hello!")]));
    const [turn] = await loadTurnMeta(db, LEAD_ID);
    expect(turn?.meta).toMatchObject({
      provider: "local",
      model: "fake-model",
      promptVersion: "v1",
      inputTokens: 100,
      outcome: "replied",
    });
  });

  it.each([
    [{ message: "   " }, "Message is empty"],
    [{ message: "x".repeat(2001) }, "Message is too long"],
    [{ leadId: "lead-1", message: "Hi" }, "Invalid UUID"],
  ])("rejects invalid input %#", async (input, error) => {
    const promise = handleBuyerMessage(input, deps([textStep("never called")]));
    await expect(promise).rejects.toBeInstanceOf(ZodError);
    await expect(promise).rejects.toThrow(error);
  });
});

describe("conversation storage", () => {
  it("round-trips Claude's raw content unchanged", async () => {
    await handleBuyerMessage({ message: "Hi" }, deps([textStep("Hello!")]));
    const raw = [
      { type: "thinking", thinking: "", signature: "sig" },
      { type: "text", text: "Hi!" },
    ];
    await appendMessages(
      db,
      LEAD_ID,
      [
        { role: "user", text: "Hello again" },
        {
          role: "assistant",
          text: "Hi!",
          toolCalls: [],
          providerData: { provider: "claude", model: "claude-haiku-5-5", content: raw },
        },
      ],
      NOW,
    );
    const saved = await loadConversation(db, LEAD_ID);
    expect(saved.at(-1)).toEqual({
      role: "assistant",
      text: "Hi!",
      toolCalls: [],
      providerData: { provider: "claude", model: "claude-haiku-5-5", content: raw },
    });
  });

  it("fails loudly on a corrupted row instead of sending it to the model", async () => {
    await handleBuyerMessage({ message: "Hi" }, deps([textStep("Hello!")]));
    await db.insert(messages).values({
      leadId: LEAD_ID,
      role: "assistant",
      content: { role: "assistant", text: 42 },
      createdAt: NOW.toISOString(),
    });
    await expect(loadConversation(db, LEAD_ID)).rejects.toThrow(/Stored message \d+ .* is invalid/);
  });
});

describe("getChatView", () => {
  it("gives the buyer page bubbles and the lead summary, but no tool names or model data", async () => {
    await handleBuyerMessage(
      { message: "2 bed in Marina" },
      deps([toolStep(["update_lead", { beds: 2 }]), textStep("Noted!")]),
    );
    const chat = await getChatView(db, LEAD_ID);
    expect(chat?.messages).toEqual([
      { role: "buyer", text: "2 bed in Marina" },
      { role: "agent", text: "Noted!" },
    ]);
    expect(chat?.lead.fields.beds).toBe(2);
    expect(JSON.stringify(chat)).not.toMatch(/update_lead|fake-model|inputTokens/);
  });
});

describe("getLeadDetail", () => {
  it("shows a readable transcript with the tools used before each reply", async () => {
    await handleBuyerMessage(
      { message: "2 bed in Marina, 120k" },
      deps([
        toolStep([
          "search_listings",
          { purpose: "rent", area: "Dubai Marina", beds: 2, maxPriceAed: 120000 },
        ]),
        textStep("I found one for AED 115,000 a year."),
      ]),
    );
    const detail = await getLeadDetail(db, LEAD_ID);
    expect(detail?.transcript).toEqual([
      { role: "buyer", text: "2 bed in Marina, 120k", toolsUsed: [] },
      {
        role: "agent",
        text: "I found one for AED 115,000 a year.",
        toolsUsed: ["search_listings"],
      },
    ]);
    expect(detail?.turns).toHaveLength(1);
  });

  it("returns null for an unknown lead", async () => {
    expect(await getLeadDetail(db, "nope")).toBeNull();
  });
});
