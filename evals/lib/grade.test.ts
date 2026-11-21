/**
 * Graders on hand-built runs: a known-good run must pass, known-bad runs must fail for the right reason
 * (the "oracle and null" check from Anthropic's eval guide, at the grader level).
 */
import { describe, expect, it } from "vitest";
import type { LlmMessage } from "@/agent/llm";
import type { Lead, Viewing } from "@/db/schema";
import { evalCaseSchema, type EvalCase } from "./cases";
import { gradeCase, sameArea } from "./grade";
import type { CaseRun } from "./run-case";

const cashBuyer: EvalCase = evalCaseSchema.parse({
  id: "cash-buyer-marina-2bed",
  description: "Buyer gives area, beds, budget and cash in one message",
  tags: ["qualification", "en"],
  source: "test",
  messages: ["2 bed in Dubai Marina, 120k, cash"],
  expect: {
    lead: {
      purpose: "rent",
      areas: ["Dubai Marina"],
      beds: 2,
      budgetAed: 120000,
      financing: "cash",
    },
    leadUnknown: ["timeline"],
    toolCalls: [
      { name: "update_lead" },
      { name: "search_listings", args: { beds: 2, maxPriceAed: 120000 }, argsAbsent: ["status"] },
    ],
    forbiddenTools: ["book_viewing"],
    viewingBooked: false,
    handoff: false,
    language: "en",
  },
});

const goodLead: Lead = {
  id: "lead-1",
  purpose: "rent",
  areas: ["Marina"],
  beds: 2,
  budgetAed: 120000,
  timeline: null,
  financing: "cash",
  status: "new",
  handoffReason: null,
  handoffSummary: null,
  createdAt: "",
  updatedAt: "",
};

const goodConversation: LlmMessage[] = [
  { role: "user", text: "2 bed in Dubai Marina, 120k, cash" },
  { role: "context", text: "Current time…" },
  {
    role: "assistant",
    text: "",
    toolCalls: [
      { id: "a", name: "update_lead", input: { beds: 2 }, inputError: null },
      {
        id: "b",
        name: "search_listings",
        input: { area: "Dubai Marina", beds: 2, maxPriceAed: 120000 },
        inputError: null,
      },
    ],
  },
  { role: "tool", callId: "a", name: "update_lead", result: '{"ok":true}', isError: false },
  {
    role: "tool",
    callId: "b",
    name: "search_listings",
    result: '{"listings":[{"id":"L02","priceAed":115000}]}',
    isError: false,
  },
  { role: "assistant", text: "L02 is AED 115,000 a year. When do you move?", toolCalls: [] },
];

function run(overrides: Partial<CaseRun> = {}): CaseRun {
  return {
    turns: [
      {
        message: "…",
        reply: "L02 is AED 115,000 a year. When do you move?",
        outcome: "replied",
        model: "m",
      },
    ],
    conversation: goodConversation,
    lead: goodLead,
    viewings: [],
    metas: [],
    ...overrides,
  };
}

