// ─── Single-agent loop — simplified from sabana-dev apps/api/src/agents/core/orchestrator.ts ───
// ONE agent + tool-calling loop (like claude-code / opencode):
//   LLM decides → tools execute → tool results enter context → repeat until done.
// Supports multi-turn in one session (chatTurn) + event stream for the TUI,
// and trims context to the model's context window.
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
  /** LLM requests-per-minute cap (default 60; <=0 = unlimited). */
  rpm?: number;
  /** Per-LLM-call timeout in ms (default 120_000). Hung providers fail fast. */
  llmTimeoutMs?: number;
  /** Injected provider (tests); defaults to createProvider(config.provider, …). */
  providerImpl?: LLMProvider;
  /** Initial permission decisions (from a saved session) + interactive asker. */
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

/** Default handler: legacy CLI behavior (write to stdout/stderr). */
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
      ok(`done in ${ev.steps} steps, ${ev.files} files changed.`);
      break;
    case "trimmed":
      warn(`Context trimmed (${ev.count} old messages dropped) to fit the model window.`);
      break;
    case "compacted":
      ok(`Context auto-compacted (${ev.dropped} messages → summary).`);
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
    this.provider =
      config.providerImpl ??
      createProvider(config.provider, {
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

  /** Register a dynamic tool (MCP). Idempotent per name. */
  registerDynamicTool(def: ToolDefinition, handler: ToolHandler): void {
    this.registry.register(def);
    this.executor.registerHandler(def.name, handler);
  }

  /** Load MCP tools (once per instance). Failure → warn, agent keeps going. */
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

  /** MCP server status (for /mcp in the TUI). */
  mcpStatus() {
    return this.mcp.status();
  }

  /** Per-LLM-call signal: user abort + call timeout. Caller must run cleanup(). */
  private withLlmTimeout(): { signal: AbortSignal; cleanup: () => void } {
    const ms = this.config.llmTimeoutMs ?? 120_000;
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      ctrl.abort(new DOMException(`LLM request timed out after ${ms}ms`, "TimeoutError"));
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      if (!ctrl.signal.aborted) ctrl.abort(this.abort.signal.reason);
    };
    if (this.abort.signal.aborted) onAbort();
    else this.abort.signal.addEventListener("abort", onAbort, { once: true });
    return {
      signal: ctrl.signal,
      cleanup: () => {
        clearTimeout(timer);
        this.abort.signal.removeEventListener("abort", onAbort);
      },
    };
  }
  async reloadMcp(): Promise<{ added: number; errors: string[] }> {
    const { tools, errors } = await this.mcp.reload();
    for (const def of tools) {
      const handler = this.mcp.handlerFor(def.name);
      if (handler) this.registerDynamicTool(def, handler);
    }
    return { added: tools.length, errors };
  }

  /** Switch model/provider mid-session (new provider, history kept). */
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

  /** Tool list for the /tools command in the TUI. */
  listTools(): Array<{ name: string; description: string }> {
    return this.registry.getAll().map((t) => ({ name: t.name, description: t.description }));
  }

  /**
   * Compact history via LLM: old messages → one summary, last N messages kept intact.
   * Used manually (/compact) and automatically past 80% window.
   */
  async compactHistory(messages: ModelMessage[]): Promise<{
    ok: boolean;
    messages: ModelMessage[];
    summary: string;
    dropped: number;
    error?: string;
  }> {
    if (messages.length <= 4) {
      return { ok: false, messages, summary: "", dropped: 0, error: "History too short to compact." };
    }
    let summary = "";
    const { signal, cleanup } = this.withLlmTimeout();
    try {
      for await (const ev of this.provider.generate({
        model: this.config.model,
        messages: [{ role: "user", content: buildCompactPrompt(messages) }],
        maxTokens: Math.min(2048, this.config.maxTokens),
        signal,
      })) {
        if (ev.type === "text_delta") summary += ev.text;
        else if (ev.type === "error") {
          return { ok: false, messages, summary: "", dropped: 0, error: ev.message };
        }
      }
    } catch (e) {
      return { ok: false, messages, summary: "", dropped: 0, error: (e as Error).message };
    } finally {
      cleanup();
    }
    summary = summary.trim();
    if (!summary) {
      return { ok: false, messages, summary: "", dropped: 0, error: "Empty summary." };
    }
    const applied = applyCompactSummary(messages, summary);
    return { ok: true, messages: applied.messages, summary, dropped: applied.dropped };
  }

  /** Current permission decisions (saved into the session). */
  getApprovals(): ApprovalState {
    return this.permissions.getState();
  }

  /** Merge permission decisions (e.g. from a sub-agent) into this engine. */
  mergeApprovals(s: ApprovalState): void {
    const cur = this.permissions.getState();
    this.permissions.setState({
      allowAll: [...new Set([...cur.allowAll, ...(s.allowAll || [])])],
      denied: [...new Set([...cur.denied, ...(s.denied || [])])],
    });
  }

  /** One-shot (used by classic CLI + benchmark): brand-new session, single run. */
  async run(userPrompt: string, workspaceDir: string): Promise<AgentResult> {
    const { result } = await this.chatTurn(userPrompt, workspaceDir, []);
    return result;
  }

  /**
   * One turn in a long session. history = LLM messages so far
   * (starting with the system message). Returns the newest history + turn result.
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

    // Workspace-bound handlers (sandbox) — sabana-dev registerHandlers() pattern
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

    // MCP tools (lazy, once per instance; failure → warn, continue without MCP).
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

      // ── Auto-compact past 80% context window (once per turn) ──
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

      // ── Rate limit: wait for an LLM request slot (abort = stop) ──
      try {
        await this.limiter.acquire(this.abort.signal);
      } catch {
        break;
      }

      // ── LLM call with retry on 429/5xx (sabana-dev orchestrator pattern) ──
      let text = "";
      let reasoning = "";
      let toolCalls: ToolCallInfo[] = [];
      let lastError = "";
      let timedOut = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        text = "";
        reasoning = "";
        toolCalls = [];
        lastError = "";
        timedOut = false;
        const { signal, cleanup } = this.withLlmTimeout();
        try {
          for await (const ev of this.provider.generate({
            model: this.config.model,
            messages,
            tools: this.registry.toModelTools(),
            maxTokens: this.config.maxTokens,
            signal,
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
        } finally {
          cleanup();
        }
        if (!lastError) break;
        // Our own call timeout (not user cancel) → fail fast, never retry:
        // retrying a hung provider just multiplies the hang.
        if (/timed?\s*out/i.test(lastError) && !this.abort.signal.aborted) {
          timedOut = true;
          break;
        }
        if (!/429|rate.?limit|quota|5\d\d|network/i.test(lastError)) break;
        const wait = Math.round(10_000 * 2 ** attempt * (0.8 + Math.random() * 0.4));
        this.emit({ type: "warn", message: `LLM ${lastError.slice(0, 120)} — retrying in ${(wait / 1000).toFixed(1)}s...` });
        await new Promise((r) => setTimeout(r, wait));
      }
      if (text) this.emit({ type: "text_end" });
      if (reasoning) this.emit({ type: "reasoning_end" });
      if (timedOut) {
        const msg = `LLM request timed out (${((this.config.llmTimeoutMs ?? 120_000) / 1000).toFixed(0)}s per call). The provider may be overloaded — try again later or switch provider/model.`;
        this.emit({ type: "error", message: msg });
        return {
          messages,
          result: { success: false, steps, filesModified: [...this.filesModified], timeline: [...this.timeline], finalText: msg },
        };
      }
      if (lastError && toolCalls.length === 0 && !text) {
        this.emit({ type: "error", message: `LLM error: ${lastError}` });
        messages.push({
          role: "user",
          content: `Tool error from LLM: ${lastError}. Keep going without repeating the same thing.`,
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

      // ── No tool calls → done (final answer) ──
      if (toolCalls.length === 0) {
        finalText = text;
        if (text.trim()) {
          this.emit({ type: "done", steps, files: this.filesModified.length });
          return {
            messages,
            result: { success: true, steps, filesModified: [...this.filesModified], timeline: [...this.timeline], finalText },
          };
        }
        messages.push({ role: "user", content: "You have not done anything yet. Use tools to work on the request, then answer concisely." });
        continue;
      }

      // ── Execute tool calls in order ──
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
            content: `LOOP DETECTED: ${looped.reason}. Stop calling read-only tools. Call write_file/modified_file NOW.`,
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
            messages.push({ role: "user", content: `${eLoop.reason} Try a DIFFERENT approach, do not repeat the same command.` });
            break;
          }
        }
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: redactSecrets(outStr).slice(0, 20_000),
        });
      }

      // Trim to the model window (replaces the rigid 32-message cap)
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
