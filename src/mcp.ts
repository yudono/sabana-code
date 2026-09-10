// ─── MCP client (Model Context Protocol, stdio NDJSON) ala OpenCode/Claude Code ───
// Konfig: ~/sabana-code/mcp.json
//   { "servers": { "nama": { "command": "npx", "args": ["-y", "..."], "env": {...} } } }
// Tiap server yang jalan menyumbang tools `mcp__<server>__<tool>` ke agent.
// Gagal start / timeout → server ditandai down, agent tetap jalan tanpa tools-nya.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { ensureHome, mcpPath } from "./home.js";
import type { ToolDefinition } from "./tools/types.js";
import type { ToolHandler } from "./tools/executor.js";

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface McpConfigFile {
  servers: Record<string, McpServerConfig>;
}

export const MCP_TOOL_PREFIX = "mcp__";
const DEFAULT_TIMEOUT_MS = 15_000;

/** mcp__<server>__<tool> — server/tool hanya [a-z0-9_-] agar aman jadi nama tool. */
export function mcpToolName(server: string, tool: string): string {
  const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").slice(0, 40) || "x";
  return `${MCP_TOOL_PREFIX}${clean(server)}__${clean(tool)}`;
}

export function parseMcpToolName(name: string): { server: string; tool: string } | null {
  if (!name.startsWith(MCP_TOOL_PREFIX)) return null;
  const rest = name.slice(MCP_TOOL_PREFIX.length);
  const idx = rest.indexOf("__");
  if (idx <= 0 || idx === rest.length - 2) return null;
  return { server: rest.slice(0, idx), tool: rest.slice(idx + 2) };
}

export function loadMcpConfig(): McpConfigFile {
  ensureHome();
  try {
    const raw = JSON.parse(readFileSync(mcpPath(), "utf-8")) as Partial<McpConfigFile>;
    const servers: Record<string, McpServerConfig> = {};
    for (const [k, v] of Object.entries(raw.servers || {})) {
      if (v && typeof v.command === "string" && v.command.trim()) {
        servers[k] = {
          command: v.command.trim(),
          args: Array.isArray(v.args) ? v.args.filter((a) => typeof a === "string") : [],
          env: v.env && typeof v.env === "object" ? v.env : {},
          timeoutMs: typeof v.timeoutMs === "number" && v.timeoutMs > 0 ? v.timeoutMs : DEFAULT_TIMEOUT_MS,
        };
      }
    }
    return { servers };
  } catch {
    return { servers: {} };
  }
}

export function saveMcpConfig(cfg: McpConfigFile): void {
  ensureHome();
  writeFileSync(mcpPath(), JSON.stringify(cfg, null, 2) + "\n");
}

interface JsonRpcResponse {
  jsonrpc: string;
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

interface McpToolDesc {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

// ─── Jangan tinggalkan server yatim: bunuh semua child saat proses keluar ───
const LIVE_CLIENTS = new Set<McpClient>();
let exitHookInstalled = false;
function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  const killAll = () => {
    for (const c of LIVE_CLIENTS) {
      try {
        c.stop();
      } catch {
        /* abaikan */
      }
    }
  };
  process.once("exit", killAll);
  process.once("SIGINT", () => {
    killAll();
  });
}

/** Satu koneksi stdio ke server MCP (NDJSON: 1 objek JSON per baris). */
export class McpClient {
  private proc: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private buf = "";
  private started = false;

  constructor(
    readonly name: string,
    private cfg: McpServerConfig,
  ) {}

