/**
 * Judge calibration: a human labels the same criteria the judge scores, then we measure agreement.
 *
 *   npm run evals:calibrate -- write claude-haiku-5-5   → evals/calibration/<flow>.md (blank labels, judge hidden)
 *   (a human replaces each "?" with yes or no)
 *   npm run evals:calibrate -- score claude-haiku-5-5   → agreement per criterion + every disagreement
 *
 * The judge's own answers are NOT shown in the sheet, so the human isn't nudged towards them.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { JUDGE_CRITERIA } from "./lib/judge";
import { upgradeTrace, type TraceTurn } from "./lib/trace";

const [command, flow] = process.argv.slice(2);
if ((command !== "write" && command !== "score") || !flow) {
  console.error("Usage: npm run evals:calibrate -- write|score <flow>");
  process.exit(1);
}

const runDir = join(import.meta.dirname, "runs", flow, "baseline");
const sheet = join(import.meta.dirname, "calibration", `${flow}.md`);
const criteria = Object.keys(JUDGE_CRITERIA);

interface Row {
  prompt_id: string;
  rep: number;
  grade: Record<string, number>;
  explanation: Record<string, string>;
}

const rows = readFileSync(join(runDir, "results.jsonl"), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line) as Row)
  .filter((row) => criteria.every((id) => typeof row.grade[id] === "number"));

const clip = (text: string, max = 300) =>
  text.replace(/\s+/g, " ").slice(0, max) + (text.length > max ? " …" : "");

if (command === "write") {
  const out = [
    `# Judge calibration: ${flow}`,
    "",
    "For each conversation, replace every `?` with **yes** or **no**: does the criterion hold for EVERY assistant",
    "reply the buyer saw? Judge only the assistant. Tool results are shown so you can check facts.",
    "",
    ...Object.entries(JUDGE_CRITERIA).map(([id, text]) => `- **${id}**: ${text}`),
    "",
  ];
  for (const row of rows) {
    const trace = upgradeTrace(
      JSON.parse(
        readFileSync(join(runDir, "traces", `${row.prompt_id}_rep${row.rep}.json`), "utf8"),
      ) as TraceTurn[],
    );
    out.push(`## ${row.prompt_id} (rep ${row.rep})`, "");
    for (const turn of trace) {
      if (turn.role === "user") out.push(`- **Buyer:** ${turn.content}`);
      if (turn.role === "assistant")
        out.push(`- **Assistant:** ${turn.content.replace(/\n+/g, " / ")}`);
      if (turn.role === "assistant_note")
        out.push(
          `  - _note next to a tool call (the buyer doesn't see it):_ ${clip(turn.content, 160)}`,
        );
      if (turn.role === "tool_call")
        out.push(`  - _tool call_ \`${turn.name}\` ${clip(turn.content, 160)}`);
      if (turn.role === "tool_result")
        out.push(`  - _tool result_ \`${turn.name}\`: ${clip(turn.content)}`);
    }
    out.push("", ...criteria.map((id) => `${id}: ?`), "");
  }
  mkdirSync(join(import.meta.dirname, "calibration"), { recursive: true });
  if (existsSync(sheet)) {
    console.error(
      `${sheet} already exists; not overwriting labels. Delete it first to start over.`,
    );
    process.exit(1);
  }
  writeFileSync(sheet, out.join("\n"));
  console.log(`Wrote ${sheet} (${rows.length} conversations × ${criteria.length} criteria)`);
} else {
  const text = readFileSync(sheet, "utf8");
  const sections = text.split(/^## /m).slice(1);
  let agree = 0;
  let total = 0;
  const perCriterion = Object.fromEntries(criteria.map((id) => [id, { agree: 0, total: 0 }]));
  const disagreements: string[] = [];
  const unlabeled: string[] = [];

  for (const section of sections) {
    const [, id, rep] = section.match(/^(\S+) \(rep (\d+)\)/) ?? [];
    const row = rows.find((r) => r.prompt_id === id && r.rep === Number(rep));
    if (!row) continue;
    for (const criterion of criteria) {
      const label = section
        .match(new RegExp(`^${criterion}:\\s*(yes|no|\\?)`, "mi"))?.[1]
        ?.toLowerCase();
      if (!label || label === "?") {
        unlabeled.push(`${id} ${criterion}`);
        continue;
      }
      const human = label === "yes" ? 1 : 0;
      const judge = row.grade[criterion];
      total++;
      perCriterion[criterion]!.total++;
      if (human === judge) {
        agree++;
        perCriterion[criterion]!.agree++;
      } else {
        disagreements.push(
          `- ${id} · ${criterion}: human **${label}**, judge **${judge ? "yes" : "no"}**: ${row.explanation[criterion] ?? ""}`,
        );
      }
    }
  }
  console.log(`Agreement: ${agree}/${total} (${total ? ((agree / total) * 100).toFixed(0) : 0}%)`);
  for (const [id, c] of Object.entries(perCriterion)) {
    console.log(`  ${id.padEnd(13)} ${c.agree}/${c.total}`);
  }
  if (disagreements.length) console.log(`\nDisagreements:\n${disagreements.join("\n")}`);
  if (unlabeled.length) console.log(`\nStill "?": ${unlabeled.join(", ")}`);
}
