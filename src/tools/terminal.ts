// ─── Terminal tool — port dari sabana-dev tools/built-in/tools.ts (shell) ───
import { execSync } from "node:child_process";
import type { ToolDefinition } from "./types.js";
import { safePath } from "./sandbox.js";

export const shellTool: ToolDefinition = {
  name: "shell",
  description: "Jalankan perintah shell di workspace. Mengembalikan exitCode, stdout, stderr.",
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
    let command = args.command as string;
    command = command
      .replace(/^\s*cd\s+sandbox\s*(?:&&|;)?\s*/, "")
      .replace(/\bsandbox\//g, "./");
    const cwd = safePath(workspaceDir, (args.cwd as string) || ".");
    if (!cwd) return { error: "Path escapes workspace", denied: true };
    const timeout = (args.timeout as number) || 120_000;
    const maxLines = (args.maxOutputLines as number) || 200;
    const start = Date.now();
    try {
      const out = execSync(command, {
        cwd,
        encoding: "utf-8",
        timeout,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, CI: "true", npm_config_yes: "true", HOME: process.env.HOME },
      });
      const lines = out.split("\n");
      return {
        exitCode: 0,
        stdout: lines.length > maxLines ? lines.slice(0, maxLines).join("\n") + `\n... (${lines.length - maxLines} more)` : out,
        stderr: "",
        durationMs: Date.now() - start,
      };
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string; message?: string };
      return {
        exitCode: err.status ?? 1,
        stdout: (err.stdout || "").slice(0, 10_000),
        stderr: (err.stderr || err.message || "").slice(0, 10_000),
        durationMs: Date.now() - start,
      };
    }
  };
}
