// Shared helpers for the Claude Code hooks in this folder.
// Hooks receive a JSON payload on stdin and talk back through exit codes / stdout JSON.
import { spawnSync } from "node:child_process";
import path from "node:path";

/** On Windows, Git Bash style paths (/c/Users/...) → C:/Users/... so Node can resolve them. */
function toNativePath(p) {
  if (process.platform === "win32") {
    const m = /^\/([a-zA-Z])(\/.*)?$/.exec(p);
    if (m) return `${m[1].toUpperCase()}:${m[2] ?? "/"}`;
  }
  return p;
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
