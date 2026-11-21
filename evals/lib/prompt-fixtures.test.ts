/**
 * A prompt example must not give away an eval answer. Prompt v2's example ("Is it really only 80k?" → "It's AED
 * 115,000 per year.") matched `buyer-states-a-wrong-price` and its listing (review 2026-11-21). From v3 on, the
 * example's numbers must match no seed listing and appear in no case.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PROMPT_V3 } from "@/agent/prompts/v3";
import { SEED_LISTINGS } from "@/db/seed-data";
import { loadCases } from "./cases";

const cases = JSON.stringify(loadCases(join(import.meta.dirname, "..", "cases")));

describe("prompt v3's example", () => {
  it("uses the example values it claims to", () => {
    expect(PROMPT_V3.stable).toContain(
      'if a tool returned AED 60,000 and the buyer asks "only 40k?"',
    );
  });

  it("matches no seed listing", () => {
    expect(SEED_LISTINGS.filter((l) => [40_000, 60_000].includes(l.priceAed))).toEqual([]);
  });

  it("appears in no eval case", () => {
    for (const value of ["40k", "40,000", "40000", "60k", "60,000", "60000"]) {
      expect(cases, value).not.toContain(value);
    }
  });
});
