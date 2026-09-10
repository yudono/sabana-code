// ─── Single-agent loop — disederhanakan dari sabana-dev apps/api/src/agents/core/orchestrator.ts ───
// SATU agent + tool-calling loop (seperti claude-code / opencode):
//   LLM decides → tools execute → hasil tools masuk konteks → ulangi sampai selesai.
// Mendukung multi-turn dalam satu session (chatTurn) + event stream untuk TUI,
// dan trim konteks mengikuti context-window model yang dipakai.
import type { ModelMessage } from "./llm/types.js";
import { createProvider, type LLMProvider } from "./llm/provider.js";
import { ToolRegistry } from "./tools/registry.js";
import { ToolExecutor } from "./tools/executor.js";
import {
  deleteFileHandler,
  deleteFileTool,
  globHandler,
  globTool,
  grepHandler,
  grepTool,
  listDirectoryHandler,
  listDirectoryTool,
  modifiedFileHandler,
  modifiedFileTool,
  readFileHandler,
  readFileTool,
  writeFileHandler,
  writeFileTool,
} from "./tools/filesystem.js";
import { shellHandler, shellTool } from "./tools/terminal.js";
import { webFetchHandler, webFetchTool, webSearchHandler, webSearchTool } from "./tools/web.js";
import { skillHandler, skillTool, buildSkillsContext } from "./skills.js";
import { todoListHandler, todoListTool, todoWriteHandler, todoWriteTool } from "./todo.js";
import { McpManager } from "./mcp.js";
import type { ToolDefinition } from "./tools/types.js";
import type { ToolHandler } from "./tools/executor.js";
import { PermissionEngine, type ApprovalState, type PermissionAsker } from "./utils/permissions.js";
import { LoopDetector } from "./utils/loop.js";
import { RateLimiter } from "./utils/ratelimit.js";
import { redactSecrets, runGuardrails } from "./utils/guardrails.js";
import { summarizeCall, summarizeResult } from "./tools/summary.js";
import { SYSTEM_PROMPT, buildInitialContext } from "./prompt.js";
import { ensureFits, contextUsage } from "./session/context.js";
import { AUTO_COMPACT_PCT, applyCompactSummary, buildCompactPrompt } from "./session/compact.js";
import { dim, err, log, ok, warn } from "./utils/logger.js";

export interface AgentConfig {
  model: string;
  provider: string;
  apiKey: string;
  baseUrl: string;
  maxTokens: number;
  maxSteps: number;
  autoApprove: boolean;
  /** Batas request LLM per menit (default 60; <=0 = tanpa batas). */
  rpm?: number;
  /** Keputusan izin awal (dari session tersimpan) + penanya izin interaktif. */
  approvals?: ApprovalState;
  askPermission?: PermissionAsker;
  onEvent?: AgentEventHandler;
}

export interface AgentResult {
  success: boolean;
  steps: number;
  filesModified: string[];
  timeline: string[];
  finalText: string;
}

