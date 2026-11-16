import { describe, expect, it } from "vitest";
import { findInventedPrices, findMoneyAmounts, safeReply } from "@/agent/guards";

describe("findMoneyAmounts", () => {
  it.each([
    ["AED 115,000 a year", 115_000],
    ["only AED115000", 115_000],
    ["AED 1.2M", 1_200_000],
    ["AED 1.25 million", 1_250_000],
    ["2,450,000 AED", 2_450_000],
    ["around 120k", 120_000],
    ["1.2M budget", 1_200_000],
    ["95K dirhams", 95_000],
    ["Dhs 80,000", 80_000],
    ["٨٠ ألف درهم is not parsed, but 80000 درهم is", 80_000],
  ])("reads %j as %i", (text, value) => {
    expect(findMoneyAmounts(text).map((amount) => amount.value)).toContain(value);
  });

  it("ignores plain numbers that are not money", () => {
    expect(
      findMoneyAmounts(
        "2 bed, 3 baths, 1,250 sqft, L02, Sat 21 Nov 2026 at 10:00, call +971 50 123 4567, 60/40",
      ),
    ).toEqual([]);
  });

  it("reads lowercase m as metres unless it sits next to a currency", () => {
    expect(findMoneyAmounts("Only 500m from the beach, 120 m² of space")).toEqual([]);
    expect(findMoneyAmounts("AED 1.5m")).toEqual([{ raw: "AED 1.5m", value: 1_500_000 }]);
  });

  it("reads bare comma-grouped amounts of 10,000 or more as money", () => {
    expect(
      findMoneyAmounts("Rent: 95,000/year. The price is 1,250,000.").map((a) => a.value),
    ).toEqual([95_000, 1_250_000]);
  });

  it("reads Arabic-Indic digits", () => {
    expect(findMoneyAmounts("الإيجار ١٢٠٬٠٠٠ درهم").map((a) => a.value)).toEqual([120_000]);
  });

  it("keeps decimals of small amounts", () => {
    expect(findMoneyAmounts("AED 1.5").map((a) => a.value)).toEqual([1.5]);
  });
});

describe("findInventedPrices", () => {
  const toolResults = [
    JSON.stringify({ ok: true, listings: [{ id: "L02", priceAed: 115000 }] }),
    JSON.stringify({ ok: true, lead: { budgetAed: 120000 } }),
  ];

  it("passes prices that a tool returned, in any format", () => {
    const reply = "I found L02 for AED 115,000 per year, within your 120k budget.";
    expect(findInventedPrices(reply, toolResults)).toEqual([]);
  });

  it("does not let the model confirm a price only the buyer said", () => {
    // Buyer: "Is L02 really 80k?" The tool said 115,000. Saying yes would be an invented price.
    expect(findInventedPrices("Yes, L02 is AED 80,000 a year.", toolResults)).toHaveLength(1);
  });

  it("catches a made-up price and a monthly conversion", () => {
    const reply = "There is also a 3 bed for AED 140,000, about AED 9,583 a month for L02.";
    expect(findInventedPrices(reply, toolResults).map((a) => a.raw)).toEqual([
      "AED 140,000",
      "AED 9,583",
    ]);
  });

  it("catches an approximation that changes the number", () => {
    expect(findInventedPrices("It's roughly AED 1.2M.", ['{"priceAed":1195000}'])).toHaveLength(1);
  });

  it("catches a bare amount and an Arabic amount", () => {
    expect(findInventedPrices("Rent is 99,000 a year.", toolResults)).toHaveLength(1);
    expect(findInventedPrices("الإيجار ٩٩٬٠٠٠ درهم", toolResults)).toHaveLength(1);
    expect(findInventedPrices("الإيجار ١١٥٬٠٠٠ درهم", toolResults)).toEqual([]);
  });
});

describe("safeReply", () => {
  it("answers in Arabic when the buyer wrote Arabic", () => {
    expect(safeReply("error", "مرحبا، أبحث عن شقة")).toMatch(/[؀-ۿ]/);
    expect(safeReply("error", "Hi, looking for a flat")).toMatch(/^Sorry/);
  });
});
