import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleBuyerMessage, type ChatDeps } from "@/agent/chat";
import { loadConversation, loadTurnMeta } from "@/agent/conversation";
import { LlmError } from "@/agent/llm";
import { observeTurn, type TurnObserver } from "@/agent/observer";
import { FakeProvider, textStep, toolStep, type FakeStep } from "@/agent/testing/fake-provider";
import { RecordingObserver } from "@/agent/testing/recording-observer";
import type { Db } from "@/db/client";
import { createTestDb } from "@/db/test-db";

const NOW = new Date("2026-11-16T10:05:00Z");
const LEAD_ID = "5f0c6a7e-8a1b-4c2d-9e3f-0a1b2c3d4e5f";

let db: Db;
beforeEach(async () => {
  db = await createTestDb();
});

function deps(script: FakeStep[], observer: TurnObserver): ChatDeps {
  return {
    db,
    provider: new FakeProvider(script),
    now: () => NOW,
    newId: () => LEAD_ID,
    observer,
  };
}

describe("what the agent reports to the observer", () => {
  it("reports a turn with its model calls, tool calls and final outcome, in order", async () => {
    const observer = new RecordingObserver();
    await handleBuyerMessage(
      { message: "2 bed in Marina, 120k" },
      deps(
        [
          toolStep(
            ["update_lead", { beds: 2, budgetAed: 120000 }],
            ["search_listings", { purpose: "rent", area: "Dubai Marina", beds: 2 }],
          ),
          textStep("I found one for AED 115,000 a year."),
        ],
        observer,
      ),
    );

    expect(observer.kinds()).toEqual([
      "turn",
      "model:start",
      "model:end",
      "tool:start",
      "tool:end",
      "tool:start",
      "tool:end",
      "model:start",
      "model:end",
      "finish",
    ]);
    expect(observer.events[0]).toMatchObject({
      kind: "turn",
      info: { leadId: LEAD_ID, provider: "local", model: "fake-model", promptVersion: "v1" },
    });
    // The second call sees the buyer message, the context, the tool request and 2 results.
    expect(observer.events[7]).toEqual({ kind: "model:start", step: 2, messages: 5 });
    // Local model calls cost 0.
    expect(observer.events.at(-1)).toEqual({ kind: "finish", outcome: "replied", costUsd: 0 });
  });

  it("reports the price guard and a provider error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const observer = new RecordingObserver();
    await handleBuyerMessage(
      { message: "How much?" },
      deps([textStep("It's AED 99,000."), new LlmError("local", "unavailable", "down")], observer),
    );
    expect(observer.events).toContainEqual({
      kind: "guard",
      action: "retried",
      amounts: ["AED 99,000"],
    });
    expect(observer.events).toContainEqual({ kind: "model:end", ok: false });
    expect(observer.events.at(-1)).toMatchObject({ kind: "finish", outcome: "provider_error" });
    vi.restoreAllMocks();
  });

  it("saves the cost and the trace id with the turn", async () => {
    await handleBuyerMessage(
      { message: "Hi" },
      deps([textStep("Hello!")], new RecordingObserver()),
    );
    const [turn] = await loadTurnMeta(db, LEAD_ID);
    expect(turn?.meta).toMatchObject({
      costUsd: 0,
      traceId: "trace-recorded",
      cacheWriteInputTokens: 0,
    });
  });
});

describe("an observer can never break a chat", () => {
  const throwingEverywhere: TurnObserver = {
    turn: (_info, work) =>
      work({
        get traceId(): string {
          throw new Error("no id");
        },
        modelCall: () => {
          throw new Error("modelCall broke");
        },
        toolCall: () => ({
          end: () => {
            throw new Error("tool end broke");
          },
        }),
        guard: () => {
          throw new Error("guard broke");
        },
        finish: () => {
          throw new Error("finish broke");
        },
      }),
  };

  it("keeps the reply and the saved messages when every observer call throws", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await handleBuyerMessage(
      { message: "2 bed please" },
      deps([toolStep(["update_lead", { beds: 2 }]), textStep("Noted!")], throwingEverywhere),
    );
    expect(response).toMatchObject({ reply: "Noted!", outcome: "replied" });
    expect(await loadConversation(db, LEAD_ID)).toHaveLength(5);
    log.mockRestore();
  });

  it("runs the turn untraced when the observer fails before starting it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const broken: TurnObserver = {
      turn: () => Promise.reject(new Error("cannot reach Langfuse")),
    };
    const result = await observeTurn(broken, info(), async () => "done");
    expect(result).toBe("done");
    vi.restoreAllMocks();
  });

  it("keeps the result when the observer fails after the turn finished", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let runs = 0;
    const failsAtTheEnd: TurnObserver = {
      turn: async (_info, work) => {
        await work({
          traceId: null,
          modelCall: () => ({ end() {} }),
          toolCall: () => ({ end() {} }),
          guard() {},
          finish() {},
        });
        throw new Error("export failed");
      },
    };
    const result = await observeTurn(failsAtTheEnd, info(), async () => {
      runs++;
      return "done";
    });
    expect(result).toBe("done");
    expect(runs).toBe(1); // never run twice
    vi.restoreAllMocks();
  });

  it("never runs the turn twice when the observer fails while the turn is still running", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let runs = 0;
    let finishWork: (value: string) => void = () => {};
    const failsWhileRunning: TurnObserver = {
      turn: async (_info, work) => {
        void work({
          traceId: null,
          modelCall: () => ({ end() {} }),
          toolCall: () => ({ end() {} }),
          guard() {},
          finish() {},
        });
        throw new Error("observer gave up early");
      },
    };
    const pending = observeTurn(failsWhileRunning, info(), () => {
      runs++;
      return new Promise<string>((resolve) => {
        finishWork = resolve;
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    finishWork("done");
    expect(await pending).toBe("done");
    expect(runs).toBe(1);
    vi.restoreAllMocks();
  });

  it("passes the turn's own errors through unchanged", async () => {
    const bug = new TypeError("our bug");
    await expect(
      observeTurn(new RecordingObserver(), info(), () => Promise.reject(bug)),
    ).rejects.toBe(bug);
  });
});

function info() {
  return {
    leadId: LEAD_ID,
    userMessage: "Hi",
    provider: "local" as const,
    model: "fake-model",
    promptVersion: "v1",
  };
}