export interface ToolCallInfo {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export type AgentEvent =
  | { type: "step"; step: number; maxSteps: number }
  | { type: "text"; delta: string }
  | { type: "text_end" }
  | { type: "reasoning"; delta: string }
  | { type: "reasoning_end" }
  | { type: "tool_start"; call: ToolCallInfo }
  | { type: "tool_end"; call: ToolCallInfo; status: string; ms: number; bytes: number; summary?: string; output?: unknown }
  | { type: "warn"; message: string }
  | { type: "error"; message: string }
  | { type: "done"; steps: number; files: number }
  | { type: "trimmed"; count: number }
  | { type: "compacted"; dropped: number };

export type AgentEventHandler = (ev: AgentEvent) => void;

/** Handler default: perilaku CLI lama (tulis ke stdout/stderr). */
function defaultHandler(ev: AgentEvent): void {
  switch (ev.type) {
    case "step":
      dim(`\n── step ${ev.step}/${ev.maxSteps} ──`);
      break;
    case "text":
      process.stdout.write(ev.delta);
      break;
    case "text_end":
      process.stdout.write("\n");
      break;
    case "tool_start":
      dim(`$ ${summarizeCall(ev.call.name, ev.call.args)}`);
      break;
    case "tool_end":
      dim(`  → ${ev.status}${ev.summary ? ` ${ev.summary}` : ""} (${ev.ms}ms)`);
      break;
    case "warn":
      warn(ev.message);
      break;
    case "error":
      err(ev.message);
      break;
    case "done":
      ok(`selesai dalam ${ev.steps} step, ${ev.files} file diubah.`);
      break;
    case "trimmed":
      warn(`Konteks dipangkas (${ev.count} pesan lama dibuang) agar muat di window model.`);
      break;
    case "compacted":
      ok(`Konteks dipadatkan otomatis (${ev.dropped} pesan → ringkasan).`);
      break;
  }
}

export class SingleAgent {
  private provider: LLMProvider;
  private registry = new ToolRegistry();
  private executor: ToolExecutor;
  private permissions: PermissionEngine;
  private loops = new LoopDetector();
  private limiter: RateLimiter;
  private filesModified: string[] = [];
  private timeline: string[] = [];
  private abort: AbortController = new AbortController();
  private emit: AgentEventHandler;
  private mcp = new McpManager();
  private mcpLoaded = false;

  constructor(private config: AgentConfig) {
    this.provider = createProvider(config.provider, {
      name: config.provider,
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      model: config.model,
      maxTokens: config.maxTokens,
    });
    this.emit = config.onEvent || defaultHandler;
    this.limiter = new RateLimiter(config.rpm ?? 60);
    this.permissions = new PermissionEngine(config.autoApprove, {
      initial: config.approvals,
      asker: config.askPermission,
    });
    this.executor = new ToolExecutor(this.registry, this.permissions);
    for (const t of [
      readFileTool,
      writeFileTool,
      modifiedFileTool,
      deleteFileTool,
      listDirectoryTool,
      globTool,
      grepTool,
      shellTool,
      webSearchTool,
      webFetchTool,
      skillTool,
      todoWriteTool,
      todoListTool,
    ]) {
      this.registry.register(t);
    }
  }

  /** Daftarkan tool dinamis (MCP). Idempoten per nama. */
  registerDynamicTool(def: ToolDefinition, handler: ToolHandler): void {
    this.registry.register(def);
    this.executor.registerHandler(def.name, handler);
  }

  /** Muat tools MCP (sekali per instance). Gagal → warn, agent tetap jalan. */
  async ensureMcpLoaded(): Promise<void> {
    if (this.mcpLoaded) return;
    this.mcpLoaded = true;
    try {
      const { tools, errors } = await this.mcp.ensureLoaded();
      for (const def of tools) {
        const handler = this.mcp.handlerFor(def.name);
        if (handler) this.registerDynamicTool(def, handler);
      }
      if (tools.length > 0) this.timeline.push(`mcp: +${tools.length} tools`);
      for (const e of errors) this.emit({ type: "warn", message: `MCP: ${e}` });
    } catch (e) {
      this.emit({ type: "warn", message: `MCP gagal dimuat: ${(e as Error).message}` });
    }
  }

  /** Status server MCP (untuk /mcp di TUI). */
  mcpStatus() {
    return this.mcp.status();
  }

  async reloadMcp(): Promise<{ added: number; errors: string[] }> {
    const { tools, errors } = await this.mcp.reload();
    for (const def of tools) {
      const handler = this.mcp.handlerFor(def.name);
      if (handler) this.registerDynamicTool(def, handler);
    }
    return { added: tools.length, errors };
  }

  /** Ganti model/provider mid-session (bikin provider baru, riwayat tetap). */
  setModelProvider(model: string, provider: string, apiKey: string, baseUrl: string): void {
    this.config.model = model;
    this.config.provider = provider;
    this.config.apiKey = apiKey;
    this.config.baseUrl = baseUrl;
    this.provider = createProvider(provider, {
      name: provider,
      apiKey,
      baseUrl,
      model,
      maxTokens: this.config.maxTokens,
    });
  }

