// ─── Tool executor — diadaptasi dari sabana-dev apps/api/src/agents/tools/executor.ts ───
import type { ToolCall, ToolResult } from "./types.js";
import type { ToolRegistry } from "./registry.js";
import { permissionKey, type PermissionEngine } from "../utils/permissions.js";

export type ToolHandler = (
  args: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<unknown>;

const BLOCKED_SHELL = [
  /\bnpm\s+run\s+dev\b/,
  /\bnpx\s+vite\b/,
  /\bnext\s+dev\b/,
  /\bsleep\s+\d/,
  /\bwhile\s+true\b/,
  /&\s*$/,
];

export class ToolExecutor {
  private handlers = new Map<string, ToolHandler>();
  constructor(
    private registry: ToolRegistry,
    private permissions: PermissionEngine,
  ) {}

  registerHandler(name: string, fn: ToolHandler): void {
    this.handlers.set(name, fn);
  }

  async execute(call: ToolCall, signal?: AbortSignal): Promise<ToolResult> {
    const start = Date.now();
    const fail = (output: unknown, status: ToolResult["status"] = "error"): ToolResult => ({
      toolCallId: call.id,
      status,
      output,
      durationMs: Date.now() - start,
    });

    const tool = this.registry.get(call.name);
    if (!tool) return fail({ error: `Unknown tool: ${call.name}` });

    const v = this.registry.validate(call.name, call.args);
    if (!v.valid) return fail({ error: v.error });

    const command = call.name === "shell" ? (call.args.command as string) : undefined;
    const decision = await this.permissions.check(call.name, call.args, tool.riskLevel, command, signal);
    if (decision === "deny") {
      // Sebutkan kunci izinnya agar user/LLM paham: tolak berlaku per session.
      // Jangan di-retry — model harus ganti cara atau minta user (session baru me-reset).
      const { key } = permissionKey(call.name, call.args, command);
      return fail({
        error:
          `Permission denied: ${call.name}${command ? ` (${command})` : ""} [${key} ditolak untuk session ini — ` +
          `JANGAN ulangi perintah serupa; lanjutkan dengan cara lain atau minta user me-reset via session baru]`,
      });
    }

    if (call.name === "shell" && typeof call.args.command === "string") {
      for (const re of BLOCKED_SHELL) {
        if (re.test(call.args.command)) {
          return fail({
            error:
              `BLOCKED: perintah akan menggantung agent loop (dev server / sleep / background). ` +
              `Command: ${call.args.command}\n` +
              `Tulis file saja dan berhenti — user yang akan menjalankan server sendiri.`,
          });
        }
      }
    }

    const handler = this.handlers.get(call.name);
    if (!handler) return fail({ error: `No handler for tool: ${call.name}` });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), tool.timeout);
    if (signal) signal.addEventListener("abort", () => controller.abort(), { once: true });
    try {
      const output = await handler(call.args, controller.signal);
      const str = typeof output === "string" ? output : JSON.stringify(output);
      if (str.length > 50_000) {
        return {
          toolCallId: call.id,
          status: "success",
          output: str.slice(0, 50_000) + "\n... [truncated]",
          durationMs: Date.now() - start,
        };
      }
      return { toolCallId: call.id, status: "success", output, durationMs: Date.now() - start };
    } catch (e) {
      const err = e as { name?: string; message?: string };
      if (err.name === "AbortError") return fail({ error: `Tool ${call.name} timed out` }, "timeout");
      return fail({ error: err.message || "Unknown error" });
    } finally {
      clearTimeout(timer);
    }
  }
}