  private get timeoutMs(): number {
    return this.cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async start(): Promise<void> {
    if (this.started) return;
    const proc = spawn(this.cfg.command, this.cfg.args || [], {
      env: { ...process.env, ...(this.cfg.env || {}) },
      stdio: ["pipe", "pipe", "ignore"],
    });
    this.proc = proc;
    proc.stdout?.on("data", (chunk: Buffer) => this.onData(chunk.toString("utf-8")));
    const exitP = new Promise<never>((_, reject) => {
      proc.on("error", (e) => reject(e));
      proc.on("exit", (code) => reject(new Error(`MCP server '${this.name}' exit code ${code}`)));
    });
    // Jangan biarkan proses zombie menggantung test/runner.
    proc.unref?.();
    LIVE_CLIENTS.add(this);
    installExitHook();
    const initP = (async () => {
      await this.request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        clientInfo: { name: "sabana-code", version: "0.1.3" },
      });
      this.notify("notifications/initialized", {});
      this.started = true;
    })();
    await Promise.race([initP, exitP]);
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    const lines = this.buf.split("\n");
    this.buf = lines.pop() || "";
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      try {
        const msg = JSON.parse(t) as JsonRpcResponse;
        if (msg.id === undefined || msg.id === null) continue; // notifikasi server → abaikan
        const p = this.pending.get(Number(msg.id));
        if (!p) continue;
        this.pending.delete(Number(msg.id));
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(msg.error.message || `MCP error ${msg.error.code}`));
        else p.resolve(msg.result);
      } catch {
        /* baris non-JSON (log server) → abaikan */
      }
    }
  }

  private notify(method: string, params: unknown): void {
    try {
      this.proc?.stdin?.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
    } catch {
      /* abaikan */
    }
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (!this.proc?.stdin) return Promise.reject(new Error(`MCP server '${this.name}' tidak jalan`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP '${this.name}' timeout ${this.timeoutMs}ms untuk ${method}`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.proc!.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(e as Error);
      }
    });
  }

  async listTools(): Promise<McpToolDesc[]> {
    const res = (await this.request("tools/list", {})) as { tools?: McpToolDesc[] };
    const tools = Array.isArray(res?.tools) ? res.tools : [];
    return tools.filter((t) => t && typeof t.name === "string" && t.name);
  }

  /** tools/call → teks gabungan (content blocks) agar cocok dengan pipeline redact/trim. */
  async callTool(tool: string, args: Record<string, unknown>): Promise<unknown> {
    const res = (await this.request("tools/call", { name: tool, arguments: args || {} })) as {
      content?: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };
    const blocks = Array.isArray(res?.content) ? res.content : [];
    const text = blocks
      .map((b) => (b && typeof b.text === "string" ? b.text : b ? JSON.stringify(b) : ""))
      .filter(Boolean)
      .join("\n");
    if (res?.isError) return { error: text || `MCP tool ${tool} gagal` };
    return text || res;
  }

  stop(): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`MCP server '${this.name}' dihentikan`));
    }
    this.pending.clear();
    LIVE_CLIENTS.delete(this);
    try {
      this.proc?.kill();
    } catch {
      /* abaikan */
    }
    this.proc = null;
    this.started = false;
  }

  get isStarted(): boolean {
    return this.started;
  }
}

export interface McpServerStatus {
  name: string;
  state: "up" | "down" | "off";
  tools: string[];
  error?: string;
}

/** Manager: mulai server sesuai config, petakan tools MCP → ToolDefinition + handler. */
export class McpManager {
  private clients = new Map<string, McpClient>();
  private toolToServer = new Map<string, { server: string; tool: string; client: McpClient }>();
  private statuses: McpServerStatus[] = [];

  /** Idempoten: server yang sudah up tidak di-start ulang. */
  async ensureLoaded(): Promise<{ tools: ToolDefinition[]; errors: string[] }> {
    const cfg = loadMcpConfig();
    const defs: ToolDefinition[] = [];
    const errors: string[] = [];
    const statuses: McpServerStatus[] = [];
    for (const [name, scfg] of Object.entries(cfg.servers)) {
      let client = this.clients.get(name);
      try {
        if (!client) {
          client = new McpClient(name, scfg);
          this.clients.set(name, client);
        }
        await client.start();
        const tools = await client.listTools();
        const names: string[] = [];
        for (const t of tools) {
          const toolName = mcpToolName(name, t.name);
          names.push(toolName);
          this.toolToServer.set(toolName, { server: name, tool: t.name, client });
          defs.push({
            name: toolName,
            description: `[mcp:${name}] ${t.description || t.name}`.slice(0, 300),
            inputSchema:
              t.inputSchema && typeof t.inputSchema === "object"
                ? t.inputSchema
                : { type: "object", properties: {} },
            permissions: { requiresPermission: false },
            timeout: scfg.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            riskLevel: "moderate",
          });
        }
        statuses.push({ name, state: "up", tools: names });
      } catch (e) {
        errors.push(`${name}: ${(e as Error).message}`);
        statuses.push({ name, state: "down", tools: [], error: (e as Error).message });
      }
    }
    // Server yang dihapus dari config → hentikan.
    for (const [name, client] of this.clients) {
      if (!cfg.servers[name]) {
        client.stop();
        this.clients.delete(name);
      }
    }
    this.statuses = statuses;
    return { tools: defs, errors };
  }

  handlerFor(toolName: string): ToolHandler | null {
    const m = this.toolToServer.get(toolName);
    if (!m) return null;
    return async (args: Record<string, unknown>) => m.client.callTool(m.tool, args);
  }

  status(): McpServerStatus[] {
    return this.statuses;
  }

  async reload(): Promise<{ tools: ToolDefinition[]; errors: string[] }> {
    this.toolToServer.clear();
    return this.ensureLoaded();
  }

  stopAll(): void {
    for (const [, c] of this.clients) c.stop();
    this.clients.clear();
    this.toolToServer.clear();
    this.statuses = [];
  }
}

/** Seed mcp.json contoh (dikomentari) bila belum ada — dokumentasi hidup. */
export function ensureMcpConfigSeed(): void {
  ensureHome();
  if (existsSync(mcpPath())) return;
  saveMcpConfig({
    servers: {
      // Contoh: aktifkan dengan menghapus garis bawah depan.
      // "_fetch": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-fetch"] },
    },
  });
}
