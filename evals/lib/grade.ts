/**
 * Code checks: exact, free and repeatable. Each returns 1 (pass), 0 (fail) or undefined (not applicable),
 * with a reason for every failure so a red cell can be explained without opening the transcript.
 */
import { findInventedPrices } from "@/agent/guards";
import type { LlmMessage, LlmToolCall } from "@/agent/llm";
import type { EvalCase, LeadField } from "./cases";
import type { CaseRun } from "./run-case";

export type Scores = Record<string, number>;
export type Reasons = Record<string, string>;

/**
 * Checks that make up the headline `pass`. Language counts since 2026-11-21: an English reply to an Arabic buyer
 * is a real failure in Dubai (a held-out case showed one). Style is reported separately.
 */
export const PASS_CHECKS = [
  "extraction",
  "tool_use",
  "booking",
  "handoff",
  "no_invented_prices",
  "turns_ok",
  "language",
] as const;

const AREA_ALIASES: Record<string, string> = {
  jvc: "jumeirah village circle",
  jlt: "jumeirah lake towers",
  downtown: "downtown dubai",
  marina: "dubai marina",
  "dubai hills": "dubai hills estate",
  "the palm": "palm jumeirah",
  palm: "palm jumeirah",
};

function normalizeArea(area: string): string {
  const key = area.trim().toLowerCase();
  return AREA_ALIASES[key] ?? key;
}

/**
 * "Dubai Marina" matches "dubai marina", "Marina" (alias) and "Dubai Marina, near JBR". A shorter name doesn't
 * match ("Dubai" is not "Dubai Marina"), and neither does an empty one.
 */
export function sameArea(expected: string, actual: string): boolean {
  const a = normalizeArea(expected);
  const b = normalizeArea(actual);
  return a !== "" && b !== "" && (a === b || b.includes(a));
}

function isEmpty(value: unknown): boolean {
  return value === null || value === undefined || (Array.isArray(value) && value.length === 0);
}

function gradeExtraction(c: EvalCase, run: CaseRun): [number | undefined, string] {
  const expected = c.expect.lead;
  const unknown = c.expect.leadUnknown;
  if (!expected && !unknown) return [undefined, ""];
  const problems: string[] = [];
  for (const [field, value] of Object.entries(expected ?? {})) {
    const actual = run.lead[field as LeadField];
    if (field === "areas") {
      const saved = (actual as string[] | null) ?? [];
      for (const area of value as string[]) {
        if (!saved.some((s) => sameArea(area, s))) {
          problems.push(`areas: expected "${area}", saved ${JSON.stringify(saved)}`);
        }
      }
    } else if (actual !== value) {
      problems.push(`${field}: expected ${JSON.stringify(value)}, saved ${JSON.stringify(actual)}`);
    }
  }
  for (const field of unknown ?? []) {
    if (!isEmpty(run.lead[field])) {
      problems.push(`${field} should be unknown, saved ${JSON.stringify(run.lead[field])}`);
    }
  }
  return problems.length === 0 ? [1, ""] : [0, problems.join("; ")];
}

/** Every tool call the model made, in order. */
export function toolCallsOf(conversation: LlmMessage[]): LlmToolCall[] {
  return conversation.flatMap((m) => (m.role === "assistant" ? m.toolCalls : []));
}

/** Strings match ignoring case; only an `area` argument also accepts area aliases (see `sameArea`). */
function argMatches(key: string, expected: unknown, actual: unknown): boolean {
  if (typeof expected === "string" && typeof actual === "string") {
    if (key === "area") return sameArea(expected, actual);
    return expected.toLowerCase() === actual.toLowerCase();
  }
  return JSON.stringify(expected) === JSON.stringify(actual);
}

function gradeToolUse(c: EvalCase, run: CaseRun): [number | undefined, string] {
  const required = c.expect.toolCalls ?? [];
  const forbidden = c.expect.forbiddenTools ?? [];
  if (required.length === 0 && forbidden.length === 0) return [undefined, ""];
  const calls = toolCallsOf(run.conversation);
  const problems: string[] = [];

  for (const want of required) {
    const sameName = calls.filter((call) => call.name === want.name);
    const match = sameName.find((call) => {
      const input = (call.input ?? {}) as Record<string, unknown>;
      const argsOk = Object.entries(want.args ?? {}).every(([key, value]) =>
        argMatches(key, value, input[key]),
      );
      const absentOk = (want.argsAbsent ?? []).every(
        (key) => isEmpty(input[key]) || input[key] === "",
      );
      return argsOk && absentOk;
    });
    if (!match) {
      const seen = sameName.map((call) => JSON.stringify(call.input)).join(", ");
      problems.push(
        sameName.length === 0
          ? `never called ${want.name}`
          : `${want.name} called, but not with ${JSON.stringify(want.args ?? {})}` +
              (want.argsAbsent ? ` and without ${want.argsAbsent.join(", ")}` : "") +
              ` (got ${seen})`,
      );
    }
  }
  for (const name of forbidden) {
    if (calls.some((call) => call.name === name)) problems.push(`called forbidden ${name}`);
  }
  return problems.length === 0 ? [1, ""] : [0, problems.join("; ")];
}

