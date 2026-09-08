// ─── Permission engine — port ringkas dari sabana-dev agents/permissions/engine.ts ───
// Keputusan "allow all"/"deny" disimpan PER SESSION (bukan global): session baru
// berarti user mengulang persetujuan. "Allow once" tidak disimpan.
import * as readline from "node:readline";
import type { PermissionDecision, RiskLevel } from "../tools/types.js";
import { isSafeShellCommand } from "../tools/shellPolicy.js";

export interface ApprovalState {
  allowAll: string[];
  denied: string[];
}

/** once = izinkan eksekusi ini saja; all = ingat untuk yang serupa; deny/cancel = tolak. */
export type AskerVerdict = "once" | "all" | "deny" | "cancel";

export interface PermissionRequest {
  tool: string;
  args: Record<string, unknown>;
  command?: string;
  key: string;
  /** Perintah dasar utk shell (mis. "npm"), undefined utk tool file. */
  base?: string;
}

export type PermissionAsker = (req: PermissionRequest) => Promise<AskerVerdict>;

/** Kunci keputusan: shell dikelompokkan per perintah dasar, tool file per path. */
export function permissionKey(
  tool: string,
  args: Record<string, unknown>,
  command?: string,
): { key: string; base?: string } {
  if (command) {
    const base = command.trim().split(/\s+/)[0] || "shell";
    return { key: `shell:${base}`, base };
  }
  const p = args.path;
  if (typeof p === "string" && p) return { key: `${tool}:${p}` };
  return { key: `${tool}:${JSON.stringify(args).slice(0, 80)}` };
}

export function emptyApprovals(): ApprovalState {
  return { allowAll: [], denied: [] };
}

export class PermissionEngine {
  private allowAll = new Set<string>();
  private denied = new Set<string>();
  constructor(
    private autoApprove = false,
    private opts?: { initial?: ApprovalState; asker?: PermissionAsker },
  ) {
    if (opts?.initial) this.setState(opts.initial);
  }

  getState(): ApprovalState {
    return { allowAll: [...this.allowAll], denied: [...this.denied] };
  }

  setState(s: ApprovalState): void {
    this.allowAll = new Set(s.allowAll || []);
    this.denied = new Set(s.denied || []);
  }

  async check(
    tool: string,
    args: Record<string, unknown>,
    risk: RiskLevel,
    command?: string,
    signal?: AbortSignal,
  ): Promise<PermissionDecision> {
    if (risk === "safe") return "allow";
    // Shell read-only (ls, cd, cat, ...) bebas izin; sisanya tetap ditanya.
    if (tool === "shell" && command && isSafeShellCommand(command)) return "allow";
    const { key, base } = permissionKey(tool, args, command);
    if (this.allowAll.has(key) || this.allowAll.has("*") || this.allowAll.has("shell:*")) return "allow";
    if (this.denied.has(key)) return "deny";
    if (this.autoApprove) return "allow";
    if (signal?.aborted) return "deny";
    if (this.opts?.asker) return this.askViaUi(key, { tool, args, command, key, base }, signal);
    // Headless (benchmark/test/pipe): jangan gantung menunggu stdin.
    if (!process.stdin.isTTY) return "allow";
    return this.prompt(tool, args, command, key);
  }

  private async askViaUi(
    key: string,
    req: PermissionRequest,
    signal?: AbortSignal,
  ): Promise<PermissionDecision> {
    const verdict = await new Promise<AskerVerdict>((resolve) => {
      if (signal?.aborted) return resolve("cancel");
      const onAbort = () => resolve("cancel");
      signal?.addEventListener("abort", onAbort, { once: true });
      this.opts!.asker!(req).then(
        (v) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(v);
        },
        () => {
          signal?.removeEventListener("abort", onAbort);
          resolve("cancel");
        },
      );
    });
    // "cancel" (mis. Ctrl+C) ditolak TANPA disimpan — bukan keputusan user.
    if (verdict === "all") {
      this.allowAll.add(key);
      return "allow";
    }
    if (verdict === "deny") {
      this.denied.add(key);
      return "deny";
    }
    if (verdict === "once") return "allow";
    return "deny";
  }

  private prompt(tool: string, args: Record<string, unknown>, command: string | undefined, key: string): Promise<PermissionDecision> {
    const desc = command ? `shell: ${command}` : `${tool}(${Object.entries(args)
      .map(([k, v]) => `${k}=${String(v).substring(0, 60)}`)
      .join(", ")})`;
    process.stderr.write(`\n\x1b[33m⚡ PERMISSION\x1b[0m ${desc}\n  [1] Allow  [2] Allow all  [3] Deny (default Allow 10s)\n  > `);
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        rl.close();
        resolve("allow");
      }, 10000);
      rl.question("", (answer) => {
        clearTimeout(timeout);
        rl.close();
        const choice = answer.trim();
        if (choice === "2") {
          this.allowAll.add(key);
          resolve("allow");
        } else if (choice === "3") {
          this.denied.add(key);
          resolve("deny");
        } else resolve("allow");
      });
    });
  }
}
