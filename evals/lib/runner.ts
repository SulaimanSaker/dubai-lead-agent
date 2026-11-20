/**
 * Runs cases × reps and writes, per variant directory (Anthropic's eval-report layout):
 *   results.jsonl              one row per scored (case, rep), appended as it finishes (resumable)
 *   traces/<case>_rep<k>.json  the full conversation, for the report and for debugging
 *   errors.jsonl               attempts that produced nothing scorable (infra), never scored as model failures
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LlmProvider } from "@/agent/llm";
import { modelCallCostUsd } from "@/agent/llm/pricing";
import type { TurnObserver } from "@/agent/observer";
import type { EvalCase } from "./cases";
import { gradeCase } from "./grade";
import { JUDGE_CRITERIA, JUDGE_VERSION, type JudgeInput, type JudgeResult } from "./judge";
import { runCase, type CaseRun } from "./run-case";
import { toTrace } from "./trace";

/** Turn outcomes that mean the service failed, not the model: such attempts go to errors.jsonl. */
const INFRA_OUTCOMES = new Set(["timeout", "provider_error", "internal_error"]);

export interface RunEvalOptions {
  cases: EvalCase[];
  provider: LlmProvider;
  /** results.jsonl etc. go here, e.g. evals/runs/claude-haiku-5-5/baseline */
  outDir: string;
  reps: number;
  concurrency: number;
  timeoutMs: number;
  /** Grades soft criteria; undefined = no judge. */
  judge?: (evalCase: EvalCase, input: JudgeInput) => Promise<JudgeResult>;
  observer?: TurnObserver;
  /** Trace tags for every turn (e.g. "eval", the run id). */
  traceTags?: string[];
  /** Check that every reply came from this model (catches silent fallbacks). */
  expectModel?: string;
  log?: (line: string) => void;
}

export interface EvalSummary {
  scored: number;
  skipped: number;
  errors: number;
  metrics: Record<string, { mean: number; n: number; ci95: number }>;
  costUsd: number | null;
}

interface Row {
  prompt_id: string;
  rep: number;
  grade: Record<string, number>;
  cost_usd: number | null;
}

function readJsonl<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as T);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`case wall-clock ceiling of ${ms / 1000}s reached`)),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const num = (value: unknown) => (typeof value === "number" ? value : 0);

export async function runEval(options: RunEvalOptions): Promise<EvalSummary> {
  const log = options.log ?? (() => {});
  mkdirSync(join(options.outDir, "traces"), { recursive: true });
  const resultsFile = join(options.outDir, "results.jsonl");
  const errorsFile = join(options.outDir, "errors.jsonl");

  const done = new Set(readJsonl<Row>(resultsFile).map((row) => `${row.prompt_id}#${row.rep}`));
  const jobs = options.cases.flatMap((evalCase) =>
    Array.from({ length: options.reps }, (_, rep) => ({ evalCase, rep })),
  );
  const todo = jobs.filter(({ evalCase, rep }) => !done.has(`${evalCase.id}#${rep}`));
  let errors = 0;

  const writeError = (evalCase: EvalCase, rep: number, failureClass: string, detail: string) => {
    errors++;
    appendFileSync(
      errorsFile,
      JSON.stringify({
        prompt_id: evalCase.id,
        rep,
        class: failureClass,
        detail,
        at: new Date().toISOString(),
      }) + "\n",
    );
    log(`  ✗ ${evalCase.id} rep ${rep}: ${failureClass}: ${detail}`);
  };

  async function runJob({ evalCase, rep }: (typeof jobs)[number]) {
    let run: CaseRun;
    const started = Date.now();
    try {
      run = await withTimeout(
        runCase(evalCase, options.provider, {
          observer: options.observer,
          traceTags: [...(options.traceTags ?? []), evalCase.id],
        }),
        options.timeoutMs,
      );
    } catch (error) {
      writeError(
        evalCase,
        rep,
        "harness_or_timeout",
        error instanceof Error ? error.message : String(error),
      );
      return;
    }
    const infra = run.turns.filter((turn) => INFRA_OUTCOMES.has(turn.outcome));
    if (infra.length > 0) {
      writeError(
        evalCase,
        rep,
        "serving",
        `turn outcomes: ${run.turns.map((t) => t.outcome).join(", ")}`,
      );
      return;
    }
    const wrongModel =
      options.expectModel && run.turns.find((turn) => turn.model !== options.expectModel);
    if (wrongModel) {
      writeError(
        evalCase,
        rep,
        "model_mismatch",
        `asked for ${options.expectModel}, answered by ${wrongModel.model}`,
      );
      return;
    }

    const code = gradeCase(evalCase, run);
    const promptVersion = String(run.metas[0]?.promptVersion ?? "v1");
    const trace = toTrace(evalCase, run.conversation, promptVersion);
    let judged: JudgeResult | undefined;
    if (options.judge) {
      try {
        judged = await options.judge(evalCase, { trace, promptVersion });
      } catch (error) {
        // Not scored: a row without the judge would count on code checks alone, which a do-nothing agent
        // passes 29% of the time. The next run retries the whole (case, rep).
        writeError(
          evalCase,
          rep,
          "judge_error",
          error instanceof Error ? error.message : String(error),
        );
        return;
      }
    }
    const { grade, explanation } = combineGrades(code, judged);

    const metas = run.metas;
    const agentCost = metas.reduce<number | null>(
      (sum, meta) => (sum === null || typeof meta.costUsd !== "number" ? null : sum + meta.costUsd),
      0,
    );
    const judgeCost = judged ? modelCallCostUsd("claude", judged.model, judged.usage) : 0;
    const usage = {
      input_tokens: metas.reduce(
        (s, m) => s + num(m.inputTokens) - num(m.cachedInputTokens) - num(m.cacheWriteInputTokens),
        0,
      ),
      output_tokens: metas.reduce((s, m) => s + num(m.outputTokens), 0),
      cache_read_input_tokens: metas.reduce((s, m) => s + num(m.cachedInputTokens), 0),
      cache_creation_input_tokens: metas.reduce((s, m) => s + num(m.cacheWriteInputTokens), 0),
    };
    const row = {
      prompt_id: evalCase.id,
      rep,
      prompt: evalCase.messages.join("\n---\n"),
      tags: evalCase.tags,
      status: "ok",
      grade,
      explanation,
      model: run.turns.at(-1)?.model ?? options.provider.model,
      usage,
      cost_usd: agentCost === null || judgeCost === null ? null : agentCost + judgeCost,
      latency_s: metas.reduce((s, m) => s + num(m.latencyMs), 0) / 1000,
      tool_calls: run.conversation.reduce(
        (s, m) => s + (m.role === "assistant" ? m.toolCalls.length : 0),
        0,
      ),
      ...(judged && {
        judge_model: judged.model,
        judge_version: JUDGE_VERSION,
        judge_usage: judged.usage,
      }),
      meta: {
        turns: run.turns.map((t) => ({ outcome: t.outcome, reply: t.reply })),
        trace_ids: metas.map((m) => m.traceId ?? null),
        agent_cost_usd: agentCost,
        wall_clock_s: (Date.now() - started) / 1000,
      },
    };
    writeFileSync(
      join(options.outDir, "traces", `${evalCase.id}_rep${rep}.json`),
      JSON.stringify(trace, null, 2),
    );
    appendFileSync(resultsFile, JSON.stringify(row) + "\n");
    const failed = Object.entries(row.grade)
      .filter(([, v]) => v === 0)
      .map(([k]) => k);
    log(
      `  ${row.grade.pass === 1 ? "✓" : "✗"} ${evalCase.id} rep ${rep}${failed.length ? `  (failed: ${failed.join(", ")})` : ""}`,
    );
  }

  // A small worker pool: at most `concurrency` cases in flight.
  const queue = [...todo];
  await Promise.all(
    Array.from({ length: Math.max(1, options.concurrency) }, async () => {
      for (let job = queue.shift(); job; job = queue.shift()) await runJob(job);
    }),
  );

  const rows = readJsonl<Row>(resultsFile).filter((row) =>
    options.cases.some((evalCase) => evalCase.id === row.prompt_id),
  );
  return { scored: rows.length, skipped: jobs.length - todo.length, errors, ...summarize(rows) };
}