  abortRun(): void {
    this.abort.abort();
  }

  /** Daftar tools untuk perintah /tools di TUI. */
  listTools(): Array<{ name: string; description: string }> {
    return this.registry.getAll().map((t) => ({ name: t.name, description: t.description }));
  }

  /**
   * Padatkan riwayat via LLM: pesan lama → satu ringkasan, N pesan terakhir dipertahankan.
   * Dipakai manual (/compact) dan otomatis saat >80% window.
   */
  async compactHistory(messages: ModelMessage[]): Promise<{
    ok: boolean;
    messages: ModelMessage[];
    summary: string;
    dropped: number;
    error?: string;
  }> {
    if (messages.length <= 4) {
      return { ok: false, messages, summary: "", dropped: 0, error: "Riwayat terlalu pendek untuk dipadatkan." };
    }
    let summary = "";
    try {
      for await (const ev of this.provider.generate({
        model: this.config.model,
        messages: [{ role: "user", content: buildCompactPrompt(messages) }],
        maxTokens: Math.min(2048, this.config.maxTokens),
        signal: this.abort.signal,
      })) {
        if (ev.type === "text_delta") summary += ev.text;
        else if (ev.type === "error") {
          return { ok: false, messages, summary: "", dropped: 0, error: ev.message };
        }
      }
    } catch (e) {
      return { ok: false, messages, summary: "", dropped: 0, error: (e as Error).message };
    }
    summary = summary.trim();
    if (!summary) {
      return { ok: false, messages, summary: "", dropped: 0, error: "Ringkasan kosong." };
    }
    const applied = applyCompactSummary(messages, summary);
    return { ok: true, messages: applied.messages, summary, dropped: applied.dropped };
  }

  /** Keputusan izin saat ini (untuk disimpan ke session). */
  getApprovals(): ApprovalState {
    return this.permissions.getState();
  }

  /** Gabungkan keputusan izin (mis. dari sub-agent) ke engine ini. */
  mergeApprovals(s: ApprovalState): void {
    const cur = this.permissions.getState();
    this.permissions.setState({
      allowAll: [...new Set([...cur.allowAll, ...(s.allowAll || [])])],
      denied: [...new Set([...cur.denied, ...(s.denied || [])])],
    });
  }

  /** One-shot (dipakai CLI klasik + benchmark): session baru sekali jalan. */
  async run(userPrompt: string, workspaceDir: string): Promise<AgentResult> {
    const { result } = await this.chatTurn(userPrompt, workspaceDir, []);
    return result;
  }

  /**
   * Satu turn dalam session panjang. history = pesan LLM sejauh ini
   * (diawali system message). Mengembalikan history terbaru + hasil turn.
   */
  async chatTurn(
    userPrompt: string,
    workspaceDir: string,
    history: ModelMessage[],
  ): Promise<{ messages: ModelMessage[]; result: AgentResult }> {
    const fail = (finalText: string): { messages: ModelMessage[]; result: AgentResult } => ({
      messages: history,
      result: { success: false, steps: 0, filesModified: [...this.filesModified], timeline: [...this.timeline], finalText },
    });

    const guard = runGuardrails(userPrompt);
    if (!guard.passed) {
      this.emit({ type: "error", message: `Blocked: ${guard.reason} [${guard.code}]` });
      return fail(guard.reason || "blocked");
    }

    this.abort = new AbortController();

    // Handlers terikat workspace (sandbox) — pola sabana-dev registerHandlers()
    this.executor.registerHandler("read_file", readFileHandler(workspaceDir));
    this.executor.registerHandler("write_file", writeFileHandler(workspaceDir));
    this.executor.registerHandler("modified_file", modifiedFileHandler(workspaceDir));
    this.executor.registerHandler("delete_file", deleteFileHandler(workspaceDir));
    this.executor.registerHandler("list_directory", listDirectoryHandler(workspaceDir));
    this.executor.registerHandler("glob", globHandler(workspaceDir));
    this.executor.registerHandler("grep", grepHandler(workspaceDir));
    this.executor.registerHandler("shell", shellHandler(workspaceDir));
    this.executor.registerHandler("web_search", webSearchHandler());
    this.executor.registerHandler("web_fetch", webFetchHandler());
    this.executor.registerHandler("skill", skillHandler(workspaceDir));
    this.executor.registerHandler("todo_write", todoWriteHandler(workspaceDir));
    this.executor.registerHandler("todo_list", todoListHandler(workspaceDir));

    // Tools MCP (lazy, sekali per instance; gagal → warn, lanjut tanpa MCP).
    await this.ensureMcpLoaded();

    let messages: ModelMessage[];
    if (history.length === 0) {
      const tree = await this.snapshotTree(workspaceDir);
      const skillsCtx = buildSkillsContext(workspaceDir);
      messages = [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: buildInitialContext(userPrompt, workspaceDir, tree) + (skillsCtx ? `\n\n${skillsCtx}` : ""),
        },
      ];
      log(`workspace: ${workspaceDir}`);
      log(`model: ${this.config.model} (${this.config.provider})`);
    } else {
      messages = [...history, { role: "user", content: userPrompt }];
    }

