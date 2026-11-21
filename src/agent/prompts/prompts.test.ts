import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CURRENT_PROMPT, PROMPTS } from "@/agent/prompts";
import { PROMPT_V1 } from "@/agent/prompts/v1";
import { PROMPT_V2 } from "@/agent/prompts/v2";
import { PROMPT_V3 } from "@/agent/prompts/v3";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const amounts = [{ raw: "80k", value: 80_000 }];

describe("released prompts", () => {
  // A released prompt is never edited in place: evals compare versions, so v1 must stay what was measured.
  it("v1 is unchanged", () => {
    expect(sha256(PROMPT_V1.stable)).toBe(
      "060780634f557d1ee0d1584a43692462e3bc4e2978356e3b303d26cc44e0c784",
    );
    expect(PROMPT_V1.priceCorrection(amounts)).toBe(
      "Correction: your draft reply mentioned 80k, which no tool returned. Rewrite the reply using only " +
        "prices exactly as the tools returned them (yearly for rent), or call a tool to get the price.",
    );
  });

  // v2 reuses v1's dynamic part, so an edit to it would change the baseline without touching v1's text.
  it("v1's dynamic part is unchanged", () => {
    const context = {
      now: { label: "Mon 16 Nov 2026, 14:05" },
      lead: {
        status: "new",
        fields: { purpose: "rent", areas: ["Dubai Marina"], beds: null },
        missing: ["beds", "timeline"],
      },
    };
    expect(PROMPT_V1.dynamic(context)).toBe(
      "Current time in Dubai: Mon 16 Nov 2026, 14:05 (UTC+4).\nLead status: new.\n" +
        "Saved so far: purpose=rent; areas=Dubai Marina.\nStill unknown: beds, timeline.",
    );
  });

  it("are all selectable by version, and the app uses one of them", () => {
    expect(Object.keys(PROMPTS)).toEqual(["v1", "v2", "v3"]);
    for (const [version, prompt] of Object.entries(PROMPTS)) expect(prompt.version).toBe(version);
    expect(Object.values(PROMPTS)).toContain(CURRENT_PROMPT);
  });
});

describe("prompt v2", () => {
  it("is v1 plus one rule: don't repeat an amount the buyer said", () => {
    const added = PROMPT_V2.stable.split("\n").filter((line) => !PROMPT_V1.stable.includes(line));
    expect(added).toHaveLength(1);
    expect(added[0]).toMatch(/^- When the buyer names an amount/);
    expect(added[0]).toContain('"It\'s AED 115,000 per year."');
  });

  it("keeps v1's dynamic part", () => {
    expect(PROMPT_V2.dynamic).toBe(PROMPT_V1.dynamic);
  });

  it("tells the model how to handle the buyer's amount in the price correction", () => {
    const note = PROMPT_V2.priceCorrection(amounts);
    expect(note).toContain("your draft reply mentioned 80k");
    expect(note).toContain("Amounts the buyer said count too");
  });
});

describe("prompt v3", () => {
  it("v2 is unchanged now that it is released", () => {
    expect(sha256(PROMPT_V2.stable)).toBe(
      "16e1ca5fd0674465d1819f6e7df20007d65a872f9c975e6f3988f3c1b139cb77",
    );
  });

  it("is v2 with only the example of the amount rule changed", () => {
    const v2 = PROMPT_V2.stable.split("\n");
    const v3 = PROMPT_V3.stable.split("\n");
    expect(v3).toHaveLength(v2.length);
    const changed = v3.filter((line, i) => line !== v2[i]);
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatch(/^- When the buyer names an amount/);
    expect(changed[0]).toContain("in the buyer's language");
    expect(PROMPT_V3.dynamic).toBe(PROMPT_V2.dynamic);
    expect(PROMPT_V3.priceCorrection).toBe(PROMPT_V2.priceCorrection);
  });
  // That v3's example numbers are not fixtures is checked in evals/lib/prompt-fixtures.test.ts.
});
