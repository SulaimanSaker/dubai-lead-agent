import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadCases } from "./cases";

const CASES_DIR = join(import.meta.dirname, "..", "cases");

function dirWith(files: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), "eval-cases-"));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), JSON.stringify(content));
  }
  return dir;
}

const validCase = {
  id: "greeting-only",
  description: "A greeting gets no tools",
  tags: ["robustness", "en"],
  source: "synthetic",
  messages: ["Hi"],
  expect: { viewingBooked: false, handoff: false, language: "en" },
};

describe("loadCases", () => {
  it("loads the real case set, all valid, with unique ids", () => {
    const cases = loadCases(CASES_DIR);
    expect(cases.length).toBeGreaterThanOrEqual(30);
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
    // Both directions are covered for handoff and booking.
    expect(cases.some((c) => c.expect.handoff)).toBe(true);
    expect(cases.some((c) => !c.expect.handoff)).toBe(true);
    expect(cases.some((c) => c.expect.viewingBooked)).toBe(true);
    expect(cases.some((c) => c.expect.language === "ar")).toBe(true);
  });

  it("names every schema problem: unknown tool and missing booking expectation", () => {
    const dir = dirWith({
      "robustness.json": {
        category: "robustness",
        cases: [
          { ...validCase, expect: { ...validCase.expect, forbiddenTools: ["delete_everything"] } },
          { ...validCase, id: "third", expect: { handoff: false, language: "en" } },
        ],
      },
    });
    expect(() => loadCases(dir)).toThrow(/unknown tool/);
    expect(() => loadCases(dir)).toThrow(/viewingBooked/);
  });

  it("rejects a case filed under the wrong category", () => {
    const dir = dirWith({
      "robustness.json": {
        category: "robustness",
        cases: [{ ...validCase, tags: ["booking", "en"] }],
      },
    });
    expect(() => loadCases(dir)).toThrow(/tags\[0\] "booking", expected "robustness"/);
  });

  it("rejects duplicate ids across files", () => {
    const dir = dirWith({
      "a.json": { category: "robustness", cases: [validCase] },
      "b.json": { category: "robustness", cases: [validCase] },
    });
    expect(() => loadCases(dir)).toThrow(/duplicate case id: greeting-only/);
  });
});
