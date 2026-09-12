// ─── TUI coding agent (Ink): chat + input + live tool-calling ───
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdin, useStdout } from "ink";
import TextInput from "ink-text-input";
import { SingleAgent, type AgentEvent } from "../agent.js";
import {
  fetchProviderModels,
  findModel,
  isChatModelId,
  listModels,
  testProviderConnection,
} from "../llm/models.js";
import { credentialSummary, removeCredential, resolveCredentials, saveCredential } from "../auth.js";
import { PROVIDER_PRESETS, SUPPORTED_PROVIDERS } from "../settings.js";
import { listProjects, projectIdFor, projectSessions } from "../projects.js";
import { rpmFromSettings } from "../settings.js";
import { readFileSync, existsSync, statSync } from "node:fs";
import { safePath } from "../tools/sandbox.js";
import { summarizeCall, summarizeResult } from "../tools/summary.js";
import { highlight, type HlSeg } from "./highlight.js";
import { createMouseParser, stripMouseSequences } from "./mouse.js";
import { buildPreviewForTool } from "./preview.js";
import { bannerSegs, hasChatItems } from "./banner.js";
import type { PermissionAsker, PermissionRequest, AskerVerdict } from "../utils/permissions.js";
import { listAgents, loadAgent, runSubAgent } from "../subagents.js";
import { listSkills, loadSkill } from "../skills.js";
import { formatTodos, loadTodos } from "../todo.js";
import { createCheckpoint, listCheckpoints, pairPromptCheckpoints, rewindToCheckpoint } from "../checkpoint.js";
import { contextUsage } from "../session/context.js";
import { flog } from "../utils/filelog.js";
import {
  createSession,
  lastSession,
  listSessions,
  loadSession,
  saveSession,
  type Session,
} from "../session/store.js";
import { helpText, matchModelName, parseCommand, suggestCommands } from "./commands.js";

export type ChatItem =
  | { kind: "user"; id: string; text: string }
  | { kind: "assistant"; text: string }
  | {
      kind: "tool";
      id: string;
      name: string;
      preview: PreviewRef;
      summary: string;
      detail?: string;
      status: "running" | "ok" | "error";
      /** Output mentah terpotong (untuk pratinjau fullscreen). */
      output?: string;
    }
  | { kind: "info"; tone: "dim" | "yellow" | "red" | "green"; text: string };

export interface ClickHit {
  y0: number;
  y1: number;
  kind: "tool" | "user";
  id: string;
  /** User prompt text (kind "user" only) — for the revert menu. */
  text?: string;
}

/** Minimal reference for building previews (without bulky content). */
export interface PreviewRef {
  name: string;
  path?: string;
  command?: string;
  url?: string;
  query?: string;
  pattern?: string;
}

/** Batas simpan output per tool-call (pratinjau). */
export const PREVIEW_STORE_CAP = 20_000;

export function previewRefFor(name: string, args: Record<string, unknown>): PreviewRef {
  const s = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
  return {
    name,
    path: s(args.path),
    command: s(args.command),
    url: s(args.url),
    query: s(args.query),
    pattern: s(args.pattern),
  };
}

function capOutput(output: unknown): string | undefined {
  if (output === undefined) return undefined;
  const s = typeof output === "string" ? output : JSON.stringify(output);
  return s.length > PREVIEW_STORE_CAP ? s.slice(0, PREVIEW_STORE_CAP) + "\n…[dipotong]" : s;
}

export interface TuiOptions {
  initialSession: Session;
  workspaceDir: string;
  maxSteps: number;
  initialPrompt?: string;
}

const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// Langkah scroll chat per tekan tombol panah (baris).
const SCROLL_STEP = 3;

function truncate(s: string, n = 400): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

// ─── Estimated terminal cell widths (bias UP to avoid overflow) ───
function cellWidth(s: string): number {
  let n = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    n += 1;
    if (
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2300 && cp <= 0x27bf) || // simbol teknis/dingbats: hitung 2 (aman)
      (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe4f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1faff) ||
      (cp >= 0x20000 && cp <= 0x3fffd)
    ) {
      n += 1;
    }
  }
  return n;
}

/** Split text into exact terminal rows (greedy char-wrap by cell width). */
export function wrapText(s: string, w: number): string[] {
  const width = Math.max(20, w);
  const out: string[] = [];
  for (const ln of s.split("\n")) {
    if (ln === "") {
      out.push("");
      continue;
    }
    let cur = "";
    let cw = 0;
    for (const ch of ln) {
      const cwch = cellWidth(ch);
      if (cw + cwch > width && cur !== "") {
        out.push(cur);
        cur = "";
        cw = 0;
      }
      cur += ch;
      cw += cwch;
    }
    out.push(cur);
  }
  return out;
}

/** One rendered terminal row: styled segments (+ tool id / user prompt for clicks). */
export interface ChatRow {
  segs: HlSeg[];
  toolId?: string;
  /** Set on user content rows: which prompt (for right-click revert). */
  user?: { id: string; text: string };
}

/** Chat text width (compensates root padding). */
function chatWidth(cols: number): number {
  return Math.max(20, cols - 4);
}

/**
 * Flatten one chat item into exact terminal rows (content + one gap row).
 * Row count IS the height — no estimation, so scroll math never drifts.
 * Flat Claude-style: no boxes, status shown by color/icon.
 */
export function itemRowList(it: ChatItem, cols: number): ChatRow[] {
  const w = chatWidth(cols);
  const rows: ChatRow[] = [];
  switch (it.kind) {
    case "user": {
      const chunks = wrapText(`❯ ${it.text}`, w);
      chunks.forEach((c, i) => {
        rows.push(
          i === 0
            ? { segs: [{ text: "❯ ", color: "green", bold: true }, { text: c.slice(2) }], user: { id: it.id, text: it.text } }
            : { segs: [{ text: c }], user: { id: it.id, text: it.text } },
        );
      });
      break;
    }
    case "assistant":
      for (const c of wrapText(it.text, w)) rows.push({ segs: [{ text: c }] });
      break;
    case "tool": {
      const line = `${it.status === "running" ? "⏳" : it.status === "ok" ? "✓" : "✗"} ${it.summary}${it.detail ? ` · ${it.detail}` : ""}`;
      const paint = (t: string): HlSeg =>
        it.status === "running"
          ? { text: t, color: "yellow" }
          : it.status === "ok"
            ? { text: t, dim: true }
            : { text: t, color: "red" };
      for (const c of wrapText(line, w)) rows.push({ segs: [paint(c)], toolId: it.id });
      break;
    }
    case "info": {
      const paint = (t: string): HlSeg =>
        it.tone === "dim" ? { text: t, dim: true } : { text: t, color: it.tone };
      for (const c of wrapText(it.text, w)) rows.push({ segs: [paint(c)] });
      break;
    }
  }
  rows.push({ segs: [{ text: "" }] }); // gap row between blocks
  return rows;
}

/**
 * Line-based viewport: scroll rows (0 = tail pinned), slice partial edge items.
 * @returns start index into the row list + clamped scroll
 */
export function sliceRowWindow(total: number, avail: number, scroll: number): { start: number; scroll: number } {
  const s = Math.min(Math.max(0, Math.floor(scroll)), Math.max(0, total - avail));
  return { start: Math.max(0, total - avail - s), scroll: s };
}

/** Text row heights (for preview panels & click maps). */
function wrapRows(s: string, w: number): number {
  const ww = Math.max(20, w);
  return s.split("\n").reduce((n, ln) => n + Math.max(1, Math.ceil(cellWidth(ln) / ww)), 0);
}

export interface PreviewKey {
  ctrl?: boolean;
  escape?: boolean;
  upArrow?: boolean;
  downArrow?: boolean;
  return?: boolean;
  pageUp?: boolean;
  pageDown?: boolean;
}

export type PreviewKeyAction = "close" | "up" | "down" | "pageup" | "pagedown" | null;
/**
 * Tombol saat preview fullscreen terbuka → aksi. Pure agar bisa di-unit-test.
 * Esc SELALU menutup (tidak ada pengecualian state lain) — regresi bug Esc mati.
 */
