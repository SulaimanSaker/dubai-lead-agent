// PostToolUse hook (Write|Edit): format the edited file, then lint it.
// - Prettier always fixes formatting silently.
// - ESLint auto-fixes what it can; remaining errors (e.g. a layer-boundary violation)
//   are sent back to Claude with exit code 2 so it fixes them right away.
import { projectRelative, readHookInput, runNodeBin } from "./lib.mjs";

const input = await readHookInput();
const file = input.tool_input?.file_path;
const rel = projectRelative(file);
if (!rel) process.exit(0); // outside this project: not our business

runNodeBin("node_modules/prettier/bin/prettier.cjs", [
  "--write",
  "--ignore-unknown",
  "--log-level",
  "warn",
  rel,
]);

if (!/\.(ts|tsx|js|jsx|mjs|cjs|mts)$/.test(rel)) process.exit(0);

const lint = runNodeBin("node_modules/eslint/bin/eslint.js", ["--fix", "--no-warn-ignored", rel]);
if (lint.status !== 0) {
  process.stderr.write(
    `ESLint found problems in ${rel} after your edit. Fix them before continuing:\n${lint.stdout}${lint.stderr}`,
  );
  process.exit(2);
}
