// PreToolUse hook (Write|Edit|NotebookEdit): protect files the agent must not change on its own.
// - .env files (secrets): always denied. .env.example is allowed.
// - evals/cases/ (golden eval data): the human must approve, so the agent can't
//   "fix" a failing eval by changing the expected answer.
import { projectRelative, readHookInput } from "./lib.mjs";

const input = await readHookInput();
const rel = projectRelative(input.tool_input?.file_path ?? input.tool_input?.notebook_path);
if (!rel) process.exit(0);

const fileName = rel.split("/").pop() ?? "";

function decide(permissionDecision, permissionDecisionReason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision,
        permissionDecisionReason,
      },
    }),
  );
  process.exit(0);
}

if (fileName.startsWith(".env") && fileName !== ".env.example") {
  decide(
    "deny",
    `${rel} holds secrets. Agents never edit .env files — change .env.example and ask the human.`,
  );
}

if (rel.startsWith("evals/cases/")) {
  decide(
    "ask",
    `${rel} is golden eval data. Changing it can hide a real agent bug. Approve only if the case itself is wrong.`,
  );
}