describe("gradeCase", () => {
  it("passes a correct run (oracle)", () => {
    const { scores, reasons } = gradeCase(cashBuyer, run());
    expect(scores).toEqual({
      extraction: 1,
      tool_use: 1,
      booking: 1,
      handoff: 1,
      no_invented_prices: 1,
      turns_ok: 1,
      language: 1,
      style: 1,
      pass: 1,
    });
    expect(reasons).toEqual({});
  });

  it("fails a do-nothing agent (null)", () => {
    const { scores, reasons } = gradeCase(
      cashBuyer,
      run({
        turns: [{ message: "…", reply: "Hello! How can I help?", outcome: "replied", model: "m" }],
        conversation: [
          { role: "user", text: "…" },
          { role: "assistant", text: "Hello!", toolCalls: [] },
        ],
        lead: {
          ...goodLead,
          purpose: null,
          areas: null,
          beds: null,
          budgetAed: null,
          financing: null,
        },
      }),
    );
    expect(scores.pass).toBe(0);
    expect(scores.extraction).toBe(0);
    expect(scores.tool_use).toBe(0);
    expect(reasons.tool_use).toMatch(/never called update_lead/);
  });

  it("catches an invented field, a forbidden tool, an unwanted booking and an extra filter", () => {
    const viewing: Viewing = {
      id: "v",
      leadId: "lead-1",
      listingId: "L02",
      startsAt: "2026-11-21T07:00:00.000Z",
      status: "booked",
      createdAt: "",
    };
    const conversation: LlmMessage[] = [
      ...goodConversation.slice(0, 2),
      {
        role: "assistant",
        text: "",
        toolCalls: [
          { id: "a", name: "update_lead", input: {}, inputError: null },
          {
            id: "b",
            name: "search_listings",
            input: { beds: 2, maxPriceAed: 120000, status: "ready" },
            inputError: null,
          },
          { id: "c", name: "book_viewing", input: { listingId: "L02" }, inputError: null },
        ],
      },
    ];
    const { scores, reasons } = gradeCase(
      cashBuyer,
      run({ conversation, viewings: [viewing], lead: { ...goodLead, timeline: "asap" } }),
    );
    expect(reasons.extraction).toMatch(/timeline should be unknown/);
    expect(reasons.tool_use).toMatch(/without status/);
    expect(reasons.tool_use).toMatch(/called forbidden book_viewing/);
    expect(reasons.booking).toMatch(/booked L02/);
    expect(scores.pass).toBe(0);
  });

  it("catches a made-up price, a failed turn, the wrong language and leaked tool names", () => {
    const { scores, reasons } = gradeCase(
      { ...cashBuyer, expect: { ...cashBuyer.expect, language: "ar" } },
      run({
        turns: [
          {
            message: "…",
            reply: "I used search_listings: it's AED 99,000. [END_CHAT]",
            outcome: "replied",
            model: "m",
          },
          {
            message: "…",
            reply: "Sorry, something went wrong.",
            outcome: "provider_error",
            model: "m",
          },
        ],
      }),
    );
    expect(reasons.no_invented_prices).toMatch(/AED 99,000/);
    expect(reasons.turns_ok).toMatch(/turn 2: provider_error/);
    expect(reasons.language).toMatch(/not in Arabic/);
    expect(reasons.style).toMatch(/leaks "search_listings"/);
    expect(scores.pass).toBe(0);
  });

  // Since 2026-11-21 language is part of the headline: an English reply to an Arabic buyer fails the case.
  it("fails pass on the wrong language alone", () => {
    const { scores, reasons } = gradeCase(
      { ...cashBuyer, expect: { ...cashBuyer.expect, language: "ar" } },
      run(),
    );
    expect(scores).toMatchObject({ extraction: 1, tool_use: 1, language: 0, pass: 0 });
    expect(reasons.pass).toBe("failed: language");
  });

  it("checks handoff in both directions", () => {
    const handoffCase = {
      ...cashBuyer,
      expect: { viewingBooked: false, handoff: true, language: "en" as const },
    };
    expect(gradeCase(handoffCase, run()).reasons.handoff).toBe("not handed off");
    const handedOff = {
      ...goodLead,
      status: "handed_off" as const,
      handoffReason: "negotiation" as const,
    };
    expect(gradeCase(cashBuyer, run({ lead: handedOff })).reasons.handoff).toMatch(
      /shouldn't have/,
    );
  });

  it("leaves checks out when a case doesn't ask for them", () => {
    const minimal = {
      ...cashBuyer,
      expect: { viewingBooked: false, handoff: false, language: "en" as const },
    };
    const { scores } = gradeCase(minimal, run());
    expect(scores).not.toHaveProperty("extraction");
    expect(scores).not.toHaveProperty("tool_use");
    expect(scores.pass).toBe(1);
  });
});

describe("sameArea", () => {
  it("accepts aliases and fuller names, rejects other areas", () => {
    expect(sameArea("Jumeirah Village Circle", "JVC")).toBe(true);
    expect(sameArea("Dubai Marina", "Marina")).toBe(true);
    expect(sameArea("Dubai Hills Estate", "Dubai Hills")).toBe(true);
    expect(sameArea("Dubai Marina", "Dubai Marina, near JBR")).toBe(true);
    expect(sameArea("Dubai Marina", "Business Bay")).toBe(false);
  });

  // Review finding: "x".includes("") is true, and "Dubai" is inside every "... Dubai ..." name.
  it("rejects an empty name and a shorter, vaguer name", () => {
    expect(sameArea("Dubai Marina", "")).toBe(false);
    expect(sameArea("Dubai Marina", "Dubai")).toBe(false);
    expect(sameArea("Downtown Dubai", "Dubai")).toBe(false);
  });
});

describe("tool_use argument matching", () => {
  const viewing = evalCaseSchema.parse({
    ...cashBuyer,
    expect: {
      ...cashBuyer.expect,
      toolCalls: [{ name: "get_listing", args: { listingId: "L02" } }],
      forbiddenTools: [],
    },
  });
  const withListingId = (listingId: string) =>
    run({
      conversation: [
        { role: "user", text: "Tell me more" },
        {
          role: "assistant",
          text: "",
          toolCalls: [{ id: "a", name: "get_listing", input: { listingId }, inputError: null }],
        },
        { role: "tool", callId: "a", name: "get_listing", result: "{}", isError: false },
        { role: "assistant", text: "Here it is.", toolCalls: [] },
      ],
    });

  it("matches a string argument exactly (ignoring case), not as a substring or an empty string", () => {
    expect(gradeCase(viewing, withListingId("l02")).scores.tool_use).toBe(1);
    expect(gradeCase(viewing, withListingId("")).scores.tool_use).toBe(0);
    expect(gradeCase(viewing, withListingId("L020")).scores.tool_use).toBe(0);
  });
});
