import { describe, expect, it } from "vitest";
import { listLeads, scoreLead, summarizeLead } from "@/agent/leads";
import { leads, type Lead } from "@/db/schema";
import { createTestDb } from "@/db/test-db";
import { bookViewing } from "@/tools/book-viewing";

const base: Lead = {
  id: "lead-1",
  purpose: null,
  areas: null,
  beds: null,
  budgetAed: null,
  timeline: null,
  financing: null,
  status: "new",
  handoffReason: null,
  handoffSummary: null,
  createdAt: "2026-11-16T10:00:00.000Z",
  updatedAt: "2026-11-16T10:00:00.000Z",
};

const qualified: Lead = {
  ...base,
  purpose: "rent",
  areas: ["Dubai Marina"],
  beds: 2,
  budgetAed: 120000,
  timeline: "asap",
  financing: "cash",
  status: "qualified",
};

describe("scoreLead", () => {
  it("is 0 / cold for an empty lead and 100 / hot for a qualified cash buyer with a viewing", () => {
    expect(scoreLead(base, 0)).toEqual({ value: 0, label: "cold" });
    expect(scoreLead(qualified, 1)).toEqual({ value: 100, label: "hot" });
  });

  it("ranks a browsing mortgage buyer below an urgent cash buyer", () => {
    const browsing = {
      ...qualified,
      timeline: "browsing" as const,
      financing: "mortgage" as const,
    };
    expect(scoreLead(browsing, 0)).toEqual({ value: 60, label: "warm" });
    expect(scoreLead(browsing, 0).value).toBeLessThan(scoreLead(qualified, 0).value);
  });
});

describe("summarizeLead", () => {
  it("writes one readable line from the fields", () => {
    expect(summarizeLead(qualified, 1)).toBe(
      "Wants to rent a 2-bed, in Dubai Marina, budget AED 120,000 a year, paying cash, as soon as possible. " +
        "1 viewing booked.",
    );
  });

  it("still shows a handoff when no requirement is known", () => {
    const askedForPerson: Lead = {
      ...base,
      status: "handed_off",
      handoffReason: "asked_for_human",
      handoffSummary: "Buyer asked for a person.",
    };
    expect(summarizeLead(askedForPerson, 0)).toBe(
      "No requirements yet. Handed off (asked_for_human): Buyer asked for a person.",
    );
    expect(summarizeLead({ ...base, timeline: "asap" }, 0)).toBe(
      "Wants to rent or buy a home, as soon as possible.",
    );
  });

  it("handles an empty lead, a studio purchase and a handoff", () => {
    expect(summarizeLead(base, 0)).toBe("No requirements yet.");
    const handedOff: Lead = {
      ...base,
      purpose: "sale",
      beds: 0,
      status: "handed_off",
      handoffReason: "negotiation",
      handoffSummary: "Wants 10% off L05.",
    };
    expect(summarizeLead(handedOff, 0)).toBe(
      "Wants to buy a studio. Handed off (negotiation): Wants 10% off L05.",
    );
  });
});

describe("listLeads", () => {
  it("lists leads newest first, with booked viewings in the score", async () => {
    const db = await createTestDb();
    await db.insert(leads).values([
      { ...qualified, id: "old", updatedAt: "2026-11-15T10:00:00.000Z" },
      { ...base, id: "new", updatedAt: "2026-11-16T09:00:00.000Z" },
    ]);
    const booked = await bookViewing.execute(
      { listingId: "L02", startsAt: "2026-11-21T10:00:00+04:00" },
      { db, leadId: "old", now: new Date("2026-11-16T05:00:00Z") },
    );
    expect(booked.ok).toBe(true);

    const all = await listLeads(db);
    // "new" was updated at 09:00; "old" at 05:00 (the booking) at the latest.
    expect(all.map((lead) => lead.id)).toEqual(["new", "old"]);
    const old = all.find((lead) => lead.id === "old");
    expect(old?.viewings).toEqual([
      {
        listingId: "L02",
        title: "Spacious 2BR in Al Sahab Tower",
        label: "Sat 21 Nov 2026, 10:00",
        status: "booked",
      },
    ]);
    expect(old?.score).toEqual({ value: 100, label: "hot" });
  });
});
