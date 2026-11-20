import { describe, expect, it } from "vitest";
import type { LlmMessage } from "@/agent/llm";
import { evalCaseSchema } from "./cases";
import { promptVersionOf, toTrace, upgradeTrace, type TraceTurn } from "./trace";

const evalCase = evalCaseSchema.parse({
  id: "greeting-only",
  description: "Greeting only, no details",
  tags: ["conversation", "en"],
  source: "test",
  messages: ["Hi"],
  expect: { viewingBooked: false, handoff: false, language: "en" },
});

const conversation: LlmMessage[] = [
  { role: "user", text: "2 bed in Marina?" },
  { role: "context", text: "Current time in Dubai: Mon 16 Nov 2026, 14:05 (UTC+4)." },
  {
    role: "assistant",
    text: "Let me search.",
    toolCalls: [{ id: "a", name: "search_listings", input: { beds: 2 }, inputError: null }],
  },
  { role: "tool", callId: "a", name: "search_listings", result: "{}", isError: false },
  { role: "assistant", text: "Found one: L02.", toolCalls: [] },
];

describe("toTrace", () => {
  it("marks text next to a tool call as a note the buyer didn't see, and the final reply as shown", () => {
    const trace = toTrace(evalCase, conversation, "v1");
    expect(trace.map((turn) => turn.role)).toEqual([
      "system",
      "user",
      "context",
      "tool_call",
      "assistant_note",
      "tool_result",
      "assistant",
    ]);
    expect(promptVersionOf(trace)).toBe("v1");
  });
});

describe("upgradeTrace", () => {
  it("turns an old trace into the new roles, and is safe to run twice", () => {
    const old: TraceTurn[] = toTrace(evalCase, conversation, "v1").map((turn) => ({
      ...turn,
      role:
        turn.role === "context"
          ? "system"
          : turn.role === "assistant_note"
            ? "assistant"
            : turn.role,
    }));
    const upgraded = upgradeTrace(old);
    expect(upgraded).toEqual(toTrace(evalCase, conversation, "v1"));
    expect(upgradeTrace(upgraded)).toEqual(upgraded);
  });
});
