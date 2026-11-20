/**
 * Golden eval cases: schema and loader. Cases live in evals/cases/<category>.json and are protected
 * (a hook asks the human before any edit). See evals/CLAUDE.md and docs/plans/2026-11-17-evals.md.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { FINANCING, PURPOSES, TIMELINES } from "@/db/schema";
import { TOOLS_BY_NAME } from "@/tools";

const toolName = z.string().refine((name) => TOOLS_BY_NAME.has(name), {
  message: `unknown tool (known: ${[...TOOLS_BY_NAME.keys()].join(", ")})`,
});

const LEAD_FIELDS = ["purpose", "areas", "beds", "budgetAed", "timeline", "financing"] as const;
export type LeadField = (typeof LEAD_FIELDS)[number];

const expectedLead = z.strictObject({
  purpose: z.enum(PURPOSES).optional(),
  /** Each listed area must be among the saved areas (aliases like "JVC" count). */
  areas: z.array(z.string().min(2)).min(1).optional(),
  beds: z.number().int().min(0).optional(),
  budgetAed: z.number().int().positive().optional(),
  timeline: z.enum(TIMELINES).optional(),
  financing: z.enum(FINANCING).optional(),
});

const expectedToolCall = z.strictObject({
  name: toolName,
  /** Only the arguments that matter (partial match). */
  args: z.record(z.string(), z.unknown()).optional(),
  /** Arguments that must NOT be sent (e.g. filters the buyer never asked for). */
  argsAbsent: z.array(z.string()).optional(),
});

export const evalCaseSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "kebab-case id"),
  description: z.string().min(10),
  /** tags[0] = category (report grouping); tags[1] = language. */
  tags: z.array(z.string().min(1)).min(2),
  /** Where the case comes from: a real trace/finding (with date) or "synthetic". */
  source: z.string().min(3),
  /** "Now" for the conversation (calendar answers depend on it). Default: Mon 16 Nov 2026 14:05 Dubai. */
  now: z.iso.datetime().optional(),
  /** State before the conversation starts, e.g. a slot already booked by another buyer. */
  setup: z
    .strictObject({
      bookedViewings: z.array(z.strictObject({ listingId: z.string(), startsAt: z.string() })),
    })
    .optional(),
  /** Buyer messages, sent in order (scripted: they don't adapt to the agent's questions). */
  messages: z.array(z.string().min(1)).min(1).max(6),
  expect: z.strictObject({
    lead: expectedLead.optional(),
    /** Fields that must still be empty at the end: no invented data. */
    leadUnknown: z.array(z.enum(LEAD_FIELDS)).optional(),
    toolCalls: z.array(expectedToolCall).optional(),
    forbiddenTools: z.array(toolName).optional(),
    /** Every case states both, so "always book" or "always hand off" can't score well. */
    viewingBooked: z.boolean(),
    handoff: z.boolean(),
    /** The language every reply must be in. */
    language: z.enum(["en", "ar"]),
  }),
});

export type EvalCase = z.infer<typeof evalCaseSchema>;

const caseFileSchema = z.strictObject({
  category: z.string().min(2),
  cases: z.array(evalCaseSchema).min(1),
});

export const DEFAULT_NOW = "2026-11-16T10:05:00Z"; // Mon 16 Nov 2026, 14:05 in Dubai

/** Load and validate every case file. Throws one clear error listing every problem. */
export function loadCases(dir: string): EvalCase[] {
  const files = readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .sort();
  const cases: EvalCase[] = [];
  const problems: string[] = [];

  for (const file of files) {
    const parsed = caseFileSchema.safeParse(JSON.parse(readFileSync(join(dir, file), "utf8")));
    if (!parsed.success) {
      problems.push(`${file}:\n${z.prettifyError(parsed.error)}`);
      continue;
    }
    for (const evalCase of parsed.data.cases) {
      if (evalCase.tags[0] !== parsed.data.category) {
        problems.push(
          `${file}: case ${evalCase.id} has tags[0] "${evalCase.tags[0]}", expected "${parsed.data.category}"`,
        );
      }
      cases.push(evalCase);
    }
  }

  const seen = new Set<string>();
  for (const evalCase of cases) {
    if (seen.has(evalCase.id)) problems.push(`duplicate case id: ${evalCase.id}`);
    seen.add(evalCase.id);
  }
  if (problems.length > 0) throw new Error(`Invalid eval cases:\n${problems.join("\n")}`);
  return cases;
}
