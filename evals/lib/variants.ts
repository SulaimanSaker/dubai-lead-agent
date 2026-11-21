/**
 * Variant folders under evals/runs/<model>/, in the eval report's layout: `baseline`, then `v1`, `v2`, … for each
 * change, with a `change.md` whose first line names it. Each row records its `prompt_version`, and a folder
 * holds one prompt version only (the runner refuses to mix them).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const VARIANT_NAME = /^(baseline|v\d+)$/;

/** The prompt version of a variant folder (from its first row), or undefined if it has no rows yet. */
function promptVersionIn(dir: string): string | undefined {
  const file = join(dir, "results.jsonl");
  if (!existsSync(file)) return undefined;
  const first = readFileSync(file, "utf8").split("\n").find(Boolean);
  return first
    ? ((JSON.parse(first) as { prompt_version?: string }).prompt_version ?? "unknown")
    : undefined;
}

/**
 * Where a run of `promptVersion` goes when no --variant is given: the folder that already holds that version
 * (so a re-run resumes), else `baseline` for a model's first run. A new version for a model that already has a
 * baseline needs an explicit `--variant v<N>` and a change.md saying what changed.
 */
export function defaultVariant(modelDir: string, promptVersion: string): string {
  const variants = existsSync(modelDir)
    ? readdirSync(modelDir).filter((name) => VARIANT_NAME.test(name))
    : [];
  const same = variants.filter((name) => promptVersionIn(join(modelDir, name)) === promptVersion);
  if (same.length > 1) {
    throw new Error(
      `Several run folders hold prompt ${promptVersion} (${same.join(", ")}): pass --variant to choose one.`,
    );
  }
  if (same[0]) return same[0];
  if (!promptVersionIn(join(modelDir, "baseline"))) return "baseline";
  const next = Math.max(0, ...variants.map((name) => Number(name.slice(1)) || 0)) + 1;
  throw new Error(
    `No run folder holds prompt ${promptVersion} yet. Start one with --variant v${next} ` +
      `and write ${join(modelDir, `v${next}`, "change.md")} (first line: what changed).`,
  );
}
