// ─── Sandbox path guard — port langsung dari sabana-dev apps/api/src/agents/tools/sandbox.ts ───
import { isAbsolute, relative, resolve } from "node:path";

/** Resolve path user relatif ke workspaceDir, tolak bila keluar sandbox. */
export function safePath(workspaceDir: string, userPath: string): string | null {
  const stripped = userPath.replace(/^sandbox[\\/]/, "").replace(/^sandbox$/, "");
  const abs = isAbsolute(stripped) ? resolve(stripped) : resolve(workspaceDir, stripped);
  const rel = relative(workspaceDir, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return abs;
}