type Graded = Pick<JudgeResult, "scores" | "reasons">;

/**
 * Headline `pass` = code checks AND the judge's "answers" + "grounded". Code alone can't see that "Hello!"
 * doesn't answer "Who am I talking to?": a do-nothing agent passed 29% of cases on code checks only.
 * `code_pass` keeps the code-only result. Without a judge, `pass` is the code result.
 */
export function combineGrades(code: Graded, judged?: Graded) {
  const grade: Record<string, number> = {
    ...code.scores,
    ...judged?.scores,
    code_pass: code.scores.pass ?? 0,
  };
  const explanation: Record<string, string> = { ...code.reasons, ...judged?.reasons };
  if (code.reasons.pass) explanation.code_pass = code.reasons.pass;
  if (judged) {
    const judgeFails = ["answers", "grounded"].filter((id) => judged.scores[id] === 0);
    grade.pass = grade.code_pass === 1 && judgeFails.length === 0 ? 1 : 0;
    const why = [
      code.reasons.pass,
      judgeFails.length ? `judge: ${judgeFails.join(", ")}` : "",
    ].filter(Boolean);
    if (why.length) explanation.pass = why.join("; ");
    else delete explanation.pass;
  }
  return { grade, explanation };
}

/**
 * The inverse of `combineGrades`: the code-check part of a saved row, for re-grading with a new judge. Rows
 * written before `explanation.code_pass` existed have the code reason inside `explanation.pass`.
 */
export function codeGradesOf(
  grade: Record<string, number>,
  explanation: Record<string, string>,
): Graded {
  const own = (id: string) => !(id in JUDGE_CRITERIA) && id !== "code_pass" && id !== "pass";
  const scores = Object.fromEntries(Object.entries(grade).filter(([id]) => own(id)));
  const reasons = Object.fromEntries(Object.entries(explanation).filter(([id]) => own(id)));
  scores.pass = grade.code_pass ?? grade.pass ?? 0;
  const codeReason =
    explanation.code_pass ??
    (explanation.pass ?? "")
      .split("; ")
      .filter((part) => part && !part.startsWith("judge:"))
      .join("; ");
  if (codeReason) reasons.pass = codeReason;
  return { scores, reasons };
}

/** Mean per metric over scored rows, with a 95% interval (normal approximation; wide on small n). */
export function summarize(rows: Row[]): Pick<EvalSummary, "metrics" | "costUsd"> {
  const metrics: EvalSummary["metrics"] = {};
  const ids = [...new Set(rows.flatMap((row) => Object.keys(row.grade)))];
  for (const id of ids) {
    const values = rows
      .map((row) => row.grade[id])
      .filter((v): v is number => typeof v === "number");
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    metrics[id] = {
      mean,
      n: values.length,
      ci95: 1.96 * Math.sqrt((mean * (1 - mean)) / values.length),
    };
  }
  const costUsd = rows.reduce<number | null>(
    (sum, row) => (sum === null || row.cost_usd === null ? null : sum + row.cost_usd),
    0,
  );
  return { metrics, costUsd };
}
