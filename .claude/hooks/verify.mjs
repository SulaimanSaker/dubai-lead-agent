// Stop hook: before Claude finishes a turn, run `npm run check`
// (typecheck + lint + format check + unit tests). If it fails, exit code 2
// blocks the stop and sends the errors back to Claude to fix.
//
// To stay fast, it only runs when code changed since the last passing check
// (newest file modification time vs. a stamp file, git-ignored).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { projectDir, readHookInput } from "./lib.mjs";

const input = await readHookInput();
// Claude is already fixing a failure from this hook: don't loop forever.
if (input.stop_hook_active) process.exit(0);

const STAMP = path.join(projectDir, ".claude", ".verify-stamp");
const WATCH_DIRS = ["src", "evals", ".claude/hooks"];
const WATCH_FILES = [
  "package.json",
  "tsconfig.json",
  "eslint.config.mjs",
  "vitest.config.mts",
  "next.config.ts",
];
const SKIP = new Set(["node_modules", ".next", "reports"]);

function newestMtime(target) {
  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    return 0;
  }
  if (!stat.isDirectory()) return stat.mtimeMs;
  let newest = 0;
  for (const entry of fs.readdirSync(target)) {
    if (SKIP.has(entry)) continue;
    newest = Math.max(newest, newestMtime(path.join(target, entry)));
  }
  return newest;
}

const lastChange = Math.max(
  ...[...WATCH_DIRS, ...WATCH_FILES].map((p) => newestMtime(path.join(projectDir, p))),
);
let lastPass = 0;
try {
  lastPass = Number(fs.readFileSync(STAMP, "utf8")) || 0;
} catch {}
if (lastChange <= lastPass) process.exit(0); // nothing changed since the last green check

const startedAt = Date.now();
// One command string through the shell (npm is npm.cmd on Windows). No separate args array:
// Node warns that args + shell are concatenated without escaping (DEP0190).
const result = spawnSync("npm run check", {
  cwd: projectDir,
  encoding: "utf8",
  shell: true,
});

if (result.status === 0) {
  fs.writeFileSync(STAMP, String(startedAt));
  process.exit(0);
}

const output = `${result.stdout ?? ""}${result.stderr ?? ""}`
  .trim()
  .split("\n")
  .slice(-60)
  .join("\n");
process.stderr.write(
  `\`npm run check\` failed. Fix these problems before finishing (do not skip or disable checks):\n${output}\n`,
);
process.exit(2);
