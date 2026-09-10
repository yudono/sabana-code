// ─── Sandbox path guard — direct port from sabana-dev apps/api/src/agents/tools/sandbox.ts ───
import { isAbsolute, relative, resolve } from "node:path";

/** Resolve a user path relative to workspaceDir, reject when escaping the sandbox. */
export function safePath(workspaceDir: string, userPath: string): string | null {
  const stripped = userPath.replace(/^sandbox[\\/]/, "").replace(/^sandbox$/, "");
  const abs = isAbsolute(stripped) ? resolve(stripped) : resolve(workspaceDir, stripped);
  const rel = relative(workspaceDir, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return abs;
}
