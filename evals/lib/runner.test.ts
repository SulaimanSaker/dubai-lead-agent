import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { LlmError } from "@/agent/llm";
import { FakeProvider, textStep, toolStep } from "@/agent/testing/fake-provider";
import { loadCases } from "./cases";
import type { JudgeInput } from "./judge";
import { codeGradesOf, combineGrades, runEval } from "./runner";

const ALL = loadCases(join(import.meta.dirname, "..", "cases"));
const pick = (...ids: string[]) => ALL.filter((c) => ids.includes(c.id));
const tmp = () => mkdtempSync(join(tmpdir(), "eval-run-"));
const lines = (file: string) =>
  existsSync(file)
    ? readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

describe("runEval", () => {
  it("scores a do-nothing agent near zero on cases that need work (null baseline)", async () => {
    const outDir = tmp();
    const nullAgent = new FakeProvider([textStep("Hello! How can I help you today?")], {
      repeatLast: true,
    });
    const summary = await runEval({
      cases: pick("cash-buyer-marina-2bed", "asks-for-a-real-person", "picks-a-time-gets-booked"),
      provider: nullAgent,
      outDir,
      reps: 1,
      concurrency: 2,
      timeoutMs: 30_000,
    });
    expect(summary.scored).toBe(3);
    expect(summary.metrics.pass?.mean).toBe(0);
    const rows = lines(join(outDir, "results.jsonl"));
    expect(rows[0]).toMatchObject({ status: "ok", model: "fake-model", cost_usd: 0 });
    expect(existsSync(join(outDir, "traces", `${rows[0].prompt_id}_rep0.json`))).toBe(true);
  });

  it("passes a scripted agent that does the right thing (oracle through the whole pipeline)", async () => {
    const outDir = tmp();
    const oracle = new FakeProvider([
      toolStep([
        "handoff_to_human",
        { reason: "asked_for_human", summary: "Buyer asked to speak to a person." },
      ]),
      textStep("Of course. A human agent will contact you shortly."),
    ]);
    const summary = await runEval({
      cases: pick("asks-for-a-real-person"),
      provider: oracle,
      outDir,
      reps: 1,
      concurrency: 1,
      timeoutMs: 30_000,
    });
    expect(summary.metrics.pass?.mean).toBe(1);
  });

  it("fails the headline when the judge says the agent didn't answer, even if code checks pass", async () => {
    const outDir = tmp();
    const summary = await runEval({
      cases: pick("goodbye"),
      provider: new FakeProvider([textStep("Hello! How can I help you today?")]),
      outDir,
      reps: 1,
      concurrency: 1,
      timeoutMs: 30_000,
      judge: async () => ({
        scores: { answers: 0, grounded: 1, professional: 1 },
        reasons: {
          answers: "Replies 'How can I help' to a goodbye.",
          grounded: "",
          professional: "",
        },
        model: "claude-sonnet-5-5",
        usage: {
          inputTokens: 1000,
          outputTokens: 100,
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
        },
      }),
    });
    const [row] = lines(join(outDir, "results.jsonl"));
    expect(row.grade).toMatchObject({ code_pass: 1, answers: 0, pass: 0 });
    expect(row.explanation.pass).toBe("judge: answers");
    expect(row.judge_model).toBe("claude-sonnet-5-5");
    expect(row.cost_usd).toBeCloseTo((1000 * 2 + 100 * 10) / 1e6, 10); // judge cost counted
    expect(summary.metrics.pass?.mean).toBe(0);
  });

  it("gives the judge the saved trace and prompt version, and records the judge version", async () => {
    const outDir = tmp();
    const inputs: JudgeInput[] = [];
    await runEval({
      cases: pick("goodbye"),
      provider: new FakeProvider([textStep("Goodbye!")]),
      outDir,
      reps: 1,
      concurrency: 1,
      timeoutMs: 30_000,
      judge: async (_case, input) => {
        inputs.push(input);
        return {
          scores: { answers: 1, grounded: 1, professional: 1 },
          reasons: { answers: "", grounded: "", professional: "" },
          model: "claude-sonnet-5-5",
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            cachedInputTokens: 0,
            cacheWriteInputTokens: 0,
          },
        };
      },
    });
    const saved = JSON.parse(readFileSync(join(outDir, "traces", "goodbye_rep0.json"), "utf8"));
    expect(inputs[0]).toEqual({ trace: saved, promptVersion: "v1" });
    expect(lines(join(outDir, "results.jsonl"))[0]).toMatchObject({ judge_version: "v2" });
  });

  // Review finding: a failed judge call used to leave a row scored on code checks only.
  it("puts a judge failure in errors.jsonl and doesn't score the row", async () => {
    const outDir = tmp();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const summary = await runEval({
      cases: pick("goodbye"),
      provider: new FakeProvider([textStep("Goodbye!")]),
      outDir,
      reps: 1,
      concurrency: 1,
      timeoutMs: 30_000,
      judge: async () => {
        throw new Error("judge overloaded");
      },
    });
    expect(summary).toMatchObject({ scored: 0, errors: 1 });
    expect(lines(join(outDir, "results.jsonl"))).toEqual([]);
    expect(lines(join(outDir, "errors.jsonl"))[0]).toMatchObject({
      prompt_id: "goodbye",
      class: "judge_error",
      detail: "judge overloaded",
    });
    vi.restoreAllMocks();
  });

  it("puts provider outages in errors.jsonl, not in the scores", async () => {
    const outDir = tmp();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const down = new FakeProvider([new LlmError("claude", "unavailable", "overloaded")], {
      repeatLast: true,
    });
    const summary = await runEval({
      cases: pick("greeting-only"),
      provider: down,
      outDir,
      reps: 2,
      concurrency: 1,
      timeoutMs: 30_000,
    });
    expect(summary.scored).toBe(0);
    expect(summary.errors).toBe(2);
    expect(lines(join(outDir, "errors.jsonl"))[0]).toMatchObject({
      prompt_id: "greeting-only",
      class: "serving",
    });
    expect(lines(join(outDir, "results.jsonl"))).toEqual([]);
    vi.restoreAllMocks();
  });

  it("flags a reply from a different model than requested", async () => {
    const outDir = tmp();
    const summary = await runEval({
      cases: pick("greeting-only"),
      provider: new FakeProvider([textStep("Hi!")]),
      outDir,
      reps: 1,
      concurrency: 1,
      timeoutMs: 30_000,
      expectModel: "claude-haiku-5-5",
    });
    expect(summary.errors).toBe(1);
    expect(lines(join(outDir, "errors.jsonl"))[0]).toMatchObject({ class: "model_mismatch" });
  });

  it("resumes: finished (case, rep) pairs are not run again", async () => {
    const outDir = tmp();
    const options = {
      cases: pick("goodbye"),
      outDir,
      reps: 2,
      concurrency: 1,
      timeoutMs: 30_000,
    };
    await runEval({
      ...options,
      provider: new FakeProvider([textStep("Bye!")], { repeatLast: true }),
    });
    const second = new FakeProvider([textStep("Bye!")], { repeatLast: true });
    const summary = await runEval({ ...options, provider: second });
    expect(summary).toMatchObject({ scored: 2, skipped: 2 });
    expect(second.requests).toHaveLength(0);
  });
});

describe("combineGrades / codeGradesOf", () => {
  const code = {
    scores: { extraction: 0, handoff: 1, pass: 0 },
    reasons: { extraction: "beds should be 2", pass: "failed: extraction" },
  };
  const judged = {
    scores: { answers: 0, grounded: 1, professional: 1 },
    reasons: { answers: "ignored the question", grounded: "", professional: "" },
  };

  it("needs code checks AND the judge for pass, and keeps the code-only result", () => {
    const { grade, explanation } = combineGrades(code, judged);
    expect(grade).toMatchObject({ pass: 0, code_pass: 0, answers: 0 });
    expect(explanation.pass).toBe("failed: extraction; judge: answers");
    expect(explanation.code_pass).toBe("failed: extraction");
  });

  it("gets the code part back from a saved row, so a new judge can re-grade it", () => {
    const { grade, explanation } = combineGrades(code, judged);
    expect(codeGradesOf(grade, explanation)).toEqual(code);
    // Rows from judge v1 had no explanation.code_pass: the code reason is inside explanation.pass.
    const v1Explanation = { ...explanation };
    delete v1Explanation.code_pass;
    expect(codeGradesOf(grade, v1Explanation)).toEqual(code);
  });
});
