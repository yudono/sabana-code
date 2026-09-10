// ─── Terminal tool — ported from sabana-dev tools/built-in/tools.ts (shell) ───
// Runs through sabana-sandbox (src/sabana-sandbox.ts): double filter —
// user approval (y/a/n) + static policy + workspace jail. `rm -rf /`,
// sudo, curl|sh, and out-of-workspace paths are ALWAYS blocked (cannot be approved).
import type { ToolDefinition } from "./types.js";
import { safePath } from "./sandbox.js";
import { runSandboxed } from "../sabana-sandbox.js";

export const shellTool: ToolDefinition = {
  name: "shell",
  description:
    "Jalankan perintah shell di workspace via sabana-sandbox (kurungan workspace + blocklist). Mengembalikan exitCode, stdout, stderr.",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "Perintah shell" },
      cwd: { type: "string", description: "Direktori kerja relatif (default root)" },
      timeout: { type: "number", description: "Timeout ms (default 120000)" },
      maxOutputLines: { type: "number" },
    },
    required: ["command"],
  },
  permissions: { requiresPermission: true },
  timeout: 180_000,
  riskLevel: "moderate",
};

export function shellHandler(workspaceDir: string) {
  return async (args: Record<string, unknown>) => {
    const command = args.command as string;
    const rel = (args.cwd as string) || ".";
    const cwd = safePath(workspaceDir, rel);
    if (!cwd) return { error: "Path escapes workspace", denied: true };
    const timeout = (args.timeout as number) || 120_000;
    const maxLines = (args.maxOutputLines as number) || 200;
    const r = await runSandboxed(command, workspaceDir, { timeoutMs: timeout, cwd: rel });
    if (r.blocked) {
      return {
        error:
          `SANDBOX BLOCKED: ${r.blocked}\n` +
          `The command was not executed at all and cannot be approved. Rewrite it to stay inside the workspace (${workspaceDir}).`,
        blocked: true,
      };
    }
    const lines = r.stdout.split("\n");
    return {
      exitCode: r.exitCode,
      stdout: lines.length > maxLines ? lines.slice(0, maxLines).join("\n") + `\n... (${lines.length - maxLines} more)` : r.stdout,
      stderr: r.stderr.slice(0, 10_000),
      durationMs: r.durationMs,
    };
  };
}
