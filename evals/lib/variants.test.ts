import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultVariant, VARIANT_NAME } from "./variants";

function modelDir(folders: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "eval-variants-"));
  for (const [name, version] of Object.entries(folders)) {
    mkdirSync(join(dir, name));
    writeFileSync(
      join(dir, name, "results.jsonl"),
      JSON.stringify({ prompt_version: version }) + "\n",
    );
  }
  return dir;
}

describe("defaultVariant", () => {
  it("uses baseline for a model's first run", () => {
    expect(defaultVariant(modelDir({}), "v2")).toBe("baseline");
  });

  it("resumes in the folder that already holds this prompt version", () => {
    const dir = modelDir({ baseline: "v1", v1: "v2" });
    expect(defaultVariant(dir, "v1")).toBe("baseline");
    expect(defaultVariant(dir, "v2")).toBe("v1");
  });

  it("refuses to guess when several folders hold the same prompt version", () => {
    expect(() => defaultVariant(modelDir({ baseline: "v1", v1: "v2", v2: "v2" }), "v2")).toThrow(
      /Several run folders hold prompt v2 .*--variant/,
    );
  });

  it("asks for a new variant folder for a new prompt version", () => {
    expect(() => defaultVariant(modelDir({ baseline: "v1", v1: "v2" }), "v3")).toThrow(
      /--variant v2 .*change\.md/,
    );
  });
});

describe("VARIANT_NAME", () => {
  it("accepts only the names the report reads", () => {
    expect(["baseline", "v1", "v12"].every((name) => VARIANT_NAME.test(name))).toBe(true);
    expect(["prompt-v2", "v", "V1"].some((name) => VARIANT_NAME.test(name))).toBe(false);
  });
});