function gradeBooking(c: EvalCase, run: CaseRun): [number, string] {
  const booked = run.viewings.some((v) => v.status === "booked");
  if (booked === c.expect.viewingBooked) return [1, ""];
  return [
    0,
    booked
      ? `booked ${run.viewings.map((v) => `${v.listingId} ${v.startsAt}`).join(", ")} but shouldn't have`
      : "no viewing booked",
  ];
}

function gradeHandoff(c: EvalCase, run: CaseRun): [number, string] {
  const handedOff = run.lead.status === "handed_off";
  if (handedOff === c.expect.handoff) return [1, ""];
  return [
    0,
    handedOff ? `handed off (${run.lead.handoffReason}) but shouldn't have` : "not handed off",
  ];
}

function gradePrices(run: CaseRun): [number, string] {
  const toolResults = run.conversation.flatMap((m) => (m.role === "tool" ? [m.result] : []));
  const invented = run.turns.flatMap((turn) => findInventedPrices(turn.reply, toolResults));
  return invented.length === 0
    ? [1, ""]
    : [0, `amounts no tool returned: ${invented.map((a) => a.raw).join(", ")}`];
}

function gradeTurns(run: CaseRun): [number, string] {
  const bad = run.turns
    .map((t, i) => ({ i, outcome: t.outcome }))
    .filter((t) => t.outcome !== "replied");
  return bad.length === 0
    ? [1, ""]
    : [0, bad.map((t) => `turn ${t.i + 1}: ${t.outcome}`).join("; ")];
}

const ARABIC = /[؀-ۿ]/g;
const LATIN = /[A-Za-z]/g;

function gradeLanguage(c: EvalCase, run: CaseRun): [number, string] {
  const wrong = run.turns.flatMap((turn, i) => {
    const arabic = (turn.reply.match(ARABIC) ?? []).length;
    const latin = (turn.reply.match(LATIN) ?? []).length;
    const ok = c.expect.language === "ar" ? arabic > 0 && arabic >= latin : arabic === 0;
    return ok ? [] : [`turn ${i + 1}`];
  });
  return wrong.length === 0
    ? [1, ""]
    : [0, `not in ${c.expect.language === "ar" ? "Arabic" : "English"}: ${wrong.join(", ")}`];
}

const MAX_WORDS = 90;
const LEAKS = [
  /\b(update_lead|search_listings|get_listing|get_available_slots|book_viewing|handoff_to_human)\b/,
  /\[\s*\/?\s*(END|TOOL|INST|CONTEXT)[A-Z_ ]*\]/i,
  /<\/?(tool|thinking|system)[^>]*>/i,
];

/** WhatsApp style: short, at most two questions, no tool names or markup leaking into the reply. */
function gradeStyle(run: CaseRun): [number, string] {
  const problems = run.turns.flatMap((turn, i) => {
    const issues: string[] = [];
    const words = turn.reply.split(/\s+/).filter(Boolean).length;
    if (words > MAX_WORDS) issues.push(`${words} words`);
    const questions = (turn.reply.match(/[?؟]/g) ?? []).length;
    if (questions > 2) issues.push(`${questions} questions`);
    const leak = LEAKS.find((pattern) => pattern.test(turn.reply));
    if (leak) issues.push(`leaks "${turn.reply.match(leak)?.[0]}"`);
    return issues.length > 0 ? [`turn ${i + 1}: ${issues.join(", ")}`] : [];
  });
  return problems.length === 0 ? [1, ""] : [0, problems.join("; ")];
}

/** All code checks for one run, plus `pass` (every applicable correctness check passed). */
export function gradeCase(c: EvalCase, run: CaseRun): { scores: Scores; reasons: Reasons } {
  const results: Record<string, [number | undefined, string]> = {
    extraction: gradeExtraction(c, run),
    tool_use: gradeToolUse(c, run),
    booking: gradeBooking(c, run),
    handoff: gradeHandoff(c, run),
    no_invented_prices: gradePrices(run),
    turns_ok: gradeTurns(run),
    language: gradeLanguage(c, run),
    style: gradeStyle(run),
  };
  const scores: Scores = {};
  const reasons: Reasons = {};
  for (const [id, [score, reason]] of Object.entries(results)) {
    if (score === undefined) continue;
    scores[id] = score;
    if (reason) reasons[id] = reason;
  }
  const failed = PASS_CHECKS.filter((id) => scores[id] === 0);
  scores.pass = failed.length === 0 ? 1 : 0;
  if (failed.length > 0) reasons.pass = `failed: ${failed.join(", ")}`;
  return { scores, reasons };
}
