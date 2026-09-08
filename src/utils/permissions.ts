// ─── Permission engine — port ringkas dari sabana-dev agents/permissions/engine.ts ───
import * as readline from "node:readline";
import type { PermissionDecision, RiskLevel } from "../tools/types.js";

export class PermissionEngine {
  private allowAll = new Set<string>();
  private denied = new Set<string>();
  constructor(private autoApprove = false) {
    if (!process.stdin.isTTY) this.autoApprove = true;
  }

  async check(
    tool: string,
    args: Record<string, unknown>,
    risk: RiskLevel,
    command?: string,
  ): Promise<PermissionDecision> {
    if (risk === "safe") return "allow";
    const key = command ? `shell:${command.trim().split(/\s+/)[0]}` : `${tool}:${(args.path as string) || JSON.stringify(args).slice(0, 80)}`;
    if (this.allowAll.has(key) || this.allowAll.has("*") || this.allowAll.has("shell:*")) return "allow";
    if (this.denied.has(key)) return "deny";
    if (this.autoApprove) return "allow";
    return this.prompt(tool, args, command, key);
  }

  private prompt(tool: string, args: Record<string, unknown>, command: string | undefined, key: string): Promise<PermissionDecision> {
    const desc = command ? `shell: ${command}` : `${tool}(${Object.entries(args).map(([k, v]) => `${k}=${String(v).slice(0, 60)}`).join(", ")})`;
    process.stderr.write(`\n\x1b[33m⚡ PERMISSION\x1b[0m ${desc}\n  [1] Allow  [2] Allow all  [3] Deny (default Allow 10s)\n  > `);
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        rl.close();
        resolve("allow");
      }, 10_000);
      rl.question("", (ans) => {
        clearTimeout(t);
        rl.close();
        const c = ans.trim();
        if (c === "2") {
          this.allowAll.add(key);
          resolve("allow");
        } else if (c === "3") {
          this.denied.add(key);
          resolve("deny");
        } else resolve("allow");
      });
    });
  }
}