    const fit = ensureFits(messages, this.config.model, this.config.provider);
    messages = fit.messages;
    if (fit.trimmed > 0) this.emit({ type: "trimmed", count: fit.trimmed });

    let finalText = "";
    let steps = 0;
    let compactedThisTurn = false;

    while (steps < this.config.maxSteps && !this.abort.signal.aborted) {
      steps++;
      this.emit({ type: "step", step: steps, maxSteps: this.config.maxSteps });

      // ── Auto-compact saat menyentuh >80% context window (sekali per turn) ──
      if (!compactedThisTurn && messages.length > 8) {
        const u = contextUsage(messages, this.config.model, this.config.provider);
        if (u.pct > AUTO_COMPACT_PCT) {
          const c = await this.compactHistory(messages);
          compactedThisTurn = true;
          if (c.ok && c.dropped > 0) {
            messages = c.messages;
            this.emit({ type: "compacted", dropped: c.dropped });
          }
        }
      }

      // ── Rate limit: tunggu slot request LLM (batal = berhenti) ──
      try {
        await this.limiter.acquire(this.abort.signal);
      } catch {
        break;
      }

      // ── LLM call dengan retry 429/5xx (pola sabana-dev orchestrator) ──
      let text = "";
      let reasoning = "";
      let toolCalls: ToolCallInfo[] = [];
      let lastError = "";
      for (let attempt = 0; attempt < 3; attempt++) {
        text = "";
        reasoning = "";
        toolCalls = [];
        lastError = "";
        try {
          for await (const ev of this.provider.generate({
            model: this.config.model,
            messages,
            tools: this.registry.toModelTools(),
            maxTokens: this.config.maxTokens,
            signal: this.abort.signal,
          })) {
            if (ev.type === "text_delta") {
              text += ev.text;
              this.emit({ type: "text", delta: ev.text });
            } else if (ev.type === "reasoning_delta") {
              reasoning += ev.text;
              this.emit({ type: "reasoning", delta: ev.text });
            } else if (ev.type === "tool_call") {
              toolCalls.push({ id: ev.id, name: ev.name, args: ev.args });
            } else if (ev.type === "error") {
              lastError = ev.message;
            }
          }
        } catch (e) {
          lastError = (e as Error).message;
        }
        if (!lastError) break;
        if (!/429|rate.?limit|quota|5\d\d|timeout|network/i.test(lastError)) break;
        const wait = 10_000 * 2 ** attempt;
        this.emit({ type: "warn", message: `LLM ${lastError.slice(0, 120)} — retry ${wait / 1000}s...` });
        await new Promise((r) => setTimeout(r, wait));
      }
      if (text) this.emit({ type: "text_end" });
      if (reasoning) this.emit({ type: "reasoning_end" });
      if (lastError && toolCalls.length === 0 && !text) {
        this.emit({ type: "error", message: `LLM error: ${lastError}` });
        messages.push({
          role: "user",
          content: `Tool error dari LLM: ${lastError}. Coba lanjutkan tanpa mengulang hal yang sama.`,
        });
        continue;
      }

      messages.push({
        role: "assistant",
        content: text || "",
        tool_calls: toolCalls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: { name: tc.name, arguments: JSON.stringify(tc.args) },
        })),
      });
      this.timeline.push(`step${steps}: text=${text.length}c tools=[${toolCalls.map((t) => t.name).join(",")}]`);

      // ── Tidak ada tool call → selesai (final answer) ──
      if (toolCalls.length === 0) {
        finalText = text;
        if (text.trim()) {
          this.emit({ type: "done", steps, files: this.filesModified.length });
          return {
            messages,
            result: { success: true, steps, filesModified: [...this.filesModified], timeline: [...this.timeline], finalText },
          };
        }
        messages.push({ role: "user", content: "Kamu belum melakukan apa-apa. Pakai tools untuk mengerjakan request, lalu jawab ringkas." });
        continue;
      }

      // ── Eksekusi tool calls berurutan ──
      for (const tc of toolCalls) {
        if (this.abort.signal.aborted) break;
        const looped = this.loops.record(tc.name, tc.args);
        if (looped.detected) {
          this.emit({ type: "warn", message: `loop: ${looped.reason}` });
          messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: JSON.stringify({ error: `LOOP BLOCKED: ${looped.reason}` }),
          });
          this.loops.resetProgress();
          messages.push({
            role: "user",
            content: `LOOP TERDETEKSI: ${looped.reason}. Berhenti memanggil read-only tools. Panggil write_file/modified_file SEKARANG.`,
          });
          break;
        }

        this.emit({ type: "tool_start", call: tc });
        const result = await this.executor.execute(tc, this.abort.signal);
        const outStr = typeof result.output === "string" ? result.output : JSON.stringify(result.output);
        const summary =
          summarizeResult(tc.name, { status: result.status, output: result.output, durationMs: result.durationMs }) ??
          undefined;
        this.emit({ type: "tool_end", call: tc, status: result.status, ms: result.durationMs, bytes: outStr.length, summary, output: result.output });
        this.timeline.push(`${tc.name} → ${result.status}`);

        if (result.status === "success" && (tc.name === "write_file" || tc.name === "modified_file")) {
          const p = tc.args.path as string;
          if (p && !this.filesModified.includes(p)) this.filesModified.push(p);
          this.loops.resetProgress();
        }
        if (result.status === "success" && tc.name === "delete_file") {
          const p = tc.args.path as string;
          if (p) this.filesModified = this.filesModified.filter((f) => f !== p);
          this.loops.resetProgress();
        }
        if (result.status === "error") {
          const msg = (result.output as { error?: string })?.error || outStr;
          const eLoop = this.loops.recordError(msg);
          if (eLoop.detected) {
            messages.push({ role: "tool", tool_call_id: tc.id, content: redactSecrets(JSON.stringify(result.output)).slice(0, 20_000) });
            messages.push({ role: "user", content: `${eLoop.reason} Coba pendekatan BERBEDA, jangan ulangi perintah yang sama.` });
            break;
          }
        }
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: redactSecrets(outStr).slice(0, 20_000),
        });
      }

      // Trim mengikuti window model (ganti batas kaku 32 pesan)
      const refit = ensureFits(messages, this.config.model, this.config.provider);
      messages = refit.messages;
      if (refit.trimmed > 0) this.emit({ type: "trimmed", count: refit.trimmed });
    }

    return {
      messages,
      result: {
        success: this.abort.signal.aborted ? false : this.filesModified.length > 0 || !!finalText,
        steps,
        filesModified: [...this.filesModified],
        timeline: [...this.timeline],
        finalText,
      },
    };
  }

  private async snapshotTree(workspaceDir: string): Promise<string> {
    try {
      const out = (await listDirectoryHandler(workspaceDir)({ maxDepth: 2 })) as { listing?: string };
      return out.listing || "";
    } catch {
      return "";
    }
  }
}