export function previewKeyAction(inp: string, key: PreviewKey): PreviewKeyAction {
  if (key.escape) return "close";
  if (key.ctrl && inp === "c") return "close";
  if (key.upArrow) return "up";
  if (key.downArrow) return "down";
  if (key.pageUp) return "pageup";
  if (key.pageDown) return "pagedown";
  return null;
}

export const PROMPT_HISTORY_MAX = 100;

/**
 * Prompt history navigation (shell-style ↑/↓). Pure for unit tests.
 * @param current index into history, or null when editing fresh input
 * @param dir -1 = older (up), +1 = newer (down)
 * @returns next index, or null to restore the draft being typed
 */
export function historyStep(current: number | null, dir: -1 | 1, len: number): number | null {
  if (len === 0) return null;
  if (current === null) return dir < 0 ? len - 1 : null;
  const next = current + dir;
  if (next < 0) return 0;
  if (next >= len) return null;
  return next;
}

/**
 * Strip invisible terminal junk so stray bytes can never corrupt prompts
 * or break "/" parsing (which silently routes commands to the LLM).
 * Aggressive: strip ALL control chars (0x00-0x1f, 0x7f), ESC, CSI, OSC,
 * mouse sequences, orphan remnants. Only printable ASCII + Unicode survive.
 */
export function sanitizeInput(v: string): string {
  return stripMouseSequences(v)
    // OSC sequences: ESC ] ... BEL/ST
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    // CSI sequences: ESC [ ... final char
    .replace(/\x1b\[[0-9;?]*[@-~]/g, "")
    // Bracketed paste: ESC [ 200 ~ ... ESC [ 201 ~
    .replace(/\x1b\[20[01]~/g, "")
    // Orphan mouse remnants (no leading ESC)
    .replace(/^(?:\d+;){1,2}\d+[mM]/, "")
    .replace(/\[<?\d{0,4};?\d{0,4}/g, "")
    // ALL control chars: 0x00-0x1f (includes tab, CR, LF, ESC) + 0x7f (DEL)
    .replace(/[\x00-\x1f\x7f]/g, "")
    // Any remaining ESC that slipped through
    .replace(/\x1b/g, "");
}

/** Show the original prompt, not the initial-context blob.
 *  Bentuk blob: "## USER REQUEST\n<prompt>\n\n## WORKSPACE\n...".
 *  Hanya bagian prompt yang ditampilkan; section berikutnya dipotong. */
export function displayPrompt(content: string): string {
  const lines = content.split("\n");
  const reqIdx = lines.findIndex((l) => l.trim() === "## USER REQUEST");
  const raw = reqIdx >= 0 ? lines.slice(reqIdx + 1) : lines;
  const prompt: string[] = [];
  let started = reqIdx < 0;
  for (const l of raw) {
    if (/^##\s/.test(l)) {
      if (started) break; // section berikutnya (WORKSPACE/FILE TREE/…) bukan prompt
      continue;
    }
    started = true;
    prompt.push(l);
  }
  const t = prompt.join("\n").trim();
  return truncate(t || content);
}

/** Transient error notes (Ctrl+C/abort) — hidden on resume, stale. */
const ABORT_RE = /^Tool error dari LLM:/;

function tryParseToolOutput(content: string): unknown {
  const t = content.trim();
  if (!(t.startsWith("{") && t.endsWith("}"))) return content;
  try {
    return JSON.parse(t);
  } catch {
    return content;
  }
}

function toolStatusOf(parsed: unknown): "ok" | "error" {
  if (parsed && typeof parsed === "object" && typeof (parsed as { error?: unknown }).error === "string") {
    return "error";
  }
  return "ok";
}

/**
 * Bangun ulang item chat dari riwayat tersimpan (resume).
 * Baris tool direkonstruksi ringkas (tanpa dump isi) agar tampilan resume
 * sama dengan sesi live: pasangan assistant.tool_calls ↔ pesan tool.
 */
export function rebuildItems(messages: Session["messages"]): ChatItem[] {
  const out: ChatItem[] = [];
  const toolById = new Map<string, string>();
  let ui = 0; // stable per-resume ids for user rows (right-click revert)
  for (const m of messages) {
    if (m.role === "tool" && m.tool_call_id) toolById.set(m.tool_call_id, m.content);
  }
  for (const m of messages) {
    if (m.role === "user") {
      if (ABORT_RE.test(m.content.trim())) continue;
      out.push({ kind: "user", id: `u${ui++}`, text: displayPrompt(m.content) });
    } else if (m.role === "assistant") {
      if (m.content.trim()) out.push({ kind: "assistant", text: m.content });
      for (const tc of m.tool_calls ?? []) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.function.arguments || "{}") as Record<string, unknown>;
        } catch {
          args = {};
        }
        const raw = toolById.get(tc.id);
        const parsed = raw !== undefined ? tryParseToolOutput(raw) : undefined;
        const status = toolStatusOf(parsed);
        out.push({
          kind: "tool",
          id: tc.id,
          name: tc.function.name,
          preview: previewRefFor(tc.function.name, args),
          summary: summarizeCall(tc.function.name, args),
          detail:
            parsed !== undefined
              ? (summarizeResult(tc.function.name, {
                  status: status === "ok" ? "success" : "error",
                  output: parsed,
                  durationMs: 0,
                }) ?? undefined)
              : undefined,
          status,
          output: parsed !== undefined ? capOutput(parsed) : undefined,
        });
      }
    }
  }
  return out;
}

function makeAgent(
  session: Session,
  maxSteps: number,
  onEvent: (ev: AgentEvent) => void,
  asker: PermissionAsker,
): SingleAgent {
  const creds = resolveCredentials(session.provider);
  return new SingleAgent({
    model: session.model,
    provider: session.provider,
    apiKey: creds.apiKey,
    baseUrl: creds.baseUrl,
    maxTokens: 8_192,
    maxSteps,
    // Izin terminal/file ditanya inline (asker) + disimpan per session.
    autoApprove: false,
    approvals: session.approvals,
    askPermission: asker,
    rpm: rpmFromSettings(),
    onEvent,
  });
}

