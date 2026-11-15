// Shared helpers for the Claude Code hooks in this folder.
// Hooks receive a JSON payload on stdin and talk back through exit codes / stdout JSON.
import { spawnSync } from "node:child_process";
import path from "node:path";

/**
 * Windows path clean-up:
 * - Git Bash style (/c/Users/...) → C:/Users/... so Node can resolve it.
 * - Drive letter always UPPERCASE. Claude Code may pass "c:\...". Vitest then loads itself twice under two
 *   spellings of the same path and fails with "Vitest failed to find the runner".
 */
function toNativePath(p) {
  if (process.platform !== "win32") return p;
  const gitBash = /^\/([a-zA-Z])(\/.*)?$/.exec(p);
  if (gitBash) return `${gitBash[1].toUpperCase()}:${gitBash[2] ?? "/"}`;
  return p.replace(/^([a-z]):/, (_, drive) => `${drive.toUpperCase()}:`);
}

export const projectDir = path.resolve(
  toNativePath(process.env.CLAUDE_PROJECT_DIR ?? process.cwd()),
);

export async function readHookInput() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

/** Path of the edited file relative to the project, with forward slashes. null if outside the project. */
export function projectRelative(filePath) {
  if (!filePath) return null;
  const rel = path.relative(projectDir, path.resolve(toNativePath(filePath)));
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join("/");
}

/** Run a Node CLI that lives in node_modules (no shell, works the same on Windows and Unix). */
export function runNodeBin(binPath, args) {
  return spawnSync(process.execPath, [path.join(projectDir, binPath), ...args], {
    cwd: projectDir,
    encoding: "utf8",
  });
}
