/**
 * Re-grade saved runs with the current judge, without running the agent again (the conversations are in
 * traces/). Code checks are kept as they are; only the judge's scores, `pass`, the judge cost and
 * `judge_version` change. Rows already graded by the current judge version are skipped.
 *
 *   npm run evals:rejudge -- claude-haiku-5-5 gemma-3-4b      (or no names = every flow in evals/runs)
 *
 * Before changing anything, the rows are copied to results.judge-<old version>.jsonl (once per old version), so
 * before/after can be compared. Don't run `evals` on the same flow at the same time: this rewrites results.jsonl.
 */
import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { modelCallCostUsd } from "@/agent/llm/pricing";
import { loadCases } from "./lib/cases";
import { JUDGE_CRITERIA, JUDGE_VERSION, judgeRun } from "./lib/judge";
import { combineGrades, codeGradesOf } from "./lib/runner";
import { promptVersionOf, upgradeTrace, type TraceTurn } from "./lib/trace";

interface Row {
  prompt_id: string;
  rep: number;
  grade: Record<string, number>;
  explanation: Record<string, string>;
  cost_usd: number | null;
  judge_version?: string;
  meta?: { agent_cost_usd?: number | null };
  [key: string]: unknown;
}

const RUNS = join(import.meta.dirname, "runs");
const JUDGE_IDS = Object.keys(JUDGE_CRITERIA);
const CONCURRENCY = 4;
const cases = new Map(loadCases(join(import.meta.dirname, "cases")).map((c) => [c.id, c]));

async function rejudgeFlow(flow: string) {
  const dir = join(RUNS, flow, "baseline");
  const resultsFile = join(dir, "results.jsonl");
  const rows = readFileSync(resultsFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Row);
  const before = rows.filter((row) => row.grade.pass === 1).length;
  let cost = 0;
  let failed = 0;
  const changes: string[] = [];

  const queue = rows.filter((row) => row.judge_version !== JUDGE_VERSION);
  const skipped = rows.length - queue.length;
  const unknown = queue.filter((row) => !cases.has(row.prompt_id)).map((row) => row.prompt_id);
  if (unknown.length)
    throw new Error(`${flow}: rows for unknown cases: ${[...new Set(unknown)].join(", ")}`);

  // Keep the rows as the older judge graded them (named after that judge), before anything changes.
  const oldVersion = queue[0]?.judge_version ?? "v1";
  const backup = join(dir, `results.judge-${oldVersion}.jsonl`);
  if (queue.length > 0 && !existsSync(backup)) copyFileSync(resultsFile, backup);
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      for (let row = queue.shift(); row; row = queue.shift()) {
        const evalCase = cases.get(row.prompt_id);
        if (!evalCase) continue; // checked above
        const traceFile = join(dir, "traces", `${row.prompt_id}_rep${row.rep}.json`);
        const trace = upgradeTrace(JSON.parse(readFileSync(traceFile, "utf8")) as TraceTurn[]);
        writeFileSync(traceFile, JSON.stringify(trace, null, 2));

        let judged;
        try {
          judged = await judgeRun(evalCase, { trace, promptVersion: promptVersionOf(trace) });
        } catch (error) {
          failed++;
          console.error(`  ✗ ${row.prompt_id} rep ${row.rep}: judge failed, row kept: ${error}`);
          continue;
        }
        const oldGrade = { ...row.grade };
        const { grade, explanation } = combineGrades(
          codeGradesOf(row.grade, row.explanation),
          judged,
        );
        const judgeCost = modelCallCostUsd("claude", judged.model, judged.usage) ?? 0;
        cost += judgeCost;
        const agentCost = row.meta?.agent_cost_usd;
        Object.assign(row, {
          grade,
          explanation,
          cost_usd: typeof agentCost === "number" ? agentCost + judgeCost : null,
          judge_model: judged.model,
          judge_version: JUDGE_VERSION,
          judge_usage: judged.usage,
        });
        const flipped = ["pass", ...JUDGE_IDS].filter((id) => oldGrade[id] !== grade[id]);
        if (flipped.length)
          changes.push(
            `  ${row.prompt_id} rep ${row.rep}: ` +
              flipped.map((id) => `${id} ${oldGrade[id] ?? "-"}→${grade[id]}`).join(", "),
          );
      }
    }),
  );

  writeFileSync(resultsFile, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");

  const after = rows.filter((row) => row.grade.pass === 1).length;
  console.log(
    `${flow}: re-graded ${rows.length - skipped - failed}, skipped ${skipped}, judge failures ${failed} · ` +
      `pass ${before}/${rows.length} → ${after}/${rows.length} · judge cost $${cost.toFixed(4)}`,
  );
  if (changes.length) console.log(changes.sort().join("\n"));
}

const flows = process.argv.slice(2);
const targets = flows.length
  ? flows
  : readdirSync(RUNS).filter((name) => existsSync(join(RUNS, name, "baseline", "results.jsonl")));
async function main() {
  for (const flow of targets) await rejudgeFlow(flow);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
