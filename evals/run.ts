/**
 * Run the eval suite against a real model.
 *
 *   npm run evals -- --provider claude [--reps 3] [--case id1,id2] [--concurrency 4] [--no-judge]
 *   npm run evals -- --provider claude --prompt v3 --variant v2   (a new prompt version: next v<N> folder + change.md)
 *   npm run evals -- --provider local  [--reps 1]          (LM Studio, free but slow)
 *   npm run evals -- --provider null                        (do-nothing agent: must score ~0)
 *
 * Writes evals/runs/<model>/<variant>/ (results.jsonl, traces/, errors.jsonl). Without --variant: the folder that
 * already holds this prompt version, or baseline for a new model (evals/lib/variants.ts). Resumable: re-running skips
 * finished (case, rep) pairs. Then: npm run evals:report -- <model>   and   npm run evals:compare
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { getProvider, type LlmProvider } from "@/agent/llm";
import { readLlmConfig } from "@/agent/llm/config";
import { CURRENT_PROMPT, PROMPTS } from "@/agent/prompts";
import { FakeProvider, textStep } from "@/agent/testing/fake-provider";
import { getTurnObserver, startTracing, stopTracing } from "@/agent/tracing";
import { loadCases } from "./lib/cases";
import { defaultVariant, VARIANT_NAME } from "./lib/variants";
import { JUDGE_CRITERIA, JUDGE_MODEL, judgeRun } from "./lib/judge";
import { runEval } from "./lib/runner";

const { values } = parseArgs({
  options: {
    provider: { type: "string", default: "claude" },
    model: { type: "string" },
    variant: { type: "string" },
    prompt: { type: "string" },
    reps: { type: "string", default: "1" },
    case: { type: "string" },
    concurrency: { type: "string" },
    "no-judge": { type: "boolean", default: false },
    "timeout-s": { type: "string" },
  },
});

const METRICS = [
  { id: "pass", label: "Pass", kind: "binary" },
  { id: "code_pass", label: "Code checks", kind: "binary" },
  { id: "extraction", label: "Extraction", kind: "binary" },
  { id: "tool_use", label: "Tool use", kind: "binary" },
  { id: "booking", label: "Booking", kind: "binary" },
  { id: "handoff", label: "Handoff", kind: "binary" },
  { id: "no_invented_prices", label: "No invented $", kind: "binary" },
  { id: "turns_ok", label: "Turns OK", kind: "binary" },
  { id: "language", label: "Language", kind: "binary" },
  { id: "style", label: "Style", kind: "binary" },
  ...Object.keys(JUDGE_CRITERIA).map((id) => ({
    id,
    label: `Judge: ${id}`.slice(0, 14),
    kind: "binary",
  })),
];

function chooseProvider(): { provider: LlmProvider; expectModel?: string; local: boolean } {
  const name = values.provider;
  if (name === "null") {
    return {
      provider: new FakeProvider([textStep("Hello! How can I help you today?")], {
        repeatLast: true,
      }),
      local: true,
    };
  }
  if (name !== "claude" && name !== "local")
    throw new Error(`--provider must be claude, local or null`);
  const config = readLlmConfig({
    ...process.env,
    LLM_PROVIDER: name,
    ...(values.model &&
      (name === "claude" ? { CLAUDE_MODEL: values.model } : { LMSTUDIO_MODEL: values.model })),
  });
  const provider = getProvider(config);
  // Claude must answer with exactly the requested model (a silent fallback would invalidate the comparison).
  return {
    provider,
    expectModel: name === "claude" ? provider.model : undefined,
    local: name === "local",
  };
}

async function main() {
  const { provider, expectModel, local } = chooseProvider();
  const prompt = !values.prompt
    ? CURRENT_PROMPT
    : Object.hasOwn(PROMPTS, values.prompt)
      ? PROMPTS[values.prompt]
      : undefined;
  if (!prompt) throw new Error(`--prompt must be one of: ${Object.keys(PROMPTS).join(", ")}`);
  const ids = values.case?.split(",").map((id) => id.trim());
  const cases = loadCases(join(import.meta.dirname, "cases")).filter(
    (c) => !ids || ids.includes(c.id),
  );
  if (cases.length === 0) throw new Error(`No cases match --case ${values.case}`);

  const flow = provider.model.replace(/^.*\//, "").replace(/[^a-z0-9.-]+/gi, "-");
  const flowDir = join(import.meta.dirname, "runs", flow);
  const variant = values.variant ?? defaultVariant(flowDir, prompt.version);
  if (!VARIANT_NAME.test(variant)) {
    throw new Error(
      `--variant must be baseline or v<N> (the report reads only those), not "${variant}"`,
    );
  }
  const outDir = join(flowDir, variant);
  if (variant !== "baseline" && !existsSync(join(outDir, "change.md"))) {
    throw new Error(
      `Write ${join(outDir, "change.md")} first (first line: what this variant changes).`,
    );
  }
  const stateFile = join(flowDir, "_state.json");
  if (!existsSync(flowDir) || !existsSync(stateFile)) {
    mkdirSync(flowDir, { recursive: true });
    writeFileSync(
      stateFile,
      JSON.stringify(
        {
          metrics: METRICS,
          perf_fields: [{ id: "cost_usd" }, { id: "latency_s", unit: "s" }, { id: "tool_calls" }],
        },
        null,
        2,
      ),
    );
  }

  const tracing = values.provider === "null" ? false : startTracing();
  const runId = `eval-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}-${randomUUID().slice(0, 4)}`;
  const reps = Number(values.reps);
  const judge = values["no-judge"] ? undefined : judgeRun;
  console.log(
    `Eval: ${cases.length} cases × ${reps} reps on ${provider.name} ${provider.model}, prompt ${prompt.version}` +
      ` · judge ${judge ? JUDGE_MODEL : "off"} · tracing ${tracing ? `on (tags: eval, ${runId})` : "off"}`,
  );
  console.log(`→ ${outDir}\n`);

  const started = Date.now();
  const summary = await runEval({
    cases,
    provider,
    prompt,
    outDir,
    reps,
    concurrency: Number(values.concurrency ?? (local ? 1 : 4)),
    timeoutMs: Number(values["timeout-s"] ?? (local ? 900 : 300)) * 1000,
    judge,
    observer: tracing ? getTurnObserver() : undefined,
    traceTags: ["eval", runId],
    expectModel,
    log: (line) => console.log(line),
  });
  await stopTracing();

  console.log(
    `\nScored ${summary.scored} (skipped ${summary.skipped} already done) · errors ${summary.errors} · ` +
      `${((Date.now() - started) / 1000).toFixed(0)} s · cost ${summary.costUsd === null ? "unknown" : `$${summary.costUsd.toFixed(4)}`}`,
  );
  for (const metric of METRICS) {
    const m = summary.metrics[metric.id];
    if (!m) continue;
    console.log(
      `  ${metric.label.padEnd(15)} ${(m.mean * 100).toFixed(0).padStart(3)}%  ±${(m.ci95 * 100).toFixed(0)}  (n=${m.n})`,
    );
  }
  console.log(`\nReport: npm run evals:report -- evals/runs/${flow}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