export function App({ initialSession, workspaceDir, maxSteps, initialPrompt }: TuiOptions): React.JSX.Element {
  const { exit } = useApp();
  const { isRawModeSupported } = useStdin();
  const { stdout } = useStdout();

  // Actual terminal size (fullscreen) + follow resizes.
  const [size, setSize] = useState(() => ({
    columns: stdout?.columns || 80,
    rows: stdout?.rows || 24,
  }));
  useEffect(() => {
    if (!stdout) return;
    const onResize = () => setSize({ columns: stdout.columns || 80, rows: stdout.rows || 24 });
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);

  const [session, setSession] = useState<Session>(initialSession);
  const [items, setItems] = useState<ChatItem[]>(() =>
    initialSession.messages.length > 0
      ? [
          {
            kind: "info" as const,
            tone: "dim" as const,
            text: `Resuming session ${initialSession.id.slice(0, 8)} (${initialSession.messages.length} messages).`,
          },
          ...rebuildItems(initialSession.messages),
        ]
      : [],
  );
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [stream, setStream] = useState("");
  const [cutoff, setCutoff] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [spin, setSpin] = useState(0);

  const sessionRef = useRef(session);
  const itemsRef = useRef(items);
  const streamRef = useRef("");
  const runningRef = useRef(false);
  const agentRef = useRef<SingleAgent | null>(null);
  // Last live model list (for /models <number> selection).
  const modelPickRef = useRef<{ provider: string; models: string[] } | null>(null);

  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  const push = useCallback((item: ChatItem) => {
    setItems((prev) => [...prev, item]);
  }, []);

  const flushStream = useCallback(() => {
    const t = streamRef.current;
    streamRef.current = "";
    setStream("");
    if (t.trim()) push({ kind: "assistant", text: t });
  }, [push]);

  const persist = useCallback((s: Session) => {
    sessionRef.current = s;
    setSession(s);
    saveSession(s);
  }, []);

  // ── Izin terminal/file inline: [y] sekali / [a] semua serupa / [n] tolak ──
  const [approval, setApproval] = useState<{ label: string; scope: string } | null>(null);

  // ── Dropdown SelectList: model/provider/commands/menu ──
  const [dropdown, setDropdown] = useState<{
    type: "models" | "providers" | "commands" | "menu";
    title: string;
    options: string[];
    selected: number;
    onSelect: (value: string) => void;
  } | null>(null);

  const openModelDropdown = useCallback((options: string[], onSelect: (value: string) => void) => {
    setDropdown({ type: "models", title: "Model", options, selected: 0, onSelect });
  }, []);

  const openProviderDropdown = useCallback((options: string[], onSelect: (value: string) => void) => {
    setDropdown({ type: "providers", title: "Provider", options, selected: 0, onSelect });
  }, []);

  /** Generic popup menu (e.g. right-click revert). Esc cancels. */
  const openMenuDropdown = useCallback((title: string, options: string[], onSelect: (value: string) => void) => {
    setDropdown({ type: "menu", title, options, selected: 0, onSelect });
  }, []);

  const closeDropdown = useCallback(() => {
    setDropdown(null);
  }, []);
  const approvalResolve = useRef<((v: AskerVerdict) => void) | null>(null);
  const approvalActive = useRef(false);

  const asker = useCallback((_req: PermissionRequest): Promise<AskerVerdict> => {
    return new Promise((resolve) => {
      approvalResolve.current = resolve;
      approvalActive.current = true;
      const label = _req.command
        ? `$ ${_req.command.replace(/\s+/g, " ").trim().slice(0, 100)}`
        : summarizeCall(_req.tool, _req.args);
      setApproval({ label, scope: _req.base ? `all "${_req.base}"` : "all similar" });
    });
  }, []);

  const answerApproval = useCallback((v: AskerVerdict) => {
    const r = approvalResolve.current;
    approvalResolve.current = null;
    approvalActive.current = false;
    setApproval(null);
    // The engine stores "all"/"deny" itself; session sync happens
    // when the turn finishes (runTurn) to avoid saving stale state.
    if (r) r(v);
  }, []);

/** State pratinjau fullscreen: judul + baris token + teks polos per baris. */
interface PreviewState {
  title: string;
  segs: HlSeg[][];
  plain: string[];
}

  // ── Pratinjau fullscreen baris tool (klik → buka, Esc → tutup) ──
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [previewScroll, setPreviewScroll] = useState(0);
  const rowMapRef = useRef<ClickHit[]>([]);
  const lastMouseAt = useRef(0);
  // Timestamp COMPLETE mouse sequences (parser) — untuk menangkal phantom Esc.
  // Lebih presisi dari lastMouseAt (potongan chunk) sehingga Esc asli lolos.
  const lastSeqAt = useRef(0);
  // Shell-style prompt history (↑ = lebih lama, ↓ = kembali ke draf).
  const histRef = useRef<string[]>([]);
  const histIdxRef = useRef<number | null>(null);
  const navValueRef = useRef<string | null>(null);
  const draftRef = useRef("");
  const openPreviewRef = useRef<(id: string) => void>(() => {});
  const clickRef = useRef<{ rowMap: ClickHit[]; previewOpen: boolean }>({
    rowMap: [],
    previewOpen: false,
  });
  const openRevertRef = useRef<(userId: string, text: string) => void>(() => {});

  const closePreview = useCallback(() => {
    setPreview(null);
    setPreviewScroll(0);
  }, []);

  const openPreviewById = useCallback(
    (id: string) => {
      const it = itemsRef.current.find((m) => m.kind === "tool" && m.id === id);
      if (!it || it.kind !== "tool") return;
      const pv = buildPreviewForTool(it, workspaceDir);
      const segs = highlight(pv.body, pv.lang);
      setPreview({
        title: pv.title,
        segs,
        plain: segs.map((ln) => ln.map((s) => s.text).join("")),
      });
      setPreviewScroll(0);
      setDropdown(null);
    },
    [workspaceDir],
  );

  // ── Agent events → TUI updates ──
  const handleEvent = useCallback(
    (ev: AgentEvent) => {
      switch (ev.type) {
        case "text":
          streamRef.current += ev.delta;
          setStream(streamRef.current);
          break;
        case "text_end":
        case "step":
          flushStream();
          break;
        case "tool_start":
          flushStream();
          push({
            kind: "tool",
            id: ev.call.id,
            name: ev.call.name,
            preview: previewRefFor(ev.call.name, ev.call.args),
            summary: summarizeCall(ev.call.name, ev.call.args),
            status: "running",
          });
          break;
        case "tool_end":
          flushStream();
          setItems((prev) =>
            prev.map((it) =>
              it.kind === "tool" && it.id === ev.call.id
                ? {
                    ...it,
                    status: ev.status === "success" ? "ok" : "error",
                    detail: ev.summary,
                    output: capOutput(ev.output),
                  }
                : it,
            ),
          );
          break;
        case "warn":
          flushStream();
          push({ kind: "info", tone: "yellow", text: ev.message });
          break;
        case "error":
          flushStream();
          push({ kind: "info", tone: "red", text: ev.message });
          break;
        case "trimmed":
          push({ kind: "info", tone: "yellow", text: `Context trimmed (${ev.count} messages) to fit the model window.` });
          break;
        case "compacted":
          push({ kind: "info", tone: "green", text: `Context auto-compacted (${ev.dropped} messages → summary). Continuing…` });
          break;
        case "done":
          flushStream();
          break;
      }
    },
    [flushStream, push],
  );

  /**
   * Rewind to a user prompt's auto-checkpoint: restores files + history,
   * then loads the prompt into the input for editing (not auto-sent).
   */
  const doRevertUserPrompt = useCallback(
    (userId: string, text: string) => {
      if (runningRef.current) {
        push({ kind: "info", tone: "yellow", text: "Wait for the turn to finish first." });
        return;
      }
      const sess = sessionRef.current;
      const items = itemsRef.current;
      const userTexts = items.filter((m) => m.kind === "user").map((m) => (m as { text: string }).text);
      const order = items.filter((m) => m.kind === "user").findIndex((m) => (m as { id: string }).id === userId);
      if (order < 0) {
        push({ kind: "info", tone: "red", text: "Prompt no longer on screen." });
        return;
      }
      const cps = listCheckpoints(sess.id).map((c) => ({ id: c.id, label: c.label, createdAt: c.createdAt }));
      const cpId = pairPromptCheckpoints(userTexts, cps).get(order);
      if (!cpId) {
        push({ kind: "info", tone: "yellow", text: "No checkpoint for this prompt (it may have been pruned). Nothing to rewind." });
        return;
      }
      const { session: next, result } = rewindToCheckpoint(sess, workspaceDir, cpId);
      if (!result.ok) {
        push({ kind: "info", tone: "red", text: result.error || "Rewind failed." });
        return;
      }
      persist(next);
      agentRef.current = makeAgent(next, maxSteps, handleEvent, asker);
      setCutoff(itemsRef.current.length + 1);
      setScrollOffset(0);
      for (const it of rebuildItems(next.messages)) push(it);
      setInput(text);
      const bits = [
        `${result.restored.length} files restored`,
        ...(result.deleted.length > 0 ? [`${result.deleted.length} files deleted`] : []),
        ...(result.skipped.length > 0 ? [`${result.skipped.length} skipped`] : []),
      ];
      push({ kind: "info", tone: "green", text: `Rewound to "${text.slice(0, 60)}" (${bits.join(", ")}). Prompt loaded below — edit, then Enter to resend.` });
    },
    [handleEvent, maxSteps, persist, push, workspaceDir, asker],
  );

  const openRevertMenu = useCallback(
    (userId: string, text: string) => {
      setDropdown(null);
      openMenuDropdown(`Prompt • checkpoint`, [
        "↩ Rewind to here (restore files + history)",
        "⧉ Save checkpoint here",
      ], (pick) => {
        if (pick.startsWith("↩")) doRevertUserPrompt(userId, text);
        else {
          const cp = createCheckpoint(sessionRef.current, workspaceDir, text);
          push({ kind: "info", tone: "green", text: `Checkpoint saved: ${cp.id.slice(0, 8)} "${cp.label}".` });
        }
      });
    },
    [doRevertUserPrompt, openMenuDropdown, push, workspaceDir],
  );

  if (!agentRef.current) {
    agentRef.current = makeAgent(sessionRef.current, maxSteps, handleEvent, asker);
  }

  const runTurn = useCallback(
    async (prompt: string) => {
      if (runningRef.current) {
        push({ kind: "info", tone: "yellow", text: "Wait for the turn to finish (Ctrl+C to cancel)." });
        return;
      }
      runningRef.current = true;
      setRunning(true);
      // Auto-checkpoint BEFORE the turn: right-click revert on this prompt
      // restores files + history to exactly this point.
      try {
        createCheckpoint(sessionRef.current, workspaceDir, prompt);
      } catch {
        /* checkpoint is best-effort, the turn still runs */
      }
      push({ kind: "user", id: `u${Date.now().toString(36)}${Math.floor(Math.random() * 0xffff).toString(16)}`, text: prompt });
      try {
        const sess = sessionRef.current;
        const { messages, result } = await agentRef.current!.chatTurn(prompt, workspaceDir, sess.messages);
        flushStream();
        persist({ ...sess, messages, filesModified: result.filesModified, approvals: agentRef.current!.getApprovals() });
        if (!result.success) {
          push({
            kind: "info",
            tone: "red",
            text: result.finalText || "Turn finished with no result — check the errors above.",
          });
        }
      } catch (e) {
        flushStream();
        push({ kind: "info", tone: "red", text: `Failed: ${(e as Error).message}` });
      } finally {
        runningRef.current = false;
        setRunning(false);
      }
    },
    [flushStream, persist, push, workspaceDir],
  );

  // ── Slash commands ──
  const execCommand = useCallback(
    async (name: string, args: string[]) => {
      const sess = sessionRef.current;
      const agent = agentRef.current!;

      /** Ganti model session aktif (dipakai /models). */
      const doSelectModel = (id: string) => {
        const known = findModel(id, sess.provider);
        const creds = resolveCredentials(sess.provider);
        agent.setModelProvider(id, sess.provider, creds.apiKey, creds.baseUrl);
        persist({ ...sess, model: id });
        push({
          kind: "info",
          tone: "green",
          text: known
            ? `Model → ${id} (window ${known.contextWindow.toLocaleString()} token)`
            : `Model → ${id} (not in catalog, using provider default window)`,
        });
      };

      /** Pindah provider (dipakai /providers use). */
      const doSwitchProvider = async (p: string): Promise<boolean> => {
        if (!SUPPORTED_PROVIDERS.includes(p)) {
          push({ kind: "info", tone: "red", text: `Unknown provider: ${p}` });
          return false;
        }
        const creds = resolveCredentials(p);
        if (!creds.apiKey && p !== "ollama" && p !== "mock") {
          push({ kind: "info", tone: "red", text: `Provider ${p} needs an API key — /login ${p} <key> or sabana-code auth login ${p}. Cancelled.` });
          return false;
        }
        agent.setModelProvider(sess.model, p, creds.apiKey, creds.baseUrl);
        modelPickRef.current = null; // daftar /models lama tak berlaku lagi
        persist({ ...sess, provider: p });
        push({ kind: "info", tone: "green", text: `Provider → ${p}. Testing connection…` });
        const test = await testProviderConnection(p);
        push({ kind: "info", tone: test.ok ? "green" : "red", text: test.detail });
        return test.ok;
      };

      /** Simpan kredensial (dipakai /login dan /providers login). */
      const doLogin = (p: string, key: string, base: string): boolean => {
        if (!p || !key || !SUPPORTED_PROVIDERS.includes(p) || p === "mock") {
          push({ kind: "info", tone: "red", text: "Usage: /login <provider> <api-key> [base-url]" });
          return false;
        }
        saveCredential(p, key, base || "");
        push({ kind: "info", tone: "green", text: `Credential for ${p} saved globally. Works from any directory now.` });
        return true;
      };

      switch (name) {
        case "help": {
          push({ kind: "info", tone: "dim", text: helpText() });
          break;
        }
        case "new": {
          persist(createSession(sess.model, sess.provider, workspaceDir));
          agentRef.current = makeAgent(sessionRef.current, maxSteps, handleEvent, asker);
          setCutoff(itemsRef.current.length + 1);
          setScrollOffset(0);
          push({ kind: "info", tone: "green", text: `New session: ${sessionRef.current.id.slice(0, 8)}` });
          break;
        }
        case "sessions": {
          const list = listSessions();
          if (list.length === 0) push({ kind: "info", tone: "dim", text: "No saved sessions yet." });
          else
            push({
              kind: "info",
              tone: "dim",
              text: ["Saved sessions:", ...list.slice(0, 15).map((s, i) => `  ${i + 1}. ${s.id.slice(0, 8)}  ${s.title}  [${s.model}/${s.provider}]  ${s.turns} turns`)].join("\n"),
            });
          break;
        }
        case "projects": {
          const mine = projectIdFor(workspaceDir);
          const list = listProjects();
          if (list.length === 0) push({ kind: "info", tone: "dim", text: "No registered projects yet." });
          else
            push({
              kind: "info",
              tone: "dim",
              text: [
                "Projects (history per folder):",
                ...list.slice(0, 15).map((p) => `  ${p.id === mine ? "●" : "○"} ${p.name}  ${p.sessions} sessions  ${p.path}`),
              ].join("\n"),
            });
          const mineInfo = list.find((p) => p.id === mine);
          if (mineInfo && mineInfo.sessions > 0) {
            const ss = projectSessions(mine)
              .map((s) => `  - ${s.id.slice(0, 8)}  ${s.title}`)
              .join("\n");
            if (ss) push({ kind: "info", tone: "dim", text: `Sessions in this project:\n${ss}\nResume: /resume <id>` });
          }
          break;
        }
        case "agents": {
          const list = listAgents();
          if (list.length === 0)
            push({ kind: "info", tone: "dim", text: "No profiles in ~/sabana-code/agents/ yet. Create <name>.md with name/description frontmatter." });
          else
            push({
              kind: "info",
              tone: "dim",
              text: ["Custom sub-agents:", ...list.map((a) => `  ${a.name} — ${a.description}${a.model ? ` (model: ${a.model})` : ""}`), "Usage: /agent <name> <task>"].join("\n"),
            });
          break;
        }
        case "agent": {
          const [aname, ...rest] = args;
          const profile = aname ? loadAgent(aname) : null;
          if (!profile) {
            push({ kind: "info", tone: "red", text: aname ? `Sub-agent '${aname}' not found. /agents to list.` : "Usage: /agent <name> <task>" });
            break;
          }
          const task = rest.join(" ").trim();
          if (!task) {
            push({ kind: "info", tone: "red", text: `Usage: /agent ${profile.name} <task>` });
            break;
          }
          if (runningRef.current) {
            push({ kind: "info", tone: "yellow", text: "Wait for the turn to finish first." });
            break;
          }
          runningRef.current = true;
          setRunning(true);
          push({ kind: "info", tone: "dim", text: `→ delegating to ${profile.name}: ${truncate(task, 140)}` });
          try {
            const sess = sessionRef.current;
            const creds = resolveCredentials(sess.provider);
            const sub = await runSubAgent(profile, task, workspaceDir, {
              provider: sess.provider,
              apiKey: creds.apiKey,
              baseUrl: creds.baseUrl,
              model: sess.model,
              maxTokens: 8_192,
              maxSteps: Math.min(20, maxSteps),
              approvals: sess.approvals,
              askPermission: asker,
            });
            push({ kind: "assistant", text: sub.text.trim() || "(sub-agent returned no text)" });
            // Merge new sub-agent approvals into the session + main engine.
            agentRef.current?.mergeApprovals(sub.approvals);
            persist({
              ...sess,
              messages: [
                ...sess.messages,
                { role: "user" as const, content: `[sub-agent ${profile.name}] ${task}` },
                { role: "assistant" as const, content: sub.text },
              ],
              filesModified: [...new Set([...sess.filesModified, ...sub.files])],
              approvals: agentRef.current?.getApprovals() ?? sess.approvals,
            });
            if (!sub.success) push({ kind: "info", tone: "yellow", text: "Sub-agent finished without a full result." });
          } catch (e) {
            push({ kind: "info", tone: "red", text: `Sub-agent failed: ${(e as Error).message}` });
          } finally {
            runningRef.current = false;
            setRunning(false);
          }
          break;
        }
        case "resume": {
          if (!args[0]) {
            const last = lastSession();
            if (!last) {
              push({ kind: "info", tone: "red", text: "No sessions yet. Usage: /resume <id>." });
              break;
            }
            args = [last.id];
          }
          let target = loadSession(args[0]);
          if (!target) {
            const idx = parseInt(args[0], 10);
            const list = listSessions();
            if (!isNaN(idx) && idx >= 1 && idx <= list.length) target = loadSession(list[idx - 1].id);
          }
          if (!target) {
            push({ kind: "info", tone: "red", text: `Session '${args[0]}' not found.` });
            break;
          }
          persist(target);
          agentRef.current = makeAgent(target, maxSteps, handleEvent, asker);
          setCutoff(itemsRef.current.length + 1);
          setScrollOffset(0);
          push({ kind: "info", tone: "green", text: `Resuming session ${target.id.slice(0, 8)} (${target.messages.length} messages).` });
          for (const it of rebuildItems(target.messages)) push(it);
          break;
        }
        case "providers": {
          const sub = (args[0] || "list").toLowerCase();
          // Open the dropdown with no subcommand atau subcommand "select"
          if (sub === "list" || sub === "select" || sub === "") {
            const providers = SUPPORTED_PROVIDERS.filter((p) => p !== "mock");
            openProviderDropdown(providers, async (pick) => {
              await doSwitchProvider(pick);
            });
            break;
          }
          if (sub === "use" && args[1]) {
            await doSwitchProvider(args[1].toLowerCase());
            break;
          }
          if (sub === "login" && args[1] && args[2]) {
            doLogin(args[1].toLowerCase(), args[2], args[3] || "");
            break;
          }
          push({ kind: "info", tone: "red", text: "Usage: /providers [list]  •  /providers use <name>  •  /providers login <name> <key> [base-url]" });
          break;
        }
        case "models": {
          const arg = (args[0] || "").trim();
          const pending = modelPickRef.current?.provider === sess.provider ? modelPickRef.current : null;
          // Select by number from the last list.
          if (/^\d+$/.test(arg) && pending) {
            const idx = parseInt(arg, 10) - 1;
            const pick = pending.models[idx];
            if (!pick) {
              push({ kind: "info", tone: "red", text: `Number out of range (1–${pending.models.length}).` });
              break;
            }
            modelPickRef.current = null;
            doSelectModel(pick);
            break;
          }
          // Input manual: cocok persis ke daftar terakhir atau katalog (tanpa fetch).
          if (arg && !/^\d+$/.test(arg)) {
            const exact = matchModelName(arg, pending?.models ?? [], listModels(sess.provider).map((m) => m.id));
            if (exact) {
              modelPickRef.current = null;
              doSelectModel(exact);
              break;
            }
          }
          const filter = /^\d+$/.test(arg) ? "" : arg.toLowerCase();
          push({ kind: "info", tone: "dim", text: `Fetching ${sess.provider} model list…` });
          const live = await fetchProviderModels(sess.provider);
          if (!live.ok) {
            const known = listModels(sess.provider);
            push({
              kind: "info",
              tone: "yellow",
              text: [`Live fetch failed (${live.error}). Built-in catalog:`, ...known.map((m) => `  ${m.id} — ${m.description}`), "Select: /models <number|exact name>"].join("\n"),
            });
            break;
          }
          let models = live.models.filter(isChatModelId);
          if (filter) models = models.filter((m) => m.toLowerCase().includes(filter));
          if (models.length === 0) {
            push({ kind: "info", tone: "red", text: "No matching models. Try another filter or type the exact name: /models <name>." });
            break;
          }
          const CAP = 40;
          const shown = models.slice(0, CAP);
          modelPickRef.current = { provider: sess.provider, models: shown };
          // Buka dropdown jika tidak ada argumen atau user minta pilih
          if (!arg) {
            openModelDropdown(shown, (pick) => {
              doSelectModel(pick);
            });
            break;
          }
          push({
            kind: "info",
            tone: "dim",
            text: [
              `Model ${sess.provider} (${live.source === "live" ? "live" : "catalog"}${models.length > CAP ? `, showing ${CAP}/${models.length}` : `, ${models.length}`}) — active: ${sess.model}`,
              ...shown.map((m, i) => `  ${i + 1}. ${m}${m === sess.model ? "  ← active" : ""}`),
              "Select: /models <number|exact name>  or bare /models for the dropdown",
            ].join("\n"),
          });
          break;
        }
        case "skills": {
          const list = listSkills(workspaceDir);
          if (list.length === 0)
            push({ kind: "info", tone: "dim", text: "No skills yet. Create *.md in ~/sabana-code/skills/ or <project>/.sabana/skills/ (name/description frontmatter)." });
          else
            push({
              kind: "info",
              tone: "dim",
              text: ["Skills:", ...list.map((s) => `  ${s.name} — ${s.description} [${s.scope}]`), "View: /skill <name>"].join("\n"),
            });
          break;
        }
        case "skill": {
          const sname = (args[0] || "").toLowerCase();
          if (!sname) {
            push({ kind: "info", tone: "red", text: "Usage: /skill <name>" });
            break;
          }
          const s = loadSkill(sname, workspaceDir);
          if (!s) {
            push({ kind: "info", tone: "red", text: `Skill '${sname}' not found. /skills to list.` });
            break;
          }
          const body = s.instructions.length > 3000 ? s.instructions.slice(0, 3000) + "\n…(dipotong)" : s.instructions;
          push({ kind: "info", tone: "dim", text: `Skill ${s.name} [${s.scope}] — ${s.description}\n\n${body}` });
          break;
        }
        case "todo": {
          const list = loadTodos(workspaceDir);
          const done = list.items.filter((t) => t.status === "completed").length;
          push({
            kind: "info",
            tone: "dim",
            text: `Todos (${done}/${list.items.length} done):\n${formatTodos(list.items)}`,
          });
          break;
        }
        case "mcp": {
          if ((args[0] || "").toLowerCase() === "reload") {
            push({ kind: "info", tone: "dim", text: "Reloading MCP…" });
            try {
              const r = await agent.reloadMcp();
              push({
                kind: "info",
                tone: r.errors.length > 0 ? "yellow" : "green",
                text: `MCP reload: +${r.added} tools${r.errors.length > 0 ? `\nFailed: ${r.errors.join("; ")}` : ""}`,
              });
            } catch (e) {
              push({ kind: "info", tone: "red", text: `MCP reload failed: ${(e as Error).message}` });
            }
          }
          const st = agent.mcpStatus();
          if (st.length === 0)
            push({ kind: "info", tone: "dim", text: "No MCP servers yet. Add them in ~/sabana-code/mcp.json, then /mcp reload." });
          else
            push({
              kind: "info",
              tone: "dim",
              text: [
                "MCP:",
                ...st.map((s) =>
                  s.state === "up"
                    ? `  ● ${s.name} — ${s.tools.length} tools`
                    : `  ○ ${s.name} — down${s.error ? `: ${s.error.slice(0, 120)}` : ""}`,
                ),
              ].join("\n"),
            });
          break;
        }
        case "checkpoint": {
          const label = args.join(" ").trim();
          const cp = createCheckpoint(sess, workspaceDir, label || undefined);
          push({ kind: "info", tone: "green", text: `Checkpoint saved: ${cp.id.slice(0, 8)} "${cp.label}" (${cp.files.length} files, ${cp.messages.length} messages). Rewind: /rewind ${cp.id.slice(0, 8)}` });
          break;
        }
        case "checkpoints": {
          const list = listCheckpoints(sess.id);
          if (list.length === 0) push({ kind: "info", tone: "dim", text: "No checkpoints in this session yet. Create one: /checkpoint [label]" });
          else
            push({
              kind: "info",
              tone: "dim",
              text: ["Checkpoints:", ...list.map((c) => `  ${c.id.slice(0, 8)}  "${c.label}"  ${c.files} files  ${c.messages} messages`), "Rewind: /rewind <id>"].join("\n"),
            });
          break;
        }
        case "rewind": {
          const id = args[0];
          if (!id) {
            push({ kind: "info", tone: "red", text: "Usage: /rewind <id> (see /checkpoints)" });
            break;
          }
          if (runningRef.current) {
            push({ kind: "info", tone: "yellow", text: "Wait for the turn to finish first." });
            break;
          }
          const { session: next, result } = rewindToCheckpoint(sess, workspaceDir, id);
          if (!result.ok) {
            push({ kind: "info", tone: "red", text: result.error || "Rewind gagal." });
            break;
          }
          persist(next);
          setCutoff(itemsRef.current.length + 1);
          setScrollOffset(0);
          for (const it of rebuildItems(next.messages)) push(it);
          const bits = [
            `${result.restored.length} files restored`,
            ...(result.deleted.length > 0 ? [`${result.deleted.length} files deleted`] : []),
            ...(result.skipped.length > 0 ? [`${result.skipped.length} skipped`] : []),
          ];
          push({ kind: "info", tone: "green", text: `Rewound to checkpoint ${id}: ${bits.join(", ")}. History: ${next.messages.length} messages.` });
          break;
        }
        case "compact": {
          if (runningRef.current) {
            push({ kind: "info", tone: "yellow", text: "Wait for the turn to finish first (Ctrl+C to cancel)." });
            break;
          }
          if (sess.messages.length <= 4) {
            push({ kind: "info", tone: "dim", text: "History is still short — no need to compact yet." });
            break;
          }
          runningRef.current = true;
          setRunning(true);
          push({ kind: "info", tone: "dim", text: "Summarizing context…" });
          try {
            const r = await agent.compactHistory(sess.messages);
            if (!r.ok) {
              push({ kind: "info", tone: "red", text: `Compact failed: ${r.error}` });
            } else {
              persist({ ...sess, messages: r.messages });
              push({ kind: "info", tone: "green", text: `Context compacted (${r.dropped} messages → summary):\n${r.summary.slice(0, 800)}` });
            }
          } catch (e) {
            push({ kind: "info", tone: "red", text: `Compact failed: ${(e as Error).message}` });
          } finally {
            runningRef.current = false;
            setRunning(false);
          }
          break;
        }
        case "context": {
          const u = contextUsage(sess.messages, sess.model, sess.provider);
          push({
            kind: "info",
            tone: u.pct > 85 ? "red" : u.pct > 60 ? "yellow" : "dim",
            text: `Context: ~${u.tokens.toLocaleString()} / ${u.window.toLocaleString()} tokens (${u.pct.toFixed(1)}%) • ${sess.messages.length} messages • model ${sess.model}`,
          });
          break;
        }
        case "tools": {
          push({
            kind: "info",
            tone: "dim",
            text: ["Tools:", ...agent.listTools().map((t) => `  ${t.name} — ${t.description}`)].join("\n"),
          });
          break;
        }
        case "login": {
          // /login <provider> <key> [baseUrl] — simpan ke ~/sabana-code/settings.json
          const [p, key, base] = args;
          doLogin((p || "").toLowerCase(), key || "", base || "");
          break;
        }
        case "logout": {
          const p = args[0];
          if (!p) {
            const rows = credentialSummary().map((c) => `  ${c.provider.padEnd(10)} ${c.source}`).join("\n");
            push({ kind: "info", tone: "dim", text: `Credentials:\n${rows}\nRemove: /logout <provider>` });
            break;
          }
          const removed = removeCredential(p);
          push({
            kind: "info",
            tone: removed ? "green" : "red",
            text: removed ? `Credential for ${p} removed.` : `No stored credential for ${p}.`,
          });
          break;
        }
        case "clear":
          setCutoff(itemsRef.current.length);
          setScrollOffset(0);
          break;
        case "quit":
        case "exit":
          saveSession(sessionRef.current);
          exit();
          break;
        default:
          push({ kind: "info", tone: "red", text: `Unknown command: /${name}. Type /help.` });
          break;
      }
    },
    [exit, handleEvent, maxSteps, persist, push, workspaceDir, asker],
  );

  const submit = useCallback(
    (value: string) => {
      // Sanitize FIRST: invisible bytes (ANSI/mouse/paste) must never reach
      // parsing — a dirty "/quit" would otherwise run as an LLM prompt.
      const text = sanitizeInput(value).trim();
      if (!text) return;
      // Record prompt history (consecutive dedup, cap 100).
      const h = histRef.current;
      if (h[h.length - 1] !== text) {
        h.push(text);
        if (h.length > PROMPT_HISTORY_MAX) h.shift();
      }
      histIdxRef.current = null;
      navValueRef.current = null;
      setInput("");
      setScrollOffset(0); // new output → stick back to tail
      const cmd = parseCommand(text);
      if (cmd) void execCommand(cmd.name, cmd.args);
      else void runTurn(text);
    },
    [execCommand, runTurn],
  );

  // Filter leftover terminal junk out of typing (Ink receives the bytes too).
  // Complete sequences always dropped; partial tails only briefly after mouse
  // activity (so normal typing is never eaten). Also: open/close the "/"
  // autocomplete dropdown and reset history navigation when the user types
  // themselves (not via ↑/↓ navigation).
  const onInputChange = useCallback((v: string) => {
    let c = sanitizeInput(v);
    if (Date.now() - lastMouseAt.current < 300) {
      c = c.replace(/\[<?\d{0,4};?\d{0,4}$/, "");
    }
    if (c !== navValueRef.current) histIdxRef.current = null;
    navValueRef.current = null;
    setInput(c);
    if (dropdown === null || dropdown.type === "commands") {
      const matches = suggestCommands(c);
      if (matches.length === 0) {
        if (dropdown !== null) setDropdown(null);
      } else {
        setDropdown({ type: "commands", title: "Commands", options: matches, selected: 0, onSelect: (opt) => setInput(`${opt} `) });
      }
    }
  }, [dropdown]);

  // Shell-style prompt-history navigation: ↑ = lebih lama, ↓ = lebih baru/draf.
  const navHistory = (dir: -1 | 1): void => {
    const h = histRef.current;
    const next = historyStep(histIdxRef.current, dir, h.length);
    if (next === null) {
      if (histIdxRef.current !== null) {
        histIdxRef.current = null;
        navValueRef.current = draftRef.current;
        setInput(draftRef.current);
      }
      return;
    }
    if (histIdxRef.current === null) draftRef.current = input;
    histIdxRef.current = next;
    navValueRef.current = h[next];
    setInput(h[next]);
  };

  // Auto-submit the initial prompt (e.g. for demos / smoke tests)
  const bootRef = useRef(false);
  useEffect(() => {
    if (!bootRef.current && initialPrompt) {
      bootRef.current = true;
      const t = setTimeout(() => submit(initialPrompt), 100);
      return () => clearTimeout(t);
    }
    bootRef.current = true;
  }, [initialPrompt, submit]);

  // Spinner while the agent works
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setSpin((s) => (s + 1) % SPIN.length), 120);
    return () => clearInterval(t);
  }, [running]);

  // Left-click a tool row → fullscreen preview. Right-click a user prompt →
  // revert menu (checkpoint popup). Wheel/gesture → scroll chat (or preview).
  // Own listener on raw stdin; Ink still receives the bytes, so the onChange
  // filter + KeyHandler escape window fend off typing garbage.
  useEffect(() => {
    const parser = createMouseParser(
      (c) => {
        lastSeqAt.current = Date.now();
        const st = clickRef.current;
        if (!st || st.previewOpen) return;
        const hit = st.rowMap.find((r) => c.y >= r.y0 && c.y < r.y1);
        if (hit && hit.kind === "tool") openPreviewRef.current(hit.id);
      },
      (dir) => {
        lastSeqAt.current = Date.now();
        const d = dir === "up" ? SCROLL_STEP : -SCROLL_STEP;
        if (clickRef.current.previewOpen) setPreviewScroll((s) => Math.max(0, s + d));
        else setScrollOffset((s) => Math.max(0, s + d));
      },
      (c) => {
        lastSeqAt.current = Date.now();
        const st = clickRef.current;
        if (!st || st.previewOpen) return;
        const hit = st.rowMap.find((r) => c.y >= r.y0 && c.y < r.y1);
        if (hit && hit.kind === "user" && hit.text !== undefined) openRevertRef.current(hit.id, hit.text);
      },
    );
    const onData = (chunk: Buffer) => {
      const s = chunk.toString("utf-8");
      // Selalu teruskan ke parser (sequence bisa terpotong antar chunk);
      // cap waktu hanya untuk sequence mouse agar Esc asli tak ikut ditekan.
      if (s.includes("\x1b[<")) lastMouseAt.current = Date.now();
      parser(s);
    };
    process.stdin.on("data", onData);
    return () => {
      process.stdin.off("data", onData);
    };
  }, []);

  const usage = contextUsage(session.messages, session.model, session.provider);
  const visible = items.slice(cutoff).slice(-300);
  // Big centered brand with no conversation yet; header kecil biasa setelah ada chat.
  const showBanner = !preview && !hasChatItems(visible);
  const projectName = workspaceDir.split("/").filter(Boolean).pop() || workspaceDir;
  const cols = Math.max(40, size.columns);
  const rows = Math.max(12, size.rows);

  // Dropdown: show at most 8 options around the selection (to fit the screen).
  const DD_MAX = 8;
  let ddVisible: string[] = [];
  let ddOffset = 0;
  if (dropdown) {
    const n = dropdown.options.length;
    ddOffset = n <= DD_MAX ? 0 : Math.min(Math.max(0, dropdown.selected - Math.floor(DD_MAX / 2)), n - DD_MAX);
    ddVisible = dropdown.options.slice(ddOffset, ddOffset + DD_MAX);
  }

  // Smooth line-based viewport: every chat row scrolls (no page-break jumps).
  // scrollOffset 0 = tail (newest) pinned bottom; clamped so view never empties.
  const CHROME_ROWS = 4 + 1 + 3 + 1; // header + margin + input + status
  const approvalRows = approval ? 5 : 0;
  const dropdownRows = dropdown ? 8 + ddVisible.length : 0;
  const avail = Math.max(5, rows - CHROME_ROWS - approvalRows - dropdownRows - 2);
  const feed: ChatItem[] = stream ? [...visible, { kind: "assistant", text: `${stream}▍` }] : visible;
  const allRows: ChatRow[] = feed.flatMap((it) => itemRowList(it, cols));
  const { start, scroll } = sliceRowWindow(allRows.length, avail, scrollOffset);
  const winRows = allRows.slice(start, start + avail);

  // ── Terminal row → click map for mouse (1-based coordinates).
  // Header info sits below the prompt for a clean top; chat starts at row 2
  // (1 row of feed top margin). Tool rows → preview, user rows → revert menu.
  const chatStartRow = 2;
  {
    const rowMap: ClickHit[] = [];
    winRows.forEach((r, i) => {
      if (r.toolId) rowMap.push({ y0: chatStartRow + i, y1: chatStartRow + i + 1, kind: "tool", id: r.toolId });
      else if (r.user) rowMap.push({ y0: chatStartRow + i, y1: chatStartRow + i + 1, kind: "user", id: r.user.id, text: r.user.text });
    });
    rowMapRef.current = rowMap;
  }
  clickRef.current = { rowMap: rowMapRef.current, previewOpen: preview !== null };
  openPreviewRef.current = openPreviewById;
  openRevertRef.current = openRevertMenu;

  // ── Fullscreen preview panel: border(2) + title(1) + footer(1).
  const previewAvail = preview ? Math.max(5, rows - 4 - 1 - 4 - 1 - (approval ? 5 : 0)) : 0;
  let pvShown: HlSeg[][] = [];
  let pvStart = 0;
  let pvTotalRows = 0;
  let pvScrollClamped = 0;
  if (preview) {
    const w = Math.max(20, cols - 6);
    const hs = preview.plain.map((l) => Math.max(1, Math.ceil(cellWidth(l) / w)));
    pvTotalRows = hs.reduce((a, b) => a + b, 0);
    const maxP = Math.max(0, pvTotalRows - previewAvail);
    pvScrollClamped = Math.min(previewScroll, maxP);
    let skipped = 0;
    let li = 0;
    while (li < hs.length && skipped + hs[li] <= pvScrollClamped) {
      skipped += hs[li];
      li++;
    }
    if (li < hs.length && skipped < pvScrollClamped) li++; // lewati baris parsial atas
    let used = 0;
    const out: HlSeg[][] = [];
    let idx = li;
    while (idx < preview.segs.length && used < previewAvail) {
      const h = hs[idx] ?? 1;
      if (used + h > previewAvail) break;
      out.push(preview.segs[idx]);
      used += h;
      idx++;
    }
    pvShown = out;
    pvStart = li;
  }

  return (
    <Box flexDirection="column" width={cols} height={rows} paddingX={1}>
      <Box flexDirection="column" flexGrow={1} marginTop={1}>
        {preview ? (
          <Box key="__preview" borderStyle="round" borderColor="magenta" paddingX={1} flexDirection="column" flexGrow={1}>
            <Box marginBottom={1}>
              <Text bold>{truncate(preview.title, cols)}</Text>
            </Box>
            {pvShown.map((ln, i) => (
              <Text key={pvStart + i}>
                {ln.every((s) => s.text === "") ? (
                  " "
                ) : (
                  ln.map((s, j) => (
                    <Text key={j} color={s.dim ? undefined : s.color} dimColor={s.dim ? true : undefined} bold={s.bold}>
                      {s.text}
                    </Text>
                  ))
                )}
              </Text>
            ))}
            <Box marginTop={1}>
              <Text dimColor>
                Esc/q close · ↑↓/PgUp/PgDn scroll{pvTotalRows > previewAvail ? ` · ↑${pvScrollClamped}/${pvTotalRows}` : ""}
              </Text>
            </Box>
          </Box>
        ) : showBanner ? (
          <Box key="__banner" flexDirection="column" flexGrow={1} justifyContent="center" alignItems="center">
            {bannerSegs().map((ln, i) => (
              <Text key={i}>
                {ln.every((s) => s.text === "") ? (
                  " "
                ) : (
                  ln.map((s, j) => (
                    <Text key={j} color={s.dim ? undefined : s.color} dimColor={s.dim ? true : undefined} bold={s.bold}>
                      {s.text}
                    </Text>
                  ))
                )}
              </Text>
            ))}
            {stream ? (
              <Box marginTop={1} alignSelf="flex-start">
                <Text>{stream}▍</Text>
              </Box>
            ) : null}
          </Box>
        ) : (
          // Flat Claude-style feed: styled rows, no boxes (enables smooth per-row scroll).
          winRows.map((row, i) => (
            <Text key={`${cutoff}-${start + i}`}>
              {row.segs.every((s) => s.text === "") ? (
                " "
              ) : (
                row.segs.map((s, j) => (
                  <Text key={j} color={s.dim ? undefined : s.color} dimColor={s.dim ? true : undefined} bold={s.bold}>
                    {s.text}
                  </Text>
                ))
              )}
            </Text>
          )))}
      </Box>

      {dropdown && !preview && (
        <Box marginTop={1} marginBottom={1} borderStyle="round" borderColor="cyan" paddingX={1} paddingY={1} width={Math.min(cols - 4, 60)} flexDirection="column">
          <Box marginBottom={1}>
            <Text>
              <Text bold color="cyan">{dropdown.title}</Text>
              <Text dimColor>  ↑↓ navigate · Enter={dropdown.type === "commands" ? "run/complete" : "select"} · Esc=cancel</Text>
            </Text>
          </Box>
          {ddOffset > 0 && (
            <Box><Text dimColor>  ↑ {ddOffset} more above…</Text></Box>
          )}
          {ddVisible.map((opt, vi) => {
            const idx = ddOffset + vi;
            return (
              <Box key={`${idx}-${opt}`}>
                <Text color={dropdown.selected === idx ? "cyan" : undefined} dimColor={dropdown.selected !== idx}>
                  {dropdown.selected === idx ? "► " : "  "}{opt}{dropdown.type === "models" && opt === session.model ? "  ← active" : dropdown.type === "providers" && opt === session.provider ? "  ← active" : ""}
                </Text>
              </Box>
            );
          })}
          {ddOffset + ddVisible.length < dropdown.options.length && (
            <Box><Text dimColor>  ↓ {dropdown.options.length - ddOffset - ddVisible.length} more below…</Text></Box>
          )}
        </Box>
      )}
      {!preview && (
        <Box marginTop={1} borderStyle="single" borderColor={approval ? "yellow" : running ? "yellow" : "gray"} paddingX={1}>
          <Text color={approval ? "yellow" : running ? "yellow" : "green"}>
            {approval ? "⚡ " : running ? SPIN[spin] + " " : "❯ "}
          </Text>
          <TextInput
            value={input}
            onChange={onInputChange}
            onSubmit={submit}
            focus={approval === null && preview === null}
            placeholder={
              approval ? "Waiting for approval… (y/a/n)" : running ? "Agent working… (Ctrl+C cancels)" : "Type a message or /command…"
            }
          />
        </Box>
      )}

      <Box marginTop={1} borderStyle="round" borderColor="cyan" paddingX={1} flexDirection="column">
        <Box>
          <Text>
            <Text bold color="cyan">sabana-code</Text>
            <Text bold>  {projectName}</Text>
            <Text dimColor>  {session.id.slice(0, 8)} • {session.model}/{session.provider}</Text>
          </Text>
        </Box>
        <Box><Text dimColor>{workspaceDir}</Text></Box>
      </Box>

      {approval && (
        <Box marginTop={1} borderStyle="round" borderColor="yellow" paddingX={1} flexDirection="column">
          <Box>
            <Text bold color="yellow">Terminal permission </Text>
            <Text>{approval.label}</Text>
          </Box>
          <Box>
            <Text dimColor>[y] once   [a] {approval.scope}   [n] deny</Text>
          </Box>
        </Box>
      )}

      <Box marginTop={0}>
        <Text dimColor>
          ctx ~{usage.tokens.toLocaleString()}/{usage.window.toLocaleString()} ({usage.pct.toFixed(0)}%)
          {"  "}• {session.filesModified.length} files • /help
          {scroll > 0 ? ` • ↑${scroll} (PgDn/wheel down)` : ""}
        </Text>
      </Box>

      {isRawModeSupported && <KeyHandler onKey={(inp, key) => {
        if (process.env.SABANA_DEBUG_INPUT) flog("input", `inp=${JSON.stringify(inp)} key=${JSON.stringify(key)}`);
        // Escape artifacts from complete mouse sequences (klik/wheel ditangani
        // parser sendiri). Jendela sempit + berbasis sequence (bukan chunk)
        // so real Esc is never eaten.
        if (key.escape && Date.now() - lastSeqAt.current < 150) return;
        // Pratinjau fullscreen: Esc/Ctrl+C/q menutup; panah scroll; lainnya abaikan.
        // (pakai state `preview` langsung — closure ini dibuat ulang tiap render,
        // jadi selalu segar; ref terpisah rawan lupa di-sync dan bikin Esc mati.)
        if (preview) {
          if ((inp === "q" || inp === "Q") && !approvalActive.current) {
            closePreview();
            return;
          }
          const act = previewKeyAction(inp, key);
          if (act === "close") {
            closePreview();
            return;
          }
          if (act === "up") {
            setPreviewScroll((s) => Math.max(0, s - SCROLL_STEP));
            return;
          }
          if (act === "down") {
            setPreviewScroll((s) => s + SCROLL_STEP);
            return;
          }
          if (act === "pageup") {
            setPreviewScroll((s) => Math.max(0, s - previewAvail));
            return;
          }
          if (act === "pagedown") {
            setPreviewScroll((s) => s + previewAvail);
            return;
          }
          if (approvalActive.current) {
            const c = inp.toLowerCase();
            if (c === "y") answerApproval("once");
            else if (c === "a") answerApproval("all");
            else if (c === "n") answerApproval("deny");
          }
          return;
        }
        // Dropdown navigation takes priority
        if (dropdown) {
          if (key.upArrow) {
            setDropdown(d => d ? { ...d, selected: Math.max(0, d.selected - 1) } : null);
            return;
          }
          if (key.downArrow) {
            setDropdown(d => d ? { ...d, selected: Math.min(d.options.length - 1, d.selected + 1) } : null);
            return;
          }
          if (key.return) {
            const sel = dropdown.options[dropdown.selected];
            // Commands: Enter saat input sudah persis = JALANKAN; selain itu = lengkapi.
            if (dropdown.type === "commands" && input.trim() === sel) {
              closeDropdown();
              submit(input);
              return;
            }
            dropdown.onSelect(sel);
            closeDropdown();
            return;
          }
          if (key.escape) {
            closeDropdown();
            return;
          }
          // Ignore other keys when dropdown is open
          return;
        }
        if (approvalActive.current) {
          // Scrolling stays allowed while the approval box shows (y/a/n never clash).
          if (key.upArrow) {
            setScrollOffset((s) => s + SCROLL_STEP);
            return;
          }
          if (key.downArrow) {
            setScrollOffset((s) => Math.max(0, s - SCROLL_STEP));
            return;
          }
          if (key.pageUp) {
            setScrollOffset((s) => s + avail);
            return;
          }
          if (key.pageDown) {
            setScrollOffset((s) => Math.max(0, s - avail));
            return;
          }
          if (key.escape) {
            // Allow escape to exit even in approval mode
          }
        }
        // Input prompt (saat tidak ada dropdown/modal):
        // ↑/↓ = riwayat prompt (ala shell), PgUp/PgDn = scroll chat.
        if (!approvalActive.current && !dropdown) {
          if (key.upArrow) {
            navHistory(-1);
            return;
          }
          if (key.downArrow) {
            navHistory(1);
            return;
          }
          if (key.pageUp) {
            setScrollOffset((s) => s + avail);
            return;
          }
          if (key.pageDown) {
            setScrollOffset((s) => Math.max(0, s - avail));
            return;
          }
        }
        if (key.ctrl && inp === "c") {
          // Batal juga menutup box izin (tanpa menyimpan keputusan).
          if (approvalActive.current) answerApproval("cancel");
          if (runningRef.current) {
            agentRef.current?.abortRun();
            push({ kind: "info", tone: "yellow", text: "Cancelling turn…" });
          } else {
            const a = agentRef.current;
            saveSession({ ...sessionRef.current, approvals: a ? a.getApprovals() : sessionRef.current.approvals });
            exit();
          }
          return;
        }
        // While waiting approval: y = once, a = all similar, n/Esc = deny.
        if (approvalActive.current) {
          const c = inp.toLowerCase();
          if (c === "y") answerApproval("once");
          else if (c === "a") answerApproval("all");
          else if (c === "n" || key.escape) answerApproval("deny");
        }
      }} />}
    </Box>
  );
}

function KeyHandler({ onKey }: { onKey: (inp: string, key: { ctrl?: boolean; escape?: boolean; upArrow?: boolean; downArrow?: boolean; return?: boolean; pageUp?: boolean; pageDown?: boolean }) => void }): React.JSX.Element {
  useInput((inp, key) => {
    onKey(inp, key);
  });
  return <></>;
}
